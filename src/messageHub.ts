/**
 * In-memory bridge between the bot (which receives Telegram messages
 * asynchronously) and the MCP tools (which read them on demand).
 *
 * Single process, single user, so a plain queue + waiter set is enough:
 *  - The bot calls `push()` for every incoming message from the registered chat.
 *  - If a tool is currently waiting (e.g. `tg_ask`), the message resolves the
 *    oldest waiter. Otherwise it is queued for the next `tg_get_messages`.
 *
 * Waiters MUST be cleaned up on every exit path — timeout, client disconnect
 * (AbortSignal), or a session reset — otherwise a dead waiter lingers and
 * `push()` hands it the next message, which then never reaches the live
 * consumer. (That zombie-waiter bug stranded messages across session restarts:
 * a killed session's pending `tg_get_messages` left a waiter behind that ate the
 * next session's messages.)
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
  /** Settle the pending next() call and tear down its timer/abort listener. */
  settle: (msg: IncomingMessage | null) => void;
}

export class MessageHub {
  private queue: IncomingMessage[] = [];
  // Insertion-ordered, so the first entry is the oldest waiter. A Set gives
  // O(1) removal from any position (needed for abort/timeout cleanup).
  private waiters = new Set<Waiter>();

  /** Called by the bot for each incoming message from the registered chat. */
  push(msg: IncomingMessage): void {
    const waiter = this.waiters.values().next().value as Waiter | undefined;
    if (waiter) {
      waiter.settle(msg);
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
   * If `signal` aborts (the MCP request's connection dropped), the waiter is
   * removed and the call resolves null so no zombie waiter is left behind.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<IncomingMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        settle: (msg) => {
          // Idempotent teardown: a waiter is only ever settled once, but push,
          // the timer, and abort can race — whichever wins removes it.
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.waiters.delete(waiter);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => waiter.settle(null), timeoutMs);
      const onAbort = () => waiter.settle(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /**
   * Drop all queued messages and resolve every waiter with null. Called when a
   * new session spawns: the previous session was the only consumer, so any
   * leftover waiter is a zombie that would otherwise steal the new session's
   * first incoming message.
   */
  reset(): void {
    this.queue = [];
    for (const waiter of [...this.waiters]) waiter.settle(null);
  }
}
