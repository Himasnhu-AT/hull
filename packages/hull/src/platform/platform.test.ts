import { describe, expect, it } from 'vitest';
import { InputCore } from '../input/index.ts';
import type { InputMap } from '../schema/input-map.ts';
import { UiPanel, buildNode, screenProblems, type UiContext, type UiView } from '../ui/index.ts';
import { createPlatform, createSaves, createSettings, localStore, memoryStore, openSettingsScreen, PadNav, settingsScreenDef, type Store } from './index.ts';
import { dbForVolume } from './settings.ts';
import type { Game } from '../core/index.ts';

const quiet = (log: string[] = []) => (m: string) => { log.push(m); };

describe('saves', () => {
  it('round-trips JSON and lists newest first', () => {
    let t = 100;
    const saves = createSaves({ store: memoryStore(), version: 1, now: () => t++ });
    expect(saves.write('a', { hp: 3, items: ['x'] })).toBe(true);
    saves.write('b', { hp: 9 });
    expect(saves.read('a')).toEqual({ hp: 3, items: ['x'] });
    expect(saves.read('missing')).toBeNull();
    expect(saves.list().map((s) => s.slot)).toEqual(['b', 'a']);
    saves.delete('a');
    expect(saves.read('a')).toBeNull();
    expect(saves.list().map((s) => s.slot)).toEqual(['b']);
  });

  it('migrates an old save up to the current version', () => {
    const store = memoryStore();
    createSaves({ store, version: 1 }).write('s', { name: 'ada' });
    const log: string[] = [];
    const v3 = createSaves({
      store,
      version: 3,
      report: quiet(log),
      migrations: {
        1: (d) => ({ ...(d as object), hp: 10 }),
        2: (d) => ({ ...(d as { hp: number }), hp: (d as { hp: number }).hp * 2 }),
      },
    });
    expect(v3.read('s')).toEqual({ name: 'ada', hp: 20 });
    expect(v3.list()[0]!.version).toBe(1);
    expect(log).toEqual([]);
  });

  it('reports and skips a corrupt file, a foreign file, a missing migration and a newer save', () => {
    const store = memoryStore();
    const log: string[] = [];
    const saves = createSaves({ store, version: 2, report: quiet(log), migrations: {} });
    store.write('saves', 'bad', '{"hull":"save","vers');
    store.write('saves', 'foreign', '{"x":1}');
    store.write('saves', 'old', JSON.stringify({ hull: 'save', version: 1, savedAt: 1, data: {} }));
    store.write('saves', 'new', JSON.stringify({ hull: 'save', version: 5, savedAt: 1, data: {} }));
    saves.write('ok', { fine: true });
    expect(saves.read('bad')).toBeNull();
    expect(saves.read('foreign')).toBeNull();
    expect(saves.read('old')).toBeNull();
    expect(saves.read('new')).toBeNull();
    // list() leaves out files that are not saves at all; old and newer saves are real files and still show.
    expect(saves.list().map((s) => s.slot).sort()).toEqual(['new', 'ok', 'old']);
    expect(log.some((l) => l.startsWith('saves/bad: corrupt'))).toBe(true);
    expect(log.some((l) => l.includes('saves/old') && l.includes('no migration'))).toBe(true);
    expect(log.some((l) => l.includes('saves/new') && l.includes('newer'))).toBe(true);
    // Reported once, not on every list.
    const n = log.length;
    saves.list();
    expect(log.length).toBe(n);
  });

  it('refuses a slot name that could leave its folder', () => {
    const saves = createSaves({ store: memoryStore(), version: 1 });
    expect(() => saves.write('../evil', {})).toThrow(/not valid/);
    expect(() => saves.read('a/b')).toThrow(/not valid/);
  });

  it('survives a storage that throws', () => {
    const boom = { length: 0, key: () => null, getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('no'); } };
    const saves = createSaves({ store: localStore('g', boom), version: 1 });
    expect(saves.write('a', {})).toBe(false);
    expect(saves.read('a')).toBeNull();
    expect(saves.list()).toEqual([]);
  });
});

const map: InputMap = {
  kind: 'input-map',
  actions: { jump: { type: 'button', keys: ['Space'] }, fire: { type: 'button', keys: ['KeyF'] } },
} as InputMap;

function inputRig(): InputCore {
  const core = new InputCore(() => 0);
  core.setMap(map, 'input-map/play');
  return core;
}

