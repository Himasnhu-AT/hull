// The animation system: skeletons generated from a character config, clips (keyframes or generated), a state graph
// with blending, IK, and the Animator behaviour that runs them on game time.
export { Animator, Limb } from './animator.ts';
export { registerGenerator, generatorNames, compileClip, sampleClip, evalCurve } from './clip.ts';
export type { Clip, ClipEvent, Generated, GeneratorFactory } from './clip.ts';
export { Graph, compileCondition } from './graph.ts';
export { twoBone, lookAt } from './ik.ts';
export { characterHits } from './hits.ts';
export type { ResolvedHit } from './hits.ts';
export { Skeleton, Pose, buildBody, humanoidDims, accumulate, composite, REF_HEIGHT } from './skeleton.ts';
export type { HumanoidDims, BuiltBody } from './skeleton.ts';
