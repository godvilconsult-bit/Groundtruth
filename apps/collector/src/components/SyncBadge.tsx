import { describeSyncState, type SyncState } from '@groundtruth/collector-core';

/**
 * Persistent sync status.
 *
 * ADR-0002 requires sync state to be visible at all times: a mapper must never have
 * to guess whether a day's walking is safe. So this is never hidden, never collapsed
 * into an icon, and always states a number the mapper can watch reach zero.
 */

export interface SyncBadgeProps {
  readonly state: SyncState;
  readonly locale: 'sw' | 'en';
  readonly now: number;
  readonly onSyncNow?: () => void;
}

function countdown(nextAttemptAt: number | null, now: number, locale: 'sw' | 'en'): string | null {
  if (nextAttemptAt === null || nextAttemptAt <= now) return null;
  const seconds = Math.ceil((nextAttemptAt - now) / 1000);
  const shown = seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
  return locale === 'sw' ? `Itajaribu tena baada ya ${shown}` : `Retrying in ${shown}`;
}

export function SyncBadge({ state, locale, now, onSyncNow }: SyncBadgeProps) {
  const message = describeSyncState(state, locale);
  const waiting = countdown(state.nextAttemptAt, now, locale);
  const clear = state.pendingItems === 0;

  return (
    <div
      class={`sync sync--${state.phase.toLowerCase()}${clear ? ' sync--clear' : ''}`}
      data-testid="sync-badge"
      data-phase={state.phase}
      // polite, not assertive: sync changes constantly and must not interrupt a
      // mapper mid-form to announce something they did not ask about.
      aria-live="polite"
    >
      <span class="sync__message" data-testid="sync-message">
        {message}
      </span>

      {waiting ? (
        <span class="sync__countdown" data-testid="sync-countdown">
          {waiting}
        </span>
      ) : null}

      {/* A manual override exists because the mapper often knows something the
          device does not — that they have just walked into an office with wifi. */}
      {!clear && onSyncNow ? (
        <button type="button" class="sync__now" onClick={onSyncNow} data-testid="sync-now">
          {locale === 'sw' ? 'Tuma sasa' : 'Send now'}
        </button>
      ) : null}
    </div>
  );
}
