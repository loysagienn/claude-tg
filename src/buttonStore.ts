import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Persists the id of the single Telegram message that currently carries the
 * inline "OK" button. At most one message bears the button at a time: it is set
 * when an outgoing narration message/photo is sent with the button attached, and
 * cleared once the button is removed — which happens before every outgoing
 * message, on every incoming message, and when the button is clicked. Persisted
 * so a restart can still strip a stale button from the last message.
 */
export class ButtonStore {
  private messageId: number | null = null;

  constructor(private readonly filePath: string) {}

  /** Read the persisted message id, if any. Tolerates a missing/empty file. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8").trim();
      if (!raw) return;
      const data = JSON.parse(raw) as { messageId?: number };
      this.messageId =
        typeof data.messageId === "number" ? data.messageId : null;
    } catch {
      // Malformed file — treat as unset rather than crashing.
    }
  }

  get(): number | null {
    return this.messageId;
  }

  /** Remember the id of the message now bearing the button, and persist it. */
  set(messageId: number): void {
    this.messageId = messageId;
    this.persist();
  }

  /** Forget the tracked message (its button has been / will be removed). */
  clear(): void {
    if (this.messageId === null) return;
    this.messageId = null;
    this.persist();
  }

  private persist(): void {
    writeFileSync(
      this.filePath,
      `${JSON.stringify({ messageId: this.messageId }, null, 2)}\n`,
    );
  }
}
