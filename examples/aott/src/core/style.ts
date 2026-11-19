// Shared material look: physically based materials for everything.
import * as THREE from 'hull/three';

/** Options for litMaterial: any MeshStandardMaterial parameter. */
export type LitOptions = THREE.MeshStandardMaterialParameters;

/**
 * The game's standard surface: a PBR MeshStandardMaterial. Defaults to a matte dielectric (roughness 0.85,
 * metalness 0); opts pass straight through (map, normalMap, roughness, metalness, emissive, side, transparent...).
 * Suggested roughness: cloth 0.9, skin 0.6, stone 0.95, wood 0.8, leather 0.7, steel 0.35 with metalness 1.
 */
export function litMaterial(color?: THREE.ColorRepresentation, opts: LitOptions = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
}
