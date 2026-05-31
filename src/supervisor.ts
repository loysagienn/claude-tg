import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * Owns the lifecycle of Telegram-driven Claude Code sessions, enforcing the
 * invariant that **at most one** session is alive at a time (0 or 1).
 *
 * Requests to start a session come from two sources:
 *  - a Telegram message that arrives while no session is active (origin
 *    `telegram`) — these sessions live forever, until the user sends `stop`;
 *  - a schedule firing (origin `schedule`) — these additionally die after
 *    {@link SessionRequest.inactivityMs} of no interaction.
 *
 * Both go onto a FIFO {@link queue}. The pump starts the next queued request
 * whenever no session is active; it runs on enqueue, on child exit, and at
 * startup. Messages that arrive while a session IS active are not queued — the
 * bot forwards them to the live session via the MessageHub. `stop` kills the
 * active session only and leaves the queue untouched.
 */
export interface SessionRequest {
  /** Where the request came from. Decides forever-vs-timeout behaviour. */
  origin: "telegram" | "schedule";
  /** First instruction handed to the spawned session. */
  prompt: string;
  /** Source schedule id, for dedup and logging (schedule-origin only). */
  scheduleId?: string;
  /** Schedule name, used in the "starting" notification. */
  name?: string;
  /** Inactivity timeout in ms; if set, the session dies after this idle gap. */
  inactivityMs?: number;
}

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
  /**
   * IANA timezone the session runs in (set as TZ in its env). Must match the
   * zone the scheduler interprets `at`/cron times in, so the agent's own clock
   * (`date`, `Date.now()`) agrees with how the schedule it creates will fire.
   */
  timezone: string;
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

The user's timezone is Asia/Jerusalem. Interpret any time the user mentions, and report any time back to them, in that timezone.

Reporting (CRITICAL — without this the user is blind and assumes you have hung):
- CRITICAL: text you write OUTSIDE a tool call is NOT delivered — the human only ever sees the argument of a tg_send_message / tg_ask / tg_send_photo call. Your final/turn-ending prose goes to a log they cannot read. Every result, confirmation, and narration MUST be the argument of one of those tool calls. In particular, after any tg_*_schedule call, send the confirmation via tg_send_message — do not merely state it before looping on tg_get_messages.
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

Scheduling (you can act in the future, not only now):
- You have telegram MCP tools to schedule sessions: tg_create_schedule, tg_list_schedules, tg_update_schedule, tg_delete_schedule, tg_run_schedule_now.
- Whenever the user asks for anything time-based — a reminder, "in N minutes/hours", "every morning", "every Monday", "on the 1st", a one-off at a specific date/time — DO NOT just wait or claim you cannot. Create a schedule: kind "once" with an absolute datetime for a single future action, or kind "cron" (5-field pattern) for a recurring one. All times are Asia/Jerusalem.
- A one-shot deletes itself after firing. After creating a schedule, confirm to the user what you set and when (in Asia/Jerusalem).
- Use tg_list_schedules / tg_update_schedule / tg_delete_schedule when the user wants to see, change, or cancel existing reminders.

Operating loop (critical):
1. Handle the current instruction, narrating via tg_send_message as above.
2. When done, send a final result message, then call mcp__telegram__tg_get_messages with waitSeconds: 3600 to wait for the next instruction.
3. If it returns no message (timeout), call it again. Repeat forever — never end your turn on your own.

