// The input map's actions as a table: one row per action with its type, its keys as chips and what clashes. A row opens
// for the rest (mouse, gamepad, deadzone, sensitivity...). Keys are added by pressing them, not by typing their names.
// The rows write through the same `onChange(pointer, value)` as every other widget, so each edit is checked against the
// schema by the server before it is kept.

import { useEffect, useMemo, useState, type JSX } from 'react';
import { defaultFor, mapEntryFields, type Field } from '../lib/schemaForm.ts';
import {
  SLOTS, captureName, clashesOf, displayName, findConflicts, keySlots, mouseChoices, padChoices, padList, retype,
  type ActionType,
} from '../lib/bindings.ts';
import { leaveBox } from '../lib/keys.ts';
import { Icon } from './Icon.tsx';

type Change = (pointer: string, value: unknown, final?: boolean) => void;

const TYPES: readonly { type: ActionType; label: string; title: string }[] = [
  { type: 'button', label: 'Btn', title: 'button: held or not' },
  { type: 'axis', label: 'Axis', title: 'axis: -1 to 1' },
  { type: 'axis2', label: 'Stick', title: 'axis2: two axes, like a stick' },
];
const SLOT_LABEL: Record<string, string> = { neg: 'neg', pos: 'pos', up: 'up', down: 'down', left: 'left', right: 'right' };
const MOUSE_BUTTONS = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'WheelUp', 'WheelDown'];
const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (a: unknown): ActionType => (isObj(a) && (a['type'] === 'axis' || a['type'] === 'axis2') ? a['type'] : 'button');

interface Cap { action: string; slot: string }

