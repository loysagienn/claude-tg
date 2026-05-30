import { Cron } from "croner";
import type {
  Schedule,
  ScheduleInput,
  SchedulePatch,
  ScheduleSpec,
  ScheduleStore,
} from "./scheduleStore.js";
import type { SessionRequest } from "./supervisor.js";

/** Scheduled sessions die after this long with no interaction (see supervisor). */
export const SCHEDULED_INACTIVITY_MS = 30 * 60 * 1000;

export interface SchedulerDeps {
  /** Put a session request on the supervisor's queue. */
  enqueue: (req: SessionRequest) => boolean;
  /** IANA timezone all cron/once times are interpreted in. */
  timezone: string;
}

/** A schedule plus its computed next-run time, returned to listing callers. */
export interface ScheduleView extends Schedule {
  /** ISO datetime of the next firing, or null if it will never fire again. */
  nextRun: string | null;
}

/**
 * Turns persisted {@link Schedule}s into live croner jobs. When a job fires it
 * enqueues a `schedule`-origin session request; a fired `once` schedule then
 * deletes itself from the store. All CRUD goes through here so the live jobs
 * and the persisted store stay in sync.
 *
 * Missed firings (process was down) are not tracked — croner only ever fires on
 * a future tick, so a schedule simply runs at its next eligible time.
 */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private readonly store: ScheduleStore,
    private readonly deps: SchedulerDeps,
  ) {}

  /** Build live jobs for every persisted schedule. Call once at startup. */
  start(): void {
    for (const s of this.store.list()) this.arm(s);
  }

  list(): ScheduleView[] {
    return this.store.list().map((s) => ({
      ...s,
      nextRun: this.jobs.get(s.id)?.nextRun()?.toISOString() ?? null,
    }));
  }

  create(input: ScheduleInput): Schedule {
    this.assertValid(input.schedule);
    const schedule = this.store.create(input);
    this.arm(schedule);
    return schedule;
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    if (patch.schedule) this.assertValid(patch.schedule);
    const updated = this.store.update(id, patch);
    if (updated) this.arm(updated);
    return updated;
  }

  remove(id: string): boolean {
    this.disarm(id);
    return this.store.remove(id);
  }

  /** Enqueue a schedule's session immediately, bypassing its timer. */
  runNow(id: string): { ok: boolean; reason?: string } {
    const s = this.store.get(id);
    if (!s) return { ok: false, reason: "no such schedule" };
    const queued = this.deps.enqueue(this.toRequest(s));
    return queued
      ? { ok: true }
      : { ok: false, reason: "already active or queued" };
  }

  /** Stop and forget the live job for a schedule, if any. */
  private disarm(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  /** (Re)build the live job for a schedule. */
  private arm(s: Schedule): void {
    this.disarm(s.id);
    const fire = () => this.fire(s.id);
    const job =
      s.schedule.kind === "once"
        ? new Cron(
            new Date(s.schedule.at),
            { timezone: this.deps.timezone, maxRuns: 1 },
            fire,
          )
        : new Cron(s.schedule.expr, { timezone: this.deps.timezone }, fire);
    this.jobs.set(s.id, job);
  }

  /** Job callback: enqueue the session; a `once` schedule then self-deletes. */
  private fire(id: string): void {
    const s = this.store.get(id);
    if (!s) return;
    this.deps.enqueue(this.toRequest(s));
    if (s.schedule.kind === "once") this.remove(id);
  }

  private toRequest(s: Schedule): SessionRequest {
    return {
      origin: "schedule",
      prompt: s.prompt,
      scheduleId: s.id,
      name: s.name,
      inactivityMs: SCHEDULED_INACTIVITY_MS,
    };
  }

  /** Throw if a spec is malformed, before it is ever persisted. */
  private assertValid(spec: ScheduleSpec): void {
    if (spec.kind === "once") {
      if (Number.isNaN(Date.parse(spec.at))) {
        throw new Error(`invalid 'at' datetime: ${spec.at}`);
      }
      return;
    }
    // Construct paused so it parses the pattern without scheduling a timer.
    const probe = new Cron(spec.expr, { timezone: this.deps.timezone, paused: true });
    probe.stop();
  }
}
