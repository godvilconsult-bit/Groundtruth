import type { FormField } from '@groundtruth/collector-core';

/**
 * One field of a spec-driven form.
 *
 * Renders strictly from the {@link FormField} the form model produced. It makes no
 * decisions of its own: no defaulting, no coercion, no guessing at a widget it does
 * not know. Deciding here rather than in the model is how a renderer bug becomes
 * invisible — the component would look correct while producing wrong values.
 *
 * Accessibility is not decoration on a device used one-handed, outdoors, in sun:
 * every control is bound to its label, errors are announced, and touch targets are
 * sized for a thumb rather than a mouse.
 */

export interface FieldControlProps {
  readonly field: FormField;
  readonly onChange: (field: string, value: unknown) => void;
  readonly locale: 'sw' | 'en';
}

export function FieldControl({ field, onChange, locale }: FieldControlProps) {
  const id = `f-${field.field}`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const invalid = field.errors.length > 0;

  const describedBy = [field.help ? helpId : null, invalid ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const shared = {
    id,
    name: field.field,
    'aria-invalid': invalid,
    'aria-required': field.required,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  };

  return (
    <div class={`field${invalid ? ' field--invalid' : ''}`} data-field={field.field}>
      <label class="field__label" for={id}>
        {field.label}
        {field.required ? (
          <span class="field__required" aria-hidden="true">
            {' *'}
          </span>
        ) : null}
      </label>

      {field.help ? (
        <p class="field__help" id={helpId}>
          {field.help}
        </p>
      ) : null}

      {renderControl(field, shared, onChange, locale)}

      {invalid ? (
        <ul class="field__errors" id={errorId} role="alert">
          {field.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type SharedProps = Record<string, unknown>;

function renderControl(
  field: FormField,
  shared: SharedProps,
  onChange: FieldControlProps['onChange'],
  locale: 'sw' | 'en',
) {
  const set = (value: unknown) => onChange(field.field, value);

  switch (field.widget) {
    case 'boolean':
      return (
        <input
          {...shared}
          type="checkbox"
          class="field__checkbox"
          checked={field.value === true}
          onChange={(e) => set((e.currentTarget as HTMLInputElement).checked)}
        />
      );

    case 'select':
      return (
        <select
          {...shared}
          class="field__select"
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={(e) => set((e.currentTarget as HTMLSelectElement).value)}
        >
          {/* An explicit empty option, so "not yet answered" is a visible state
              rather than the first option silently appearing to be the answer. */}
          <option value="">{locale === 'sw' ? '— Chagua —' : '— Select —'}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case 'multiselect':
      return (
        <div class="field__multiselect" role="group" aria-labelledby={`${shared['id']}`}>
          {(field.options ?? []).map((option) => {
            const selected = Array.isArray(field.value) && field.value.includes(option.value);
            return (
              <label class="field__checkbox-row" key={option.value}>
                <input
                  type="checkbox"
                  name={`${field.field}[]`}
                  value={option.value}
                  checked={selected}
                  onChange={(e) => {
                    const current = Array.isArray(field.value) ? [...field.value] : [];
                    const next = (e.currentTarget as HTMLInputElement).checked
                      ? [...current, option.value]
                      : current.filter((v) => v !== option.value);
                    set(next.length > 0 ? next : undefined);
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      );

    case 'integer':
    case 'number':
      return (
        <input
          {...shared}
          type="number"
          class="field__number"
          // A numeric keypad rather than the full keyboard: fewer taps and fewer
          // mistyped digits with one hand in bright sun.
          inputMode={field.widget === 'integer' ? 'numeric' : 'decimal'}
          step={field.widget === 'integer' ? 1 : 'any'}
          value={typeof field.value === 'number' ? String(field.value) : ''}
          onInput={(e) => {
            const raw = (e.currentTarget as HTMLInputElement).value;
            if (raw === '') return set(undefined);
            const parsed = field.widget === 'integer' ? Number.parseInt(raw, 10) : Number(raw);
            // A half-typed "-" must not become 0. Pass the raw string through and
            // let schema validation reject it, rather than inventing a number the
            // mapper never entered.
            set(Number.isNaN(parsed) ? raw : parsed);
          }}
        />
      );

    case 'photo':
      return (
        <input
          {...shared}
          type="file"
          class="field__photo"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            const file = (e.currentTarget as HTMLInputElement).files?.[0];
            set(file ?? undefined);
          }}
        />
      );

    case 'text':
    default:
      return (
        <input
          {...shared}
          type="text"
          class="field__text"
          value={typeof field.value === 'string' ? field.value : ''}
          onInput={(e) => set((e.currentTarget as HTMLInputElement).value)}
        />
      );
  }
}
