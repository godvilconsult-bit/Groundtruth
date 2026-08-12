import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  Outbox,
  DailyByteBudget,
  CaptureSession,
  SyncEngine,
  ObservationForm,
  type SyncState,
  type Locale,
} from '@groundtruth/collector-core';
// Storage is a platform adapter, so it lives in the app rather than in
// collector-core, which declares itself free of any storage engine.
import {
  openCollectorDb,
  IndexedDbOutboxStore,
  IndexedDbSequenceStore,
  requestPersistentStorage,
} from './storage/indexeddb-store.js';
import { SpecValidator, V1_SPECS, specVersionOf, type FeatureClassSpec } from '@groundtruth/spec';
import { ObservationFormView } from './components/ObservationFormView.js';
import { SyncBadge } from './components/SyncBadge.js';
import { DevTransport } from './dev-transport.js';

/**
 * The collector shell.
 *
 * Wires the pieces that were built and tested in isolation into something a person
 * can actually use: published spec in, form out, observation queued, sync visible.
 *
 * Two things here are real rather than demonstrated. Storage is genuine IndexedDB,
 * so a refresh keeps the queue — which is the whole point of the offline design and
 * the thing worth seeing with your own eyes. And the specs are the ones published to
 * the database, imported rather than re-typed, so the form you see is the form a
 * mapper sees.
 *
 * The transport is stubbed until Phase 4's HTTP layer exists. That is stated in the
 * UI rather than hidden, because a demo that looks like it is talking to a server
 * when it is not teaches the wrong thing about what has been proven.
 */

const CHUMBAGENI = '00000000-0000-4000-8000-000000000003';
/** Fallback position when geolocation is denied — central Tanga, clearly labelled. */
const TANGA_FALLBACK = { lon: 39.0951, lat: -5.0699, accuracyM: 12 };

const validator = new SpecValidator(V1_SPECS);
const transport = new DevTransport();

const COPY = {
  sw: {
    title: 'Ukusanyaji',
    choose: 'Chagua aina ya kitu',
    saved: 'Imehifadhiwa',
    position: 'Mahali',
    positionPending: 'Inatafuta mahali…',
    positionDenied: 'Mahali hakijapatikana — inatumia mahali pa mfano',
    accuracy: 'Usahihi',
    budget: 'Data iliyotumika leo',
    offline: 'Zima mtandao',
    online: 'Washa mtandao',
    language: 'English',
    stub: 'Seva ya majaribio — Awamu ya 4 itaunganisha seva halisi',
    back: 'Rudi',
  },
  en: {
    title: 'Collection',
    choose: 'Choose a feature type',
    saved: 'Saved',
    position: 'Position',
    positionPending: 'Finding position…',
    positionDenied: 'Position unavailable — using a sample position',
    accuracy: 'Accuracy',
    budget: 'Data used today',
    offline: 'Go offline',
    online: 'Go online',
    language: 'Kiswahili',
    stub: 'Stub server — Phase 4 wires the real one',
    back: 'Back',
  },
} as const;

interface Runtime {
  outbox: Outbox;
  budget: DailyByteBudget;
  session: CaptureSession;
  engine: SyncEngine;
}