describe('settings', () => {
  it('persists, reloads, and reports a corrupt file', () => {
    const store = memoryStore();
    const a = createSettings({ store, report: quiet() });
    a.set({ quality: 'high', invertY: true, sensitivity: 9 });
    a.setVolume('music', 0.5);
    const b = createSettings({ store, report: quiet() });
    expect(b.values).toMatchObject({ quality: 'high', invertY: true, sensitivity: 3, volume: { music: 0.5 } });

    const log: string[] = [];
    store.write('settings', 'settings', '{nope');
    expect(createSettings({ store, report: quiet(log) }).values.quality).toBe('medium');
    expect(log[0]).toMatch(/corrupt/);
    store.write('settings', 'settings', JSON.stringify({ version: 1, values: { quality: 'ultra', volume: { sfx: 'loud' }, fullscreen: 3 } }));
    const log2: string[] = [];
    const c = createSettings({ store, report: quiet(log2) });
    expect(c.values.quality).toBe('medium');
    expect(log2.map((l) => l.split(':')[0])).toEqual(['settings#/volume/sfx', 'settings#/quality', 'settings#/fullscreen']);
  });

  it('applies to the audio buses, the render quality, the window and the input overrides', () => {
    const store = memoryStore();
    store.write('settings', 'settings', JSON.stringify({ version: 1, values: { volume: { music: 0.5 }, quality: 'low', bindings: { jump: { main: ['KeyJ'] } } } }));
    const settings = createSettings({ store, report: quiet() });
    const input = inputRig();
    const buses: [string, number][] = [];
    const qualities: string[] = [];
    const fs: boolean[] = [];
    const caps: number[] = [];
    settings.apply({
      audio: { setBus: (b, db) => buses.push([b, db]) },
      render: { setQuality: (q) => qualities.push(q) },
      input,
      fullscreen: (on) => fs.push(on),
      pixelRatioCap: (c) => caps.push(c),
      busLevels: { music: -10, sfx: 0 },
    });
    // Start: only the bus the player changed is pushed, relative to the level the mixer file gives it.
    expect(buses).toEqual([['music', dbForVolume(-10, 0.5)]]);
    expect(buses[0]![1]).toBeCloseTo(-16.02, 1);
    expect(qualities).toEqual(['low']);
    expect(caps).toEqual([1]);
    expect(fs).toEqual([]);
    expect(input.overrides()).toEqual({ jump: { main: ['KeyJ'] } });
    expect(input.bindings().find((r) => r.action === 'jump')!.sources).toEqual(['KeyJ']);

    settings.set({ quality: 'high', fullscreen: true });
    settings.setVolume('sfx', 0);
    expect(qualities).toEqual(['low', 'high']);
    expect(caps).toEqual([1, 2]);
    expect(fs).toEqual([true]);
    expect(buses.at(-1)).toEqual(['sfx', -80]);

    // A rebind made in game is written back to the settings file.
    input.rebind('fire', 'main', 0, 'KeyG');
    expect(settings.values.bindings).toEqual({ jump: { main: ['KeyJ'] }, fire: { main: ['KeyG'] } });
    expect(JSON.parse(store.read('settings', 'settings')!).values.bindings.fire.main).toEqual(['KeyG']);
  });

  it('applies the look options', () => {
    const s = createSettings({ store: memoryStore(), report: quiet() });
    s.set({ invertY: true, sensitivity: 2 });
    const out = { x: 0, y: 0 };
    s.look(3, 4, out);
    expect(out).toEqual({ x: 6, y: -8 });
  });
});

