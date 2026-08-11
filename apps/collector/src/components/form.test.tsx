// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { ObservationForm } from '@groundtruth/collector-core';
import { SpecValidator, V1_SPECS, specVersionOf, type FeatureClassSpec } from '@groundtruth/spec';
import { ObservationFormView } from './ObservationFormView.js';
import { SyncBadge } from './SyncBadge.js';
import type { SyncState } from '@groundtruth/collector-core';

afterEach(cleanup);

const validator = new SpecValidator(V1_SPECS);
const building = V1_SPECS.find((s) => s.featureClass === 'BUILDING_FOOTPRINT') as FeatureClassSpec;
const water = V1_SPECS.find((s) => s.featureClass === 'WATER_POINT') as FeatureClassSpec;

const makeForm = (spec: FeatureClassSpec = building, locale: 'sw' | 'en' = 'sw') =>
  new ObservationForm({ spec, specVersion: specVersionOf(spec), locale, validator });

const renderForm = (form: ObservationForm, locale: 'sw' | 'en' = 'sw', onChange = vi.fn()) => {
  const onSubmit = vi.fn();
  render(
    <ObservationFormView form={form} locale={locale} onChange={onChange} onSubmit={onSubmit} />,
  );
  return { onChange, onSubmit };
};

describe('spec-driven rendering', () => {
  it('renders a control for every field in the specification', () => {
    renderForm(makeForm());
    for (const hint of building.uiHints.fields) {
      expect(document.querySelector(`[data-field="${hint.field}"]`)).not.toBeNull();
    }
  });

  it('renders Swahili labels by default', () => {
    renderForm(makeForm());
    expect(screen.getByText(/Matumizi ya jengo/)).toBeTruthy();
    expect(screen.getByText(/Idadi ya ghorofa/)).toBeTruthy();
  });

  it('renders English when asked', () => {
    renderForm(makeForm(building, 'en'), 'en');
    expect(screen.getByText(/Building use/)).toBeTruthy();
  });

  it('renders select options from the spec, with an explicit unanswered state', () => {
    // Without an empty option the first choice silently looks like the answer.
    renderForm(makeForm());
    const select = document.querySelector('[data-field="structure_use"] select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options[0]?.value).toBe('');
    expect([...select.options].map((o) => o.value)).toContain('residential');
    expect([...select.options].map((o) => o.text)).toContain('Makazi');
  });

  it('uses a numeric keypad for integer fields', () => {
    renderForm(makeForm());
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    expect(input.getAttribute('inputmode')).toBe('numeric');
  });

  it('renders a checkbox for boolean fields', () => {
    renderForm(makeForm(water), 'sw');
    const input = document.querySelector('[data-field="functional"] input') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
  });

  it('marks required fields', () => {
    renderForm(makeForm());
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    expect(input.getAttribute('aria-required')).toBe('true');
  });

  it('binds every control to its label for one-handed outdoor use', () => {
    renderForm(makeForm());
    for (const hint of building.uiHints.fields) {
      const label = document.querySelector(`[data-field="${hint.field}"] label`);
      const control = document.querySelector(
        `[data-field="${hint.field}"] input, [data-field="${hint.field}"] select`,
      );
      expect(label?.getAttribute('for')).toBe(control?.getAttribute('id'));
    }
  });
});

describe('refuse rather than approximate', () => {
  const unrenderable = () => {
    const future: FeatureClassSpec = {
      ...building,
      uiHints: {
        fields: building.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, widget: 'signature_pad' as never } : f,
        ),
      },
    };
    return makeForm(future);
  };

  it('shows a refusal instead of the form', () => {
    renderForm(unrenderable());
    expect(screen.getByTestId('form-unrenderable')).toBeTruthy();
    expect(screen.queryByTestId('observation-form')).toBeNull();
  });

  it('renders NO fields at all, not even the ones it could draw', () => {
    // The whole point: a mapper answers what they are shown, and the server
    // accepts it. Half a form is confidently wrong data.
    renderForm(unrenderable());
    expect(document.querySelectorAll('[data-field]').length).toBe(0);
  });

  it('offers no way to submit', () => {
    renderForm(unrenderable());
    expect(screen.queryByTestId('form-submit')).toBeNull();
  });

  it('names the unsupported control and reassures about saved work', () => {
    renderForm(unrenderable());
    expect(screen.getByText(/signature_pad/)).toBeTruthy();
    expect(screen.getByText(/haijapotea/)).toBeTruthy();
  });
});