export function BindingsField({ field, value, problems, send, onChange, renderField }: {
  field: Field; value: unknown; problems: readonly string[];
  send(v: unknown, final?: boolean): void; onChange: Change; renderField(f: Field): JSX.Element;
}): JSX.Element {
  const actions: Record<string, unknown> = isObj(value) ? value : {};
  const names = Object.keys(actions);
  const conflicts = useMemo(() => findConflicts(actions), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [cap, setCap] = useState<Cap | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const root = field.schemaRoot ?? {};
  const at = (name: string, prop: string): string => `${field.pointer}/${esc(name)}${prop ? `/${prop}` : ''}`;

  // While a "+" waits for a key, the next key press anywhere is that key. Escape gives up; a click elsewhere does too.
  useEffect(() => {
    if (!cap) return;
    const down = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCap(null); return; }
      const n = captureName(e);
      if (!n) return;
      const a = actions[cap.action];
      const slots = keySlots(a);
      const have = slots[cap.slot] ?? [];
      setCap(null);
      if (have.includes(n)) return;
      const list = [...have, n];
      onChange(typeOf(a) === 'button' ? at(cap.action, 'keys') : at(cap.action, `keys/${cap.slot}`), list, true);
    };
    const away = (e: PointerEvent): void => { if (!(e.target as Element | null)?.closest?.('[data-capturing]')) setCap(null); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('pointerdown', away, true); };
  });

  const toggle = (n: string): void => setOpen((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const setKeys = (name: string, slot: string, list: string[]): void => {
    onChange(typeOf(actions[name]) === 'button' ? at(name, 'keys') : at(name, `keys/${slot}`), list, true);
  };
  const addAction = (): void => {
    const k = draft.trim();
    if (!k) return;
    if (k in actions) { setNote(`"${k}" is already here.`); return; }
    send({ ...actions, [k]: defaultFor(root, field.valueSchema) }, true);
    setDraft(''); setNote(null);
    setOpen((s) => new Set(s).add(k));
  };
  // Dropping a property sends the action without it: a value of undefined cannot travel to the server.
  const setProp = (name: string, prop: string, v: unknown): void => {
    const a = actions[name];
    if (v !== undefined) { onChange(at(name, prop), v, true); return; }
    if (isObj(a)) { const { [prop]: _gone, ...rest } = a; onChange(at(name, ''), rest, true); }
  };
  const removeAction = (k: string): void => { const { [k]: _gone, ...rest } = actions; send(rest, true); };

  const chip = (name: string, action: string, slot: string, i: number, list: string[]): JSX.Element => {
    const clash = clashesOf(name, action, conflicts);
    const label = displayName(name);
    return (
      <span key={`${name}${i}`} className={`bchip${clash.length ? ' clash' : ''}`} title={clash.length ? `${label} is also on ${clash.join(', ')}` : name}>
        {label}
        <button className="bx" aria-label={`Remove ${label} from ${action}`} onClick={() => setKeys(action, slot, list.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button>
      </span>
    );
  };
  const adder = (action: string, slot: string): JSX.Element => {
    const on = cap?.action === action && cap.slot === slot;
    return (
      <button className={`badd${on ? ' on' : ''}`} data-capturing={on ? '' : undefined} aria-label={`Add a key to ${action}${slot === 'main' ? '' : ` ${slot}`}`}
        title="Click, then press the key" onClick={() => setCap(on ? null : { action, slot })}>
        {on ? 'Press a key...' : <Icon name="plus" size={11} />}
      </button>
    );
  };

  return (
    <div className="fld bindings">
      <div className="fh">
        <span className="fl" title={field.help}>{names.length} {names.length === 1 ? 'action' : 'actions'}</span>
        {conflicts.length > 0 && <span className="bconf" role="status" title={conflicts.map((c) => `${displayName(c.source)}: ${c.actions.join(', ')}`).join('\n')}><Icon name="warn" size={12} />{conflicts.length} {conflicts.length === 1 ? 'key is' : 'keys are'} on two actions</span>}
      </div>
      {field.help && <div className="help">{field.help}</div>}
      {names.length === 0 && <div className="help">Nothing here yet.</div>}
      <div className="btable">
        {names.map((name) => {
          const a = actions[name];
          const type = typeOf(a);
          const slots = keySlots(a);
          const isOpen = open.has(name);
          const pads = padList(a);
          const mouse = isObj(a) && typeof a['mouse'] === 'string' ? a['mouse'] : '';
          const slotNames = SLOTS[type];
          const clashing = [...new Set([...Object.values(slots).flat(), ...(type === 'button' ? pads.map((p) => `pad:${p}`) : [])].flatMap((n) => clashesOf(n, name, conflicts).map((o) => `${displayName(n)} is also on ${o}`)))];
          const extra = mapEntryFields(field, name, a).filter((f) => /\/(deadzone|sensitivity|invertY|rebind)$/.test(f.pointer));
          const rebindOff = isObj(a) && a['rebind'] === false;
          return (
            <div className={`brow${isOpen ? ' open' : ''}`} key={name}>
              <div className="bhead">
                <button className={`mapc${isOpen ? ' open' : ''}`} onClick={() => toggle(name)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${name}`}><Icon name="chevron" size={12} /></button>
                <span className="bname" title={name}>{name}</span>
                {rebindOff && <span className="btag" title="Not in the key-binding screen (rebind: false)">fixed</span>}
                <div className="seg bseg" role="group" aria-label={`Type of ${name}`}>
                  {TYPES.map((t) => (
                    <button key={t.type} className={type === t.type ? 'on' : ''} aria-pressed={type === t.type} title={t.title}
                      onClick={() => { if (type !== t.type && isObj(a)) onChange(at(name, ''), retype(a, t.type), true); }}>{t.label}</button>
                  ))}
                </div>
                <button className="rs show" onClick={() => removeAction(name)} aria-label={`Remove ${name}`} title={`Remove ${name}`}><Icon name="trash" /></button>
              </div>
              <div className="bchips">
                {slotNames.map((slot) => {
                  const list = slots[slot] ?? [];
                  return (
                    <div className="bslot" key={slot}>
                      {type !== 'button' && <span className="bsl">{SLOT_LABEL[slot] ?? slot}</span>}
                      {list.map((n, i) => chip(n, name, slot, i, list))}
                      {adder(name, slot)}
                      {slot === slotNames[slotNames.length - 1] && (
                        <>
                          {type === 'button' && pads.map((p, i) => <span key={`pad${p}`} className="bchip pad" title={`gamepad ${p}`}>{displayName(`pad:${p}`)}<button className="bx" aria-label={`Remove pad ${p} from ${name}`} onClick={() => onChange(at(name, 'pad'), pads.filter((_, j) => j !== i), true)}><Icon name="close" size={10} /></button></span>)}
                          {type !== 'button' && pads[0] && <span className="bchip pad" title={`gamepad ${pads[0]}`}>{pads[0]}<button className="bx" aria-label={`Remove pad ${pads[0]} from ${name}`} onClick={() => setProp(name, 'pad', undefined)}><Icon name="close" size={10} /></button></span>}
                          {mouse && <span className="bchip mouse" title={`mouse ${mouse}`}>mouse {mouse}<button className="bx" aria-label={`Remove mouse from ${name}`} onClick={() => setProp(name, 'mouse', undefined)}><Icon name="close" size={10} /></button></span>}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {clashing.map((c) => <div className="bnote" key={c} role="alert"><Icon name="warn" size={12} />{c}</div>)}
              {isOpen && (
                <div className="bbody">
                  <div className="bsrc">
                    {type === 'button' && (
                      <label>Mouse button<select className="field-in" value="" aria-label={`Add a mouse button to ${name}`} onChange={(e) => { if (e.target.value) setKeys(name, 'main', [...(slots['main'] ?? []).filter((k) => k !== e.target.value), e.target.value]); }}>
                        <option value="">Add...</option>{MOUSE_BUTTONS.map((m) => <option key={m} value={m}>{displayName(m)}</option>)}
                      </select></label>
                    )}
                    {type !== 'button' && (
                      <label>Mouse<select className="field-in" value={mouse} aria-label={`Mouse use of ${name}`} onChange={(e) => setProp(name, 'mouse', e.target.value || undefined)}>
                        <option value="">None</option>{mouseChoices(type).map((m) => <option key={m} value={m}>{m}</option>)}
                      </select></label>
                    )}
                    <label>Gamepad<select className="field-in" value={type === 'button' ? '' : pads[0] ?? ''} aria-label={`Gamepad source of ${name}`}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (type === 'button') { if (v && !pads.includes(v)) onChange(at(name, 'pad'), [...pads, v], true); }
                        else setProp(name, 'pad', v || undefined);
                      }}>
                      <option value="">{type === 'button' ? 'Add...' : 'None'}</option>
                      {padChoices(type).map((p) => <option key={p} value={p}>{p}</option>)}
                    </select></label>
                  </div>
                  {extra.map((f) => renderField(f))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mapadd">
        <input className="field-in" value={draft} placeholder="New action" aria-label="New action name" spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); setNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter') addAction(); }} onKeyUp={leaveBox} />
        <button className="btn" onClick={addAction} disabled={!draft.trim()}><Icon name="plus" />Add</button>
      </div>
      {note && <div className="err" role="alert"><Icon name="warn" /><span>{note}</span></div>}
      {problems.length > 0 && <div className="err" role="alert"><Icon name="warn" /><span>{problems.join(' ')}</span></div>}
    </div>
  );
}