// ---- a tiny DOM, enough for the ui widgets -------------------------------------------------------------------

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  className = '';
  textContent = '';
  style: Record<string, unknown> = { setProperty() {}, cssText: '' };
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  appendChild(c: FakeEl): void { c.parent = this; this.children.push(c); }
  addEventListener(t: string, fn: () => void): void { (this.listeners[t] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  click(): void { this.listeners['click']?.forEach((f) => f()); }
  focus(): void {}
  closest(): null { return null; }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelectorAll(): FakeEl[] { return this.all().filter((e) => e.tag === 'button'); }
  querySelector(): null { return null; }
}

function uiRig() {
  const live: (() => void)[] = [];
  const ctx: UiContext = {
    doc: { createElement: (t: string) => new FakeEl(t), activeElement: null } as unknown as Document,
    track: (fn) => { live.push(fn); return () => { live.splice(live.indexOf(fn), 1); }; },
  };
  const root = new UiPanel(ctx, 'stack');
  const actions = new Map<string, () => void>();
  const ui = { root, screens: [], action: (n: string, fn: () => void) => { actions.set(n, fn); return () => actions.delete(n); } } as unknown as UiView;
  const el = root.el as unknown as FakeEl;
  const texts = (): string[] => el.all().filter((e) => e.tag === 'p' || e.tag === 'h2' || e.tag === 'button').map((e) => e.textContent);
  return { ui, tick: () => live.forEach((f) => f()), el, texts, button: (t: string) => el.all().find((e) => e.tag === 'button' && e.textContent === t)! };
}

describe('settings screen', () => {
  it('is a valid ui-screen built from the buses', () => {
    const def = settingsScreenDef(['master', 'music']);
    expect(screenProblems(def, 'ui-screen/settings')).toEqual([]);
    expect(def.root.panel).toMatchObject({ menu: true, align: 'center' });
    expect(def.pausesGame).toBe(true);
  });

  it('builds with the kit, shows the values and changes them with buttons', () => {
    const settings = createSettings({ store: memoryStore(), report: quiet() });
    const r = uiRig();
    let closed = 0;
    const screen = openSettingsScreen(r.ui, { settings, buses: ['master', 'music'], onClose: () => closed++ });
    r.tick();
    expect(r.texts()).toEqual(expect.arrayContaining(['Settings', 'Music volume', 'Quality', 'Medium', '100%', 'Off', '1.00x', 'Key bindings', 'Back']));
    // The two volume buttons of the music row are the 3rd and 4th buttons after master's.
    const buttons = r.el.all().filter((e) => e.tag === 'button');
    expect(buttons.map((b) => b.textContent).slice(0, 4)).toEqual(['-', '+', '-', '+']);
    buttons[2]!.click();
    r.tick();
    expect(settings.values.volume['music']).toBe(0.9);
    expect(r.texts()).toContain('90%');
    r.button('Change').click();
    r.tick();
    expect(settings.values.quality).toBe('high');
    expect(r.texts()).toContain('High');
    r.button('Back').click();
    expect(closed).toBe(1);
    screen.close();
    expect(closed).toBe(1);
  });

  it('builds the same tree through buildNode, naming the place of a mistake', () => {
    const r = uiRig();
    const def = settingsScreenDef(['master']);
    const bad = structuredClone(def);
    (bad.root.children as unknown[])[1] = { nope: {} };
    expect(() => buildNode(r.ui.root, bad.root, 'ui-screen/settings#/root', { vm: {}, mock: {}, strings: (k) => k, run: () => {} })).toThrow(/ui-screen\/settings#\/root\/children\/1/);
  });
});

describe('pad navigation', () => {
  it('moves once per press, repeats while held, and presses on South', () => {
    const nav = new PadNav();
    const ev: string[] = [];
    const emit = (e: string) => ev.push(e);
    nav.update(1, false, false, emit);
    expect(ev).toEqual(['next']);
    for (let i = 0; i < 23; i++) nav.update(1, false, false, emit);
    expect(ev).toEqual(['next']);
    nav.update(1, false, false, emit); // frame 25: past the first delay
    nav.update(1, false, false, emit);
    expect(ev).toEqual(['next']);
    for (let i = 0; i < 6; i++) nav.update(1, false, false, emit);
    expect(ev).toEqual(['next', 'next']);
    nav.update(0, true, false, emit);
    nav.update(0, true, false, emit);
    nav.update(0, false, true, emit);
    expect(ev.slice(2)).toEqual(['press', 'back']);
  });
});

describe('platform', () => {
  function fakeDoc() {
    const l: Record<string, (() => void)[]> = {};
    return {
      hidden: false,
      fullscreenElement: null,
      documentElement: {},
      addEventListener: (t: string, f: () => void) => { (l[t] ??= []).push(f); },
      removeEventListener: (t: string, f: () => void) => { l[t] = (l[t] ?? []).filter((x) => x !== f); },
      fire: (t: string) => l[t]?.forEach((f) => f()),
    };
  }

  it('pauses a hidden page and resumes only a pause it made', () => {
    const doc = fakeDoc();
    const store: Store = memoryStore();
    const game = { paused: false } as unknown as Game;
    const win = { document: doc, devicePixelRatio: 3, localStorage: undefined } as never;
    const p = createPlatform(game, { id: 'g', doc: doc as never, win, store, report: quiet() });
    expect(p.kind).toBe('browser');
    doc.hidden = true; doc.fire('visibilitychange');
    expect(game.paused).toBe(true);
    doc.hidden = false; doc.fire('visibilitychange');
    expect(game.paused).toBe(false);
    game.paused = true; // the player's own pause
    doc.hidden = true; doc.fire('visibilitychange');
    doc.hidden = false; doc.fire('visibilitychange');
    expect(game.paused).toBe(true);
    expect(p.pixelRatio()).toBe(1.5); // medium caps a 3x display
    p.settings.set({ quality: 'low' });
    expect(p.pixelRatio()).toBe(1);
    p.dispose();
  });

  it('uses the shell bridge when there is one', () => {
    const doc = fakeDoc();
    const store = memoryStore();
    let fullscreen = false;
    const shell = { ...store, platform: 'darwin', getFullscreen: () => fullscreen, setFullscreen: (on: boolean) => { fullscreen = on; }, quit: () => {} };
    const win = { document: doc, hullShell: shell } as never;
    const p = createPlatform({ paused: false } as unknown as Game, { id: 'g', doc: doc as never, win, report: quiet() });
    expect(p.kind).toBe('desktop');
    p.saves.write('one', { a: 1 });
    expect(store.list('saves')).toEqual(['one']);
    p.fullscreen.toggle();
    expect(fullscreen).toBe(true);
    expect(p.fullscreen.active).toBe(true);
    p.dispose();
  });
});
