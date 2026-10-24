// The selection bar (the motion verb) and the pause menu (site navigation).
import { gsap } from 'gsap';
import { onPage, ease, stopScroll, startScroll, prefersReducedMotion } from '../engine';

const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>(':scope > li > a, :scope > li > button')];

/** One accent bar per menu slides to the item under the pointer or focus; it rests on the home item. */
function wireMenu(menu: HTMLElement) {
  const list = items(menu);
  if (!list.length) return () => {};
  const home = () => list.find((i) => i.hasAttribute('aria-current')) ?? list[0];
  let sel: HTMLElement | null = null;
  const motion = !prefersReducedMotion();
  let bar: HTMLElement | null = null;
  if (motion) {
    bar = document.createElement('span');
    bar.className = 'menu__bar';
    bar.setAttribute('aria-hidden', 'true');
    menu.prepend(bar);
  }
  const select = (el: HTMLElement, instant = false) => {
    if (sel === el) return;
    sel?.classList.remove('is-sel');
    sel = el;
    el.classList.add('is-sel');
    if (!bar) return;
    const li = el.parentElement!;
    const to = { y: li.offsetTop, height: li.offsetHeight, autoAlpha: 1 };
    if (instant) gsap.set(bar, to);
    else gsap.to(bar, { ...to, duration: 0.28, ease: ease.soft, overwrite: true });
  };
  const offs: (() => void)[] = [];
  list.forEach((el) => {
    const on = () => select(el);
    el.addEventListener('pointerenter', on);
    el.addEventListener('focus', on);
    offs.push(() => { el.removeEventListener('pointerenter', on); el.removeEventListener('focus', on); });
  });
  const rest = () => { if (!menu.contains(document.activeElement) && !menu.matches(':hover')) select(home()); };
  (menu as HTMLElement & { rest?: () => void }).rest = rest;
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  };
  menu.addEventListener('pointerleave', rest);
  menu.addEventListener('focusout', () => requestIdle(rest));
  menu.addEventListener('keydown', key);
  // Place after layout settles (fonts can change item heights).
  select(home(), true);
  document.fonts?.ready.then(() => { if (sel && bar) gsap.set(bar, { y: sel.parentElement!.offsetTop, height: sel.parentElement!.offsetHeight }); });
  const ro = new ResizeObserver(() => { if (sel && bar) gsap.set(bar, { y: sel.parentElement!.offsetTop, height: sel.parentElement!.offsetHeight }); });
  ro.observe(menu);
  // Re-place after the menu becomes visible (it was laid out while hidden).
  (menu as HTMLElement & { refresh?: () => void }).refresh = () => {
    const f = list.find((i) => i === document.activeElement) ?? home();
    list.forEach((i) => i.classList.remove('is-sel'));
    sel = null;
    select(f, true);
  };
  return () => { offs.forEach((f) => f()); menu.removeEventListener('pointerleave', rest); menu.removeEventListener('keydown', key); ro.disconnect(); bar?.remove(); };
}
const requestIdle = (fn: () => void) => setTimeout(fn, 0);

// ---- Pause menu ----
let lastFocus: HTMLElement | null = null;
const isOpen = () => document.documentElement.classList.contains('is-paused');

function openMenu() {
  const m = document.getElementById('menu');
  if (!m || isOpen()) return;
  lastFocus = document.activeElement as HTMLElement;
  const h = document.documentElement;
  h.classList.add('is-paused');
  h.classList.remove('frame-away');
  m.hidden = false;
  document.querySelector('[data-menu-open]')?.setAttribute('aria-expanded', 'true');
  const label = document.querySelector('[data-state-label]');
  if (label) label.textContent = 'Paused';
  stopScroll();
  document.body.style.overflow = 'hidden';
  if (!prefersReducedMotion()) {
    gsap.timeline()
      .fromTo(m, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: ease.soft })
      .fromTo(m.querySelectorAll('.pause__title, .pause .menu li, .pause__side'), { x: -40, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.5, stagger: 0.035, ease: ease.out }, 0.05);
  }
  m.querySelector<HTMLElement>('[data-resume]')?.focus();
  (m.querySelector('[data-menu]') as (HTMLElement & { refresh?: () => void }) | null)?.refresh?.();
}

function closeMenu(restore = true) {
  const m = document.getElementById('menu');
  if (!m || !isOpen()) return;
  const h = document.documentElement;
  const done = () => {
    m.hidden = true;
    h.classList.remove('is-paused');
    document.body.style.overflow = '';
    document.querySelector('[data-menu-open]')?.setAttribute('aria-expanded', 'false');
    const label = document.querySelector<HTMLElement>('[data-state-label]');
    const main = document.querySelector<HTMLElement>('main');
    if (label && main) label.textContent = main.dataset.state === 'Main menu' && scrollY > innerHeight * 0.55 ? 'In game' : main.dataset.state || '';
    startScroll();
    if (restore) lastFocus?.focus?.();
  };
  if (prefersReducedMotion() || !restore) return done();
  gsap.to(m, { autoAlpha: 0, duration: 0.2, ease: ease.soft, onComplete: () => { gsap.set(m, { clearProps: 'opacity,visibility' }); done(); } });
}

export function startMenus() {
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.('[data-menu-open]')) { isOpen() ? closeMenu() : openMenu(); return; }
    if (t.closest?.('[data-resume]')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      isOpen() ? closeMenu() : openMenu();
      return;
    }
    if (e.key === 'Tab' && isOpen()) {
      // Focus trap inside the pause menu.
      const m = document.getElementById('menu')!;
      const f = [...m.querySelectorAll<HTMLElement>('a[href], button:not([tabindex="-1"])')].filter((x) => x.offsetParent);
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Leaving through a menu link: the screen push slides over the open menu, and the swap
  // brings a fresh, closed one (Astro replaces <body> and the <html> classes).

  onPage(() => {
    document.querySelector('[data-menu-open]')?.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    const offs = [...document.querySelectorAll<HTMLElement>('[data-menu]')].map(wireMenu);
    return () => { offs.forEach((f) => f()); };
  });
}
