import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Config } from "./config.js";
import type { ChatStore } from "./chatStore.js";
import type { MessageHub } from "./messageHub.js";
import type { AgentKind, SessionSupervisor } from "./supervisor.js";
import { downloadTelegramFile } from "./download.js";

/**
 * Initial instruction for a session started via the /agent buttons: unlike a
 * message-started session there is no user text yet, so the agent just greets
 * and drops into the normal wait-for-messages loop.
 */
const AGENT_START_PROMPT =
  "Пользователь запустил эту сессию вручную командой /agent, выбрав тебя как агента. " +
  "Конкретной задачи пока нет. Отправь короткое приветствие через tg_send_message " +
  "(одна строка: какой ты агент и что готов к работе) и жди инструкций через tg_get_messages.";

/**
 * Create the grammy bot with its update handlers:
 *  - /start          → stub reply
 *  - <passphrase>     → register the sender's chat id (persisted via the store)
 *  - any other text from the registered chat → offered to the supervisor first
 *    (which may start/stop a Claude session — `/stop` kills the live one); if
 *    it declines, forwarded into the MessageHub so the live session's MCP
 *    tools (tg_ask / tg_get_messages) read it
 *  - a photo / document from the registered chat → downloaded to the configured
 *    download dir, then routed exactly like text with the saved path inlined
 *    ("[photo saved: <path>] <caption>"), so media can both start a session and
 *    reach a live one
 *  - anything else    → ignored
 */
export function createBot(
  config: Config,
  store: ChatStore,
  hub: MessageHub,
  supervisor: SessionSupervisor,
): Bot {
  const bot = new Bot(config.token);

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 claude-tg is running.");
  });

  // /agent → pick which CLI agent to start a session with. The only way to
  // start a codex session; plain messages keep starting claude ones.
  bot.command("agent", async (ctx) => {
    if (String(ctx.chat.id) !== store.get()) return;
    await ctx.reply("Каким агентом запустить сессию?", {
      reply_markup: new InlineKeyboard()
        .text("claude", "agent:claude")
        .text("codex", "agent:codex"),
    });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // Registration: whoever sends the passphrase becomes the target chat.
    if (text.trim() === config.passphrase) {
      store.set(String(ctx.chat.id));
      await ctx.reply("✅ Chat registered. You will now receive messages here.");
      return;
    }

    // Only accept messages from the registered chat; ignore strangers.
    if (String(ctx.chat.id) !== store.get()) return;

    // The supervisor may start a new session (no session live → queued) or stop
    // one (`/stop`). If it consumes the message, don't also queue it for the
    // hub.
    const consumed = await supervisor.handle(text);
    if (consumed) return;

    // A session is live: this message is interaction with it (resets the
    // inactivity timeout) and is delivered via the hub.
    supervisor.noteActivity();
    hub.push({ id: ctx.message.message_id, date: ctx.message.date, text });
  });

  // Incoming media: download it locally and route the saved path like a text
  // message — through the supervisor first (so a photo/file can start a
  // session), else into the hub for the live session. The session agent has
  // filesystem access, so the path is all it needs to read the content.
  const handleMedia = async (
    ctx: Context & { message: NonNullable<Context["message"]> },
    kind: "photo" | "file",
    fileId: string,
    preferredName?: string,
  ): Promise<void> => {
    if (String(ctx.chat?.id) !== store.get()) return;

    const caption = ctx.message.caption;
    let text: string;
    try {
      const path = await downloadTelegramFile(
        ctx.api,
        config.token,
        fileId,
        config.downloadDir,
        preferredName,
      );
      text = `[${kind} saved: ${path}]${caption ? ` ${caption}` : ""}`;
    } catch (err) {
      // Downloads can fail (e.g. Bot API's 20 MB limit) — still deliver the
      // caption plus the error so the session can react instead of stalling.
      const detail = err instanceof Error ? err.message : String(err);
      text = `[${kind} received, but saving it failed: ${detail}]${caption ? ` ${caption}` : ""}`;
    }

    const consumed = await supervisor.handle(text);
    if (consumed) return;
    supervisor.noteActivity();
    hub.push({ id: ctx.message.message_id, date: ctx.message.date, text });
  };

  bot.on("message:photo", async (ctx) => {
    // Sizes are ordered small → large; take the largest rendition.
    const sizes = ctx.message.photo;
    await handleMedia(ctx, "photo", sizes[sizes.length - 1].file_id);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    await handleMedia(ctx, "file", doc.file_id, doc.file_name);
  });

  // Inline button taps:
  //  - "claude"/"codex" (agent:<kind>, from /agent) → start a session of that
  //    agent, editing the picker message so the choice can't be re-used.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    // Always answer to clear the client's loading spinner.
    if (String(ctx.chat?.id) !== store.get()) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === "agent:claude" || data === "agent:codex") {
      const agent: AgentKind = data === "agent:codex" ? "codex" : "claude";
      // Mirror the message flow: a live session owns the dialog, so don't
      // queue a second one behind it — that would fire unexpectedly later.
      if (supervisor.isActive()) {
        await ctx.answerCallbackQuery({
          text: "Сессия уже активна — сначала останови её (/stop).",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      // Replace the picker so the buttons disappear and the choice is visible.
      await ctx.editMessageText(`🚀 Запускаю сессию агента ${agent}…`);
      supervisor.enqueue({
        origin: "telegram",
        agent,
        prompt: AGENT_START_PROMPT,
      });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.catch((err) => {
    console.error("bot error:", err);
  });

  return bot;
}
