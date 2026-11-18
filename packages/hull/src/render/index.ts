// The render bridge. Games import from here and never from three.js: they add Mesh, Camera and Light to nodes,
// call `instances` for crowds, and the host calls `mountRender`. Backends sit behind the `Backend` interface.
export { Mesh, Camera, Light, instances, activeCamera } from './behaviours.ts';
export type { Instances, InstancesOptions } from './behaviours.ts';
export { mountRender } from './mount.ts';
export type { RenderOptions, RenderView } from './mount.ts';
export { debug } from './debug.ts';
export { teleported } from './interp.ts';
export { defaultLook, resolveLook, sunDirection } from './look.ts';
export type { ResolvedLook, ToneMapping } from './look.ts';
export { materialKey, materialParams } from './materials.ts';
export type { Shape } from './materials.ts';
export type { Backend, Capability, Quality, RenderStats } from './backend.ts';
