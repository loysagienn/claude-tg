import { Bot } from "grammy";
import type { Config } from "./config.js";
import type { ChatStore } from "./chatStore.js";
import type { MessageHub } from "./messageHub.js";

/**
 * Create the grammy bot with its update handlers:
 *  - /start          → stub reply
 *  - <passphrase>     → register the sender's chat id (persisted via the store)
 *  - any other text from the registered chat → forwarded into the MessageHub
 *    so MCP tools (tg_ask / tg_get_messages) can read it
 *  - anything else    → ignored
 */
export function createBot(
  config: Config,
  store: ChatStore,
  hub: MessageHub,
): Bot {
  const bot = new Bot(config.token);

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 telegram-mcp is running.");
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

    hub.push({ id: ctx.message.message_id, date: ctx.message.date, text });
  });

  // A reply that is only a photo (with optional caption) still carries useful
  // info — forward the caption (or a placeholder) so tg_ask can resolve.
  bot.on("message:photo", async (ctx) => {
    if (String(ctx.chat.id) !== store.get()) return;
    hub.push({
      id: ctx.message.message_id,
      date: ctx.message.date,
      text: ctx.message.caption ?? "[photo]",
    });
  });

  bot.catch((err) => {
    console.error("bot error:", err);
  });

  return bot;
}
