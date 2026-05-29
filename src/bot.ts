import { Bot } from "grammy";
import type { Config } from "./config.js";
import type { ChatStore } from "./chatStore.js";

/**
 * Create the grammy bot with its update handlers:
 *  - /start          → stub reply
 *  - <passphrase>     → register the sender's chat id (persisted via the store)
 *  - anything else    → ignored
 */
export function createBot(config: Config, store: ChatStore): Bot {
  const bot = new Bot(config.token);

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 telegram-mcp is running.");
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.trim() !== config.passphrase) return;

    const chatId = String(ctx.chat.id);
    store.set(chatId);
    await ctx.reply("✅ Chat registered. You will now receive messages here.");
  });

  bot.catch((err) => {
    console.error("bot error:", err);
  });

  return bot;
}
