//! wasm-bindgen boundary. The worker passes typed arrays through as slices
//! (copied into the wasm heap by the bindgen ABI) and receives `nodal` back
//! as a `Float32Array` the worker copies out before transferring to the page.

use crate::fem::{self, Dirichlet, FacePressure, NodalForce, SolveOptions, SolverChoice};
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

/// Linear-elastic TET10 solve.
///
/// `mesh.nodes` is a Float64Array or Float32Array of xyz coordinates in
/// millimetres. `mesh.elements` is a Uint32Array, 10 indices per element
/// (VTK order). `material` matches the stub (`E_MPa`, `nu`, optional
/// `yield_MPa`). `bcs` carries typed arrays:
///
/// - `fixedDofs` / `fixedValues`: prescribed DOFs (`node * 3 + axis`). Missing
///   values mean 0.
/// - `fixedNodes`: nodes whose three DOFs are fixed at 0.
/// - `forceNodes` / `forceValues`: nodal forces, three components per node, N.
/// - `pressureFaces` / `pressures`: 6 node indices per face and one pressure
///   per face, MPa. Positive pressure pushes against the right-hand normal of
///   the first three nodes.
///
/// `options.solver` is `"auto"` (default), `"cholesky"` or `"pcg"`. Auto uses
/// supernodal Cholesky at or below `choleskyMaxDofs` (default 20000 free DOFs)
/// and Jacobi PCG above that. `tol` and `maxIter` apply to PCG.
#[wasm_bindgen(js_name = solve_tet10)]
pub fn solve_tet10(
    mesh: &JsValue,
    material: &JsValue,
    bcs: &JsValue,
    options: &JsValue,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let nodes = read_nodes(mesh).map_err(fem_failure)?;
    let elements = read_elements(mesh, nodes.len()).map_err(fem_failure)?;
    let material = parse_material(material).map_err(failure)?;
    let (dirichlet, forces, pressures) = read_bcs(bcs, nodes.len()).map_err(fem_failure)?;
    let options = read_options(options).map_err(fem_failure)?;
    let fem_material = fem::Material {
        young: material.e_mpa,
        poisson: material.nu,
        yield_mpa: material.yield_mpa,
    };
    let output = fem::solve_tet10(
        &nodes,
        &elements,
        fem_material,
        &dirichlet,
        &forces,
        &pressures,
        &options,
    )
    .map_err(fem_failure)?;
    let elapsed = js_sys::Date::now() - started;
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire<'a> {
        source: &'static str,
        field: &'static str,
        units: &'static str,
        min: f64,
        max: f64,
        p95: f64,
        safety_factor: Option<f64>,
        fos: Option<f64>,
        warnings: &'a [fem::Warning],
        solver: &'static str,
        stats: FemStats,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FemStats {
        dofs: u32,
        free_dofs: u32,
        nodes: u32,
        elements: u32,
        iterations: u32,
        residual: f64,
        assembly_ms: f64,
        solve_ms: f64,
        ms: f64,
    }
    let wire = Wire {
        source: "fem",
        field: "von_mises",
        units: "MPa",
        min: output.min,
        max: output.max,
        p95: output.p95,
        safety_factor: output.safety_factor,
        fos: output.safety_factor,
        warnings: &output.warnings,
        solver: output.solver.as_str(),
        stats: FemStats {
            dofs: output.dofs as u32,
            free_dofs: output.free_dofs as u32,
            nodes: nodes.len() as u32,
            elements: elements.len() as u32,
            iterations: output.iterations as u32,
            residual: output.residual,
            assembly_ms: output.assembly_secs * 1.0e3,
            solve_ms: output.solve_secs * 1.0e3,
            ms: elapsed,
        },
    };
    let value = serde_wasm_bindgen::to_value(&wire).map_err(|err| js_err(&err.to_string()))?;
    attach_f64(&value, "nodal", &output.von_mises)?;
    attach_f64(&value, "displacement", &output.displacement)?;
    set_number_or_null(&value, "safetyFactor", output.safety_factor)?;
    set_number_or_null(&value, "fos", output.safety_factor)?;
    Ok(value)
}

fn fem_failure(err: fem::FemError) -> JsValue {
    js_err(&err.to_string())
}

