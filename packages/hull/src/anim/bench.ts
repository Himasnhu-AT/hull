// What a project hands the Studio's character bench so it shows the model the game really draws. The bench keeps its
// own turntable, camera and Animator (clips and the state graph run on the character's skeleton as usual); a project
// that builds its bodies in code registers a builder per character id, and the bench puts that body on the skeleton
// in place of its rigid stand-in. The project's module is bundled for the bench by the project server (hull.json
// "models") and its default export is called once with the registry.
import type { Object3D } from 'three';
import type { Animator } from './animator.ts';

/** What the bench tells a model each frame. */
export interface BenchView {
  /** The bench's Animator for this character: its clips, graph parameters and skeleton. */
  animator: Animator;
  /** The clip held in Clips mode, or null in State graph mode. */
  clip: string | null;
  /** True while the turntable clip is playing (false when scrubbed or paused). */
  playing: boolean;
  /** Seconds since the model was built. */
  time: number;
}

/** One model on the bench. */
export interface BenchModel {
  /** The body, feet on y = 0 and facing +Z (towards the bench camera); metres. Hull draws it; the bench destroys it with the character, so dispose of what you made in `dispose`. */
  object: Object3D;
  /**
   * Joints of the object by the character's bone names ("hips", "armL", "forearmL"...). Each frame the bench copies the
   * skeleton's pose onto them, so the clips and the state graph move the real body. Leave it out for a body that moves itself.
   */
  bones?: Record<string, Object3D>;
  /** Whether the object's frame is the config's turned half a circle about Y (it faces +Z, the config faces -Z). Default true. */
  turned?: boolean;
  /** Copy the bones' offsets as well as their rotations. Default false: rotations only. */
  offsets?: boolean;
  /** Called every frame before the pose is copied: run the body's own update (cloth, gait) here. */
  update?(dt: number, view: BenchView): void;
  /** Called every frame after the pose is copied (skinned bodies refresh their bone matrices here). */
  posed?(): void;
  /** Box the body fills in metres, for framing the camera. Without it the bench measures the object. */
  bounds?(): { min: [number, number, number]; max: [number, number, number] } | null;
  dispose?(): void;
}

export type BenchModelBuilder = (id: string) => BenchModel;

/** The registry the module's default export receives. `match` is a character id ("soldier") or a prefix with a star ("titan-*"). */
export type RegisterBenchModel = (match: string, build: BenchModelBuilder) => void;
