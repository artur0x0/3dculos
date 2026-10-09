//! wasm-bindgen boundary. The worker passes typed arrays through as slices
//! (copied into the wasm heap by the bindgen ABI) and receives `nodal` back
//! as a `Float32Array` the worker copies out before transferring to the page.

use crate::stub::{self, Material, Profile, Study, Warning, SOURCE_STUB, VERSION};
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    version: &'static str,
    solvers: [&'static str; 1],
    simd: bool,
    threads: bool,
    max_dofs: MaxDofs,
}

#[derive(serde::Serialize)]
struct MaxDofs {
    phone: u32,
    desktop: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire<'a> {
    source: &'static str,
    field: &'static str,
    units: &'static str,
    min: f32,
    max: f32,
    p95: f32,
    safety_factor: Option<f64>,
    /// Same value as `safetyFactor`. Kept so the phase-0 contract name `fos` resolves.
    fos: Option<f64>,
    warnings: &'a [Warning],
    stats: Stats,
}

#[derive(serde::Serialize)]
struct Stats {
    dofs: u32,
    ms: f64,
    vertices: u32,
    triangles: u32,
}

fn js_err(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

fn failure(err: stub::SolveError) -> JsValue {
    js_err(&err.to_string())
}

#[wasm_bindgen(js_name = capabilities)]
pub fn capabilities() -> Result<JsValue, JsValue> {
    let caps = Capabilities {
        version: VERSION,
        solvers: ["stub"],
        simd: stub::simd_compiled(),
        threads: false,
        max_dofs: MaxDofs {
            phone: stub::PHONE_MAX_DOFS,
            desktop: stub::DESKTOP_MAX_DOFS,
        },
    };
    serde_wasm_bindgen::to_value(&caps).map_err(|err| js_err(&err.to_string()))
}

#[wasm_bindgen(js_name = solve)]
pub fn solve(
    study: JsValue,
    positions: &[f32],
    indices: &[u32],
    face_ids: &[u32],
    material: JsValue,
    profile: &str,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let study = parse_study(&study).map_err(failure)?;
    let material = parse_material(&material).map_err(failure)?;
    let profile = Profile::parse(profile).map_err(failure)?;
    let output =
        stub::solve(&study, positions, indices, face_ids, material, profile).map_err(failure)?;
    let elapsed = js_sys::Date::now() - started;
    let wire = Wire {
        source: SOURCE_STUB,
        field: "von_mises",
        units: "MPa",
        min: output.min,
        max: output.max,
        p95: output.p95,
        safety_factor: output.safety_factor,
        fos: output.safety_factor,
        warnings: &output.warnings,
        stats: Stats {
            dofs: output.dofs,
            ms: elapsed,
            vertices: output.vertices,
            triangles: output.triangles,
        },
    };
    let value = serde_wasm_bindgen::to_value(&wire).map_err(|err| js_err(&err.to_string()))?;
    let nodal = js_sys::Float32Array::from(output.nodal.as_slice());
    let attached = js_sys::Reflect::set(&value, &JsValue::from_str("nodal"), &nodal)
        .map_err(|_| js_err("failed to attach the nodal Float32Array"))?;
    if !attached {
        return Err(js_err("failed to attach the nodal Float32Array"));
    }
    // serde-wasm-bindgen drops Option::None, which becomes a missing field.
    // The contract uses null when yield / p95 is undefined.
    set_number_or_null(&value, "safetyFactor", output.safety_factor)?;
    set_number_or_null(&value, "fos", output.safety_factor)?;
    Ok(value)
}

fn set_number_or_null(value: &JsValue, key: &str, number: Option<f64>) -> Result<(), JsValue> {
    let js = match number {
        Some(n) => JsValue::from_f64(n),
        None => JsValue::NULL,
    };
    let ok = js_sys::Reflect::set(value, &JsValue::from_str(key), &js)
        .map_err(|_| js_err("failed to set a result field"))?;
    if !ok {
        return Err(js_err("failed to set a result field"));
    }
    Ok(())
}

#[wasm_bindgen(js_name = cancel)]
pub fn cancel() {
    stub::request_cancel();
}

#[wasm_bindgen(js_name = dispose)]
pub fn dispose() {
    stub::reset();
}

fn parse_study(value: &JsValue) -> Result<Study, stub::SolveError> {
    if value.is_null() || value.is_undefined() {
        return Ok(Study::default());
    }
    serde_wasm_bindgen::from_value(value.clone())
        .map_err(|err| stub::SolveError::BadStudy(err.to_string()))
}

fn parse_material(value: &JsValue) -> Result<Material, stub::SolveError> {
    if value.is_null() || value.is_undefined() {
        return Err(stub::SolveError::BadMaterial(
            "material is required ({E_MPa, nu, yield_MPa}, megapascals)".into(),
        ));
    }
    serde_wasm_bindgen::from_value(value.clone())
        .map_err(|err| stub::SolveError::BadMaterial(err.to_string()))
}