fn attach_f64(value: &JsValue, key: &str, data: &[f64]) -> Result<(), JsValue> {
    let array = js_sys::Float64Array::from(data);
    let attached = js_sys::Reflect::set(value, &JsValue::from_str(key), &array)
        .map_err(|_| js_err("failed to attach a Float64Array"))?;
    if !attached {
        return Err(js_err("failed to attach a Float64Array"));
    }
    Ok(())
}

fn read_nodes(mesh: &JsValue) -> Result<Vec<[f64; 3]>, fem::FemError> {
    let flat = object_f64(mesh, "nodes").or_else(|_| object_f64(mesh, "positions"))?;
    if flat.len() % 3 != 0 {
        return Err(fem::FemError::BadMesh(
            "mesh.nodes length must be a multiple of 3".into(),
        ));
    }
    Ok(flat
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect())
}

fn read_elements(mesh: &JsValue, n_nodes: usize) -> Result<Vec<[u32; 10]>, fem::FemError> {
    let flat = object_u32(mesh, "elements")?;
    if flat.len() % 10 != 0 {
        return Err(fem::FemError::BadMesh(
            "mesh.elements length must be a multiple of 10".into(),
        ));
    }
    let mut elements = Vec::with_capacity(flat.len() / 10);
    for chunk in flat.chunks_exact(10) {
        let mut elem = [0_u32; 10];
        elem.copy_from_slice(chunk);
        if elem.iter().any(|id| *id as usize >= n_nodes) {
            return Err(fem::FemError::BadMesh(
                "mesh.elements references a node outside mesh.nodes".into(),
            ));
        }
        elements.push(elem);
    }
    Ok(elements)
}

fn read_bcs(
    bcs: &JsValue,
    n_nodes: usize,
) -> Result<(Vec<Dirichlet>, Vec<NodalForce>, Vec<FacePressure>), fem::FemError> {
    if bcs.is_null() || bcs.is_undefined() {
        return Err(fem::FemError::BadLoad(
            "bcs is required (fixedDofs / fixedNodes, forces, pressures)".into(),
        ));
    }
    let n_dof = n_nodes * 3;
    let mut dirichlet = Vec::new();
    if has_field(bcs, "fixedNodes") {
        for node in object_u32(bcs, "fixedNodes")? {
            if node as usize >= n_nodes {
                return Err(fem::FemError::BadLoad(format!(
                    "fixedNodes references node {node} outside the mesh"
                )));
            }
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: node * 3 + axis,
                    value: 0.0,
                });
            }
        }
    }
    if has_field(bcs, "fixedDofs") {
        let dofs = object_u32(bcs, "fixedDofs")?;
        let values = if has_field(bcs, "fixedValues") {
            object_f64(bcs, "fixedValues")?
        } else {
            Vec::new()
        };
        if !values.is_empty() && values.len() != dofs.len() {
            return Err(fem::FemError::BadLoad(
                "bcs.fixedValues must be empty or the same length as bcs.fixedDofs".into(),
            ));
        }
        for (i, dof) in dofs.into_iter().enumerate() {
            if dof as usize >= n_dof {
                return Err(fem::FemError::BadLoad(format!(
                    "fixedDofs index {dof} is outside the mesh"
                )));
            }
            dirichlet.push(Dirichlet {
                dof,
                value: values.get(i).copied().unwrap_or(0.0),
            });
        }
    }
    let mut forces = Vec::new();
    if has_field(bcs, "forceNodes") || has_field(bcs, "forceValues") {
        let nodes = object_u32(bcs, "forceNodes")?;
        let values = object_f64(bcs, "forceValues")?;
        if values.len() != nodes.len() * 3 {
            return Err(fem::FemError::BadLoad(
                "bcs.forceValues must contain three components per forceNodes entry".into(),
            ));
        }
        for (i, node) in nodes.into_iter().enumerate() {
            forces.push(NodalForce {
                node,
                force: [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]],
            });
        }
    }
    let mut pressures = Vec::new();
    if has_field(bcs, "pressureFaces") || has_field(bcs, "pressures") {
        let faces = object_u32(bcs, "pressureFaces")?;
        let values = object_f64(bcs, "pressures")?;
        if faces.len() != values.len() * 6 {
            return Err(fem::FemError::BadLoad(
                "bcs.pressureFaces must contain six node indices per pressures entry".into(),
            ));
        }
        for (i, pressure) in values.into_iter().enumerate() {
            let mut nodes = [0_u32; 6];
            nodes.copy_from_slice(&faces[i * 6..i * 6 + 6]);
            pressures.push(FacePressure { nodes, pressure });
        }
    }
    Ok((dirichlet, forces, pressures))
}

