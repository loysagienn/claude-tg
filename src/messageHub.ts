/**
 * In-memory bridge between the bot (which receives Telegram messages
 * asynchronously) and the MCP tools (which read them on demand).
 *
 * Single process, single user, so a plain queue + waiter list is enough:
 *  - The bot calls `push()` for every incoming message from the registered chat.
 *  - If a tool is currently waiting (e.g. `tg_ask`), the message resolves the
 *    oldest waiter. Otherwise it is queued for the next `tg_get_messages`.
 */
export interface IncomingMessage {
  /** Telegram message_id. */
  id: number;
  /** Unix timestamp in seconds (Telegram's message.date). */
  date: number;
  /** Message text (or photo caption). */
  text: string;
}

interface Waiter {
  resolve: (msg: IncomingMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MessageHub {
  private queue: IncomingMessage[] = [];
  private waiters: Waiter[] = [];

  /** Called by the bot for each incoming message from the registered chat. */
  push(msg: IncomingMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Return and clear everything queued so far, without waiting. */
  drain(): IncomingMessage[] {
    const msgs = this.queue;
    this.queue = [];
    return msgs;
  }

  /**
   * Resolve with the next message. If one is already queued it returns
   * immediately; otherwise it waits up to `timeoutMs` and then resolves null.
   */
  next(timeoutMs: number): Promise<IncomingMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}
