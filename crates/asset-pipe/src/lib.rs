#![allow(clippy::chunks_exact_to_as_chunks, clippy::too_many_arguments)]
//! 3D asset pipeline (docs/ASSETS.md, "3D pipeline"): glTF in, staged cook, cooked asset out.
//!
//! - [`desc`]: the `.asset.ron` sidecar (shared with the engine runtime; always built).
//! - `model`, `gltf_in`, `glb_out`: the in-memory model and the glTF reader / GLB writer.
//! - `simplify`, `collider`, `impostor`: the geometry stages' algorithms.
//! - `pipeline`: [`pipeline::Stage`], [`pipeline::Pipeline`] and the standard stages. Add your own
//!   by implementing `Stage` and pushing it (or inserting it after a named stage).
//! - `fixtures`: a procedural tree for tests and the demo.

pub mod desc;

#[cfg(feature = "pipeline")]
mod model;
#[cfg(feature = "pipeline")]
pub use model::*;
#[cfg(feature = "pipeline")]
pub mod collider;
#[cfg(feature = "pipeline")]
pub mod fixtures;
#[cfg(feature = "pipeline")]
pub mod glb_out;
#[cfg(feature = "pipeline")]
pub mod gltf_in;
#[cfg(feature = "pipeline")]
pub mod impostor;
#[cfg(feature = "pipeline")]
pub mod pipeline;
#[cfg(feature = "pipeline")]
pub mod simplify;
