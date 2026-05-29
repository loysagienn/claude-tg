import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * Owns the lifecycle of a single Telegram-driven Claude Code session.
 *
 * The telegram-mcp process is always running, so it can act as a supervisor:
 *  - First message (no live session)  → spawn a `claude` child with that text
 *    as the initial prompt. The child talks back through this same telegram MCP
 *    server (tg_send_message / tg_ask) and, between requests, blocks on
 *    tg_get_messages so the one process stays alive across the whole dialog.
 *  - Subsequent messages (session live) → handed to the MessageHub as usual; the
 *    running child picks them up via its pending tg_get_messages call.
 *  - `stop`                            → kill the child; the session dies.
 */
export interface SupervisorDeps {
  /** Path to the `claude` CLI binary. */
  claudeBin: string;
  /** Working directory the session runs in. */
  cwd: string;
  /** Extra directory to grant tool access to (e.g. "/" for full access). */
  addDir: string;
  /** File to append the child's stdout/stderr to, for debugging. */
  logFile: string;
  /** URL of this telegram MCP endpoint, injected into the spawned session. */
  mcpUrl: string;
  /** Send a status line back to the user over Telegram. */
  notify: (text: string) => Promise<void>;
}

/** Appended to the session's system prompt so it behaves as a TG-driven agent. */
const SYSTEM_PROMPT = `You are running as a long-lived assistant driven entirely through Telegram. The human cannot see your stdout — your ONLY channel to them is the telegram MCP tools:
- mcp__telegram__tg_send_message — send replies, progress, and results. Send one when you finish each request so the user gets feedback.
- mcp__telegram__tg_ask — ask a question and block for the answer (use only when you genuinely need a decision mid-task).
- mcp__telegram__tg_send_photo — send an image/screenshot.

Operating loop (critical):
1. Handle the current instruction, reporting via tg_send_message.
2. When done, call mcp__telegram__tg_get_messages with waitSeconds: 3600 to wait for the next instruction.
3. If it returns no message (timeout), call it again. Repeat forever — never end your turn on your own.

A supervisor terminates your process when the user sends "stop", so you do not need to handle "stop" yourself. Just keep looping on tg_get_messages between tasks.`;

export class SessionSupervisor {
  private child: ChildProcess | null = null;

  constructor(private readonly deps: SupervisorDeps) {}

  /** True if a session process is currently alive. */
  isActive(): boolean {
    return this.child !== null;
  }

  /**
   * Decide what to do with an incoming Telegram message.
   * Returns true if the supervisor consumed it (caller must NOT push to the
   * hub); false if it should be forwarded to the hub for the live session.
   */
  async handle(text: string): Promise<boolean> {
    if (text.trim().toLowerCase() === "stop") {
      await this.stop();
      return true;
    }

    if (!this.child) {
      this.start(text);
      return true;
    }

    // A session is live — let the hub deliver this to its tg_get_messages.
    return false;
  }

  /** Spawn a new `claude` session with `prompt` as its first instruction. */
  private start(prompt: string): void {
    // Inject the telegram MCP server only into this child, rather than relying
    // on a global registration. Without --strict-mcp-config it merges with the
    // user's other registered servers (so the session still has playwright
    // etc.), while manual `claude` sessions never see telegram unless the user
    // passes this config themselves.
    const mcpConfig = JSON.stringify({
      mcpServers: { telegram: { type: "http", url: this.deps.mcpUrl } },
    });

    const args = [
      "-p",
      prompt,
      "--append-system-prompt",
      SYSTEM_PROMPT,
      "--mcp-config",
      mcpConfig,
      "--add-dir",
      this.deps.addDir,
      "--dangerously-skip-permissions",
    ];

    const child = spawn(this.deps.claudeBin, args, {
      cwd: this.deps.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Lead its own process group (gpid === pid) so we can signal the whole
      // group — claude plus anything it spawns — via a negative pid. Lets us
      // guarantee the session dies with this process (see shutdownSync).
      detached: true,
    });
    this.child = child;

    const log = createWriteStream(this.deps.logFile, { flags: "a" });
    log.write(`\n=== session ${child.pid} started ${new Date().toISOString()} ===\n`);
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    child.on("exit", (code, signal) => {
      log.write(`=== session ${child.pid} exited code=${code} signal=${signal} ===\n`);
      log.end();
      // Only clear if this is still the current child (guard against races).
      if (this.child === child) this.child = null;
      // A natural exit (not a stop-kill) — let the user know the loop ended.
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        void this.deps
          .notify("⚠️ Session ended on its own. Send a message to start a new one.")
          .catch(() => {});
      }
    });

    child.on("error", (err) => {
      log.write(`=== session spawn error: ${String(err)} ===\n`);
      if (this.child === child) this.child = null;
      void this.deps
        .notify(`❌ Failed to start session: ${err.message}`)
        .catch(() => {});
    });
  }

  /** Kill the live session — its whole process group — if any. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.deps.notify("ℹ️ No active session to stop.");
      return;
    }
    this.child = null;
    const pid = child.pid;
    this.killGroup(pid, "SIGTERM");
    // Escalate if the group doesn't die promptly.
    setTimeout(() => this.killGroup(pid, "SIGKILL"), 3000);
    await this.deps.notify("🛑 Session stopped.");
  }

  /**
   * Synchronously SIGKILL the session's process group. Safe to call from a
   * process `exit` handler (no async), so node never leaves an orphaned claude
   * (or its subprocesses) behind on shutdown. No-op if no session is live.
   */
  shutdownSync(): void {
    this.killGroup(this.child?.pid, "SIGKILL");
  }

  /**
   * Send `signal` to the session's process group. The child is spawned
   * `detached`, so it leads its own group; a negative pid targets that whole
   * group (claude + any subprocess it spawned). No-op if the pid is unknown or
   * the group is already gone.
   */
  private killGroup(pid: number | undefined, signal: NodeJS.Signals | 0): void {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Group already gone.
    }
  }
}
