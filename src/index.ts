import { InputFile } from "grammy";
import { loadConfig } from "./config.js";
import { ChatStore } from "./chatStore.js";
import { MessageHub } from "./messageHub.js";
import { createBot } from "./bot.js";
import { createMcpServer } from "./mcp.js";
import { createHttpServer } from "./server.js";
import { createUploader } from "./spaces.js";
import { SessionSupervisor } from "./supervisor.js";
import { ScheduleStore } from "./scheduleStore.js";
import { Scheduler } from "./scheduler.js";

const config = loadConfig();

const store = new ChatStore(config.chatIdFile);
store.load();

const hub = new MessageHub();

const supervisor = new SessionSupervisor({
  claudeBin: config.session.claudeBin,
  cwd: config.session.cwd,
  addDir: config.session.addDir,
  logFile: config.session.logFile,
  mcpUrl: `http://${config.host}:${config.port}/mcp`,
  notify: (text) => sendMessage(text),
  resetHub: () => hub.reset(),
});

const scheduleStore = new ScheduleStore(config.schedulesFile);
scheduleStore.load();

const scheduler = new Scheduler(scheduleStore, {
  enqueue: (req) => supervisor.enqueue(req),
  timezone: config.timezone,
});
scheduler.start();

const bot = createBot(config, store, hub, supervisor);

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
    waitForReply: (timeoutMs, signal) => hub.next(timeoutMs, signal),
    drainMessages: () => hub.drain(),
    onActivity: () => supervisor.noteActivity(),
    schedules: {
      list: () => scheduler.list(),
      create: (input) => scheduler.create(input),
      update: (id, patch) => scheduler.update(id, patch),
      remove: (id) => scheduler.remove(id),
      runNow: (id) => scheduler.runNow(id),
    },
  }),
);

app.listen(config.port, config.host, () => {
  console.log(
    `telegram-mcp listening on http://${config.host}:${config.port}/mcp`,
  );
});

// Ensure the spawned claude session never outlives this process: on any exit
// path, SIGKILL its whole process group. SIGINT/SIGTERM route through
// process.exit so the synchronous `exit` handler does the killing; an uncaught
// exception terminates the process and fires `exit` too. (A SIGKILL to *this*
// process cannot be trapped — run node under an OS supervisor to cover that.)
process.on("exit", () => supervisor.shutdownSync());
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

bot
  .start({
    onStart: (info) =>
      console.log(`bot @${info.username} started (long polling)`),
  })
  .catch((err) => {
    console.error("failed to start bot:", err);
  });
