/**
 * Who is connected right now (F-DASH-03, PLAN-MVP §5.3 step 5).
 *
 * Presence is a property of the OPEN CONNECTIONS, not of the database: it
 * changes several times a minute per student and would be pure write
 * amplification on a table. It therefore lives in memory, in this module,
 * and `attempts.present_at` keeps the durable "last sign of life" that
 * survives a restart.
 *
 * The consequence is explicit and accepted: with `WORKER_MODE` split across
 * processes, each web process knows its own connections. The MVP runs one
 * process (ADR-001, ADR-009).
 */

export interface PresenceRecord {
  userId: string;
  lastSeenAt: Date;
  /** Open SSE connections of that user on that evaluation. */
  connections: number;
  online: boolean;
}

export interface PresenceChange {
  evaluationId: string;
  userId: string;
  online: boolean;
  lastSeenAt: Date;
}

export class PresenceMap {
  private readonly rooms = new Map<string, Map<string, PresenceRecord>>();

  private room(evaluationId: string): Map<string, PresenceRecord> {
    let room = this.rooms.get(evaluationId);
    if (!room) {
      room = new Map();
      this.rooms.set(evaluationId, room);
    }
    return room;
  }

  /** A connection opened. Returns a change only when the user WAS offline. */
  join(evaluationId: string, userId: string, now: Date): PresenceChange | null {
    const room = this.room(evaluationId);
    const record = room.get(userId);
    if (!record) {
      room.set(userId, { userId, lastSeenAt: now, connections: 1, online: true });
      return { evaluationId, userId, online: true, lastSeenAt: now };
    }
    record.connections += 1;
    record.lastSeenAt = now;
    if (record.online) return null;
    record.online = true;
    return { evaluationId, userId, online: true, lastSeenAt: now };
  }

  /** A connection closed. The user goes offline when the last one is gone. */
  leave(evaluationId: string, userId: string, now: Date): PresenceChange | null {
    const room = this.rooms.get(evaluationId);
    const record = room?.get(userId);
    if (!room || !record) return null;
    record.connections = Math.max(0, record.connections - 1);
    record.lastSeenAt = now;
    if (record.connections > 0 || !record.online) return null;
    record.online = false;
    return { evaluationId, userId, online: false, lastSeenAt: now };
  }

  /** A heartbeat on an open connection (a clock frame went out). */
  touch(evaluationId: string, userId: string, now: Date): void {
    const record = this.rooms.get(evaluationId)?.get(userId);
    if (record) record.lastSeenAt = now;
  }

  /**
   * Marks silent users offline (PLAN-MVP §5.3: 45 s). A connection that is
   * still open but has stopped being written to is not a presence.
   */
  sweep(now: Date, idleMs: number): PresenceChange[] {
    const changes: PresenceChange[] = [];
    for (const [evaluationId, room] of this.rooms) {
      for (const record of room.values()) {
        if (!record.online) continue;
        if (now.getTime() - record.lastSeenAt.getTime() < idleMs) continue;
        record.online = false;
        changes.push({
          evaluationId,
          userId: record.userId,
          online: false,
          lastSeenAt: record.lastSeenAt,
        });
      }
    }
    return changes;
  }

  online(evaluationId: string): Set<string> {
    const room = this.rooms.get(evaluationId);
    if (!room) return new Set();
    const out = new Set<string>();
    for (const record of room.values()) if (record.online) out.add(record.userId);
    return out;
  }

  /** How many DISTINCT users are connected — the lobby counter (F-LIVE-02). */
  count(evaluationId: string): number {
    return this.online(evaluationId).size;
  }

  lastSeenAt(evaluationId: string, userId: string): Date | null {
    return this.rooms.get(evaluationId)?.get(userId)?.lastSeenAt ?? null;
  }

  /** The evaluations that currently hold at least one record. */
  watchedEvaluations(): string[] {
    return [...this.rooms.keys()];
  }

  reset(): void {
    this.rooms.clear();
  }
}

/** One map per process; the SSE routes and the ticker share it. */
export const presence = new PresenceMap();
