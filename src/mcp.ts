import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IncomingMessage } from "./messageHub.js";
import type {
  Schedule,
  ScheduleInput,
  SchedulePatch,
} from "./scheduleStore.js";
import type { ScheduleView } from "./scheduler.js";

/** Manage the persisted list of scheduled sessions (backed by the Scheduler). */
export interface ScheduleApi {
  list: () => ScheduleView[];
  create: (input: ScheduleInput) => Schedule;
  update: (id: string, patch: SchedulePatch) => Schedule | null;
  remove: (id: string) => boolean;
  runNow: (id: string) => { ok: boolean; reason?: string };
}

export interface ToolDeps {
  /**
   * Send a text message to the configured user. `withButton` attaches the
   * inline "OK" (stop-session) button — set only for tg_send_message, not for
   * status notices or tg_ask prompts.
   */
  sendMessage: (
    text: string,
    opts?: { withButton?: boolean },
  ) => Promise<void>;
  /**
   * Send a photo (local file path or http(s) URL) with an optional caption.
   * `withButton` attaches the inline "OK" button — set only for tg_send_photo.
   */
  sendPhoto: (
    photo: string,
    caption?: string,
    opts?: { withButton?: boolean },
  ) => Promise<void>;
  /**
   * Resolve with the next incoming message, or null after timeoutMs. The
   * AbortSignal (from the MCP request) lets the wait be torn down if the client
   * disconnects, so no zombie waiter is left behind.
   */
  waitForReply: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<IncomingMessage | null>;
  /** Return and clear all queued incoming messages without waiting. */
  drainMessages: () => IncomingMessage[];
  /**
   * Register interaction with the live session (resets its inactivity timeout).
   * Called when the session sends a message to the user; incoming user messages
   * ping it separately via the bot.
   */
  onActivity: () => void;
  /** CRUD over scheduled sessions, exposed as MCP tools. */
  schedules: ScheduleApi;
}

const DEFAULT_ASK_TIMEOUT = 120;

/** Minimal shape of the per-request extra we rely on for progress heartbeats. */
type RequestExtra = {
  _meta?: { progressToken?: string | number };
  /** Aborts when the underlying MCP request/connection is cancelled. */
  signal?: AbortSignal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's
  // ServerNotification union is bivariant-unfriendly; we only ever pass a valid
  // progress notification below.
  sendNotification?: (n: any) => Promise<void>;
};

/**
 * While waiting for a human reply (potentially minutes), emit periodic progress
 * notifications. MCP clients reset their request timeout on progress, so this
 * keeps long `tg_ask` calls from being cancelled client-side. Best-effort: a
 * no-op if the client didn't supply a progressToken.
 */
async function waitWithHeartbeat<T>(
  extra: RequestExtra | undefined,
  waitMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const progressToken = extra?._meta?.progressToken;
  let interval: ReturnType<typeof setInterval> | undefined;

  if (progressToken !== undefined && extra?.sendNotification) {
    let progress = 0;
    interval = setInterval(() => {
      void extra
        .sendNotification!({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: (progress += 1),
            message: "waiting for your Telegram reply…",
          },
        })
        .catch(() => {});
    }, 20_000);
  }

  try {
    return await run();
  } finally {
    if (interval) clearInterval(interval);
  }
}

function formatMessages(msgs: IncomingMessage[]): string {
  return msgs
    .map((m) => `[${new Date(m.date * 1000).toISOString()}] ${m.text}`)
    .join("\n");
}

/** MCP tool result shape for the two states a handler can return. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Report a tool failure on both channels: push a notice to the user over
 * Telegram (best-effort — swallowed if that very channel is what broke) so an
 * error never goes unseen, and return an MCP error result so the session also
 * knows the call failed and can react / narrate it.
 *
 * `notifyUser` is false only for tg_send_message itself, where re-sending over
 * the broken channel would just fail again.
 */
