import { loadConfig } from "./config.js";
import { ChatStore } from "./chatStore.js";
import { createBot } from "./bot.js";
import { createMcpServer } from "./mcp.js";
import { createHttpServer } from "./server.js";

const config = loadConfig();

const store = new ChatStore(config.chatIdFile);
store.load();

const bot = createBot(config, store);

const sendMessage = async (text: string): Promise<void> => {
  const chatId = store.get();
  if (!chatId) {
    throw new Error(
      "No chat registered yet — send the passphrase to the bot first.",
    );
  }
  await bot.api.sendMessage(chatId, text);
};

const app = createHttpServer(() => createMcpServer({ sendMessage }));

app.listen(config.port, config.host, () => {
  console.log(
    `telegram-mcp listening on http://${config.host}:${config.port}/mcp`,
  );
});

bot
  .start({
    onStart: (info) =>
      console.log(`bot @${info.username} started (long polling)`),
  })
  .catch((err) => {
    console.error("failed to start bot:", err);
  });
