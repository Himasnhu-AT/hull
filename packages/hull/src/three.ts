// hull/three: the engine's own copy of three.js, re-exported. A game that builds three.js objects itself (see
// `SceneObject` in hull/render) imports from here, so the game and the render backends share one copy and `instanceof`
// holds across the two. Everything the three package exports is here unchanged, plus the few addon helpers games
// reach for most (the addons are separate files in three's package, so they are named here one by one).
export * from 'three';
export { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
export { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
