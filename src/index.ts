import { InputFile } from "grammy";
import { loadConfig } from "./config.js";
import { ChatStore } from "./chatStore.js";
import { MessageHub } from "./messageHub.js";
import { createBot } from "./bot.js";
import { createMcpServer } from "./mcp.js";
import { createHttpServer } from "./server.js";
import { createUploader } from "./spaces.js";

const config = loadConfig();

const store = new ChatStore(config.chatIdFile);
store.load();

const hub = new MessageHub();
const bot = createBot(config, store, hub);

const uploader = config.spaces ? createUploader(config.spaces) : null;
if (!uploader) {
  console.warn(
    "Spaces not configured — photos will be uploaded to Telegram directly.",
  );
}

const requireChat = (): string => {
  const chatId = store.get();
  if (!chatId) {
    throw new Error(
      "No chat registered yet — send the passphrase to the bot first.",
    );
  }
  return chatId;
};

const sendMessage = async (text: string): Promise<void> => {
  await bot.api.sendMessage(requireChat(), text);
};

const sendPhoto = async (photo: string, caption?: string): Promise<void> => {
  const isUrl = /^https?:\/\//i.test(photo);

  // Rule: local files are re-hosted on Spaces first, then sent to Telegram by
  // URL (Telegram fetches it) rather than as a multipart upload. Remote URLs
  // pass through untouched. Fall back to a direct upload only if Spaces is
  // unconfigured.
  let media: string | InputFile;
  if (isUrl) {
    media = photo;
  } else if (uploader) {
    media = await uploader(photo);
  } else {
    media = new InputFile(photo);
  }

  await bot.api.sendPhoto(requireChat(), media, caption ? { caption } : {});
};

const app = createHttpServer(() =>
  createMcpServer({
    sendMessage,
    sendPhoto,
    waitForReply: (timeoutMs) => hub.next(timeoutMs),
    drainMessages: () => hub.drain(),
  }),
);

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
