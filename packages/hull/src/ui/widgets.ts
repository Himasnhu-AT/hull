// The widgets: thin wrappers over DOM elements. A widget never writes to the DOM unless its value changed, and its
// per-frame update allocates nothing (strings are built only when the number behind them changed).

export type Anchor =
  | 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

/** What every widget gets from the view that owns it. `track` adds a function to the per-frame update list. */
export interface UiContext {
  readonly doc: Document;
  track(update: () => void): () => void;
}

export interface BoxOpts {
  /** Pin to a corner, an edge or the centre of the parent, inside the theme's gutter. */
  anchor?: Anchor;
  /** Pixels. */
  width?: number;
  /** Pixels between children (panel, stack, row). */
  gap?: number;
  /** Accessible name. Text and buttons are named by their text already; a panel or a bar needs one. */
  label?: string;
}

export class UiWidget {
  private hidden = false;
  private anchorClass = '';
  private readonly offs: (() => void)[] = [];
  parent: UiPanel | null = null;

  constructor(protected readonly ctx: UiContext, readonly el: HTMLElement, o: BoxOpts = {}) {
    if (o.anchor) this.setAnchor(o.anchor);
    if (o.width !== undefined) el.style.width = `${o.width}px`;
    if (o.gap !== undefined) el.style.setProperty('--hull-gap', `${o.gap}px`);
    if (o.label) el.setAttribute('aria-label', o.label);
  }

  setAnchor(a: Anchor | undefined): this {
    const next = a ? `hull-a hull-a-${a}` : '';
    if (next === this.anchorClass) return this;
    if (this.anchorClass) this.el.classList.remove(...this.anchorClass.split(' '));
    if (next) this.el.classList.add(...next.split(' '));
    this.anchorClass = next;
    return this;
  }

  show(visible: boolean): this {
    if (visible === !this.hidden) return this;
    this.hidden = !visible;
    this.el.classList.toggle('hull-hidden', this.hidden);
    return this;
  }

  /** Shows the widget while `read()` is truthy. Checked every frame; the DOM is touched only when the answer flips. */
  bindVisible(read: () => unknown): this {
    this.own(this.ctx.track(() => this.show(!!read())));
    return this;
  }

  protected own(off: () => void): void { this.offs.push(off); }

  /** Removes the element and stops its bindings. */
  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.parent?.forget(this);
    this.el.remove();
  }
}

export class UiText extends UiWidget {
  private shown = '';
  private raw: unknown = undefined;

  constructor(ctx: UiContext, text: string, o: BoxOpts & { title?: boolean; muted?: boolean; live?: boolean } = {}) {
    super(ctx, ctx.doc.createElement(o.title ? 'h2' : 'p'), o);
    this.el.className = o.title ? 'hull-title' : o.muted ? 'hull-text hull-label' : 'hull-text';
    // A value that changes during play (score, ammo) is announced politely if asked; a HUD is silent by default.
    if (o.live) this.el.setAttribute('aria-live', 'polite');
    this.set(text);
  }

  set(value: string | number): this {
    const s = typeof value === 'number' ? String(value) : value;
    if (s === this.shown) return this;
    this.shown = s;
    this.el.textContent = s;
    return this;
  }

  /**
   * Shows what `read()` returns each frame. `format` turns the value into text; it runs only when the value changed,
   * so a score or a timer does not build a string per frame.
   */
  bind<T extends string | number>(read: () => T, format?: (v: T) => string): this {
    this.own(this.ctx.track(() => {
      const v = read();
      if (v === this.raw) return;
      this.raw = v;
      this.set(format ? format(v) : v);
    }));
    return this;
  }
}

export class UiBar extends UiWidget {
  private readonly fill: HTMLElement;
  private v = NaN;
  private m = NaN;
  private low = false;
  private lowBelow: number;

  constructor(ctx: UiContext, o: BoxOpts & { lowBelow?: number } = {}) {
    super(ctx, ctx.doc.createElement('div'), o);
    this.el.className = 'hull-bar';
    this.fill = ctx.doc.createElement('i');
    this.el.appendChild(this.fill);
    this.lowBelow = o.lowBelow ?? 0;
    this.el.setAttribute('role', 'progressbar');
    this.el.setAttribute('aria-valuemin', '0');
    this.set(0, 1);
  }

  set(value: number, max = 1): this {
    if (value === this.v && max === this.m) return this;
    if (max !== this.m) this.el.setAttribute('aria-valuemax', String(max));
    this.v = value;
    this.m = max;
    const f = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
    this.fill.style.transform = `scaleX(${f})`;
    this.el.setAttribute('aria-valuenow', String(Math.round(value)));
    const low = f < this.lowBelow;
    if (low !== this.low) { this.low = low; this.el.classList.toggle('low', low); }
    return this;
  }

  /** `max` may be a number or a function, for a bar whose capacity changes (an upgrade). */
  bind(read: () => number, max: number | (() => number) = 1): this {
    this.own(this.ctx.track(() => this.set(read(), typeof max === 'number' ? max : max())));
    return this;
  }
}

export class UiButton extends UiWidget {
  private shown = '';
  private press: (() => void) | null;

