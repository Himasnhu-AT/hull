// The key-binding screen. The number of rows depends on the input map, so it is built with the panel API instead of a
// static `ui-screen`; it is themed the same way (it lives on the ui layer) and is a `menu` panel, so the arrow keys,
// the d-pad (see nav.ts) and Escape work. A rebind waits for the next key, mouse button or pad button (`input.capture`).
import { sourceLabel } from '../../input/keys.ts';
import type { BindingRow, InputView } from '../../input/core.ts';
import type { UiPanel, UiView } from '../../ui/index.ts';

export interface BindingsDeps {
  input: Pick<InputView, 'bindings' | 'rebind' | 'unbind' | 'addBinding' | 'capture' | 'cancelCapture' | 'resetBindings' | 'onBindingsChanged'>;
  onClose?: () => void;
  /** Tells the pad navigation to stand still while a button press is being captured. */
  onCapture?: (capturing: boolean) => void;
}

export interface BindingsScreen { close(): void; readonly capturing: boolean }

const slotLabel = (r: BindingRow): string => (r.slot === 'main' ? r.action : `${r.action} ${r.slot}`);

export function openBindingsScreen(ui: UiView, deps: BindingsDeps): BindingsScreen {
  const { input } = deps;
  const host = ui.root.stack({ label: 'key bindings' });
  host.el.style.cssText = 'position:absolute;inset:0';
  const panel: UiPanel = host.panel({ anchor: 'center', menu: true, label: 'Key bindings', gap: 8, solid: true });
  panel.el.style.maxHeight = '80vh';
  panel.el.style.overflowY = 'auto';

  let capturing = false;
  let note = '';
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (capturing) input.cancelCapture();
    off();
    host.dispose();
    deps.onClose?.();
  };
  panel.onBack = () => { if (capturing) input.cancelCapture(); else close(); };

  const rebuild = (focusLabel?: string): void => {
    panel.clear();
    panel.title('Key bindings');
    for (const r of input.bindings()) {
      const row = panel.row({ gap: 8 });
      row.text(slotLabel(r), { width: 170 });
      r.sources.forEach((src, i) => {
        const b = row.button(sourceLabel(src), () => begin(r, i, b.el), { label: `${slotLabel(r)}: ${sourceLabel(src)}. Press to change` });
        if (!r.rebind) b.setDisabled(true);
      });
      if (r.rebind) row.button('+', () => begin(r, -1, null), { label: `Add a key to ${slotLabel(r)}` });
      else row.text('fixed', { muted: true });
    }
    if (note) panel.text(note, { muted: true, live: true });
    const foot = panel.row({ gap: 12 });
    foot.button('Reset all', () => { input.resetBindings(); note = 'Back to the defaults.'; });
    foot.button('Back', close, { primary: true });
    if (focusLabel) panel.el.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focusLabel)}"]`)?.focus();
    else panel.focusFirst();
  };

  function begin(r: BindingRow, index: number, el: HTMLElement | null): void {
    if (capturing) return;
    capturing = true;
    deps.onCapture?.(true);
    if (el) el.textContent = 'Press a key...';
    note = 'Press a key, mouse button or pad button. Escape cancels.';
    void input.capture().then((src) => {
      capturing = false;
      deps.onCapture?.(false);
      if (closed) return;
      note = '';
      if (src !== null) {
        const others = index < 0 ? input.addBinding(r.action, r.slot, src) : input.rebind(r.action, r.slot, index, src);
        if (others.length) note = `${sourceLabel(src)} is also used by ${others.join(', ')}.`;
      }
      rebuild(el ? el.getAttribute('aria-label') ?? undefined : undefined);
    });
  }

  // Any change (ours, or a live edit of the map) redraws the rows.
  const off = input.onBindingsChanged(() => { if (!capturing) rebuild(); });
  rebuild();
  return { close, get capturing() { return capturing; } };
}