A supervisor terminates your process when the user sends "stop", so you do not need to handle "stop" yourself. Just keep looping on tg_get_messages between tasks. (A scheduled session is additionally terminated after a period of no interaction — that is expected and not an error.)`;

export class SessionSupervisor {
  private child: ChildProcess | null = null;
  /** The request that spawned the live child, if any. */
  private active: SessionRequest | null = null;
  /** Pending session requests, started one at a time by the pump. */
  private queue: SessionRequest[] = [];
  /** Why we last killed the child, so the exit handler reports correctly. */
  private killReason: "stop" | "timeout" | null = null;
  /** Inactivity timer for a schedule-origin session; cleared on every exit. */
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

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

    // No live session → this message starts a new (forever) one via the queue.
    if (!this.child) {
      this.enqueue({ origin: "telegram", prompt: text });
      return true;
    }

    // A session is live — let the hub deliver this to its tg_get_messages.
    return false;
  }

  /**
   * Add a session request to the queue and try to start it. Schedule-origin
   * requests are de-duplicated: if a session for the same schedule is already
   * active or already queued, the request is dropped and `false` is returned.
   */
  enqueue(req: SessionRequest): boolean {
    if (req.scheduleId) {
      if (this.active?.scheduleId === req.scheduleId) return false;
      if (this.queue.some((q) => q.scheduleId === req.scheduleId)) return false;
    }
    this.queue.push(req);
    this.pump();
    return true;
  }

  /**
   * Register interaction with the live session, resetting its inactivity timer.
   * Called for messages routed to the session and for outgoing messages it
   * sends. No-op unless a schedule-origin session with a timeout is active.
   */
  noteActivity(): void {
    if (this.child && this.active?.inactivityMs) this.armInactivity();
  }

  /** Start the next queued request if nothing is currently running. */
  private pump(): void {
    if (this.child) return;
    const req = this.queue.shift();
    if (req) this.start(req);
  }

  /** Spawn a new `claude` session for `req`. */
  private start(req: SessionRequest): void {
    // A fresh session is the only consumer of the hub, so discard anything a
    // previous session left behind (stale waiters / queued messages).
    this.deps.resetHub();
    this.active = req;
    this.killReason = null;

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
      req.prompt,
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
      // Pin the child's clock to the configured zone so its `date`/`Date` agree
      // with how croner interprets the `at`/cron times it sets — otherwise it
      // reads UTC, labels it as Asia/Jerusalem, and schedules hours off.
      env: { ...process.env, TZ: this.deps.timezone },
      stdio: ["ignore", "pipe", "pipe"],
      // Lead its own process group (gpid === pid) so we can signal the whole
      // group — claude plus anything it spawns — via a negative pid. Lets us
      // guarantee the session dies with this process (see shutdownSync).
      detached: true,
    });
    this.child = child;

    const log = createWriteStream(this.deps.logFile, { flags: "a" });
    const tag = req.origin === "schedule" ? ` schedule=${req.scheduleId}` : "";
    log.write(`\n=== session ${child.pid} started ${new Date().toISOString()} origin=${req.origin}${tag} ===\n`);
    log.write(`prompt: ${req.prompt}\n`);
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    // Announce auto-started (scheduled) sessions so they don't appear out of
    // nowhere; user-started ones need no announcement.
    if (req.origin === "schedule") {
      void this.deps
        .notify(`🕘 Запускаю расписанную сессию: ${req.name ?? req.scheduleId}`)
        .catch(() => {});
    }

    // Arm the inactivity timeout for schedule-origin sessions.
    this.armInactivity();

    child.on("exit", (code, signal) => {
      log.write(`=== session ${child.pid} exited code=${code} signal=${signal} ===\n`);
      log.end();
      const reason = this.killReason;
      // Only clear if this is still the current child (guard against races).
      if (this.child === child) {
        this.child = null;
        this.active = null;
        this.killReason = null;
        this.clearInactivity();
      }
      this.notifyExit(reason, code);
      // A slot freed up — start whatever is next in the queue.
      this.pump();
    });

    child.on("error", (err) => {
      log.write(`=== session spawn error: ${String(err)} ===\n`);
      if (this.child === child) {
        this.child = null;
        this.active = null;
        this.killReason = null;
        this.clearInactivity();
      }
      void this.deps
        .notify(`❌ Failed to start session: ${err.message}`)
        .catch(() => {});
      this.pump();
    });
  }

  /** Tell the user why the session ended, unless we already did (stop). */
  private notifyExit(reason: "stop" | "timeout" | null, code: number | null): void {
    if (reason === "stop") {
      // stop() already sent "🛑 Session stopped."
      return;
    }
    if (reason === "timeout") {
      void this.deps
        .notify("⏰ Сессия завершена (30 мин бездействия). Отправьте сообщение, чтобы начать новую.")
        .catch(() => {});
      return;
    }
    // Natural exit. Distinguish a clean finish from a crash: a non-zero exit
    // (e.g. an API 529 that exhausted its retries) otherwise dies silently
    // mid-task and looks like a hang from Telegram, so surface the exit code.
    const msg =
      code && code !== 0
        ? `❌ Session crashed (exit code ${code}) — likely a transient API/tool error mid-task. Send a message to retry.`
        : "⚠️ Session ended on its own. Send a message to start a new one.";
    void this.deps.notify(msg).catch(() => {});
  }

  /**
   * Kill the live session — its whole process group — if any. `silent` (used by
   * the "OK" button) suppresses both the "🛑 Session stopped." notice and the
   * "no active session" notice; the exit handler stays quiet either way because
   * the kill reason is "stop".
   */
  async stop(opts: { silent?: boolean } = {}): Promise<void> {
    if (!this.child) {
      if (!opts.silent) await this.deps.notify("ℹ️ No active session to stop.");
      return;
    }
    this.killReason = "stop";
    const pid = this.child.pid;
    this.killGroup(pid, "SIGTERM");
    // Escalate if the group doesn't die promptly.
    setTimeout(() => this.killGroup(pid, "SIGKILL"), 3000);
    if (!opts.silent) await this.deps.notify("🛑 Session stopped.");
  }

  /**
   * (Re)arm the inactivity timer for the active session. No-op unless the
   * active request carries an `inactivityMs`. When it fires, the session's
   * whole process group is killed (the exit handler then notifies the user).
   */
  private armInactivity(): void {
    this.clearInactivity();
    const ms = this.active?.inactivityMs;
    if (!ms || !this.child) return;
    this.inactivityTimer = setTimeout(() => {
      const pid = this.child?.pid;
      if (pid === undefined) return;
      this.killReason = "timeout";
      this.killGroup(pid, "SIGTERM");
      setTimeout(() => this.killGroup(pid, "SIGKILL"), 3000);
    }, ms);
  }

  private clearInactivity(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
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
