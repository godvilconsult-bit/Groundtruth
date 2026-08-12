// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { ReviewStation, type QueueItem } from './ReviewStation.js';
import { REVIEW_REASON, validateReview } from '@groundtruth/qa';

afterEach(cleanup);

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  observationId: 'obs-1',
  featureClass: 'ACCESS_POINT',
  collectorId: 'c1',
  submittedAt: '2026-08-11T09:00:00Z',
  gpsAccuracyM: 6.5,
  reasonCodes: ['REP_NEW_COLLECTOR'],
  attributes: { access_type: 'gate', reachable_on_foot: true },
  mediaRefs: [],
  selectedForResurvey: false,
  ...over,
});

const setup = (items: QueueItem[] = [item()], clock = { t: 1_000 }) => {
  const onDecide = vi.fn();
  render(<ReviewStation items={items} onDecide={onDecide} now={() => clock.t} />);
  return { onDecide, clock };
};

describe('the queue', () => {
  it('shows the current position', () => {
    setup([item({ observationId: 'a' }), item({ observationId: 'b' })]);
    expect(screen.getByTestId('queue-position').textContent).toContain('1 / 2');
  });

  it('shows why QA flagged it, before the data', () => {
    // A reviewer who knows what to look for finds it faster than one who has to
    // work it out from the attributes.
    setup([item({ reasonCodes: ['GEO_ACCURACY_POOR', 'REP_NEW_COLLECTOR'] })]);
    const reasons = screen.getByTestId('reason-codes').textContent ?? '';
    expect(reasons).toContain('GEO_ACCURACY_POOR');
    expect(reasons).toContain('REP_NEW_COLLECTOR');
  });

  it('marks a re-survey sample, which a reviewer should judge independently', () => {
    setup([item({ selectedForResurvey: true })]);
    expect(screen.getByTestId('resurvey-badge')).toBeTruthy();
  });

  it('advances to the next item after a decision', () => {
    setup([item({ observationId: 'a' }), item({ observationId: 'b' })]);
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByTestId('review-station').getAttribute('data-observation')).toBe('b');
  });

  it('reports a clear queue rather than a blank screen', () => {
    setup([]);
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
  });
});

describe('keyboard decisions — 36 seconds does not survive a mouse', () => {
  it('accepts on "a"', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'a' });
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        observationId: 'obs-1',
        decision: 'ACCEPT',
        reason: REVIEW_REASON.CONFIRMED_CORRECT,
      }),
    );
  });

  it('rejects wrong location on "l"', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'l' });
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'REJECT', reason: REVIEW_REASON.WRONG_LOCATION }),
    );
  });

  it('escalates on "e"', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'e' });
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'ESCALATE' }),
    );
  });

  it('ignores unbound keys instead of guessing', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'z' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('ignores browser shortcuts, so ctrl+A does not accept', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('emits only decision/reason pairs the domain accepts', () => {
    // The console must not be able to record a combination the rules reject —
    // "rejected as CONFIRMED_CORRECT" would be noise in every later query.
    const { onDecide } = setup(Array.from({ length: 9 }, (_, i) => item({ observationId: `o${i}` })));
    for (const key of ['a', 's', 'l', 't', 'd', 'n', 'm', 'e', 'r']) {
      fireEvent.keyDown(window, { key });
    }
    for (const call of onDecide.mock.calls) {
      const d = call[0] as { decision: never; reason: never };
      expect(() =>
        validateReview({
          observationId: 'x',
          reviewerId: 'r',
          decision: d.decision,
          reason: d.reason,
          notes: 'x',
          durationMs: 1000,
        }),
      ).not.toThrow();
    }
    expect(onDecide).toHaveBeenCalledTimes(9);
  });
});

describe('time on item is measured, because rubber-stamping is the risk', () => {
  it('reports elapsed time with the decision', () => {
    const clock = { t: 1_000 };
    const { onDecide } = setup([item()], clock);
    clock.t = 31_000;
    fireEvent.keyDown(window, { key: 'a' });
    expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ durationMs: 30_000 });
  });

  it('restarts the timer for each item, not for the session', () => {
    const clock = { t: 0 };
    const { onDecide } = setup([item({ observationId: 'a' }), item({ observationId: 'b' })], clock);
    clock.t = 20_000;
    fireEvent.keyDown(window, { key: 'a' });
    clock.t = 25_000;
    fireEvent.keyDown(window, { key: 'a' });

    expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ durationMs: 20_000 });
    // Second item measures 5s, not 25s — attention on THIS observation.
    expect(onDecide.mock.calls[1]?.[0]).toMatchObject({ durationMs: 5_000 });
  });

  it('never reports a negative duration if the clock moves backwards', () => {
    const clock = { t: 10_000 };
    const { onDecide } = setup([item()], clock);
    clock.t = 5_000;
    fireEvent.keyDown(window, { key: 'a' });
    expect((onDecide.mock.calls[0]?.[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('accusing someone of fabrication is deliberately slow', () => {
  it('is not reachable by a single keystroke', () => {
    const { onDecide } = setup();
    for (const key of ['f', 'F', 'x']) fireEvent.keyDown(window, { key });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('opens a justification panel on shift+F rather than deciding', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    expect(screen.getByTestId('fabrication-panel')).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('will not submit without substantiation', () => {
    setup();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    const button = screen.getByTestId('confirm-fabrication') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('submits once justified', () => {
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    fireEvent.input(screen.getByTestId('notes-input'), {
      target: { value: 'Photo shows a different street entirely.' },
    });
    fireEvent.click(screen.getByTestId('confirm-fabrication'));

    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'REJECT',
        reason: REVIEW_REASON.SUSPECTED_FABRICATION,
        notes: 'Photo shows a different street entirely.',
      }),
    );
  });

  it('does not hijack hotkeys while the reviewer is typing', () => {
    // Typing "a gate was moved" must not accept the observation mid-sentence.
    const { onDecide } = setup();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('lets Escape abandon the accusation', () => {
    setup();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('fabrication-panel')).toBeNull();
  });
});

describe('the key legend is always visible', () => {
  it('lists every binding, so nothing must be memorised', () => {
    setup();
    const legend = screen.getByTestId('key-legend').textContent ?? '';
    expect(legend).toContain('confirmed correct');
    expect(legend).toContain('wrong location');
    expect(legend).toContain('suspected fabrication');
  });
});
