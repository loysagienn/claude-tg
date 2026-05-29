import { homedir } from "node:os";
import { join } from "node:path";

/** DigitalOcean Spaces config used to re-host photos before sending. */
export interface SpacesConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL (bucket-subdomain origin), used to build object URLs. */
  publicBase: string;
}

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
  /** Spaces config, if credentials are available; else null (direct upload). */
  spaces: SpacesConfig | null;
}

/** Load an extra env file into process.env without overriding existing keys. */
function loadEnvFileSoft(path: string): void {
  try {
    const before = { ...process.env };
    process.loadEnvFile(path);
    // Restore any key that already had a value — first loader wins.
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  } catch {
    // Missing/unreadable file — ignore.
  }
}

/** Assemble Spaces config from env, or null if creds are incomplete. */
function loadSpaces(): SpacesConfig | null {
  const region = process.env.SPACES_REGION ?? process.env.SPACES_REGIOIN; // note: typo'd key in source .env
  const bucket = process.env.SPACES_BUCKET_NAME;
  const accessKeyId = process.env.SPACES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SPACES_ACCESS_KEY_SECRET;
  const publicBase = process.env.SPACES_ENDPOINT;

  if (!region || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return null;
  }
  return {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBase: publicBase.replace(/\/+$/, ""),
  };
}

/** Load config from a `.env` file (if present) and the environment. */
export function loadConfig(): Config {
  try {
    // Node built-in: loads ./.env into process.env. No-op deps.
    process.loadEnvFile();
  } catch {
    // No .env file — fall back to the ambient environment.
  }

  // Pull Spaces credentials from the shared persistent file if not already set.
  loadEnvFileSoft(join(homedir(), ".claude", "spaces.env"));

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
    spaces: loadSpaces(),
  };
}
