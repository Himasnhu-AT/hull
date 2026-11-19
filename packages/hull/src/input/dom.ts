// The browser side of input: listeners on the page, the pointer lock, the gamepad poll, and the wiring into the game
// loop. All the logic is in core.ts; this file only translates events.
import { config } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import type { InputMap } from '../schema/input-map.ts';
import '../schema/index.ts';
import { InputCore, type InputView } from './core.ts';
import { PAD_SOURCES } from './keys.ts';
import { wireInput } from './wire.ts';

/**
 * The `code` of a key event. Some sources (remote desktops, virtual keyboards, automation over the devtools protocol)
 * send a key with an empty `code`; the `key` still says which one it was, so name it from that.
 */
export function codeOf(e: { code: string; key?: string }): string {
  if (e.code) return e.code;
  const k = e.key ?? '';
  if (k.length === 1) {
    if (k === ' ') return 'Space';
    if (/[a-z]/i.test(k)) return `Key${k.toUpperCase()}`;
    if (/[0-9]/.test(k)) return `Digit${k}`;
    return '';
  }
  return k === 'Shift' ? 'ShiftLeft' : k === 'Control' ? 'ControlLeft' : k === 'Alt' ? 'AltLeft' : k === 'Escape' || k === 'Enter' || k === 'Tab' || k === 'Backspace' || /^Arrow(Up|Down|Left|Right)$/.test(k) ? k : '';
}

function isTextField(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  if (!e || !e.tagName) return false;
  return e.isContentEditable || e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT';
}

/**
 * Starts reading devices for `game` and returns the view game code reads. `map` is the id of an `input-map` config
 * ('input-map/play'), a map value, or nothing (every action then reads idle until `setMap`). A config id is watched,
 * so editing the file rebinds the keys of the running game.
 *
 * Keys are read from the window, not from `el`, because a canvas cannot take key focus; mouse buttons and the wheel
 * are read from `el`; mouse movement counts only while the pointer is locked (or `freeLook` is on). While focus is in a
 * text field, keys are not read.
 */
