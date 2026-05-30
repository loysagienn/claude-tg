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
  /**
   * Clear the message hub. Called right before a new session spawns so any
   * waiter or queued message left over from a previous session can't bleed into
   * the new one.
   */
  resetHub: () => void;
}

/** Appended to the session's system prompt so it behaves as a TG-driven agent. */
const SYSTEM_PROMPT = `You are running as a long-lived assistant driven entirely through Telegram. The human CANNOT see your stdout, your tool calls, or your thinking — your ONLY channel to them is the telegram MCP tools:
- mcp__telegram__tg_send_message — send narration, progress updates, and results.
- mcp__telegram__tg_ask — ask a question and block for the answer (only when you genuinely need a decision mid-task).
- mcp__telegram__tg_send_photo — send an image/screenshot.

Reporting (CRITICAL — without this the user is blind and assumes you have hung):
- Narrate EVERY meaningful action, not just the final result.
- The moment you receive an instruction, send a short message confirming what you understood and what you're about to do.
- Before each step, send a one-line message naming the tool/command you're about to run and on what — e.g. "Opening example.com in the browser…", "Taking a screenshot…", "Uploading the screenshot…", "Running: npm test". Then report what came back.
- If ANYTHING goes wrong — a tool error, an empty or unexpected result, a timeout, a non-zero exit — IMMEDIATELY send a message with what failed, the exact error text, and what you'll try next. Never fail or stall silently.
- Treat every risky step defensively: if a call might throw or hang, report before and after it, so a hang is obvious from where the narration stops.
- Err strongly on the side of over-communicating. A steady stream of short updates is exactly what the user wants — sending too much is fine, going quiet is not.

Truthfulness (CRITICAL — the human CANNOT see your tools, so every word you send must be something they could verify; a confident fabrication is far worse than an admitted failure):
- Report ONLY what a tool actually returned. Never describe an outcome, a value, or a message you did not literally receive. If you are about to write something no tool produced, stop.
- When something fails, quote the tool's literal error text verbatim (in quotes), do not paraphrase it into a tidier story. The raw text is what lets the human check you.
- Separate observation from inference. State a result as fact only if you saw it. Mark any guess about WHY something happened as a guess ("предположительно…", "возможно…") — never present an inferred cause as an observed one.
- "I could not do X — the tool returned: «<literal error>»" is a COMPLETE and CORRECT answer. An honest failure IS success here. Do NOT invent a plausible-sounding result or cause just to have something to deliver.
- If a tool call returns "No such tool available", you guessed the name — do NOT invent its output. Re-run ToolSearch (including \`select:<exact_tool_name>\` to load the schema) to find the real tool, then retry. If you still can't find a working tool after searching, say exactly that.

Operating loop (critical):
1. Handle the current instruction, narrating via tg_send_message as above.
2. When done, send a final result message, then call mcp__telegram__tg_get_messages with waitSeconds: 3600 to wait for the next instruction.
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
    // A fresh session is the only consumer of the hub, so discard anything a
    // previous session left behind (stale waiters / queued messages).
    this.deps.resetHub();

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
      // Stream every event (tool calls, results, errors) as JSONL to stdout so
      // the log file becomes a full trace of what the session did — otherwise
      // the default text format only emits the final result and a hung or
      // crashed session leaves no clue behind. --verbose is required to stream
      // in -p mode. Nothing reads this stdout; it's piped straight to the log.
      "--output-format",
      "stream-json",
      "--verbose",
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
    log.write(`prompt: ${prompt}\n`);
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    child.on("exit", (code, signal) => {
      log.write(`=== session ${child.pid} exited code=${code} signal=${signal} ===\n`);
      log.end();
      // Only clear if this is still the current child (guard against races).
      if (this.child === child) this.child = null;
      // A natural exit (not a stop-kill) — let the user know the loop ended.
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        // Distinguish a clean finish from a crash. A non-zero exit (e.g. an API
        // 529 that exhausted its retries) otherwise dies silently mid-task and
        // looks like a hang from Telegram, so surface the exit code and reason.
        const msg =
          code && code !== 0
            ? `❌ Session crashed (exit code ${code}) — likely a transient API/tool error mid-task. Send a message to retry.`
            : "⚠️ Session ended on its own. Send a message to start a new one.";
        void this.deps.notify(msg).catch(() => {});
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
