//! SurfCAD FEA.
//!
//! [`stub`] is the phase-0 placeholder behind the `solve` export. [`fem`] is
//! the linear-elastic TET10 solver behind `solve_tet10`. The wasm-bindgen
//! exports in `api` are compiled only for `wasm32`. Mesh generators used by
//! the native tests and the scale bench are not part of the wasm build.

pub mod fem;
#[cfg(not(target_arch = "wasm32"))]
pub mod meshgen;
pub mod stub;

#[cfg(target_arch = "wasm32")]
mod api;
