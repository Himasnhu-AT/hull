// The corner FPS counter measures this page, the way the engine's counter measures a game.
// Redraws 4 times a second, like the metrics window. Under reduced motion it reads once and holds.
import { gsap } from 'gsap';
import { prefersReducedMotion } from '../engine';

export function startFps() {
  let frames = 0;
  let since = performance.now();
  let readings = 0;
  const tick = () => {
    frames++;
    const now = performance.now();
    const dt = now - since;
    if (dt < 250) return;
    const n = document.querySelector('[data-fps-n]');
    const ms = document.querySelector('[data-fps-ms]');
    const fps = (frames * 1000) / dt;
    if (n) n.textContent = String(Math.round(fps));
    if (ms) ms.textContent = `${(dt / frames).toFixed(1)} ms`;
    frames = 0;
    since = now;
    readings++;
    if (prefersReducedMotion() && readings >= 4) gsap.ticker.remove(tick);
  };
  gsap.ticker.add(tick);
  // A hidden tab has no frames to count: start a fresh window when it comes back.
  document.addEventListener('visibilitychange', () => { frames = 0; since = performance.now(); });
}
