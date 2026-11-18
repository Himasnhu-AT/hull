// The render bridge. M0 carries only what `hull dev` needs to show the cube (a WebGL2 view of the node tree);
// M1 puts it behind the Backend interface from the build design. CONTRACT STUB: the cli worker fills it.
import { Behaviour, type Game } from '../core/index.ts';

export declare class Mesh extends Behaviour {
  shape: 'box' | 'sphere' | 'plane';
  color: string;
}
export declare class Camera extends Behaviour {
  fov: number;
  near: number;
  far: number;
}
export declare function mountRender(game: Game, el: HTMLElement): { dispose(): void };