export function App() {
  const [locale, setLocale] = useState<Locale>('sw');
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [spec, setSpec] = useState<FeatureClassSpec | null>(null);
  const [form, setForm] = useState<ObservationForm | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [online, setOnline] = useState(true);
  const [position, setPosition] = useState<typeof TANGA_FALLBACK | null>(null);
  const [positionDenied, setPositionDenied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  // ObservationForm is a mutable class, so Preact cannot see a value change. This
  // forces the re-render rather than making the model immutable — the model is
  // shared with the server-side pipeline and reallocating it per keystroke would be
  // wasteful on the target hardware.
  const [, setFormTick] = useState(0);
  const bumpForm = useCallback(() => setFormTick((n) => n + 1), []);
  const t = COPY[locale];
  const nowRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const db = await openCollectorDb(indexedDB);
      const outbox = new Outbox(new IndexedDbOutboxStore(db));
      const budget = new DailyByteBudget(new Date());
      const session = new CaptureSession({
        outbox,
        budget,
        sequences: new IndexedDbSequenceStore(db),
        deviceId: 'browser-dev',
        appVersion: '1.0.0',
      });
      const engine = new SyncEngine({ outbox, budget, transport });

      // Eviction under disk pressure would lose an unsent day — the worst thing
      // this app could do — so the refusal is surfaced rather than swallowed.
      const persisted = await requestPersistentStorage(navigator.storage);
      if (!cancelled && !persisted.persisted) setStorageWarning(persisted.reason);

      if (!cancelled) setRuntime({ outbox, budget, session, engine });
    })().catch((error: unknown) => {
      setStorageWarning(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Position. Falls back rather than blocking: a mapper standing at a gate with a
  // slow fix must still be able to start the form.
  useEffect(() => {
    if (!navigator.geolocation) {
      setPosition(TANGA_FALLBACK);
      setPositionDenied(true);
      return;
    }
    const watch = navigator.geolocation.watchPosition(
      (p) =>
        setPosition({
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          accuracyM: Math.max(0.5, p.coords.accuracy),
        }),
      () => {
        setPosition(TANGA_FALLBACK);
        setPositionDenied(true);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  // The sync loop. Polled rather than event-driven so the visible state is always
  // current even when nothing is happening.
  useEffect(() => {
    if (!runtime) return;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      nowRef.current = Date.now();
      transport.online = online;
      const context = {
        now: new Date(),
        connection: { online, metered: false },
      };
      await runtime.engine.runOnce(context);
      if (!stopped) setSyncState(await runtime.engine.state(context));
    };

    void tick();
    const timer = setInterval(() => void tick(), 1_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runtime, online]);

  const startForm = useCallback(
    (chosen: FeatureClassSpec) => {
      setSpec(chosen);
      setForm(
        new ObservationForm({
          spec: chosen,
          specVersion: specVersionOf(chosen),
          locale,
          validator,
        }),
      );
    },
    [locale],
  );

  // Rebuild the form when the language changes, so labels and errors switch
  // together rather than the errors keeping the old locale.
  useEffect(() => {
    if (spec) startForm(spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  const onChange = useCallback(
    (field: string, value: unknown) => {
      form?.setValue(field, value);
      bumpForm();
    },
    [form],
  );

  const onSubmit = useCallback(async () => {
    if (!form || !spec || !runtime) return;
    const result = form.validate();
    bumpForm();
    if (!result.valid) return;

    await runtime.session.capture({
      featureClass: spec.featureClass,
      specVersion: specVersionOf(spec),
      position: position ?? TANGA_FALLBACK,
      attributes: form.values(),
      wardId: CHUMBAGENI,
    });

    setToast(t.saved);
    setTimeout(() => setToast(null), 1_800);
    setSpec(null);
    setForm(null);
  }, [form, spec, runtime, position, t.saved]);

  if (!runtime) {
    return <main class="app app--loading">…</main>;
  }

  const budgetSnapshot = runtime.budget.snapshot(new Date());

  return (
    <main class="app">
      <header class="app__bar">
        <h1>{t.title}</h1>
        <button type="button" class="app__lang" onClick={() => setLocale(locale === 'sw' ? 'en' : 'sw')}>
          {t.language}
        </button>
      </header>

      {syncState ? (
        <SyncBadge
          state={syncState}
          locale={locale}
          now={nowRef.current}
          onSyncNow={() => runtime.engine.requestImmediateAttempt()}
        />
      ) : null}

      <section class="app__status">
        <div>
          <span class="app__label">{t.position}</span>
          <span class="app__value">
            {position
              ? `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
              : t.positionPending}
          </span>
          {position ? (
            <span class="app__accuracy">
              {t.accuracy} ±{position.accuracyM.toFixed(0)} m
            </span>
          ) : null}
          {positionDenied ? <p class="app__warn">{t.positionDenied}</p> : null}
        </div>
        <div>
          <span class="app__label">{t.budget}</span>
          <span class="app__value">
            {(budgetSnapshot.usedBytes / 1024).toFixed(1)} KB /{' '}
            {(budgetSnapshot.limitBytes / 1024 / 1024).toFixed(0)} MB
          </span>
        </div>
      </section>

      {storageWarning ? <p class="app__warn">storage: {storageWarning}</p> : null}

      {form && spec ? (
        <>
          <button type="button" class="app__back" onClick={() => { setSpec(null); setForm(null); }}>
            ← {t.back}
          </button>
          <ObservationFormView form={form} locale={locale} onChange={onChange} onSubmit={() => void onSubmit()} />
        </>
      ) : (
        <nav class="app__classes">
          <h2>{t.choose}</h2>
          {V1_SPECS.map((candidate) => {
            const label = candidate.uiHints.fields[0]?.labels[locale] ?? candidate.featureClass;
            return (
              <button
                type="button"
                key={candidate.featureClass}
                class="app__class"
                onClick={() => startForm(candidate)}
              >
                <strong>{candidate.featureClass.toLowerCase().replace(/_/g, ' ')}</strong>
                <small>{label}</small>
              </button>
            );
          })}
        </nav>
      )}

      <footer class="app__footer">
        <button type="button" class="app__toggle" onClick={() => setOnline(!online)}>
          {online ? t.offline : t.online}
        </button>
        <span class="app__stub">{t.stub}</span>
      </footer>

      {toast ? <div class="app__toast" role="status">{toast}</div> : null}
    </main>
  );
}