async function toolFailure(
  deps: ToolDeps,
  where: string,
  err: unknown,
  notifyUser = true,
): Promise<ToolResult> {
  const detail = err instanceof Error ? err.message : String(err);
  const text = `❌ ${where} failed: ${detail}`;
  if (notifyUser) {
    try {
      await deps.sendMessage(text);
    } catch {
      // The Telegram channel itself is down — nothing more we can do here.
    }
  }
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build a fresh MCP server with the Telegram tools registered.
 *
 * In stateless streamable-HTTP mode a new server instance is created per
 * request, so this is a factory rather than a singleton. The deps it closes
 * over (bot api + message hub) are process-wide singletons.
 */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "telegram-mcp", version: "0.2.0" });

  server.registerTool(
    "tg_send_message",
    {
      title: "Send Telegram message",
      description: "Send a text message to the configured user via Telegram.",
      inputSchema: {
        text: z.string().min(1).describe("The message text to send"),
      },
    },
    async ({ text }) => {
      try {
        await deps.sendMessage(text, { withButton: true });
        deps.onActivity();
        return { content: [{ type: "text", text: "Message sent." }] };
      } catch (err) {
        // Can't report over Telegram — that's the channel that just failed.
        return toolFailure(deps, "tg_send_message", err, false);
      }
    },
  );

  server.registerTool(
    "tg_send_photo",
    {
      title: "Send Telegram photo",
      description:
        "Send a photo to the configured user via Telegram. Accepts a local " +
        "file path or an http(s) URL, with an optional caption.",
      inputSchema: {
        photo: z
          .string()
          .min(1)
          .describe("Local file path or http(s) URL of the image"),
        caption: z.string().optional().describe("Optional caption text"),
      },
    },
    async ({ photo, caption }) => {
      try {
        await deps.sendPhoto(photo, caption, { withButton: true });
        deps.onActivity();
        return { content: [{ type: "text", text: "Photo sent." }] };
      } catch (err) {
        return toolFailure(deps, "tg_send_photo", err);
      }
    },
  );

  server.registerTool(
    "tg_ask",
    {
      title: "Ask the user via Telegram and wait for a reply",
      description:
        "Send a question to the user via Telegram and BLOCK until they reply " +
        "(or the timeout elapses), then return their reply text. Optionally " +
        "attach an image (local path or URL) — e.g. a screenshot of a captcha " +
        "you need solved. Use this whenever you need input, a decision, or a " +
        "confirmation from the user mid-task.",
      inputSchema: {
        question: z.string().min(1).describe("The question / prompt to send"),
        photo: z
          .string()
          .optional()
          .describe(
            "Optional image to attach: local file path or http(s) URL " +
              "(e.g. a captcha screenshot)",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe(
            `Seconds to wait for a reply before giving up (default ${DEFAULT_ASK_TIMEOUT})`,
          ),
      },
    },
    async ({ question, photo, timeoutSeconds }, extra) => {
      try {
        if (photo) await deps.sendPhoto(photo, question);
        else await deps.sendMessage(question);
        deps.onActivity();

        const seconds = timeoutSeconds ?? DEFAULT_ASK_TIMEOUT;
        const reply = await waitWithHeartbeat(extra, seconds * 1000, () =>
          deps.waitForReply(seconds * 1000, extra?.signal),
        );

        if (!reply) {
          return {
            content: [
              {
                type: "text",
                text: `No reply received within ${seconds}s.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: reply.text }] };
      } catch (err) {
        return toolFailure(deps, "tg_ask", err);
      }
    },
  );

  server.registerTool(
    "tg_get_messages",
    {
      title: "Get incoming Telegram messages",
      description:
        "Return messages the user has sent to the bot that haven't been " +
        "consumed yet. If none are queued and waitSeconds > 0, wait up to that " +
        "long for a new message to arrive.",
      inputSchema: {
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe(
            "If no messages are queued, wait up to this many seconds for one " +
              "(default 0 — return immediately)",
          ),
      },
    },
    async ({ waitSeconds }, extra) => {
      try {
        let msgs = deps.drainMessages();

        if (msgs.length === 0 && waitSeconds && waitSeconds > 0) {
          const m = await waitWithHeartbeat(extra, waitSeconds * 1000, () =>
            deps.waitForReply(waitSeconds * 1000, extra?.signal),
          );
          if (m) msgs = [m];
        }

        if (msgs.length === 0) {
          return { content: [{ type: "text", text: "(no messages)" }] };
        }
        return { content: [{ type: "text", text: formatMessages(msgs) }] };
      } catch (err) {
        return toolFailure(deps, "tg_get_messages", err);
      }
    },
  );

  registerScheduleTools(server, deps);

  return server;
}

/** Render one schedule (with its next-run time) as a compact text block. */
function formatSchedule(s: ScheduleView): string {
  const when =
    s.schedule.kind === "cron"
      ? `cron "${s.schedule.expr}"`
      : `once at ${s.schedule.at}`;
  const next = s.nextRun ? s.nextRun : "never (won't fire again)";
  return `• ${s.name} [${s.id}]\n    ${when} (tz Asia/Jerusalem) — next: ${next}\n    prompt: ${s.prompt}`;
}

/**
 * Build a ScheduleSpec from the flat tool inputs, validating that the field
 * matching `kind` is present. Throws a clear error otherwise.
 */
function buildSpec(
  kind: "cron" | "once",
  cron: string | undefined,
  at: string | undefined,
): ScheduleInput["schedule"] {
  if (kind === "cron") {
    if (!cron) throw new Error("`cron` is required when kind is \"cron\"");
    return { kind: "cron", expr: cron };
  }
  if (!at) throw new Error("`at` is required when kind is \"once\"");
  return { kind: "once", at };
}

/** Register the schedule-management tools (list / create / update / delete / run). */
function registerScheduleTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "tg_list_schedules",
    {
      title: "List scheduled sessions",
      description:
        "List all scheduled Claude sessions with their id, name, schedule, " +
        "next run time (Asia/Jerusalem), and prompt.",
      inputSchema: {},
    },
    async () => {
      try {
        const list = deps.schedules.list();
        const text = list.length
          ? list.map(formatSchedule).join("\n\n")
          : "(no scheduled sessions)";
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolFailure(deps, "tg_list_schedules", err);
      }
    },
  );

  server.registerTool(
    "tg_create_schedule",
    {
      title: "Create a scheduled session",
      description:
        "Create a scheduled Claude session. It starts automatically at the " +
        "given time with `prompt` as its first instruction, runs as a " +
        "Telegram-driven session, and dies after 30 min of no interaction. " +
        'Use kind="cron" for a recurring schedule (5-field cron pattern, ' +
        'interpreted in Asia/Jerusalem) or kind="once" for a single run at an ' +
        "absolute datetime (deleted after it fires).",
      inputSchema: {
        name: z.string().min(1).describe("Human-friendly name for the schedule"),
        prompt: z
          .string()
          .min(1)
          .describe("First instruction handed to the spawned session"),
        kind: z
          .enum(["cron", "once"])
          .describe('"cron" for recurring, "once" for a single run'),
        cron: z
          .string()
          .optional()
          .describe(
            'Cron pattern "min hour day-of-month month day-of-week" ' +
              '(e.g. "0 9 * * *" = 09:00 daily). Required when kind="cron".',
          ),
        at: z
          .string()
          .optional()
          .describe(
            'Datetime for a one-shot run, e.g. "2026-06-01T09:00:00". ' +
              'Interpreted in Asia/Jerusalem. Required when kind="once".',
          ),
      },
    },
    async ({ name, prompt, kind, cron, at }) => {
      try {
        const schedule = deps.schedules.create({
          name,
          prompt,
          schedule: buildSpec(kind, cron, at),
        });
        return {
          content: [
            { type: "text", text: `Created schedule "${name}" [${schedule.id}].` },
          ],
        };
      } catch (err) {
        return toolFailure(deps, "tg_create_schedule", err);
      }
    },
  );

  server.registerTool(
    "tg_update_schedule",
    {
      title: "Update a scheduled session",
      description:
        "Update fields of an existing scheduled session by id. Omitted fields " +
        "are left unchanged. To change the schedule, pass `kind` plus its " +
        "matching field (`cron` or `at`).",
      inputSchema: {
        id: z.string().min(1).describe("Id of the schedule to update"),
        name: z.string().min(1).optional().describe("New name"),
        prompt: z.string().min(1).optional().describe("New prompt"),
        kind: z
          .enum(["cron", "once"])
          .optional()
          .describe("New schedule kind (pass with `cron` or `at`)"),
        cron: z.string().optional().describe('New cron pattern (with kind="cron")'),
        at: z.string().optional().describe('New one-shot datetime (with kind="once")'),
      },
    },
    async ({ id, name, prompt, kind, cron, at }) => {
      try {
        const patch: SchedulePatch = {};
        if (name !== undefined) patch.name = name;
        if (prompt !== undefined) patch.prompt = prompt;
        if (kind !== undefined) patch.schedule = buildSpec(kind, cron, at);

        const updated = deps.schedules.update(id, patch);
        if (!updated) {
          return {
            content: [{ type: "text", text: `No schedule with id ${id}.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Updated schedule [${id}].` }] };
      } catch (err) {
        return toolFailure(deps, "tg_update_schedule", err);
      }
    },
  );

  server.registerTool(
    "tg_delete_schedule",
    {
      title: "Delete a scheduled session",
      description: "Delete a scheduled session by id.",
      inputSchema: {
        id: z.string().min(1).describe("Id of the schedule to delete"),
      },
    },
    async ({ id }) => {
      try {
        const ok = deps.schedules.remove(id);
        return {
          content: [
            {
              type: "text",
              text: ok ? `Deleted schedule [${id}].` : `No schedule with id ${id}.`,
            },
          ],
          isError: !ok,
        };
      } catch (err) {
        return toolFailure(deps, "tg_delete_schedule", err);
      }
    },
  );

  server.registerTool(
    "tg_run_schedule_now",
    {
      title: "Run a scheduled session now",
      description:
        "Trigger a scheduled session immediately, bypassing its timer. It is " +
        "queued and starts as soon as no other session is active. Recurring " +
        "schedules keep their normal timetable; this is an extra ad-hoc run.",
      inputSchema: {
        id: z.string().min(1).describe("Id of the schedule to run now"),
      },
    },
    async ({ id }) => {
      try {
        const res = deps.schedules.runNow(id);
        return {
          content: [
            {
              type: "text",
              text: res.ok
                ? `Queued schedule [${id}] to run now.`
                : `Did not queue [${id}]: ${res.reason}.`,
            },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return toolFailure(deps, "tg_run_schedule_now", err);
      }
    },
  );
}
