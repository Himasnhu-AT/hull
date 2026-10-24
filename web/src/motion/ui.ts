// Page widgets: settings-style tabs, copy buttons, real-number counters, the before/after split.
import { gsap } from 'gsap';
import { onPage, onScroll, ease, prefersReducedMotion } from '../engine';

function wireTabs(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')!)!);
  const line = root.querySelector<HTMLElement>('[data-tab-line]');
  const place = (t: HTMLElement, instant: boolean) => {
    if (!line) return;
    const to = { x: t.offsetLeft, width: t.offsetWidth };
    instant || prefersReducedMotion() ? gsap.set(line, to) : gsap.to(line, { ...to, duration: 0.3, ease: ease.soft, overwrite: true });
  };
  const show = (i: number, focus = false, instant = false) => {
    tabs.forEach((t, j) => {
      const on = i === j;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panels[j].hidden = !on;
    });
    if (focus) tabs[i].focus();
    place(tabs[i], instant);
    if (!instant && !prefersReducedMotion()) {
      gsap.fromTo(panels[i].querySelectorAll('.row, .about'), { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.04, ease: ease.out, overwrite: true });
    }
  };
  const offs: (() => void)[] = [];
  tabs.forEach((t, i) => {
    const click = () => show(i);
    const key = (e: KeyboardEvent) => {
      const k = e.key;
      let n = -1;
      if (k === 'ArrowRight' || k === 'e' || k === 'E') n = (i + 1) % tabs.length;
      if (k === 'ArrowLeft' || k === 'q' || k === 'Q') n = (i - 1 + tabs.length) % tabs.length;
      if (k === 'Home') n = 0;
      if (k === 'End') n = tabs.length - 1;
      if (n >= 0) { e.preventDefault(); show(n, true); }
    };
    t.addEventListener('click', click);
    t.addEventListener('keydown', key);
    offs.push(() => { t.removeEventListener('click', click); t.removeEventListener('keydown', key); });
  });
  root.classList.add('is-tabs');
  show(0, false, true);
  document.fonts?.ready.then(() => place(tabs[tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')] ?? tabs[0], true));
  const ro = new ResizeObserver(() => place(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0], true));
  ro.observe(root);
  return () => { offs.forEach((f) => f()); ro.disconnect(); };
}

function wireCompare(root: HTMLElement) {
  const input = root.querySelector<HTMLInputElement>('input[type="range"]');
  if (!input) return () => {};
  const set = () => root.style.setProperty('--pos', `${input.value}%`);
  input.addEventListener('input', set);
  set();
  // A short sweep when it enters the view shows that the split moves.
  let tween: gsap.core.Tween | null = null;
  if (!prefersReducedMotion()) {
    const o = { v: 50 };
    tween = gsap.fromTo(o, { v: 82 }, { v: 50, duration: 1.4, ease: ease.inOut, paused: true, onUpdate: () => { input.value = String(o.v); set(); } });
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { tween?.play(); io.disconnect(); } }, { threshold: 0.5 });
    io.observe(root);
    return () => { io.disconnect(); input.removeEventListener('input', set); };
  }
  return () => input.removeEventListener('input', set);
}

export function startUi() {
  document.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest?.<HTMLButtonElement>('[data-copy]');
    if (!b) return;
    const text = b.closest('[data-code]')?.querySelector('pre')?.textContent ?? '';
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  });

  onPage(() => {
    const offs: (() => void)[] = [];
    document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((t) => offs.push(wireTabs(t)));
    document.querySelectorAll<HTMLElement>('[data-compare]').forEach((c) => offs.push(wireCompare(c)));
    // Step index (Start page): the selection bar follows the last step whose top crossed 45% of
    // the viewport, measured live on the shared scroll feed; the last step wins at the very end.
    const index = document.querySelector<HTMLElement & { rest?: () => void }>('[data-steps-index]');
    if (index) {
      const links = [...index.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
      const steps = links.map((a) => document.querySelector<HTMLElement>(a.hash));
      let active = -1;
      const spy = () => {
        let i = 0;
        steps.forEach((s, j) => { if (s && s.getBoundingClientRect().top <= innerHeight * 0.45) i = j; });
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
          const last = steps.length - 1;
          if ((steps[last]?.getBoundingClientRect().top ?? Infinity) < innerHeight) i = last;
        }
        if (i === active) return;
        active = i;
        links.forEach((l, j) => (j === i ? l.setAttribute('aria-current', 'step') : l.removeAttribute('aria-current')));
        index.rest?.();
      };
      spy();
      offs.push(onScroll(spy) as () => void);
    }
    // Settings rows, as on the engine's settings screen: the row under the pointer is selected
    // and the side panel turns into "About this setting" for it.
    document.querySelectorAll<HTMLElement>('[data-select-rows]').forEach((list) => {
      const rows = [...list.querySelectorAll<HTMLElement>(':scope > .row, :scope > .step')];
      const panel = list.parentElement?.querySelector<HTMLElement>('.about');
      const set = (row: HTMLElement) => {
        rows.forEach((r) => r.classList.toggle('is-sel', r === row));
        if (!panel) return;
        const label = panel.querySelector('[data-about-label]');
        const title = panel.querySelector('[data-about-title]');
        const text = panel.querySelector('[data-about-text]');
        if (label) label.textContent = 'About this setting';
        if (title) title.textContent = row.querySelector('.row__label')?.textContent ?? '';
        if (text) text.textContent = row.querySelector('.row__hint')?.textContent ?? '';
      };
      rows.forEach((r) => {
        const on = () => set(r);
        r.addEventListener('pointerenter', on);
        offs.push(() => r.removeEventListener('pointerenter', on));
      });
    });
    // Counters: real numbers only, counting toward the measured value.
    document.querySelectorAll<HTMLElement>('[data-count-to]').forEach((el) => {
      const to = parseFloat(el.dataset.countTo!);
      const from = parseFloat(el.dataset.countFrom ?? '0');
      const dec = parseInt(el.dataset.dec ?? '0', 10);
      const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      if (prefersReducedMotion()) { el.textContent = fmt(to); return; }
      const o = { v: from };
      el.textContent = fmt(from);
      gsap.to(o, { v: to, duration: 1.6, ease: ease.out, scrollTrigger: { trigger: el, start: 'top 85%', once: true }, onUpdate: () => { el.textContent = fmt(o.v); } });
    });
    return () => offs.forEach((f) => f());
  });
}