describe('editing', () => {
  it('reports a select change to the caller', () => {
    const { onChange } = renderForm(makeForm());
    const select = document.querySelector('[data-field="structure_use"] select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'commercial' } });
    expect(onChange).toHaveBeenCalledWith('structure_use', 'commercial');
  });

  it('reports a parsed integer, not a string', () => {
    const { onChange } = renderForm(makeForm());
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith('storeys', 3);
  });

  it('clears the value when the field is emptied', () => {
    const { onChange } = renderForm(makeForm());
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('storeys', undefined);
  });

  it('does not invent a number from half-typed input', () => {
    // "-" must not become 0. Pass it through and let validation reject it rather
    // than record a value the mapper never entered.
    const { onChange } = renderForm(makeForm());
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '-' } });
    const [, value] = onChange.mock.calls.at(-1) as [string, unknown];
    expect(value).not.toBe(0);
  });

  it('reports a boolean toggle', () => {
    const { onChange } = renderForm(makeForm(water));
    const input = document.querySelector('[data-field="functional"] input') as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith('functional', true);
  });
});

describe('validation feedback', () => {
  it('shows localised errors against the right field', () => {
    const form = makeForm();
    form.validate();
    renderForm(form);
    const errors = document.querySelector('[data-field="storeys"] .field__errors');
    expect(errors?.textContent).toContain('inahitajika');
  });

  it('announces errors to assistive technology', () => {
    const form = makeForm();
    form.validate();
    renderForm(form);
    const errors = document.querySelector('[data-field="storeys"] .field__errors');
    expect(errors?.getAttribute('role')).toBe('alert');
  });

  it('marks the invalid control with aria-invalid', () => {
    const form = makeForm();
    form.validate();
    renderForm(form);
    const input = document.querySelector('[data-field="storeys"] input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('submission', () => {
  it('disables save while required fields are missing, and says why', () => {
    renderForm(makeForm());
    const button = screen.getByTestId('form-submit') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // A dead control with no explanation is indistinguishable from a broken app.
    expect(screen.getByTestId('form-incomplete-hint')).toBeTruthy();
  });

  it('enables save once the form is complete', () => {
    const form = makeForm();
    form.setValue('structure_use', 'residential');
    form.setValue('storeys', 2);
    form.setValue('roof_material', 'iron_sheet');
    renderForm(form);
    expect((screen.getByTestId('form-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports progress so the mapper can see what remains', () => {
    const form = makeForm();
    form.setValue('structure_use', 'residential');
    renderForm(form);
    expect(screen.getByTestId('form-progress').textContent).toContain('1');
  });
});

describe('sync badge', () => {
  const state = (over: Partial<SyncState> = {}): SyncState => ({
    phase: 'IDLE',
    pendingItems: 0,
    pendingBytes: 0,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastError: null,
    ...over,
  });

  it('confirms plainly when everything is sent', () => {
    render(<SyncBadge state={state()} locale="sw" now={0} />);
    expect(screen.getByTestId('sync-message').textContent).toBe('Kila kitu kimetumwa');
  });

  it('always shows the pending count, so nothing is left to guess', () => {
    render(<SyncBadge state={state({ phase: 'OFFLINE', pendingItems: 87 })} locale="sw" now={0} />);
    expect(screen.getByTestId('sync-message').textContent).toContain('87');
  });

  it('says the phone is holding the data when offline', () => {
    render(<SyncBadge state={state({ phase: 'OFFLINE', pendingItems: 5 })} locale="en" now={0} />);
    expect(screen.getByTestId('sync-message').textContent).toContain('saved on device');
  });

  it('shows a countdown rather than an opaque wait', () => {
    render(
      <SyncBadge
        state={state({ phase: 'WAITING', pendingItems: 3, nextAttemptAt: 90_000 })}
        locale="en"
        now={30_000}
      />,
    );
    expect(screen.getByTestId('sync-countdown').textContent).toContain('1m');
  });

  it('offers a manual send when work is outstanding', () => {
    const onSyncNow = vi.fn();
    render(
      <SyncBadge state={state({ pendingItems: 2 })} locale="sw" now={0} onSyncNow={onSyncNow} />,
    );
    fireEvent.click(screen.getByTestId('sync-now'));
    expect(onSyncNow).toHaveBeenCalled();
  });

  it('hides the manual send when there is nothing to send', () => {
    render(<SyncBadge state={state()} locale="sw" now={0} onSyncNow={vi.fn()} />);
    expect(screen.queryByTestId('sync-now')).toBeNull();
  });

  it('announces politely, so it never interrupts a mapper mid-form', () => {
    render(<SyncBadge state={state({ pendingItems: 1 })} locale="sw" now={0} />);
    expect(screen.getByTestId('sync-badge').getAttribute('aria-live')).toBe('polite');
  });
});
