// The render budget's distance rules, as the engine applies them. Shared by the build and the page.
// Distances are metres at High quality, multiplied by the preset's detail_scale.

export const BASE = { shadow: 50, small_props: 60, far: 80, view: 170 };
export const SMALL_SIDE = 1.5; // largest side under this is a "small prop"

export const PRESETS = [
  { id: "low", label: "Low", scale: 0.6 },
  { id: "medium", label: "Medium", scale: 0.8 },
  { id: "high", label: "High", scale: 1.0 },
  { id: "ultra", label: "Ultra", scale: 1.5 },
];

export const rangesAt = (scale) => ({
  shadow: BASE.shadow * scale,
  small_props: BASE.small_props * scale,
  far: BASE.far * scale,
  view: BASE.view * scale,
});

// Tiers: full (detail + shadow), noshadow, faded (small prop dithered out), twin (flat far twin), gone.
export function tierOf(piece, R) {
  const d = piece.m;
  if (piece.actor) return "full";
  if (d > R.view) return "gone";
  if (piece.small) {
    if (d > R.small_props) return "faded";
    if (d > R.shadow) return "noshadow";
    return "full";
  }
  if (d > R.far) return "twin";
  return "full";
}

// What each tier draws: [shadow, detail, visible].
export function looksOf(tier) {
  switch (tier) {
    case "full": return { shadow: 1, detail: 1, show: 1 };
    case "noshadow": return { shadow: 0, detail: 1, show: 1 };
    case "faded": return { shadow: 0, detail: 1, show: 0 };
    case "twin": return { shadow: 0, detail: 0, show: 1 };
    default: return { shadow: 0, detail: 0, show: 0 };
  }
}

export const TIERS = ["full", "noshadow", "faded", "twin", "gone"];
