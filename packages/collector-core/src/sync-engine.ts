/**
 * The sync engine: outbox + budget + backoff + a transport, driven as one loop.
 *
 * Everything here is a policy decision about a mapper's day, so the policies are
 * stated rather than implied:
 *
 *   - **A rejection is not a deletion.** A 4xx means the server refused this item,
 *     which is a bug, a spec mismatch, or a tampered client — all of which need a
 *     human. The item stays queued and becomes visible through `stuckItems`.
 *   - **Observations outrank media.** Attributes, position and timestamp are the
 *     irreplaceable part and they are small. A photo can wait for wifi; the visit
 *     cannot wait at all.
 *   - **The budget delays bytes, never discards visits.** Running out of budget
 *     stops sending; it never drops anything from the queue.
 *
 * No timers, no clock, no network of its own: `runOnce` is called by whatever
 * scheduler the platform provides, and every input arrives as an argument. That is
 * what makes a six-hour offline day testable in milliseconds.
 */

import { type Outbox, type OutboxItem, type OutboxItemKind } from './outbox.js';
import { type DailyByteBudget } from './byte-budget.js';
import { backoffDelayMs, type SyncPhase, type SyncState } from './backoff.js';

/** What the transport reports back. Mirrors the shapes a real HTTP client produces. */
export type TransportOutcome =
  /** Every item in the batch was accepted and is durable server-side. */
  | { readonly kind: 'ACCEPTED'; readonly acknowledgedIds: readonly string[] }
  /**
   * The server accepted some and refused others by id — a per-item 4xx. Refused
   * items are NOT removed; they are returned to the queue carrying the reason.
   */
  | {
      readonly kind: 'PARTIAL';
      readonly acknowledgedIds: readonly string[];
      readonly rejected: readonly { readonly id: string; readonly reason: string }[];
    }
  /** 5xx, timeout, DNS failure — anything worth retrying unchanged. */
  | { readonly kind: 'TRANSIENT_FAILURE'; readonly error: string }
  /** No usable connection. Not an error; the expected state for most of a shift. */
  | { readonly kind: 'OFFLINE' };

export interface SyncTransport {
  /**
   * Send one chunk. Implementations must be safe to retry: the server deduplicates
   * on the client-generated ids these items carry (ADR-0002).
   */
  send(items: readonly OutboxItem[]): Promise<TransportOutcome>;
}

export interface ConnectionInfo {
  readonly online: boolean;
  /** Mobile data. Media is deferred unless the user overrides. */
  readonly metered: boolean;
}

export interface SyncEngineOptions {
  readonly outbox: Outbox;
  readonly budget: DailyByteBudget;
  readonly transport: SyncTransport;
  /** Injected so retry spread can be tested rather than trusted. */
  readonly random?: () => number;
  /** Send media over metered connections anyway. User-facing override. */
  readonly allowMeteredMedia?: boolean;
  /** Below this battery fraction, only observations sync. */
  readonly batteryFloorForMedia?: number;
}

export interface RunContext {
  readonly now: Date;
  readonly connection: ConnectionInfo;
  /** 0–1, or null where the platform will not say. */
  readonly batteryLevel?: number | null;
}

export interface RunResult {
  readonly sent: number;
  readonly acknowledged: number;
  readonly rejected: number;
  readonly bytesSent: number;
  readonly outcome: TransportOutcome['kind'] | 'NOTHING_TO_DO' | 'BUDGET_EXHAUSTED';
  readonly state: SyncState;
}

const DEFAULT_BATTERY_FLOOR = 0.15;

export class SyncEngine {
  readonly #outbox: Outbox;
  readonly #budget: DailyByteBudget;
  readonly #transport: SyncTransport;
  readonly #random: () => number;
  readonly #allowMeteredMedia: boolean;
  readonly #batteryFloor: number;

  #consecutiveFailures = 0;
  #lastSuccessAt: number | null = null;
  #nextAttemptAt: number | null = null;
  #lastError: string | null = null;
  #recovered = false;

  constructor(options: SyncEngineOptions) {
    this.#outbox = options.outbox;
    this.#budget = options.budget;
    this.#transport = options.transport;
    this.#random = options.random ?? Math.random;
    this.#allowMeteredMedia = options.allowMeteredMedia ?? false;
    this.#batteryFloor = options.batteryFloorForMedia ?? DEFAULT_BATTERY_FLOOR;
  }

  /**
   * Which kinds may be sent right now.
   *
   * Observations always. Media only on an unmetered connection with battery above
   * the floor, unless overridden — because media is ~98% of the bytes and most of
   * the radio time, and neither the mapper's airtime nor their remaining battery
   * should be spent on a photo when the visit itself is still unsent.
   */
  #sendableKinds(context: RunContext): OutboxItemKind[] {
    const kinds: OutboxItemKind[] = ['OBSERVATION', 'RETRACTION'];

    const battery = context.batteryLevel ?? null;
    const batteryOk = battery === null || battery >= this.#batteryFloor;
    const connectionOk = !context.connection.metered || this.#allowMeteredMedia;

