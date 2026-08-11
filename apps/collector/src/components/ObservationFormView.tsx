import type { ObservationForm } from '@groundtruth/collector-core';
import { FieldControl } from './FieldControl.js';

/**
 * The whole observation form.
 *
 * Its most important behaviour is the one that renders nothing: when the form model
 * reports an unsupported widget, this shows a refusal instead of the fields it
 * *could* draw. ADR-0003 requires exactly that — a partially-rendered form produces
 * confidently wrong data, because the mapper answers what they are shown and the
 * server accepts it.
 */

export interface ObservationFormViewProps {
  readonly form: ObservationForm;
  readonly locale: 'sw' | 'en';
  readonly onChange: (field: string, value: unknown) => void;
  readonly onSubmit: () => void;
  readonly submitting?: boolean;
}

const COPY = {
  sw: {
    cannotRender: 'Fomu hii haiwezi kuonyeshwa',
    cannotRenderBody:
      'Toleo hili la programu haliwezi kuonyesha fomu hii kikamilifu. Tumia toleo jipya. Kazi yako iliyohifadhiwa haijapotea.',
    unsupported: 'Vipengele visivyotambulika:',
    save: 'Hifadhi',
    saving: 'Inahifadhi…',
    incomplete: 'Jaza sehemu zinazohitajika',
    progress: (a: number, b: number) => `Umejaza ${a} kati ya ${b}`,
  },
  en: {
    cannotRender: 'This form cannot be displayed',
    cannotRenderBody:
      'This app version cannot render this form faithfully. Please update. Nothing you have already saved has been lost.',
    unsupported: 'Unsupported controls:',
    save: 'Save',
    saving: 'Saving…',
    incomplete: 'Fill in the required fields',
    progress: (a: number, b: number) => `${a} of ${b} answered`,
  },
} as const;

export function ObservationFormView({
  form,
  locale,
  onChange,
  onSubmit,
  submitting = false,
}: ObservationFormViewProps) {
  const t = COPY[locale];

  // Refuse rather than approximate. Note what is NOT rendered below: not a single
  // field, not a save button. There is no path from this state to a submission.
  if (!form.renderable) {
    return (
      <section class="form form--unrenderable" role="alert" data-testid="form-unrenderable">
        <h2>{t.cannotRender}</h2>
        <p>{t.cannotRenderBody}</p>
        <p class="form__detail">
          {t.unsupported} {form.unsupportedWidgets().join(', ')}
        </p>
      </section>
    );
  }

  const fields = form.fields();
  const progress = form.progress();

  return (
    <form
      class="form"
      data-testid="observation-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p class="form__progress" data-testid="form-progress">
        {t.progress(progress.answered, progress.total)}
      </p>

      {fields.map((field) => (
        <FieldControl key={field.field} field={field} onChange={onChange} locale={locale} />
      ))}

      <button
        class="form__submit"
        type="submit"
        disabled={submitting || !form.complete}
        data-testid="form-submit"
      >
        {submitting ? t.saving : t.save}
      </button>

      {/* Says WHY the button is disabled. A dead control with no explanation is
          indistinguishable from a broken app to the person holding it. */}
      {!form.complete ? (
        <p class="form__hint" data-testid="form-incomplete-hint">
          {t.incomplete}
        </p>
      ) : null}
    </form>
  );
}
