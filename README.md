# telegram-mcp

A single Node process that is both a Telegram bot (grammy) and an MCP server
(Koa, streamable HTTP). It exposes Telegram capabilities to an MCP client such
as Claude Code.

## Tools

| Tool | Description |
| --- | --- |
| `tg_send_message` | Send a text message to the configured user. |
| `tg_send_photo` | Send a photo (local file path or http(s) URL) with an optional caption. Local files are re-hosted on Spaces first, then sent to Telegram by URL. |
| `tg_ask` | Send a question (optionally with an image) and **block until the user replies** or the timeout elapses; returns the reply text. Ideal for captcha solving, confirmations, and decisions mid-task. |
| `tg_get_messages` | Return queued incoming messages from the user; optionally long-poll (`waitSeconds`) for a new one. |

### How incoming messages flow

The bot forwards every message from the registered chat into an in-memory
`MessageHub`. If a tool is currently waiting (`tg_ask`, or `tg_get_messages`
with `waitSeconds`), the message resolves that wait; otherwise it is queued for
the next `tg_get_messages`. Long waits emit MCP progress notifications so
clients don't time the request out.

### Photo handling

Photos given as a **local file path** (via `tg_send_photo` or `tg_ask`) are
uploaded to DigitalOcean Spaces (`telegram/<ts>-<name>`, public-read) and then
sent to Telegram by their public **URL** — Telegram fetches the image itself
rather than receiving a multipart upload. Inputs that are already `http(s)`
URLs pass through unchanged. Spaces credentials come from the env (see
`.env.example`) or `~/.claude/spaces.env`; without them it falls back to a
direct Telegram upload.

## Configuration

Copy `.env.example` to `.env` and fill it in (loaded via Node's built-in
`process.loadEnvFile()`).

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | — | Token from @BotFather. |
| `TELEGRAM_PASSPHRASE` | yes | — | Send this to the bot to register your chat. |
| `PORT` | no | `8765` | MCP HTTP port. |
| `HOST` | no | `127.0.0.1` | Keep on loopback; do not expose. |
| `CHAT_ID_FILE` | no | `chat-id.json` | Where the learned chat id is stored. |

## Registering your chat

The bot does not know where to send messages until you tell it:

1. Start the bot, open a chat with it, send `/start` (stub reply).
2. Send the `TELEGRAM_PASSPHRASE`. The bot stores your chat id in
   `CHAT_ID_FILE` and reloads it on the next start.

`tg_send_message` fails with a clear error until a chat is registered.

## Run

```bash
npm run build
npm start   # reads .env
```

## Register with Claude Code

```bash
claude mcp add --transport http telegram http://127.0.0.1:8765/mcp
```

Tools then appear as `mcp__telegram__tg_send_message`. Restart Claude Code
after changing MCP config.
