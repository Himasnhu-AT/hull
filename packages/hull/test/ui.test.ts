import { describe, expect, it } from 'vitest';
import { applyVars, buildNode, getter, readPath, screenProblems, themeVars, UiPanel, widgetOf, type UiContext } from '../src/ui/index.ts';
import type { ScreenEnv } from '../src/ui/screen.ts';
import type { UiScreenDef } from '../src/schema/index.ts';

// A tiny stand-in for the DOM that counts writes, so "touches the DOM only when a value changed" can be tested in
// Node. It implements just what the widgets use.
class FakeEl {
  writes = 0;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, (() => void)[]> = {};
  classes = new Set<string>();
  private text = '';
  private cls = '';
  parent: FakeEl | null = null;
  style = {
    props: {} as Record<string, string>,
    setProperty: (k: string, v: string) => { this.writes++; this.style.props[k] = v; },
    set transform(v: string) { (this as unknown as { owner: FakeEl }).owner.writes++; this.props['transform'] = v; },
    set width(v: string) { this.props['width'] = v; },
    props2: 0,
  };
  classList = {
    add: (...c: string[]) => { this.writes++; c.forEach((x) => this.classes.add(x)); },
    remove: (...c: string[]) => { this.writes++; c.forEach((x) => this.classes.delete(x)); },
    toggle: (c: string, on: boolean) => { this.writes++; if (on) this.classes.add(c); else this.classes.delete(c); },
  };
  constructor(readonly tag: string) {
    (this.style as unknown as { owner: FakeEl }).owner = this;
  }
  set className(v: string) { this.cls = v; }
  get className(): string { return this.cls; }
  set textContent(v: string) { this.writes++; this.text = v; }
  get textContent(): string { return this.text; }
  setAttribute(k: string, v: string): void { this.writes++; this.attrs[k] = v; }
  appendChild(c: FakeEl): void { c.parent = this; this.children.push(c); }
  addEventListener(t: string, fn: () => void): void { (this.listeners[t] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  click(): void { this.listeners['click']?.forEach((f) => f()); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

function rig() {
  const live: (() => void)[] = [];
  const ctx: UiContext = {
    doc: { createElement: (t: string) => new FakeEl(t) } as unknown as Document,
    track: (fn) => { live.push(fn); return () => { live.splice(live.indexOf(fn), 1); }; },
  };
  return { ctx, tick: () => live.forEach((f) => f()), live };
}

describe('theme', () => {
  it('turns a theme into variables, with defaults for everything it does not say', () => {
    const v = themeVars({ kind: 'ui-theme', color: { accent: '#ff0000' }, space: { gutter: 8 } });
    expect(v['--hull-accent']).toBe('#ff0000');
    expect(v['--hull-gutter']).toBe('8px');
    expect(v['--hull-panel']).toBe('#0e1012');
    expect(v['--hull-radius']).toBe('2px');
    expect(Object.keys(themeVars())).toEqual(Object.keys(v));
  });

  it('writes only the variables that changed', () => {
    const writes: string[] = [];
    const set = (n: string) => writes.push(n);
    let last = applyVars(set, themeVars(), {});
    expect(writes).toHaveLength(Object.keys(last).length);
    writes.length = 0;
    last = applyVars(set, themeVars(), last);
    expect(writes).toEqual([]);
    last = applyVars(set, themeVars({ kind: 'ui-theme', color: { accent: '#00ff00' } }), last);
    expect(writes).toEqual(['--hull-accent']);
  });
});

describe('widgets write only on change', () => {
  it('text: a bound value is written when it changes, not every frame', () => {
    const { ctx, tick } = rig();
    const root = new UiPanel(ctx);
    let score = 0;
    const t = root.text('').bind(() => score, (n) => `Score ${n}`);
    const el = t.el as unknown as FakeEl;
    tick();
    expect(el.textContent).toBe('Score 0');
    const w = el.writes;
    for (let i = 0; i < 100; i++) tick();
    expect(el.writes).toBe(w);
    score = 5;
    tick();
    expect(el.textContent).toBe('Score 5');
    expect(el.writes).toBe(w + 1);
  });

  it('bar: fill, aria value and the low state change only with the value', () => {
    const { ctx, tick } = rig();
    const root = new UiPanel(ctx);
    let hp = 100;
    const bar = root.bar({ lowBelow: 0.25, label: 'Health' }).bind(() => hp, 100);
    const el = bar.el as unknown as FakeEl;
    tick();
    expect(el.attrs['aria-valuenow']).toBe('100');
    expect(el.attrs['role']).toBe('progressbar');
    expect(el.attrs['aria-label']).toBe('Health');
    const w = el.writes;
    tick(); tick();
    expect(el.writes).toBe(w);
    hp = 20;
    tick();
    expect(el.classes.has('low')).toBe(true);
    expect(el.attrs['aria-valuenow']).toBe('20');
    hp = 50;
    tick();
    expect(el.classes.has('low')).toBe(false);
  });

  it('button: a real button element that calls what the game gave it', () => {
    const { ctx } = rig();
    const root = new UiPanel(ctx);
    let n = 0;
    const b = root.button('Play', () => n++, { primary: true });
    const el = b.el as unknown as FakeEl;
    expect(el.tag).toBe('button');
    expect(el.attrs['type']).toBe('button');
    expect(el.className).toContain('primary');
    el.click();
    el.click();
    expect(n).toBe(2);
  });

  it('bindVisible toggles only when the answer flips, and dispose stops the binding', () => {
    const { ctx, tick, live } = rig();
    const root = new UiPanel(ctx);
    let on = true;
    const t = root.text('x').bindVisible(() => on);
    const el = t.el as unknown as FakeEl;
    tick();
    const w = el.writes;
    tick();
    expect(el.writes).toBe(w);
    on = false;
    tick();
    expect(el.classes.has('hull-hidden')).toBe(true);
    t.dispose();
    expect(live).toHaveLength(0);
    expect(root.children).toHaveLength(0);
  });

  it('anchors add one class pair and swap it when changed', () => {
    const { ctx } = rig();
    const root = new UiPanel(ctx);
    const t = root.text('x', { anchor: 'top-left' });
    const el = t.el as unknown as FakeEl;
    expect([...el.classes]).toEqual(['hull-a', 'hull-a-top-left']);
    t.setAnchor('center');
    expect([...el.classes]).toEqual(['hull-a', 'hull-a-center']);
  });
});

describe('screens', () => {
  const def = (root: unknown): UiScreenDef => ({ kind: 'ui-screen', root } as UiScreenDef);

  it('reads dotted names, calls functions, and takes mocks as constants', () => {
    const vm = { player: { hp: 80, name: () => 'Ana' } };
    expect(readPath(vm, ['player', 'hp'])).toBe(80);
    expect(readPath(vm, ['player', 'name'])).toBe('Ana');
    expect(readPath(vm, ['nope', 'x'])).toBeUndefined();
    const env: ScreenEnv = { vm, mock: { 'player.hp': 5 }, strings: (k) => k, run: () => {} };
    expect(getter(env, 'player.hp')()).toBe(5);
    expect(getter(env, 'player.name')()).toBe('Ana');
  });

  it('builds the SCHEMAS.md pause screen and routes presses to named actions', () => {
    const { ctx, tick } = rig();
    const root = new UiPanel(ctx);
    const ran: string[] = [];
    const env: ScreenEnv = {
      vm: { player: { hp: 30, maxHp: 60 }, label: 'Ana' },
      mock: {},
      strings: (k) => `[${k}]`,
      run: (a) => ran.push(a),
    };
    const screen = def({
      panel: { align: 'center', width: 420 },
      children: [
        { title: { text: '@pause.title' } },
        { text: { bind: 'label', format: 'Hello {}' } },
        { bar: { bind: 'player.hp', max: 'player.maxHp' } },
        { button: { text: '@pause.resume', primary: true }, on: { press: 'game.resume' } },
        { button: { text: 'Settings' }, on: { press: 'ui.open:ui/settings' } },
      ],
    });
    buildNode(root, screen.root, 'ui-screen/pause#/root', env);
    tick();
    const els = (root.el as unknown as FakeEl).all();
    const texts = els.map((e) => e.textContent).filter(Boolean);
    expect(texts).toEqual(['[pause.title]', 'Hello Ana', '[pause.resume]', 'Settings']);
    const bar = els.find((e) => e.attrs['role'] === 'progressbar')!;
    expect(bar.attrs['aria-valuenow']).toBe('30');
    expect(bar.attrs['aria-valuemax']).toBe('60');
    els.filter((e) => e.tag === 'button').forEach((b) => b.click());
    expect(ran).toEqual(['game.resume', 'ui.open:ui/settings']);
  });

  it('names the place of a mistake', () => {
    expect(() => widgetOf({ panel: {}, row: {} }, 'ui-screen/x#/root/children/1')).toThrow(
      'ui-screen/x#/root/children/1: a node names exactly one widget (panel, stack, row, title, text, bar, button, image), found panel and row',
    );
    expect(screenProblems(def({ panel: {}, children: [{ text: {} }, { oops: 1 }, 'x'] }), 'ui-screen/x')).toEqual([
      'ui-screen/x#/root/children/1: a node names exactly one widget (panel, stack, row, title, text, bar, button, image), found none',
      'ui-screen/x#/root/children/2: a node must be an object',
    ]);
    const { ctx } = rig();
    expect(() => buildNode(new UiPanel(ctx), { bar: {} }, 'ui-screen/x#/root', { vm: {}, mock: {}, strings: (k) => k, run: () => {} })).toThrow(
      /ui-screen\/x#\/root\/bar\/bind/,
    );
  });
});
