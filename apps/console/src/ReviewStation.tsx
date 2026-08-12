import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  decisionForKey,
  REVIEW_KEYS,
  REVIEW_REASON,
  type ReviewDecisionKind,
  type ReviewReason,
} from '@groundtruth/qa';

/**
 * The review station.
 *
 * The Phase 3 target is 100 observations per hour — 36 seconds each — and that
 * number drives every decision here. Every verdict is one keystroke, the next item
 * is already rendered, and nothing requires the mouse. A confirmation dialog on the
 * common path would cost more than the whole time budget.
 *
 * The corresponding risk is that a keyboard-driven queue makes rubber-stamping
 * effortless. Two counterweights: the station measures time-on-item so decisions
 * below the rubber-stamp threshold are countable, and the one verdict with real
 * consequences for a person — suspected fabrication — is deliberately NOT bound to
 * a key and requires typed justification.
 */

export interface QueueItem {
  readonly observationId: string;
  readonly featureClass: string;
  readonly collectorId: string;
  readonly submittedAt: string;
  readonly gpsAccuracyM: number;
  readonly reasonCodes: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly mediaRefs: readonly string[];
  readonly selectedForResurvey: boolean;
}

export interface ReviewStationProps {
  readonly items: readonly QueueItem[];
  readonly onDecide: (decision: {
    observationId: string;
    decision: ReviewDecisionKind;
    reason: ReviewReason;
    notes: string | null;
    durationMs: number;
  }) => void;
  /** Injected so elapsed time is testable rather than wall-clock dependent. */
  readonly now?: () => number;
}

export function ReviewStation({ items, onDecide, now = () => Date.now() }: ReviewStationProps) {
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState('');
  const [needsNotes, setNeedsNotes] = useState(false);
  const startedAt = useRef<number>(now());
  const notesRef = useRef<HTMLTextAreaElement | null>(null);

  const item = items[index];

  // Reset the timer whenever the item changes: elapsed time must measure attention
  // on THIS observation, not since the session began.
  useEffect(() => {
    startedAt.current = now();
    setNotes('');
    setNeedsNotes(false);
  }, [item?.observationId, now]);

  const submit = useCallback(
    (decision: ReviewDecisionKind, reason: ReviewReason, withNotes: string | null) => {
      if (!item) return;
      onDecide({
        observationId: item.observationId,
        decision,
        reason,
        notes: withNotes,
        durationMs: Math.max(0, now() - startedAt.current),
      });
      setIndex((i) => i + 1);
    },
    [item, onDecide, now],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!item) return;
      // Never hijack keys while the reviewer is typing a justification.
      if (needsNotes) {
        if (event.key === 'Escape') setNeedsNotes(false);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Fabrication is deliberately not a hotkey: it affects someone's livelihood,
      // so it is reached through a control and requires typed justification.
      if (event.key === 'F' && event.shiftKey) {
        event.preventDefault();
        setNeedsNotes(true);
        queueMicrotask(() => notesRef.current?.focus());
        return;
      }

      const binding = decisionForKey(event.key);
      if (!binding) return;
      event.preventDefault();
      submit(binding.decision, binding.reason, null);
    },
    [item, needsNotes, submit],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  if (!item) {
    return (
      <section class="station station--empty" data-testid="queue-empty">
        <h2>Queue clear</h2>
        <p>No observations are waiting for review.</p>
      </section>
    );
  }

  return (
    <section class="station" data-testid="review-station" data-observation={item.observationId}>
      <header class="station__header">
        <span class="station__position" data-testid="queue-position">
          {index + 1} / {items.length}
        </span>
        <span class="station__class">{item.featureClass}</span>
        {item.selectedForResurvey ? (
          <span class="station__resurvey" data-testid="resurvey-badge">
            re-survey sample
          </span>
        ) : null}
      </header>

      {/* Why QA flagged it, shown before the data — a reviewer who knows what to
          look for finds it faster than one who has to work it out. */}
      <ul class="station__reasons" data-testid="reason-codes">
        {item.reasonCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>

      <dl class="station__attributes" data-testid="attributes">
        {Object.entries(item.attributes).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
        <div>
          <dt>gps_accuracy_m</dt>
          <dd data-testid="accuracy">{item.gpsAccuracyM}</dd>
        </div>
      </dl>

      {needsNotes ? (
        <div class="station__notes" data-testid="fabrication-panel">
          <label for="notes">Substantiate this claim</label>
          <textarea
            id="notes"
            ref={notesRef}
            data-testid="notes-input"
            value={notes}
            onInput={(e) => setNotes((e.currentTarget as HTMLTextAreaElement).value)}
          />
          <button
            type="button"
            data-testid="confirm-fabrication"
            disabled={!notes.trim()}
            onClick={() => submit('REJECT', REVIEW_REASON.SUSPECTED_FABRICATION, notes.trim())}
          >
            Record suspected fabrication
          </button>
        </div>
      ) : (
        <ul class="station__keys" data-testid="key-legend">
          {Object.entries(REVIEW_KEYS).map(([key, binding]) => (
            <li key={key}>
              <kbd>{key}</kbd> {binding.reason.toLowerCase().replace(/_/g, ' ')}
            </li>
          ))}
          <li>
            <kbd>shift+F</kbd> suspected fabrication
          </li>
        </ul>
      )}
    </section>
  );
}
