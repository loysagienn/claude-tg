import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Persisted list of scheduled sessions. Loaded once at startup and kept in
 * memory; every mutation writes the whole list back to disk atomically
 * (tmp file + rename) so a crash mid-write can't corrupt the file.
 *
 * The in-memory list is the source of truth at runtime — the file is read only
 * at startup. CRUD from the MCP tools and the auto-removal of fired `once`
 * schedules both go through here, so the file always reflects current state.
 */

/** Fire once at an absolute datetime, then delete the schedule. */
export interface OnceSpec {
  kind: "once";
  /** Datetime parseable by `new Date()`; interpreted in the configured tz. */
  at: string;
}

/** Recurring schedule expressed as a 5-field cron pattern. */
export interface CronSpec {
  kind: "cron";
  /** Standard cron pattern: `minute hour day-of-month month day-of-week`. */
  expr: string;
}

export type ScheduleSpec = OnceSpec | CronSpec;

export interface Schedule {
  /** Stable id (uuid), used for dedup, edit, delete, run-now. */
  id: string;
  /** Human-friendly name, shown in notifications and listings. */
  name: string;
  /** The first instruction handed to the spawned session. */
  prompt: string;
  /** When it fires. */
  schedule: ScheduleSpec;
}

/** Fields accepted when creating a schedule (id is generated). */
export type ScheduleInput = Omit<Schedule, "id">;

/** Partial update; `id` selects the target and cannot be changed. */
export type SchedulePatch = Partial<ScheduleInput>;

export class ScheduleStore {
  private schedules: Schedule[] = [];

  constructor(private readonly filePath: string) {}

  /** Read the persisted list. Tolerates a missing/empty/malformed file. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8").trim();
      if (!raw) return;
      const data = JSON.parse(raw) as Schedule[];
      if (Array.isArray(data)) this.schedules = data;
    } catch {
      // Malformed file — start empty rather than crashing.
    }
  }

  list(): Schedule[] {
    return [...this.schedules];
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id);
  }

  create(input: ScheduleInput): Schedule {
    const schedule: Schedule = { id: randomUUID(), ...input };
    this.schedules.push(schedule);
    this.persist();
    return schedule;
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated: Schedule = { ...existing, ...patch, id };
    this.schedules = this.schedules.map((s) => (s.id === id ? updated : s));
    this.persist();
    return updated;
  }

  remove(id: string): boolean {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    if (this.schedules.length === before) return false;
    this.persist();
    return true;
  }

  /** Atomic write: serialize to a tmp file, then rename over the target. */
  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.schedules, null, 2)}\n`);
    renameSync(tmp, this.filePath);
  }
}
