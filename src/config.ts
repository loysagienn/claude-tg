export interface Config {
  /** Telegram bot token from @BotFather. */
  token: string;
  /** Secret phrase; whoever sends it to the bot gets registered as the chat. */
  passphrase: string;
  /** Port the MCP HTTP endpoint listens on. */
  port: number;
  /** Host to bind to. Defaults to loopback — the endpoint must not be public. */
  host: string;
  /** File where the learned chat id is persisted. */
  chatIdFile: string;
}

/** Load config from a `.env` file (if present) and the environment. */
export function loadConfig(): Config {
  try {
    // Node built-in: loads ./.env into process.env. No-op deps.
    process.loadEnvFile();
  } catch {
    // No .env file — fall back to the ambient environment.
  }

  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const passphrase = process.env.TELEGRAM_PASSPHRASE ?? "";

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!passphrase) throw new Error("TELEGRAM_PASSPHRASE is not set");

  return {
    token,
    passphrase,
    port: Number(process.env.PORT ?? 8765),
    host: process.env.HOST ?? "127.0.0.1",
    chatIdFile: process.env.CHAT_ID_FILE ?? "chat-id.json",
  };
}