fn read_options(options: &JsValue) -> Result<SolveOptions, fem::FemError> {
    if options.is_null() || options.is_undefined() {
        return Ok(SolveOptions::default());
    }
    let mut out = SolveOptions::default();
    if has_field(options, "solver") {
        let name = object_string(options, "solver")?;
        out.solver = match name.as_str() {
            "auto" => SolverChoice::Auto,
            "cholesky" => SolverChoice::Cholesky,
            "pcg" => SolverChoice::Pcg,
            other => {
                return Err(fem::FemError::BadLoad(format!(
                    "options.solver must be 'auto', 'cholesky' or 'pcg', got {other:?}"
                )))
            }
        };
    }
    if has_field(options, "tol") {
        out.pcg_tol = object_number(options, "tol")?;
    }
    if has_field(options, "maxIter") {
        let max_iter = object_number(options, "maxIter")?;
        if max_iter < 1.0 || max_iter > u32::MAX as f64 {
            return Err(fem::FemError::BadLoad(
                "options.maxIter must be an integer from 1 up to 2^32-1".into(),
            ));
        }
        out.pcg_max_iter = max_iter as usize;
    }
    if has_field(options, "choleskyMaxDofs") {
        let limit = object_number(options, "choleskyMaxDofs")?;
        if limit < 0.0 || limit > u32::MAX as f64 {
            return Err(fem::FemError::BadLoad(
                "options.choleskyMaxDofs must be a non-negative integer".into(),
            ));
        }
        out.cholesky_max_dofs = limit as usize;
    }
    Ok(out)
}

fn has_field(object: &JsValue, key: &str) -> bool {
    js_sys::Reflect::has(object, &JsValue::from_str(key)).unwrap_or(false)
}

fn field(object: &JsValue, key: &str) -> Result<JsValue, fem::FemError> {
    js_sys::Reflect::get(object, &JsValue::from_str(key))
        .map_err(|_| fem::FemError::BadLoad(format!("could not read field {key}")))
}

fn object_f64(object: &JsValue, key: &str) -> Result<Vec<f64>, fem::FemError> {
    let value = field(object, key)?;
    if value.is_null() || value.is_undefined() {
        return Err(fem::FemError::BadLoad(format!(
            "{key} must be a Float64Array or Float32Array"
        )));
    }
    if let Some(array) = value.dyn_ref::<js_sys::Float64Array>() {
        let mut out = vec![0.0; array.length() as usize];
        array.copy_to(&mut out);
        return Ok(out);
    }
    if let Some(array) = value.dyn_ref::<js_sys::Float32Array>() {
        let mut tmp = vec![0.0_f32; array.length() as usize];
        array.copy_to(&mut tmp);
        return Ok(tmp.into_iter().map(f64::from).collect());
    }
    Err(fem::FemError::BadLoad(format!(
        "{key} must be a Float64Array or Float32Array"
    )))
}

fn object_u32(object: &JsValue, key: &str) -> Result<Vec<u32>, fem::FemError> {
    let value = field(object, key)?;
    let Some(array) = value.dyn_ref::<js_sys::Uint32Array>() else {
        return Err(fem::FemError::BadLoad(format!(
            "{key} must be a Uint32Array"
        )));
    };
    let mut out = vec![0_u32; array.length() as usize];
    array.copy_to(&mut out);
    Ok(out)
}

fn object_string(object: &JsValue, key: &str) -> Result<String, fem::FemError> {
    let value = field(object, key)?;
    value
        .as_string()
        .ok_or_else(|| fem::FemError::BadLoad(format!("{key} must be a string")))
}

fn object_number(object: &JsValue, key: &str) -> Result<f64, fem::FemError> {
    let value = field(object, key)?;
    value
        .as_f64()
        .ok_or_else(|| fem::FemError::BadLoad(format!("{key} must be a number")))
}

fn parse_material(value: &JsValue) -> Result<Material, stub::SolveError> {
    if value.is_null() || value.is_undefined() {
        return Err(stub::SolveError::BadMaterial(
            "material is required ({E_MPa, nu, yield_MPa}, megapascals; a null yield leaves safetyFactor null)".into(),
        ));
    }
    serde_wasm_bindgen::from_value(value.clone())
        .map_err(|err| stub::SolveError::BadMaterial(err.to_string()))
}
