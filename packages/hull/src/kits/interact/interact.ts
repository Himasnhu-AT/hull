import { Behaviour, signal, type Node } from '../../core/index.ts';
import { Quaternion, Vector3 } from 'three';
import { num, tunables } from '../../config/index.ts';
import { physicsOf, type Physics, type QueryFilter } from '../../physics/index.ts';
import type { UiView } from '../../ui/index.ts';
import { flagsOf, GROUP, KitUi, LAYER, type KitFlags } from '../common.ts';
import { kitIO } from '../io.ts';

export const interactTuning = tunables('interact', {
  halfAngle: num(55, { min: 5, max: 180, step: 1, unit: 'deg', widget: 'slider', help: 'How far off the facing direction an interactable may be and still count as "in front".' }),
  defaultRadius: num(2.2, { min: 0.3, max: 12, step: 0.1, unit: 'm', help: 'Reach of an Interactable that does not set its own radius.' }),
  closeEnough: num(0.35, { min: 0, max: 2, step: 0.05, unit: 'm', help: 'Closer than this an interactable counts as in front whatever the angle (you stand on it).' }),
});

const GROUP_INTERACTABLE = 'interactable';
const origin = new Vector3();
const there = new Vector3();
const fwd = new Vector3();
const q = new Quaternion();
const filter: QueryFilter = {};

/**
 * Something the player can use: a door, a lever, a chest, a person to talk to. It does nothing by itself; connect to
 * `used` (who used it) and react. `radius` is how close the Interactor must be (0 uses the tuning). With `once` it
 * switches itself off after the first use; turn `enabled` on and off from game code to lock and unlock it.
 */
export class Interactable extends Behaviour {
  static override state = ['enabled', 'uses'];
  radius = 0;
  /** What the prompt says: "Open door". */
  prompt = 'Use';
  enabled = true;
  once = false;
  sound = 'sound/interact';
  uses = 0;
  /** Metres above the node that the Interactor aims at (the middle of a door, not its hinge). */
  height = 0;
  readonly used = signal<[by: Node]>();

  override ready(): void { this.node.addTo(GROUP_INTERACTABLE).addTo(GROUP.save); }

  get reach(): number { return this.radius > 0 ? this.radius : interactTuning.defaultRadius; }

  /** Uses it now, as the Interactor would. False when it is switched off. */
  use(by: Node): boolean {
    if (!this.enabled) return false;
    this.uses++;
    if (this.once) this.enabled = false;
    if (this.sound !== '') kitIO.play(this.sound);
    this.used.emit(by);
    return true;
  }
}

/**
 * Finds the nearest enabled Interactable that is in range, in front of this node's forward (-Z) and not behind a wall
 * (a ray on `mask` to its centre), shows its prompt, and uses it on the `interact` action. Put it on the node that
 * looks (the first-person eye) or on the player with `height` set. The prompt goes to the Hud when the world has one
 * (a node named "hud" whose behaviour has a `prompt(text | null)` method), otherwise to a small prompt of its own.
 */
export class Interactor extends Behaviour {
  action = 'interact';
  /** Label of the key in the prompt. */
  key = 'E';
  /** Metres above the node that the search starts. */
  height = 0;
  /** Layers that block the line to an interactable. */
  mask = LAYER.world;
  /** The one the next press will use, or null. */
  target: Interactable | null = null;
  /** The prompt text now showing ("" when none). */
  promptText = '';
  readonly targetChanged = signal<[target: Interactable | null]>();
  private phys!: Physics;
  private flags!: KitFlags;
  private shown: Interactable | null = null;
  private hud: { prompt(text: string | null): void } | null | undefined = undefined;

  override ready(): void {
    this.phys = physicsOf(this.world);
    this.flags = flagsOf(this.world);
    if (this.node.get(InteractPrompt) === undefined) this.node.add(InteractPrompt);
  }

  override fixedUpdate(_dt: number): void {
    if (this.flags.paused) return;
    this.find();
    if (this.target !== this.shown) this.show(this.target);
    if (this.target && kitIO.input.action(this.action).pressed) this.target.use(this.node);
  }

  private find(): void {
    const list = this.world.group(GROUP_INTERACTABLE);
    this.node.object3d.getWorldPosition(origin);
    origin.y += this.height;
    this.node.object3d.getWorldQuaternion(q);
    fwd.set(0, 0, -1).applyQuaternion(q);
    const cosMin = Math.cos((interactTuning.halfAngle * Math.PI) / 180);
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const it = list[i]!.get(Interactable);
      if (!it || !it.enabled) continue;
      it.node.object3d.getWorldPosition(there);
      there.y += it.height;
      there.sub(origin);
      const d = there.length();
      if (d > it.reach || d >= bestD) continue;
      if (d > interactTuning.closeEnough && there.dot(fwd) < cosMin * d) continue;
      if (d > 0.05) {
        filter.mask = this.mask;
        filter.ignoreNode = it.node;
        const h = this.phys.raycast(origin, there, d, filter);
        if (h !== null && h.distance < d - 0.05) continue;
      }
      best = it;
      bestD = d;
    }
    this.target = best;
  }

  private show(t: Interactable | null): void {
    this.shown = t;
    this.promptText = t ? `[${this.key}] ${t.prompt}` : '';
    this.hud ??= this.findHud();
    this.hud?.prompt(t ? this.promptText : null);
    this.targetChanged.emit(t);
  }

  private findHud(): { prompt(text: string | null): void } | null {
    const n = this.world.find('hud');
    if (!n) return null;
    for (const b of n.behaviours) {
      if (typeof (b as { prompt?: unknown }).prompt === 'function') return b as unknown as { prompt(text: string | null): void };
    }
    return null;
  }

  /** True while the prompt is drawn by the Hud instead of by this kit. */
  get usesHud(): boolean { return this.hud != null; }
}

/** The Interactor's own prompt, bottom centre. It stays hidden when a Hud draws the prompt. */
export class InteractPrompt extends KitUi {
  protected build(ui: UiView): void {
    const me = this.node.get(Interactor)!;
    const p = ui.root.panel({ anchor: 'bottom', label: 'Prompt' });
    p.bindVisible(() => me.promptText !== '' && !me.usesHud);
    p.title('').bind(() => me.promptText);
  }
}