    if (batteryOk && connectionOk) kinds.push('MEDIA');
    return kinds;
  }

  async state(context: RunContext): Promise<SyncState> {
    const stats = await this.#outbox.stats();
    let phase: SyncPhase = 'IDLE';
    if (!context.connection.online) phase = 'OFFLINE';
    else if (stats.pending > 0 && this.#nextAttemptAt !== null) phase = 'WAITING';
    else if (stats.inFlight > 0) phase = 'SYNCING';

    return Object.freeze({
      phase,
      pendingItems: stats.pending + stats.inFlight,
      pendingBytes: stats.bytes,
      lastSuccessAt: this.#lastSuccessAt,
      consecutiveFailures: this.#consecutiveFailures,
      nextAttemptAt: this.#nextAttemptAt,
      lastError: this.#lastError,
    });
  }

  /** True when the backoff window has not yet elapsed. */
  #inBackoff(now: Date): boolean {
    return this.#nextAttemptAt !== null && now.getTime() < this.#nextAttemptAt;
  }

  async #result(
    outcome: RunResult['outcome'],
    context: RunContext,
    partial: Partial<RunResult> = {},
  ): Promise<RunResult> {
    return {
      sent: 0,
      acknowledged: 0,
      rejected: 0,
      bytesSent: 0,
      ...partial,
      outcome,
      state: await this.state(context),
    };
  }

  /**
   * One sync attempt. Safe to call as often as the platform likes: it returns
   * immediately while in backoff, offline, or with nothing to do.
   */
  async runOnce(context: RunContext): Promise<RunResult> {
    // Rescue anything an OS kill left mid-flight. Once per engine lifetime, on the
    // first run — before this, a killed sync would strand its batch permanently.
    if (!this.#recovered) {
      await this.#outbox.recoverStranded();
      this.#recovered = true;
    }

    if (!context.connection.online) {
      return this.#result('OFFLINE', context);
    }
    if (this.#inBackoff(context.now)) {
      return this.#result('NOTHING_TO_DO', context);
    }

    const remaining = this.#budget.remainingBytes(context.now);
    if (remaining <= 0) {
      // Out of budget: stop sending. Nothing is dropped — the queue simply waits for
      // tomorrow, or for the user to raise the limit.
      return this.#result('BUDGET_EXHAUSTED', context);
    }

    const claimed = await this.#outbox.claimBatch({
      maxBytes: Math.min(remaining, 64 * 1024),
      kinds: this.#sendableKinds(context),
    });

    if (claimed.length === 0) {
      return this.#result('NOTHING_TO_DO', context);
    }

    const bytes = claimed.reduce((sum, i) => sum + i.byteSize, 0);
    const ids = claimed.map((i) => i.id);

    let outcome: TransportOutcome;
    try {
      outcome = await this.#transport.send(claimed);
    } catch (error) {
      // A transport that throws is treated as transient. Losing the batch here would
      // be the worst possible interpretation of an unexpected error.
      outcome = {
        kind: 'TRANSIENT_FAILURE',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    switch (outcome.kind) {
      case 'ACCEPTED': {
        const acknowledged = await this.#outbox.acknowledge(outcome.acknowledgedIds);
        // Anything the server did not name stays queued, even on an ACCEPTED reply.
        const unacknowledged = ids.filter((id) => !outcome.acknowledgedIds.includes(id));
        if (unacknowledged.length > 0) {
          await this.#outbox.release(unacknowledged, 'not acknowledged by server');
        }
        this.#budget.record(bytes, context.now);
        this.#onSuccess(context.now);
        return this.#result('ACCEPTED', context, {
          sent: claimed.length,
          acknowledged,
          bytesSent: bytes,
        });
      }

      case 'PARTIAL': {
        const acknowledged = await this.#outbox.acknowledge(outcome.acknowledgedIds);
        for (const rejection of outcome.rejected) {
          // Requeued, not deleted. Repeated rejection surfaces via stuckItems, where
          // a human can see a spec mismatch or a server bug rather than a gap.
          await this.#outbox.release([rejection.id], rejection.reason);
        }
        const untouched = ids.filter(
          (id) =>
            !outcome.acknowledgedIds.includes(id) &&
            !outcome.rejected.some((r) => r.id === id),
        );
        if (untouched.length > 0) {
          await this.#outbox.release(untouched, 'not acknowledged by server');
        }
        this.#budget.record(bytes, context.now);
        this.#onSuccess(context.now);
        return this.#result('PARTIAL', context, {
          sent: claimed.length,
          acknowledged,
          rejected: outcome.rejected.length,
          bytesSent: bytes,
        });
      }

      case 'OFFLINE': {
        // Connectivity vanished mid-request. Not a failure worth counting toward
        // backoff — the radio, not the server, is the problem.
        await this.#outbox.release(ids, 'offline');
        return this.#result('OFFLINE', context, { sent: claimed.length });
      }

      case 'TRANSIENT_FAILURE':
      default: {
        await this.#outbox.release(ids, outcome.error);
        this.#onFailure(context.now, outcome.error);
        return this.#result('TRANSIENT_FAILURE', context, { sent: claimed.length });
      }
    }
  }

  #onSuccess(now: Date): void {
    this.#consecutiveFailures = 0;
    this.#nextAttemptAt = null;
    this.#lastError = null;
    this.#lastSuccessAt = now.getTime();
  }

  #onFailure(now: Date, error: string): void {
    const delay = backoffDelayMs(this.#consecutiveFailures, this.#random);
    this.#consecutiveFailures += 1;
    this.#nextAttemptAt = now.getTime() + delay;
    this.#lastError = error;
  }

  /** Clear the backoff window — for a user-initiated "sync now". */
  requestImmediateAttempt(): void {
    this.#nextAttemptAt = null;
  }
}
