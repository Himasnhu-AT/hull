// Aya's HUD: health, posture and stance at the bottom left, and the locked enemy's posture bar riding over its head.
import { Vector3 } from 'hull/three';
import { Camera } from 'hull/render';
import { Combatant, KitUi, Health, kitIO } from 'hull/kits';
import type { UiBar, UiPanel, UiText, UiView } from 'hull/ui';
import { Aya } from './aya';

const NAMES = ['Stone', 'Water', 'Wind'];
const v = new Vector3();

export class AyaHud extends KitUi {
  private aya!: Aya;
  private health!: Health;
  private foe: UiPanel | null = null;
  private foeBar: UiBar | null = null;
  private foeName: UiText | null = null;
  private root: HTMLElement | null = null;
  private cam: Camera | null = null;
  /** The locked enemy's bar, for tests: 0..1 and whether it is visible. */
  foeShown = false;

  override ready(): void {
    this.aya = this.node.get(Aya)!;
    this.health = this.node.get(Health)!;
  }

  protected build(ui: UiView): void {
    const c = this.aya.c;
    const p = ui.root.panel({ anchor: 'bottom-left', label: 'Aya', width: 280 });
    p.text('HEALTH', { muted: true });
    p.bar({ label: 'Health', lowBelow: 0.3 }).bind(() => this.health.hp, () => this.health.max);
    p.text('POSTURE', { muted: true });
    p.bar({ label: 'Posture' }).bind(() => this.aya.c.posture, () => this.aya.c.maxPosture);
    p.text('').bind(() => this.aya.c.stance, (s: string) => 'STANCE  ' + (NAMES[['stone', 'water', 'wind'].indexOf(s)] ?? s).toUpperCase());
    void c;
    this.root = ui.root.el;
    const foe = ui.root.panel({ label: 'Target', width: 150 });
    foe.el.style.cssText += ';position:absolute;left:0;top:0;pointer-events:none;will-change:transform';
    this.foeName = foe.text('', { muted: true });
    this.foeBar = foe.bar({ label: 'Enemy posture', lowBelow: 0 });
    this.foe = foe;
    foe.show(false);
  }

  override update(dt: number, alpha: number): void {
    super.update(dt, alpha);
    const foe = this.foe;
    if (!foe || !this.root) return;
    const t = this.aya.lock?.target ?? null;
    const cc = t?.get(Combatant);
    this.foeShown = !!t && !!cc && cc.state !== 'dead';
    if (!this.foeShown || !t || !cc) { foe.show(false); return; }
    this.cam ??= this.aya.world.find('camera')?.get(Camera) ?? null;
    const view = this.cam?.view;
    if (!view) { foe.show(false); return; }
    v.set(t.position.x, t.position.y + 2.3, t.position.z).project(view);
    if (v.z > 1 || v.z < -1) { foe.show(false); return; }
    const w = this.root.clientWidth, h = this.root.clientHeight;
    foe.show(true);
    foe.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * w - 75).toFixed(0)}px,${((-v.y * 0.5 + 0.5) * h).toFixed(0)}px)`;
    this.foeName?.set(t.name.replace(/-\d+$/, ''));
    this.foeBar?.set(cc.posture, cc.maxPosture);
    void kitIO;
  }
}
