import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IncomingMessage } from "./messageHub.js";

export interface ToolDeps {
  /** Send a text message to the configured user. */
  sendMessage: (text: string) => Promise<void>;
  /** Send a photo (local file path or http(s) URL) with an optional caption. */
  sendPhoto: (photo: string, caption?: string) => Promise<void>;
  /** Resolve with the next incoming message, or null after timeoutMs. */
  waitForReply: (timeoutMs: number) => Promise<IncomingMessage | null>;
  /** Return and clear all queued incoming messages without waiting. */
  drainMessages: () => IncomingMessage[];
}

const DEFAULT_ASK_TIMEOUT = 120;

/** Minimal shape of the per-request extra we rely on for progress heartbeats. */
type RequestExtra = {
  _meta?: { progressToken?: string | number };
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
      await deps.sendMessage(text);
      return { content: [{ type: "text", text: "Message sent." }] };
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
      await deps.sendPhoto(photo, caption);
      return { content: [{ type: "text", text: "Photo sent." }] };
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
      if (photo) await deps.sendPhoto(photo, question);
      else await deps.sendMessage(question);

      const seconds = timeoutSeconds ?? DEFAULT_ASK_TIMEOUT;
      const reply = await waitWithHeartbeat(extra, seconds * 1000, () =>
        deps.waitForReply(seconds * 1000),
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
      let msgs = deps.drainMessages();

      if (msgs.length === 0 && waitSeconds && waitSeconds > 0) {
        const m = await waitWithHeartbeat(extra, waitSeconds * 1000, () =>
          deps.waitForReply(waitSeconds * 1000),
        );
        if (m) msgs = [m];
      }

      if (msgs.length === 0) {
        return { content: [{ type: "text", text: "(no messages)" }] };
      }
      return { content: [{ type: "text", text: formatMessages(msgs) }] };
    },
  );

  return server;
}