  constructor(ctx: UiContext, text: string, onPress: (() => void) | null, o: BoxOpts & { primary?: boolean } = {}) {
    super(ctx, ctx.doc.createElement('button'), o);
    // A real <button>: it is focusable, Enter and Space press it, and screen readers know it.
    this.el.setAttribute('type', 'button');
    this.el.className = o.primary ? 'hull-btn primary' : 'hull-btn';
    this.press = onPress;
    this.el.addEventListener('click', () => this.press?.());
    this.setText(text);
  }

  setText(text: string): this {
    if (text !== this.shown) { this.shown = text; this.el.textContent = text; }
    return this;
  }

  onPress(fn: (() => void) | null): this { this.press = fn; return this; }

  setDisabled(v: boolean): this {
    if ((this.el as HTMLButtonElement).disabled !== v) (this.el as HTMLButtonElement).disabled = v;
    return this;
  }

  focus(): void { this.el.focus(); }
}

export class UiImage extends UiWidget {
  private src = '';

  constructor(ctx: UiContext, src: string, alt: string, o: BoxOpts = {}) {
    super(ctx, ctx.doc.createElement('img'), o);
    this.el.className = 'hull-img';
    // alt is required: '' marks a decorative image, which screen readers skip.
    this.el.setAttribute('alt', alt);
    this.set(src);
  }

  set(src: string): this {
    if (src !== this.src) { this.src = src; this.el.setAttribute('src', src); }
    return this;
  }
}

export type PanelKind = 'panel' | 'stack' | 'row';

export interface PanelOpts extends BoxOpts {
  /** A panel blocks the mouse for the game under it (a dialog). Default: clicks pass through to the game. */
  solid?: boolean;
  /** Arrow keys move focus between the buttons inside; Escape calls `onBack`. */
  menu?: boolean;
}

export class UiPanel extends UiWidget {
  readonly children: UiWidget[] = [];
  /** Called on Escape inside a `menu` panel. */
  onBack: (() => void) | null = null;

  constructor(ctx: UiContext, readonly kind: PanelKind = 'panel', o: PanelOpts = {}) {
    super(ctx, ctx.doc.createElement('div'), o);
    this.el.className = `hull-${kind}${o.solid ? ' hull-solid' : ''}`;
    if (o.menu) {
      this.el.setAttribute('role', 'menu');
      this.el.addEventListener('keydown', (e) => this.onKey(e));
    }
  }

  add<T extends UiWidget>(w: T): T {
    w.parent = this;
    this.children.push(w);
    this.el.appendChild(w.el);
    return w;
  }

  /** @internal */
  forget(w: UiWidget): void {
    const i = this.children.indexOf(w);
    if (i >= 0) this.children.splice(i, 1);
  }

  panel(o?: PanelOpts): UiPanel { return this.add(new UiPanel(this.ctx, 'panel', o)); }
  stack(o?: PanelOpts): UiPanel { return this.add(new UiPanel(this.ctx, 'stack', o)); }
  row(o?: PanelOpts): UiPanel { return this.add(new UiPanel(this.ctx, 'row', o)); }
  text(text: string, o?: BoxOpts & { muted?: boolean; live?: boolean }): UiText { return this.add(new UiText(this.ctx, text, o)); }
  title(text: string, o?: BoxOpts): UiText { return this.add(new UiText(this.ctx, text, { ...o, title: true })); }
  bar(o?: BoxOpts & { lowBelow?: number }): UiBar { return this.add(new UiBar(this.ctx, o)); }
  button(text: string, onPress?: () => void, o?: BoxOpts & { primary?: boolean }): UiButton {
    return this.add(new UiButton(this.ctx, text, onPress ?? null, o));
  }
  image(src: string, alt: string, o?: BoxOpts): UiImage { return this.add(new UiImage(this.ctx, src, alt, o)); }

  /** Removes every child. */
  clear(): void {
    for (const c of this.children.slice()) c.dispose();
  }

  /** The buttons inside that can take focus, in document order. Allocates: for key presses, not for frames. */
  focusables(): HTMLElement[] {
    return Array.from(this.el.querySelectorAll<HTMLElement>('button:not(:disabled):not(.hull-hidden)'))
      .filter((b) => !b.closest('.hull-hidden'));
  }

  /** Focuses the first button; returns false if there is none. */
  focusFirst(): boolean {
    const f = this.focusables()[0];
    f?.focus();
    return !!f;
  }

  /** Moves focus by `delta` buttons, wrapping. With nothing focused yet, +1 takes the first and -1 the last. */
  focusMove(delta: number): boolean {
    const list = this.focusables();
    if (list.length === 0) return false;
    const at = list.indexOf(this.ctx.doc.activeElement as HTMLElement);
    const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    list[next]!.focus();
    return true;
  }

  private onKey(e: KeyboardEvent): void {
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': this.focusMove(1); break;
      case 'ArrowUp': case 'ArrowLeft': this.focusMove(-1); break;
      case 'Home': { const f = this.focusables()[0]; f?.focus(); break; }
      case 'End': { const l = this.focusables(); l[l.length - 1]?.focus(); break; }
      case 'Escape': if (this.onBack) this.onBack(); else handled = false; break;
      case 'Enter': case ' ': handled = false; break; // the button's own press
      default: handled = false;
    }
    // Keys the menu used must not also reach the game's input listener on the window.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  }
}
