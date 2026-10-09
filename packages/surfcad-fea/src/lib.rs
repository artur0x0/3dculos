//! SurfCAD FEA scaffold.
//!
//! The pure solver lives in [`stub`] and is what `cargo test` covers. The
//! wasm-bindgen exports in `api` are compiled only for `wasm32` and are the
//! boundary the module worker calls. Phase 0 does not solve an element model.

pub mod stub;

#[cfg(target_arch = "wasm32")]
mod api;
