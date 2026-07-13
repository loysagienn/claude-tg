import { InputFile, InlineKeyboard } from "grammy";
import { loadConfig } from "./config.js";
import { ChatStore } from "./chatStore.js";
import { ButtonStore } from "./buttonStore.js";
import { MessageHub } from "./messageHub.js";
import { createBot } from "./bot.js";
import { createMcpServer } from "./mcp.js";
import { createHttpServer } from "./server.js";
import { createUploader } from "./spaces.js";
import { SessionSupervisor } from "./supervisor.js";
import { ScheduleStore } from "./scheduleStore.js";
import { Scheduler } from "./scheduler.js";
import {
  formatTelegramMarkdown,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from "./telegramFormat.js";

const config = loadConfig();

const store = new ChatStore(config.chatIdFile);
store.load();

const buttonStore = new ButtonStore(config.buttonIdFile);
buttonStore.load();

const hub = new MessageHub();

const supervisor = new SessionSupervisor({
  claudeBin: config.session.claudeBin,
  codexBin: config.session.codexBin,
  model: config.session.model,
  cwd: config.session.cwd,
  addDir: config.session.addDir,
  logFile: config.session.logFile,
  mcpUrl: `http://${config.host}:${config.port}/mcp`,
  timezone: config.timezone,
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

// Single-button inline keyboard attached to narration messages (tg_send_message
// / tg_send_photo). Clicking it stops the live session — handled in the bot's
// callback handler. The callback_data is what that handler matches on.
const okKeyboard = new InlineKeyboard().text("OK", "stop_session");

// Remove the inline button from the message that currently carries it, if any.
// Called before sending any new message and on every incoming message / button
// click, so at most one (the latest) narration message ever shows the button.
const clearButton = async (): Promise<void> => {
  const messageId = buttonStore.get();
  if (messageId === null) return;
  // Drop the tracked id first so a failed/duplicate edit can't loop or re-edit.
  buttonStore.clear();
  const chatId = store.get();
  if (!chatId) return;
  try {
    await bot.api.editMessageReplyMarkup(chatId, messageId);
  } catch {
    // The message is gone or already has no markup — nothing to do.
  }
};

const sendMessage = async (
  text: string,
  opts: { withButton?: boolean } = {},
): Promise<void> => {
  // Always strip any prior button before sending the next message.
  await clearButton();
  const chunks = formatTelegramMarkdown(text, TELEGRAM_MESSAGE_LIMIT);
  if (chunks.length === 0) throw new Error("message is empty after formatting");
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const message = await bot.api.sendMessage(requireChat(), chunk, {
      parse_mode: "HTML",
      ...(opts.withButton && isLast ? { reply_markup: okKeyboard } : {}),
    });
    if (opts.withButton && isLast) buttonStore.set(message.message_id);
  }
};

const sendPhoto = async (
  photo: string,
  caption?: string,
  opts: { withButton?: boolean } = {},
): Promise<void> => {
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

  const captionChunks = caption
    ? formatTelegramMarkdown(caption, TELEGRAM_CAPTION_LIMIT)
    : [];
  const [firstCaption, ...overflow] = captionChunks;

  await clearButton();
  const message = await bot.api.sendPhoto(requireChat(), media, {
    ...(firstCaption ? { caption: firstCaption, parse_mode: "HTML" as const } : {}),
    ...(opts.withButton && overflow.length === 0
      ? { reply_markup: okKeyboard }
      : {}),
  });
  if (opts.withButton && overflow.length === 0) {
    buttonStore.set(message.message_id);
  }
  for (const [index, chunk] of overflow.entries()) {
    const isLast = index === overflow.length - 1;
    const sent = await bot.api.sendMessage(requireChat(), chunk, {
      parse_mode: "HTML",
      ...(opts.withButton && isLast ? { reply_markup: okKeyboard } : {}),
    });
    if (opts.withButton && isLast) buttonStore.set(sent.message_id);
  }
};

const sendDocument = async (
  file: string,
  caption?: string,
  opts: { withButton?: boolean } = {},
): Promise<void> => {
  const isUrl = /^https?:\/\//i.test(file);

  // Unlike photos, documents are NOT re-hosted on Spaces: a direct multipart
  // upload (up to 50 MB) preserves the original filename, which is the point
  // of sending a file. Remote URLs pass through for Telegram to fetch.
  const media = isUrl ? file : new InputFile(file);

  const captionChunks = caption
    ? formatTelegramMarkdown(caption, TELEGRAM_CAPTION_LIMIT)
    : [];
  const [firstCaption, ...overflow] = captionChunks;

  await clearButton();
  const message = await bot.api.sendDocument(requireChat(), media, {
    ...(firstCaption ? { caption: firstCaption, parse_mode: "HTML" as const } : {}),
    ...(opts.withButton && overflow.length === 0
      ? { reply_markup: okKeyboard }
      : {}),
  });
  if (opts.withButton && overflow.length === 0) {
    buttonStore.set(message.message_id);
  }
  for (const [index, chunk] of overflow.entries()) {
    const isLast = index === overflow.length - 1;
    const sent = await bot.api.sendMessage(requireChat(), chunk, {
      parse_mode: "HTML",
      ...(opts.withButton && isLast ? { reply_markup: okKeyboard } : {}),
    });
    if (opts.withButton && isLast) buttonStore.set(sent.message_id);
  }
};

const bot = createBot(config, store, hub, supervisor, clearButton);

const app = createHttpServer(() =>
  createMcpServer({
    sendMessage,
    sendPhoto,
    sendDocument,
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
    `claude-tg listening on http://${config.host}:${config.port}/mcp`,
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

// Populate Telegram's command menu (best-effort; the handlers work regardless).
void bot.api
  .setMyCommands([
    { command: "agent", description: "Выбрать агента (claude/codex) и запустить сессию" },
  ])
  .catch((err) => console.warn("setMyCommands failed:", err));

bot
  .start({
    onStart: (info) =>
      console.log(`bot @${info.username} started (long polling)`),
  })
  .catch((err) => {
    console.error("failed to start bot:", err);
  });
