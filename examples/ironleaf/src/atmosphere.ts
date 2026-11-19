// Time of day and weather: three looks (golden dusk, grey rain, moonlit night), the wind and the sounds that go with
// each, the rain and the fireflies. L changes the look; `?look=rain` starts on one. The look is the Studio's `look` config, so
// everything about how it is lit and graded is tuned there; this file only says which look is on and what the air does.
import { Behaviour, type Node } from 'hull';
import { vfx, type TrailHandle } from 'hull/vfx';
import { Combatant, FIGHTERS, LockOn, kitIO } from 'hull/kits';
import { clearU, windU } from './world/wind';
import { groundHeight, surfaceAt } from './world/map';
import { Aya } from './player/aya';

export const LOOKS = ['dusk', 'rain', 'night'] as const;
export type LookName = (typeof LOOKS)[number];

interface Weather {
  wind: number;
  windSpeed: number;
  /** Looping sounds that play under this look. */
  loops: string[];
  /** Effects that follow the camera under this look: [id, height above the player]. */
  trails: [string, number][];
}

export const WEATHER: Record<LookName, Weather> = {
  dusk: { wind: 0.4, windSpeed: 1.3, loops: ['sound/loop/wind', 'sound/loop/cicadas', 'sound/loop/sea'], trails: [['vfx/petals', 3]] },
  rain: { wind: 0.95, windSpeed: 2.1, loops: ['sound/loop/wind-strong', 'sound/loop/rain'], trails: [['vfx/rain', 15], ['vfx/rain-splash', 0.1]] },
  night: { wind: 0.25, windSpeed: 1.0, loops: ['sound/loop/wind', 'sound/loop/frogs', 'sound/loop/sea'], trails: [['vfx/fireflies', 1.6]] },
};

interface RenderView { setLook(id: string): void }
interface AudioHandle { stop?(): void }
interface Views { render?: RenderView; audio?: { play(id: string, o?: unknown): AudioHandle | undefined } }
const views = (): Views | undefined => (globalThis as { hull?: Views }).hull;

function lookFromUrl(): LookName | null {
  const loc = (globalThis as { location?: { search: string; hash: string } }).location;
  if (!loc) return null;
  const q = new URLSearchParams(loc.search).get('look') ?? new URLSearchParams(loc.hash.replace(/^#/, '')).get('look');
  return (LOOKS as readonly string[]).includes(q ?? '') ? (q as LookName) : null;
}

/** Owns which look is on. Put it on its own node; it follows the node named "player". */
export class Atmosphere extends Behaviour {
  static override state = ['index'];
  index = 0;
  private applied = -1;
  private loops: AudioHandle[] = [];
  private trails: { h: TrailHandle; node: Node; lift: number }[] = [];
  private player: Node | null = null;
  private audioTried = false;

  override ready(): void {
    const want = lookFromUrl();
    if (want) this.index = LOOKS.indexOf(want);
    vfx.setGround(groundHeight);
  }

  get look(): LookName { return LOOKS[this.index]!; }

  /** Switches to a look by name or by turning to the next one. */
  set(look: LookName | 'next'): void {
    this.index = look === 'next' ? (this.index + 1) % LOOKS.length : LOOKS.indexOf(look);
  }

  override fixedUpdate(): void {
    if (kitIO.input.action('looks').pressed) this.set('next');
  }

  override dispose(): void { this.clearWeather(); }

  override update(): void {
    const v = views();
    this.player ??= this.world.find('player') ?? null;
    if (this.index !== this.applied) {
      if (v?.render) {
        v.render.setLook('look/' + this.look);
        this.apply();
        this.applied = this.index;
      } else if (!v) {
        // Headless: there is no renderer, but the wind still follows the look.
        this.apply();
        this.applied = this.index;
      }
    }
    // Late-arriving audio: the page mounts it after the game starts, and the browser only lets it run after a first click.
    if (this.applied === this.index && !this.audioTried && v?.audio) { this.audioTried = true; this.startLoops(); }
    const p = this.player;
    if (p) this.clearGrass(p);
    if (p) for (const t of this.trails) t.node.position.set(p.position.x, p.position.y + t.lift, p.position.z);
  }

  /**
   * Tells the pampas where the camera, Aya and the enemy she fights are, so the grass between them and around the fight is
   * cut low (the third-person camera sits behind her and the grass is as tall as she is). The enemy is her lock-on target,
   * or else the nearest awake raider within 12 m.
   */
  private clearGrass(p: Node): void {
    const cam = this.world.find('camera');
    if (cam) clearU.uCamPos.value.set(cam.position.x, cam.position.y, cam.position.z);
    clearU.uFocus.value.set(p.position.x, p.position.y, p.position.z);
    let foe: Node | null = p.get(LockOn)?.target ?? null;
    if (foe && (foe.destroyed || foe.get(Combatant)?.isDead)) foe = null;
    if (!foe) {
      let best = 144;
      const g = this.world.group(FIGHTERS);
      for (let i = 0; i < g.length; i++) {
        const n = g[i]!;
        if (n === p || n.destroyed) continue;
        const c = n.get(Combatant);
        if (!c || c.isDead || c.team === 'player') continue;
        const d = (n.position.x - p.position.x) ** 2 + (n.position.z - p.position.z) ** 2;
        if (d < best) { best = d; foe = n; }
      }
    }
    if (foe) { clearU.uFoe.value.set(foe.position.x, foe.position.y, foe.position.z); clearU.uFoeOn.value = 1; } else clearU.uFoeOn.value = 0;
  }

  private apply(): void {
    const w = WEATHER[this.look];
    windU.uWind.value = w.wind;
    windU.uSpeed.value = w.windSpeed;
    this.clearWeather();
    for (const [id, lift] of w.trails) {
      const n = this.world.spawn('weather', this.node);
      const h = vfx.trail(id, n);
      this.trails.push({ h, node: n, lift });
    }
    this.audioTried = false;
  }

  private startLoops(): void {
    const a = views()?.audio;
    if (!a) return;
    for (const id of WEATHER[this.look].loops) {
      const h = a.play(id);
      if (h) this.loops.push(h);
    }
  }

  private clearWeather(): void {
    for (const l of this.loops) l.stop?.();
    this.loops.length = 0;
    for (const t of this.trails) { t.h.stop(); if (!t.node.destroyed) t.node.destroy(); }
    this.trails.length = 0;
  }
}

/** Sets the footstep sound from what Aya stands on, and from the weather (mud when it rains on dirt). */
export class Footing extends Behaviour {
  private tp!: Aya;
  private weather: Atmosphere | null = null;
  override ready(): void { this.tp = this.node.get(Aya)!; }
  override fixedUpdate(): void {
    this.weather ??= this.world.find('atmosphere')?.get(Atmosphere) ?? null;
    let s = surfaceAt(this.node.position.x, this.node.position.z);
    if (this.weather?.look === 'rain' && (s === 'dirt' || s === 'grass')) s = 'mud';
    this.tp.stepSound = 'sound/step/' + s;
  }
}
