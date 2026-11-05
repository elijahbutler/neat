'use client';

import { useId, useState } from 'react';
import { changeLabel, changeProperty, classOperations, PROPERTIES, resolveProperty, type PanelOption, type PanelOptions, type PropertyId } from '../../edit/classes';
import type { EditOperation } from '../../edit/operations';
import type { StyleSource } from '../../edit/properties';

interface Variant { prop: string; options: string[]; defaultValue?: string }

const NONE = '__none';
const GROUPS = ['Tokens', 'Used in this repo', 'Tailwind scale'] as const;
const SECTIONS = ['Spacing', 'Type', 'Color and shape'] as const;
const select = 'property-select w-full rounded-[6px] border border-rule bg-page px-2 py-2 text-[13px] focus:border-ink disabled:cursor-not-allowed disabled:bg-wash disabled:text-quiet';

/**
 * Controls for the selected element. A component's own options come first and become `set-prop`; the style controls
 * become `replace-class`. All the class-list reasoning lives in src/edit/classes.ts; this only renders it.
 */
export function PropertyPanel({ style, options, component, busy, onEdit }: {
  style: StyleSource;
  options: PanelOptions;
  /** The team component the selection is an instance of, when it is one. */
  component: { name: string; variants: Variant[]; uses: number; source: { file: string; line: number } } | null;
  busy: boolean;
  onEdit: (operations: EditOperation[], label: string) => void;
}) {
  const lockedId = useId();
  const [overrideStyles, setOverrideStyles] = useState(false);
  const locked = style.className.kind === 'locked' ? style.className.reason : null;
  const classes = style.className.kind === 'static' ? style.className.classes : [];

  function setVariant(variant: Variant, value: string) {
    const written = style.props[variant.prop];
    const before = written ?? variant.defaultValue ?? null;
    if (value === before) return;
    // The default needs no prop, so choosing it removes the one that is written.
    const next = value === variant.defaultValue ? null : value;
    if (next === null && written === undefined) return;
    onEdit([{ op: 'set-prop', target: style.target, name: variant.prop, value: next }], `${component!.name} ${variant.prop}: ${before ?? 'not set'} to ${value}`);
  }

  function setProperty(id: PropertyId, value: string | null) {
    const changes = changeProperty(classes, id, value, options, overrideStyles ? 'important' : 'normal');
    if (changes.length) onEdit(classOperations(style.target, changes), changeLabel(id, resolveProperty(classes, id, options).value, value));
  }

  return (
    <>
      {component && (
        <section className="property-group space-y-3">
          <h3 className="text-[13px] font-semibold">{component.name} options <span className="font-normal text-quiet">· used {component.uses}×</span></h3>
          {component.variants.length === 0 && <p className="text-[13px] text-quiet">{component.name} has no options to choose from.</p>}
          <div className="grid grid-cols-2 gap-3">
            {component.variants.map((variant) => (
              <VariantControl key={variant.prop} variant={variant} written={style.props[variant.prop]} disabled={busy} onChange={(value) => setVariant(variant, value)} />
            ))}
          </div>
        </section>
      )}

      {locked && <p id={lockedId} className="rounded-[6px] border border-rule bg-wash p-3 text-[13px] leading-snug">{locked}</p>}

      {SECTIONS.map((section) => (
        <fieldset key={section} className="property-group space-y-3" disabled={busy || locked !== null} aria-describedby={locked ? lockedId : undefined}>
          <legend className="text-[13px] font-semibold">{section}</legend>
          <div className="grid grid-cols-2 gap-3">
            {PROPERTIES.filter((property) => property.group === section).map((property) => (
              <PropertyControl key={property.id} id={property.id} label={property.label} classes={classes} options={options} choices={options[property.options]} onChange={(value) => setProperty(property.id, value)} />
            ))}
          </div>
        </fieldset>
      ))}

      {!locked && <div className="style-precedence space-y-2">
        <p className="text-[12px] leading-relaxed text-quiet">These controls show utility classes. Your app's styles can override them.</p>
        <label className="flex items-start gap-2 text-[12px] leading-relaxed">
          <input className="mt-1 shrink-0" type="checkbox" checked={overrideStyles} disabled={busy} onChange={(e) => setOverrideStyles(e.target.checked)} />
          Override app styles for new changes
        </label>
        {overrideStyles && <p className="text-[12px] leading-relaxed text-quiet">Overrides stylesheet and responsive rules. Keep this off unless a value does not appear.</p>}
      </div>}
    </>
  );
}

function VariantControl({ variant, written, disabled, onChange }: { variant: Variant; written: string | null | undefined; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  // null means the prop is set by code, such as variant={active ? 'default' : 'ghost'}.
  const dynamic = written === null;
  const current = written ?? variant.defaultValue ?? '';
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] text-quiet">{variant.prop}</label>
      <select id={id} className={select} value={current} disabled={disabled || dynamic} onChange={(e) => onChange(e.target.value)}>
        {!variant.options.includes(current) && <option value={current}>{dynamic ? 'Set in code' : current || 'Not set'}</option>}
        {variant.options.map((option) => <option key={option} value={option}>{option}{option === variant.defaultValue ? ' (default)' : ''}</option>)}
      </select>
    </div>
  );
}

function PropertyControl({ id, label, classes, options, choices, onChange }: {
  id: PropertyId;
  label: string;
  classes: string[];
  options: PanelOptions;
  choices: PanelOption[];
  onChange: (value: string | null) => void;
}) {
  const controlId = useId();
  const resolved = resolveProperty(classes, id, options);
  const current = resolved.value;
  const known = choices.find((choice) => choice.value === current);
  const notes = [
    resolved.fromShorthand ? `From ${resolved.className}.` : '',
    resolved.overrides.length ? `${resolved.overrides.join(', ')} also applies. Choosing a value here removes it.` : '',
    resolved.conditional.length ? `${resolved.conditional.join(', ')} stays as it is.` : '',
  ].filter(Boolean);
  return (
    <div className="space-y-1">
      <label htmlFor={controlId} className="block text-[12px] text-quiet">{label}</label>
      <div className="flex items-center gap-1.5">
        {known?.swatch && <span aria-hidden className="size-5 shrink-0 rounded-[4px] border border-rule" style={{ background: known.swatch }} />}
        <select id={controlId} className={select} value={current ?? NONE} onChange={(e) => onChange(e.target.value === NONE ? null : e.target.value)}>
          <option value={NONE}>No utility class</option>
          {/* A value outside the repo's tokens and the scale is shown so the control tells the truth, but not offered anew. */}
          {current !== null && !known && <option value={current}>{current || 'default'} (custom)</option>}
          {GROUPS.map((group) => {
            const inGroup = choices.filter((choice) => choice.group === group);
            return inGroup.length > 0 && (
              <optgroup key={group} label={group}>
                {inGroup.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </optgroup>
            );
          })}
        </select>
      </div>
      {notes.length > 0 && <p className="text-[11px] leading-snug text-quiet">{notes.join(' ')}</p>}
    </div>
  );
}
