import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Persists the single chat id we talk to. Learned at runtime when the user
 * sends the passphrase, then reloaded from disk on the next start.
 */
export class ChatStore {
  private chatId: string | null = null;

  constructor(private readonly filePath: string) {}

  /** Read the persisted chat id, if any. Tolerates a missing/empty file. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8").trim();
      if (!raw) return;
      const data = JSON.parse(raw) as { chatId?: string };
      this.chatId = data.chatId ?? null;
    } catch {
      // Malformed file — treat as unset rather than crashing.
    }
  }

  get(): string | null {
    return this.chatId;
  }

  /** Remember a chat id and persist it to disk. */
  set(chatId: string): void {
    this.chatId = chatId;
    writeFileSync(this.filePath, `${JSON.stringify({ chatId }, null, 2)}\n`);
  }
}
