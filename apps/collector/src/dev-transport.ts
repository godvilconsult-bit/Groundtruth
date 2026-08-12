import type { SyncTransport, TransportOutcome, OutboxItem } from '@groundtruth/collector-core';

/**
 * A stand-in server for running the collector without a backend.
 *
 * Phase 4's HTTP layer replaces this. It exists so the offline behaviour — the part
 * that is hard to get right and easy to get wrong — can be exercised in a browser
 * today, including the failure paths a real server would only produce occasionally.
 *
 * Deliberately NOT a happy-path stub. A transport that always succeeds would make
 * the queue look correct while never exercising release, backoff, or recovery.
 */
export class DevTransport implements SyncTransport {
  /** Flip to simulate airplane mode without touching the OS. */
  online = true;
  /** Fraction of attempts that fail transiently, so backoff is observable. */
  failureRate = 0;
  /** Round-trip delay, so "sending" is a visible state rather than instantaneous. */
  latencyMs = 600;

  readonly delivered = new Set<string>();

  async send(items: readonly OutboxItem[]): Promise<TransportOutcome> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    if (!this.online) return { kind: 'OFFLINE' };

    if (Math.random() < this.failureRate) {
      return { kind: 'TRANSIENT_FAILURE', error: 'simulated HTTP 503' };
    }

    for (const item of items) this.delivered.add(item.id);
    return { kind: 'ACCEPTED', acknowledgedIds: items.map((i) => i.id) };
  }
}
