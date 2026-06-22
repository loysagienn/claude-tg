import { Bot } from "grammy";
import type { Config } from "./config.js";
import type { ChatStore } from "./chatStore.js";
import type { MessageHub } from "./messageHub.js";
import type { SessionSupervisor } from "./supervisor.js";

/**
 * Create the grammy bot with its update handlers:
 *  - /start          → stub reply
 *  - <passphrase>     → register the sender's chat id (persisted via the store)
 *  - any other text from the registered chat → offered to the supervisor first
 *    (which may start/stop a Claude session); if it declines, forwarded into the
 *    MessageHub so the live session's MCP tools (tg_ask / tg_get_messages) read it
 *  - a click on the inline "OK" button → stop the live session (silently) and
 *    remove the button
 *  - anything else    → ignored
 *
 * `clearButton` removes the inline "OK" button from whichever message currently
 * carries it. It is called on every incoming message (per spec) and after a
 * button click.
 */
export function createBot(
  config: Config,
  store: ChatStore,
  hub: MessageHub,
  supervisor: SessionSupervisor,
  clearButton: () => Promise<void>,
): Bot {
  const bot = new Bot(config.token);

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 claude-tg is running.");
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

    // Any incoming message from the user retires the pending "OK" button.
    await clearButton();

    // The supervisor may start a new session (no session live → queued) or stop
    // one (`stop`). If it consumes the message, don't also queue it for the hub.
    const consumed = await supervisor.handle(text);
    if (consumed) return;

    // A session is live: this message is interaction with it (resets the
    // inactivity timeout) and is delivered via the hub.
    supervisor.noteActivity();
    hub.push({ id: ctx.message.message_id, date: ctx.message.date, text });
  });

  // A reply that is only a photo (with optional caption) still carries useful
  // info — forward the caption (or a placeholder) so tg_ask can resolve. Only
  // meaningful while a session is live (a fresh session would clear the hub),
  // so ignore photos sent with no active session.
  bot.on("message:photo", async (ctx) => {
    if (String(ctx.chat.id) !== store.get()) return;
    // Any incoming message retires the pending "OK" button, even with no
    // active session (the button may be left over from a previous one).
    await clearButton();
    if (!supervisor.isActive()) return;
    supervisor.noteActivity();
    hub.push({
      id: ctx.message.message_id,
      date: ctx.message.date,
      text: ctx.message.caption ?? "[photo]",
    });
  });

  // A tap on the inline "OK" button stops the live session. Per spec this path
  // is silent — no "session stopped" notice — and the button is removed after.
  bot.on("callback_query:data", async (ctx) => {
    // Always answer to clear the client's loading spinner.
    if (
      ctx.callbackQuery.data !== "stop_session" ||
      String(ctx.chat?.id) !== store.get()
    ) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await supervisor.stop({ silent: true });
    await clearButton();
  });

  bot.catch((err) => {
    console.error("bot error:", err);
  });

  return bot;
}
