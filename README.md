# telegram-mcp

A single Node process that is both a Telegram bot (grammy) and an MCP server
(Koa, streamable HTTP). It plays two roles:

1. **MCP server** — exposes Telegram capabilities (send message/photo, ask &
   wait, read incoming) to an MCP client such as Claude Code.
2. **Session supervisor** — because the process is always running, it can spawn
   a `claude` session *on demand from Telegram* and feed it your messages. The
   spawned session talks back through this same MCP server, so you can drive a
   full Claude Code session from your phone. See
   [Telegram-driven sessions](#telegram-driven-sessions).

## Tools

| Tool | Description |
| --- | --- |
| `tg_send_message` | Send a text message to the configured user. |
| `tg_send_photo` | Send a photo (local file path or http(s) URL) with an optional caption. Local files are re-hosted on Spaces first, then sent to Telegram by URL. |
| `tg_ask` | Send a question (optionally with an image) and **block until the user replies** or the timeout elapses; returns the reply text. Ideal for captcha solving, confirmations, and decisions mid-task. |
| `tg_get_messages` | Return queued incoming messages from the user; optionally long-poll (`waitSeconds`) for a new one. |
| `tg_list_schedules` | List all scheduled sessions with id, name, schedule, next run time, and prompt. |
| `tg_create_schedule` | Create a scheduled session: `kind: "cron"` (recurring) or `kind: "once"` (single run, self-deletes). |
| `tg_update_schedule` | Update a schedule by id (omitted fields unchanged). |
| `tg_delete_schedule` | Delete a schedule by id. |
| `tg_run_schedule_now` | Queue a schedule to run immediately, bypassing its timer. |

### The "OK" stop button

Every `tg_send_message` and `tg_send_photo` is sent with a single inline button
labelled **OK**, and the id of that message is remembered in `BUTTON_ID_FILE`.
The button is a stop affordance: tapping it kills the live session **silently**
(no "🛑 Session stopped." notice) and then removes the button. Only the latest
narration message carries the button — it is stripped from the previous one
before every outgoing message and on every incoming message, so there is at most
one live button at a time. `tg_ask` prompts and status notices are sent without
a button.

### How incoming messages flow

Every message from the registered chat is first offered to the session
supervisor (see below). If the supervisor doesn't consume it, the bot forwards
it into an in-memory `MessageHub`. If a tool is currently waiting (`tg_ask`, or
`tg_get_messages` with `waitSeconds`), the message resolves that wait; otherwise
it is queued for the next `tg_get_messages`. Long waits emit MCP progress
notifications so clients don't time the request out.

## Telegram-driven sessions

The process never exits, so it acts as a supervisor for `claude` sessions you
start and stop from Telegram. **At most one session is alive at a time** (0 or
1). Requests to start a session — a message that arrives while none is running,
or a [schedule](#scheduled-sessions) firing — go onto a FIFO queue; a pump
starts the next queued request whenever no session is active (on enqueue, on
session exit, and at startup). Messages that arrive *while a session is live* are
not queued — they are delivered to that session.

The basic flow for a session you start by messaging the bot:

- **First message** (no live session) → spawn a `claude` child with that text as
  the initial prompt (`-p`), an appended system prompt that tells it to talk
  only through the telegram MCP tools, `--add-dir <SESSION_ADD_DIR>`, and
  `--dangerously-skip-permissions`. The child connects back to this MCP server,
  so its `tg_send_message` / `tg_ask` / `tg_send_photo` calls reach you. The
  appended system prompt also tells the session to **narrate every meaningful
  step** (not just the final result) and to report any error — with its text —
  the moment it happens, so a stall or failure is visible from Telegram alone.
- **Subsequent messages** (session live) → delivered to the running child via
  its pending `tg_get_messages` call. The system prompt instructs the session
  to loop on `tg_get_messages(waitSeconds: 3600)` between tasks, so one process
  stays alive across the whole dialog and never ends its turn on its own.
- **`stop`** (case-insensitive) → the supervisor kills the child (SIGTERM, then
  SIGKILL after 3s). Send any message afterwards to start a fresh session.

If the child exits on its own, you get a Telegram notice and the next message
starts a new session.

### Debugging a session

The child is spawned with `--output-format stream-json --verbose`, so its
`SESSION_LOG_FILE` (default `session.log`) is a full JSONL trace of the session:
every tool call, tool result, assistant message, and error. This is the place to
look when a session goes quiet — the default text output would only emit the
final result, leaving a hung or killed session with nothing logged. Each run is
delimited by `=== session <pid> started … ===` / `… exited code=… signal=… ===`
lines, with the initial `prompt:` recorded right after the start line. Tail it
live with `tail -f session.log`; pipe a run through `jq` to read it.

On top of the log, the MCP tools forward failures to you over Telegram: if a
`tg_send_photo` / `tg_ask` / `tg_get_messages` call throws (bad path, Spaces or
Telegram API error, …) the bot sends you a `❌ <tool> failed: <reason>` notice
and returns the error to the session so it can react rather than stall silently.

The session is spawned as the leader of its own process group, and the
supervisor SIGKILLs that whole group (claude **and** anything it spawned) when
the node process exits — via the `stop` command, a `SIGINT`/`SIGTERM`, or an
uncaught exception. So the session never outlives its supervisor and no orphan
is left behind. The one case this can't cover is a `SIGKILL` to the node
process itself, which the OS delivers untrappably; run node under an OS
supervisor (systemd/pm2) if you need to survive that.

> ⚠️ **Security:** spawned sessions run with `--dangerously-skip-permissions`
> and, by default, `--add-dir /` (full filesystem access) with no per-action
> confirmation. Anyone who knows the passphrase and has the bot can drive them.
> Keep the bot private and narrow `SESSION_ADD_DIR` if you don't need full access.

### Scheduled sessions

Besides messaging the bot, sessions can start **on a schedule** — e.g. "every
morning, read the last 24h of Gmail and send me a digest". Schedules are defined
in a JSON file (`SCHEDULES_FILE`, default `schedules.json`) read at startup, and
managed at runtime through the `tg_*_schedule*` MCP tools, so a running session
can create/edit/delete its own and others' schedules.

When a schedule fires it enqueues a session with the schedule's `prompt` as the
first instruction. Differences from a message-started session:

- **Inactivity timeout.** A scheduled session is killed after **30 minutes with
  no interaction** — interaction being a message you send it or a message it
  sends you (`tg_send_message` / `tg_send_photo` / `tg_ask`). So it does its
  task, reports, and stays available for follow-up for up to 30 min, then dies
  on its own. (Message-started sessions have no timeout — they live until
  `stop`.) `stop` kills whichever session is active, scheduled or not.
- **Announced.** You get a `🕘 Запускаю расписанную сессию: <name>` notice when
  it starts and a `⏰` notice when it dies on the inactivity timeout, so sessions
  never appear or vanish unexplained.
- **De-duplicated.** A schedule won't be queued again if a session for it is
  already active or already waiting in the queue.

Each schedule is `{ id, name, prompt, schedule }` where `schedule` is either:

- `{ "kind": "cron", "expr": "0 9 * * *" }` — recurring, standard 5-field cron
  (`min hour day-of-month month day-of-week`); or
- `{ "kind": "once", "at": "2026-06-01T09:00:00" }` — a single run, **deleted
  from the file after it fires**.

All times are interpreted in **`Asia/Jerusalem`** (hardcoded for now; the agent
is also told this timezone in its system prompt). Missed firings while the
process was down are **not** caught up — a schedule simply runs at its next
eligible time. Edits and one-shot deletions are written back to the file
atomically. The runtime queue itself is in-memory and not persisted across
restarts.

> Scheduled sessions run with the same `--dangerously-skip-permissions` /
> `--add-dir` access as message-started ones — and now start *without* an
> explicit message from you, on a timer. Mind that when writing schedule prompts.

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
| `BUTTON_ID_FILE` | no | `button-id.json` | Where the id of the message bearing the "OK" button is stored. |
| `SCHEDULES_FILE` | no | `schedules.json` | Where scheduled sessions are stored (read at startup). |
| `CLAUDE_BIN` | no | `~/.local/bin/claude` | Path to the `claude` CLI used for spawned sessions. |
| `SESSION_MODEL` | no | `claude-opus-4-8` | Model the spawned session runs on (passed as `--model`). |
| `SESSION_CWD` | no | `~/devbox` | Working directory the spawned session runs in. |
| `SESSION_ADD_DIR` | no | `/` | Directory granted tool access (`/` = full filesystem). |
| `SESSION_LOG_FILE` | no | `~/devbox/telegram-mcp/session.log` | Where the session's stdout/stderr is appended. |

Spaces credentials (`SPACES_*`) are also read here or from `~/.claude/spaces.env`;
see `.env.example`.

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

## Using it from Claude Code

**Do not register this server globally** (`claude mcp add …`). If every session
sees the telegram tools, a manually-started session can call `tg_get_messages`
/ `tg_ask` and steal incoming messages from the live Telegram-driven session —
they share one in-process message queue. Instead the server is scoped to where
it's wanted:

- **Telegram-driven sessions** get it automatically: the supervisor spawns
  `claude` with `--mcp-config '{"mcpServers":{"telegram":{"type":"http","url":"…"}}}'`
  (built from `HOST`/`PORT`). It is *merged* with your other registered servers
  — no `--strict-mcp-config` — so the session still has playwright etc.
- **Manual sessions** never see telegram by default. To opt in explicitly, pass
  the bundled config (it merges with your global servers):

  ```bash
  claude --mcp-config /home/claude/devbox/telegram-mcp/telegram.mcp.json
  ```

  Edit `telegram.mcp.json` if you changed `HOST`/`PORT`.

Tools appear as `mcp__telegram__tg_send_message`. If you previously registered
the server globally, remove it: `claude mcp remove telegram`.

> Caveat: if you run a manual session with telegram enabled *while* a
> Telegram-driven session is live, both compete for the same message queue.
> Avoid overlapping the two.
