// A `ui-screen` value built into widgets. The tree is walked once; after that only bindings run, each frame, and they
// write to the DOM only when a value changed.
import type { UiNodeProps, UiScreenDef } from '../schema/ui-screen.ts';
import type { UiPanel } from './widgets.ts';

/** The values a screen can read, by dotted name: `{ player: { hp: 80 } }` is 'player.hp'. A function is called. */
export type ViewModel = Record<string, unknown>;

export const WIDGETS = ['panel', 'stack', 'row', 'title', 'text', 'bar', 'button', 'image'] as const;
type WidgetName = (typeof WIDGETS)[number];

export interface ScreenEnv {
  vm: ViewModel;
  /** Values a state of the screen replaces, by full dotted name ('save.exists'). */
  mock: Record<string, unknown>;
  /** '@pause.title' calls this with 'pause.title'. */
  strings(key: string): string;
  /** Runs the named action: a press, or any `on` entry. */
  run(action: string): void;
}

/** Reads a dotted name from the view model. Pure, and allocation-free once `parts` is split. */
export function readPath(vm: ViewModel, parts: readonly string[]): unknown {
  let v: unknown = vm;
  for (let i = 0; i < parts.length; i++) {
    if (v === null || v === undefined) return undefined;
    v = (v as Record<string, unknown>)[parts[i]!];
  }
  return typeof v === 'function' ? (v as () => unknown)() : v;
}

/** A getter for a dotted name. A mocked name is a constant. */
export function getter(env: ScreenEnv, path: string): () => unknown {
  if (path in env.mock) {
    const v = env.mock[path];
    return () => v;
  }
  const parts = path.split('.');
  return () => readPath(env.vm, parts);
}

/** The first widget key of a node, or an error naming the node. */
export function widgetOf(node: unknown, at: string): WidgetName {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${at}: a node must be an object`);
  const found = WIDGETS.filter((w) => w in (node as object));
  if (found.length !== 1) {
    throw new Error(`${at}: a node names exactly one widget (${WIDGETS.join(', ')}), found ${found.length ? found.join(' and ') : 'none'}`);
  }
  return found[0]!;
}

function text(env: ScreenEnv, raw: string | undefined): string {
  if (raw === undefined) return '';
  return raw.startsWith('@') ? env.strings(raw.slice(1)) : raw;
}

/** Builds `node` as a child of `parent`. Throws an Error that names the place ('ui-screen/pause#/root/children/1: ...'). */
export function buildNode(parent: UiPanel, node: unknown, at: string, env: ScreenEnv): void {
  const kind = widgetOf(node, at);
  const n = node as Record<string, unknown>;
  const p = (n[kind] ?? {}) as UiNodeProps;
  const on = (n['on'] ?? {}) as Record<string, string>;
  const box = {
    ...(p.align ? { anchor: p.align } : {}),
    ...(p.width !== undefined ? { width: p.width } : {}),
    ...(p.gap !== undefined ? { gap: p.gap } : {}),
    ...(p.label ? { label: text(env, p.label) } : {}),
  };
  const children = n['children'];
  if (children !== undefined && kind !== 'panel' && kind !== 'stack' && kind !== 'row') {
    throw new Error(`${at}/children: only panel, stack and row have children`);
  }

  let widget;
  switch (kind) {
    case 'panel':
    case 'stack':
    case 'row': {
      const panel = parent[kind]({ ...box, ...(p.menu ? { menu: true } : {}), ...(kind === 'panel' ? { solid: true } : {}) });
      if (on['back']) panel.onBack = () => env.run(on['back']!);
      if (Array.isArray(children)) children.forEach((c, i) => buildNode(panel, c, `${at}/children/${i}`, env));
      else if (children !== undefined) throw new Error(`${at}/children: must be a list`);
      widget = panel;
      break;
    }
    case 'title':
    case 'text': {
      const w = kind === 'title' ? parent.title(text(env, p.text), box) : parent.text(text(env, p.text), box);
      if (p.bind) {
        const read = getter(env, p.bind);
        const tpl = p.format;
        w.bind(
          (): string | number => {
            const v = read();
            return typeof v === 'number' || typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
          },
          tpl ? (v) => tpl.replace('{}', String(v)) : undefined,
        );
      }
      widget = w;
      break;
    }
    case 'bar': {
      const w = parent.bar(box);
      if (!p.bind) throw new Error(`${at}/bar/bind: a bar needs "bind", the name of the value it shows`);
      const read = getter(env, p.bind);
      const max = typeof p.max === 'string' ? getter(env, p.max) : null;
      const fixed = typeof p.max === 'number' ? p.max : 1;
      w.bind(() => Number(read()) || 0, max ? () => Number(max()) || 0 : fixed);
      widget = w;
      break;
    }
    case 'button': {
      const press = on['press'];
      const w = parent.button(text(env, p.text), press ? () => env.run(press) : undefined, { ...box, ...(p.primary ? { primary: true } : {}) });
      widget = w;
      break;
    }
    case 'image': {
      if (!p.src) throw new Error(`${at}/image/src: an image needs "src"`);
      widget = parent.image(p.src, p.alt ?? '', box);
      break;
    }
  }
  if (p.visible) widget.bindVisible(getter(env, p.visible));
}

export function screenProblems(def: UiScreenDef, id: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, at: string): void => {
    try {
      const kind = widgetOf(node, at);
      const kids = (node as { children?: unknown }).children;
      if (Array.isArray(kids)) kids.forEach((c, i) => walk(c, `${at}/children/${i}`));
      else if (kids !== undefined && (kind === 'panel' || kind === 'stack' || kind === 'row')) out.push(`${at}/children: must be a list`);
    } catch (e) {
      out.push((e as Error).message);
    }
  };
  walk(def.root, `${id}#/root`);
  return out;
}