export function mountInput(game: Game, el: HTMLElement | Window, map?: string | InputMap): InputView {
  const core = new InputCore(() => game.world.tick);
  const off: (() => void)[] = [];
  const pointerEl: HTMLElement = typeof Window !== 'undefined' && el instanceof Window ? el.document.documentElement : (el as HTMLElement);
  const doc = pointerEl.ownerDocument;
  const win = doc.defaultView!;

  if (typeof map === 'string') {
    const id = map.startsWith('input-map/') ? map : `input-map/${map}`;
    if (config.has(id)) {
      core.setMap(config.lookup('input-map', id.slice('input-map/'.length)), id);
      off.push(config.watch(id, (now) => core.setMap(now as InputMap, id)));
    } else {
      core.setMap(undefined, id);
      core.problems = [`${id}: there is no such input map in config/`];
    }
  } else core.setMap(map);

  const on = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void => {
    t.addEventListener(type, fn as EventListener, opts);
    off.push(() => t.removeEventListener(type, fn as EventListener, opts));
  };

  let locked = false;
  let wasLocked = false;
  const lockedNow = (): boolean => doc.pointerLockElement === pointerEl;

  on<KeyboardEvent>(win, 'keydown', (e) => {
    if (isTextField(e.target)) return;
    if (e.metaKey || e.ctrlKey) return; // browser shortcuts (reload, copy) are not game input
    const code = codeOf(e);
    if (!code) return;
    const swallow = core.capturingNow || core.isBound(code) || locked;
    if (swallow) e.preventDefault();
    if (e.repeat && !core.capturingNow) return;
    core.keyDown(code);
  });
  on<KeyboardEvent>(win, 'keyup', (e) => { core.keyUp(codeOf(e)); });
  on(win, 'blur', () => core.releaseAll());
  on(doc, 'visibilitychange', () => { if (doc.hidden) core.releaseAll(); });

  on<MouseEvent>(pointerEl, 'mousedown', (e) => {
    // Inside an iframe (Hull's Game view) a click only moves key focus into the page if the page lets the mousedown
    // through; the preventDefault below would stop that, and W, A, S, D would keep going to the editor around the game.
    // So take focus ourselves, first.
    if (!doc.hasFocus()) win.focus();
    if (core.capturingNow || core.isBound(`Mouse${e.button}`)) e.preventDefault();
    core.mouseDown(e.button);
  });
  on<MouseEvent>(win, 'mouseup', (e) => core.mouseUp(e.button));
  on<MouseEvent>(pointerEl, 'contextmenu', (e) => { if (core.isBound('Mouse2')) e.preventDefault(); });
  on<MouseEvent>(win, 'mousemove', (e) => {
    if (locked || core.freeLook) core.mouseMove(e.movementX || 0, e.movementY || 0);
  });
  on<WheelEvent>(pointerEl, 'wheel', (e) => {
    if (locked && core.isBound('WheelUp')) e.preventDefault();
    core.wheel(e.deltaY);
  }, { passive: false });

  on(doc, 'pointerlockchange', () => {
    locked = lockedNow();
    // Buttons held when the lock ends may never see their mouseup: let go of everything.
    if (!locked) {
      core.releaseAll();
      // Esc (or a lost lock) in an embedded game hands the keyboard back to the page around it, so the editor's own
      // shortcuts work again. A click in the game takes it back (mousedown above).
      if (wasLocked && win.parent !== win) win.parent.focus();
    }
    wasLocked = locked;
  });
  on(doc, 'pointerlockerror', () => { if (!locked) core.lockDenied = true; });

  const denied = (): void => { if (!locked) core.lockDenied = true; };
  core.host = {
    get locked() { return locked; },
    lock() {
      if (!pointerEl.requestPointerLock) { denied(); return; }
      const plain = (): void => {
        try { void Promise.resolve(pointerEl.requestPointerLock()).catch(denied); } catch { denied(); }
      };
      try {
        // Raw movement skips the OS mouse acceleration; not every platform has it, so fall back to a plain lock.
        const p = pointerEl.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | void;
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => { if (err instanceof DOMException && err.name === 'NotSupportedError') plain(); else denied(); });
        }
      } catch { plain(); }
    },
    unlock() { doc.exitPointerLock?.(); },
    dispose() { if (lockedNow()) doc.exitPointerLock?.(); },
  };

  // Gamepad: Chrome shows a pad only after its first button press, and fires an event then.
  let pads = 0;
  const buttons = new Float64Array(PAD_SOURCES.length);
  const axes = new Float64Array(4);
  on(win, 'gamepadconnected', () => { pads++; });
  on(win, 'gamepaddisconnected', () => { pads = Math.max(0, pads - 1); core.setPad(new Float64Array(PAD_SOURCES.length), axes.fill(0)); });
  const pollPad = (): void => {
    if (pads === 0 || !win.navigator.getGamepads) return;
    const list = win.navigator.getGamepads();
    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp || !gp.connected) continue;
      for (let b = 0; b < buttons.length; b++) buttons[b] = gp.buttons[b]?.value ?? 0;
      for (let a = 0; a < 4; a++) axes[a] = gp.axes[a] ?? 0;
      core.setPad(buttons, axes);
      return;
    }
  };

  off.push(wireInput(game, core, pollPad));

  current = core;
  const dispose = core.dispose.bind(core);
  core.dispose = () => {
    for (const f of off.splice(0)) f();
    dispose();
    if (current === core) current = null;
  };
  return core;
}

let current: InputCore | null = null;
const idle = new InputCore(() => 0);

/**
 * The input of the mounted game, for game code: `input.action('jump').pressed`. Before `mountInput` (or after it is
 * disposed) every action reads idle. Written out member by member, not as a Proxy, because it is read every frame.
 */
export const input: InputView = {
  action: (n) => (current ?? idle).action(n),
  axis2: (x, y, out) => (current ?? idle).axis2(x, y, out),
  vec2: (n, out) => (current ?? idle).vec2(n, out),
  get enabled() { return (current ?? idle).enabled; },
  set enabled(v) { (current ?? idle).enabled = v; },
  get pointerLocked() { return (current ?? idle).pointerLocked; },
  lockPointer: () => (current ?? idle).lockPointer(),
  unlockPointer: () => (current ?? idle).unlockPointer(),
  get lockDenied() { return (current ?? idle).lockDenied; },
  get freeLook() { return (current ?? idle).freeLook; },
  set freeLook(v) { (current ?? idle).freeLook = v; },
  record: () => (current ?? idle).record(),
  play: (l) => (current ?? idle).play(l),
  bindings: () => (current ?? idle).bindings(),
  rebind: (a, s, i, src) => (current ?? idle).rebind(a, s, i, src),
  unbind: (a, s, i) => (current ?? idle).unbind(a, s, i),
  addBinding: (a, s, src) => (current ?? idle).addBinding(a, s, src),
  capture: () => (current ?? idle).capture(),
  cancelCapture: () => (current ?? idle).cancelCapture(),
  resetBindings: (a) => (current ?? idle).resetBindings(a),
  overrides: () => (current ?? idle).overrides(),
  setOverrides: (o) => (current ?? idle).setOverrides(o),
  onBindingsChanged: (fn) => (current ?? idle).onBindingsChanged(fn),
  get problems() { return (current ?? idle).problems; },
  heldSources: () => (current ?? idle).heldSources(),
  dispose: () => (current ?? idle).dispose(),
};
