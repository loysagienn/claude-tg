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
  /** File where the id of the message currently bearing the OK button lives. */
  buttonIdFile: string;
  /** File where the list of scheduled sessions is persisted. */
  schedulesFile: string;
  /** Directory incoming media (photos/files the user sends) is saved into. */
  downloadDir: string;
  /** IANA timezone all schedule times are interpreted in (and told to agents). */
  timezone: string;
  /** Spaces config, if credentials are available; else null (direct upload). */
  spaces: SpacesConfig | null;
  /** Telegram-driven Claude Code session settings. */
  session: SessionConfig;
}

/** Settings for the auto-spawned Claude Code session. */
export interface SessionConfig {
  /** Path to the `claude` CLI binary. */
  claudeBin: string;
  /** Path to the `codex` CLI binary (sessions started via /agent → codex). */
  codexBin: string;
  /** Model the spawned session runs on (passed as `--model`). */
  model: string;
  /** Working directory the session runs in. */
  cwd: string;
  /** Extra directory granted tool access ("/" = full access). */
  addDir: string;
  /** File the session's stdout/stderr is appended to. */
  logFile: string;
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
  const region = process.env.SPACES_REGION;
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
    buttonIdFile: process.env.BUTTON_ID_FILE ?? "button-id.json",
    schedulesFile: process.env.SCHEDULES_FILE ?? "schedules.json",
    // Incoming media is transient — keep it in ~/artifacts (disposable, may be
    // auto-cleaned) rather than in a project directory.
    downloadDir:
      process.env.DOWNLOAD_DIR ?? join(homedir(), "artifacts", "claude-tg"),
    // Hardcoded for now — all cron/once times are interpreted in this zone.
    timezone: "Asia/Jerusalem",
    spaces: loadSpaces(),
    session: {
      claudeBin:
        process.env.CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude"),
      // Symlinked next to claude (target lives under nvm and moves with node
      // versions; the symlink is the stable path).
      codexBin:
        process.env.CODEX_BIN ?? join(homedir(), ".local", "bin", "codex"),
      // Pin a model so bot sessions don't drift with the global `claude`
      // default; override via SESSION_MODEL if needed.
      model: process.env.SESSION_MODEL ?? "claude-fable-5",
      cwd: process.env.SESSION_CWD ?? join(homedir(), "devbox"),
      addDir: process.env.SESSION_ADD_DIR ?? "/",
      logFile:
        process.env.SESSION_LOG_FILE ?? join(homedir(), "devbox", "claude-tg", "session.log"),
    },
  };
}
