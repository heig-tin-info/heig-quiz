/**
 * The teacher assistant's prepared writes (ADR-080, P3 amendment, decision
 * 7): a write the model asked for, its arguments FROZEN, waiting for the
 * teacher's Confirm. Kept IN MEMORY, keyed by the teacher and the
 * conversation, for ten minutes, and taken once: a confirmed, cancelled or
 * expired write is gone. A deploy or a restart forgets them all — the
 * teacher simply asks again; nothing was written.
 */
import { ASSIST_PENDING_TTL_MS, type AssistWriteTool } from "@quiz/domain";

export interface PendingWrite {
  userId: string;
  conversationId: string;
  tool: AssistWriteTool;
  /** The tool's arguments as its schema parsed them: what runs, exactly, on Confirm. */
  args: Readonly<Record<string, unknown>>;
  expiresAt: Date;
}

export class PendingWrites {
  private readonly writes = new Map<string, PendingWrite>();

  /** Stores a write under `id`; the expired ones are dropped on the way. */
  put(id: string, write: PendingWrite, now: Date): void {
    for (const [key, w] of this.writes) if (w.expiresAt <= now) this.writes.delete(key);
    this.writes.set(id, { ...write, args: Object.freeze(structuredClone(write.args)) });
  }

  /**
   * The write `id` of this teacher and conversation, REMOVED — or null when
   * there is none: never prepared, already confirmed or cancelled, expired,
   * or another teacher's or another conversation's (left untouched, then:
   * nobody else may spend it).
   */
  take(id: string, owner: { userId: string; conversationId: string }, now: Date): PendingWrite | null {
    const write = this.writes.get(id);
    if (!write || write.userId !== owner.userId || write.conversationId !== owner.conversationId) return null;
    this.writes.delete(id);
    return write.expiresAt > now ? write : null;
  }

  /** The expiry of a write prepared `now`. */
  static expiry(now: Date): Date {
    return new Date(now.getTime() + ASSIST_PENDING_TTL_MS);
  }
}
