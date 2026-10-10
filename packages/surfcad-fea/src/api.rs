//! wasm-bindgen boundary. The worker passes typed arrays through as slices
//! (copied into the wasm heap by the bindgen ABI) and receives `nodal` back
//! as a `Float32Array` the worker copies out before transferring to the page.

use crate::fem::{
    self, Dirichlet, FacePressure, NodalForce, ShellPressure, SolveOptions, SolverChoice,
};
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
    let options = read_options(options, SolverChoice::Auto).map_err(fem_failure)?;
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

/// Linear shell solve for 6-node triangles, 6 DOF per node.
///
/// `mesh.nodes` is xyz in millimetres. `mesh.elements` is six indices per
/// triangle: corners `(n0, n1, n2)` then edge midpoints `(mid01, mid12, mid20)`.
/// `mesh.thickness` is one millimetre value per element, or a single value
/// applied to every element.
///
/// `bcs` carries typed arrays:
///
/// - `clampedNodes`: all six DOFs fixed at 0.
/// - `pinnedNodes`: the three translations fixed at 0, rotations free.
/// - `fixedDofs` / `fixedValues`: prescribed DOFs (`node * 6 + component`,
///   components `ux, uy, uz, θx, θy, θz`). Missing values mean 0.
/// - `forceNodes` / `forceValues`: nodal forces, three components per node, N.
/// - `pressures`: one MPa value per element, or a single value for every
///   element. `pressureElements` selects a subset instead. Positive pressure
///   pushes against the right-hand normal of `(n0, n1, n2)`.
///
/// `options.solver` defaults to `"cholesky"` (supernodal). `"auto"` and
/// `"pcg"` are the same switches as `solve_tet10`.
#[wasm_bindgen(js_name = solve_shell)]
pub fn solve_shell(
    mesh: &JsValue,
    material: &JsValue,
    bcs: &JsValue,
    options: &JsValue,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let nodes = read_nodes(mesh).map_err(fem_failure)?;
    let elements = read_shell_elements(mesh, nodes.len()).map_err(fem_failure)?;
    let thickness = read_thickness(mesh, elements.len()).map_err(fem_failure)?;
    let material = parse_material(material).map_err(failure)?;
    let (dirichlet, forces, pressures) =
        read_shell_bcs(bcs, nodes.len(), elements.len()).map_err(fem_failure)?;
    let options = read_options(options, SolverChoice::Cholesky).map_err(fem_failure)?;
    let fem_material = fem::Material {
        young: material.e_mpa,
        poisson: material.nu,
        yield_mpa: material.yield_mpa,
    };
    let output = fem::solve_shell(
        &nodes,
        &elements,
        &thickness,
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
        source: "shell",
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
    // `nodal` is the top/bottom envelope at each node, the same role as the
    // TET10 von Mises array. The three surfaces are attached beside it.
    attach_f64(&value, "nodal", &output.von_mises_envelope)?;
    attach_f64(&value, "vonMisesTop", &output.von_mises_top)?;
    attach_f64(&value, "vonMisesMid", &output.von_mises_mid)?;
    attach_f64(&value, "vonMisesBottom", &output.von_mises_bottom)?;
    attach_f64(&value, "displacement", &output.displacement)?;
    set_number_or_null(&value, "safetyFactor", output.safety_factor)?;
    set_number_or_null(&value, "fos", output.safety_factor)?;
    Ok(value)
}

/// Lowest natural frequencies of a TET10 mesh.
///
/// `material.density_kg_m3` is required. `options.modes` defaults to 6.
/// Fixtures are homogeneous. Forces and pressures are ignored and reported
/// in `warnings`. `modes` is the translational mode shape, mode-major,
/// `ux, uy, uz` per node, scaled so the largest component is 1.
#[wasm_bindgen(js_name = modal_tet10)]
pub fn modal_tet10(
    mesh: &JsValue,
    material: &JsValue,
    bcs: &JsValue,
    options: &JsValue,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let nodes = read_nodes(mesh).map_err(fem_failure)?;
    let elements = read_elements(mesh, nodes.len()).map_err(fem_failure)?;
    let parsed = parse_material(material).map_err(failure)?;
    let density = read_density(material).map_err(fem_failure)?;
    let (dirichlet, forces, pressures) =
        read_modal_solid_bcs(bcs, nodes.len()).map_err(fem_failure)?;
    let modes = read_mode_count(options).map_err(fem_failure)?;
    let fem_material = fem::Material {
        young: parsed.e_mpa,
        poisson: parsed.nu,
        yield_mpa: parsed.yield_mpa,
    };
    let output = fem::modal_tet10(&nodes, &elements, fem_material, density, &dirichlet, modes)
        .map_err(fem_failure)?;
    let mut warnings = output.warnings.clone();
    if !forces.is_empty() || !pressures.is_empty() {
        warnings.push(fem::Warning {
            code: "modal-loads",
            msg: "Loads are ignored. A modal study uses fixtures only.".into(),
        });
    }
    let elapsed = js_sys::Date::now() - started;
    let translations =
        translational_modes(&output.modes, nodes.len(), 3, output.frequencies_hz.len());
    finish_modal(
        &output,
        &warnings,
        &translations,
        nodes.len(),
        elements.len(),
        elapsed,
    )
}

/// Lowest natural frequencies of a MITC6 shell mesh.
///
/// Same contract as `modal_tet10`. `modes` contains the translational
/// components only (`ux, uy, uz` per node). Rotary inertia is in the solve.
#[wasm_bindgen(js_name = modal_shell)]
pub fn modal_shell(
    mesh: &JsValue,
    material: &JsValue,
    bcs: &JsValue,
    options: &JsValue,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let nodes = read_nodes(mesh).map_err(fem_failure)?;
    let elements = read_shell_elements(mesh, nodes.len()).map_err(fem_failure)?;
    let thickness = read_thickness(mesh, elements.len()).map_err(fem_failure)?;
    let parsed = parse_material(material).map_err(failure)?;
    let density = read_density(material).map_err(fem_failure)?;
    let (dirichlet, forces, pressures) =
        read_modal_shell_bcs(bcs, nodes.len(), elements.len()).map_err(fem_failure)?;
    let modes = read_mode_count(options).map_err(fem_failure)?;
    let fem_material = fem::Material {
        young: parsed.e_mpa,
        poisson: parsed.nu,
        yield_mpa: parsed.yield_mpa,
    };
    let output = fem::modal_shell(
        &nodes,
        &elements,
        &thickness,
        fem_material,
        density,
        &dirichlet,
        modes,
    )
    .map_err(fem_failure)?;
    let mut warnings = output.warnings.clone();
    if !forces.is_empty() || !pressures.is_empty() {
        warnings.push(fem::Warning {
            code: "modal-loads",
            msg: "Loads are ignored. A modal study uses fixtures only.".into(),
        });
    }
    let elapsed = js_sys::Date::now() - started;
    let translations = translational_modes(
        &output.modes,
        nodes.len(),
        fem::SHELL_DOF_PER_NODE,
        output.frequencies_hz.len(),
    );
    finish_modal(
        &output,
        &warnings,
        &translations,
        nodes.len(),
        elements.len(),
        elapsed,
    )
}

fn finish_modal(
    output: &fem::ModalOutput,
    warnings: &[fem::Warning],
    translations: &[f64],
    n_nodes: usize,
    n_elem: usize,
    elapsed: f64,
) -> Result<JsValue, JsValue> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire<'a> {
        source: &'static str,
        field: &'static str,
        units: &'static str,
        warnings: &'a [fem::Warning],
        solver: &'static str,
        shift: f64,
        stats: ModalStats,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ModalStats {
        dofs: u32,
        free_dofs: u32,
        nodes: u32,
        elements: u32,
        modes: u32,
        iterations: u32,
        residual: f64,
        assembly_ms: f64,
        solve_ms: f64,
        factor_entries: u32,
        ms: f64,
    }
    let wire = Wire {
        source: "modal",
        field: "mode",
        units: "1",
        warnings,
        solver: "lobpcg",
        shift: output.shift,
        stats: ModalStats {
            dofs: output.dofs as u32,
            free_dofs: output.free_dofs as u32,
            nodes: n_nodes as u32,
            elements: n_elem as u32,
            modes: output.frequencies_hz.len() as u32,
            iterations: output.iterations as u32,
            residual: output.residual,
            assembly_ms: output.assembly_secs * 1.0e3,
            solve_ms: output.solve_secs * 1.0e3,
            factor_entries: output.factor_entries.min(u32::MAX as usize) as u32,
            ms: elapsed,
        },
    };
    let value = serde_wasm_bindgen::to_value(&wire).map_err(|err| js_err(&err.to_string()))?;
    attach_f64(&value, "frequenciesHz", &output.frequencies_hz)?;
    attach_f64(&value, "effectiveMass", &output.effective_mass)?;
    attach_f64(&value, "modes", translations)?;
    Ok(value)
}

fn translational_modes(modes: &[f64], n_nodes: usize, dof_per_node: usize, k: usize) -> Vec<f64> {
    let mut out = vec![0.0; k * n_nodes * 3];
    for mode in 0..k {
        for node in 0..n_nodes {
            for axis in 0..3 {
                let src = mode * n_nodes * dof_per_node + node * dof_per_node + axis;
                out[(mode * n_nodes + node) * 3 + axis] = modes[src];
            }
        }
    }
    out
}

fn read_density(material: &JsValue) -> Result<f64, fem::FemError> {
    if material.is_null() || material.is_undefined() || !has_field(material, "density_kg_m3") {
        return Err(fem::FemError::BadMaterial(
            "material.density_kg_m3 must be a finite number greater than 0 (kg/m³)".into(),
        ));
    }
    let density = object_number(material, "density_kg_m3")?;
    if !(density.is_finite() && density > 0.0) {
        return Err(fem::FemError::BadMaterial(
            "material.density_kg_m3 must be a finite number greater than 0 (kg/m³)".into(),
        ));
    }
    Ok(density)
}

fn read_mode_count(options: &JsValue) -> Result<usize, fem::FemError> {
    if options.is_null() || options.is_undefined() || !has_field(options, "modes") {
        return Ok(fem::DEFAULT_MODES);
    }
    let modes = object_number(options, "modes")?;
    if !(modes.is_finite() && modes >= 1.0 && modes <= 64.0) {
        return Err(fem::FemError::BadLoad(
            "options.modes must be an integer from 1 to 64".into(),
        ));
    }
    Ok(modes as usize)
}

fn read_modal_solid_bcs(
    bcs: &JsValue,
    n_nodes: usize,
) -> Result<(Vec<Dirichlet>, Vec<NodalForce>, Vec<FacePressure>), fem::FemError> {
    if bcs.is_null() || bcs.is_undefined() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    read_bcs(bcs, n_nodes)
}

fn read_modal_shell_bcs(
    bcs: &JsValue,
    n_nodes: usize,
    n_elem: usize,
) -> Result<(Vec<Dirichlet>, Vec<NodalForce>, Vec<ShellPressure>), fem::FemError> {
    if bcs.is_null() || bcs.is_undefined() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    read_shell_bcs(bcs, n_nodes, n_elem)
}

/// Bonded multi-body solve. Each body is meshed on its own and tied by
/// projection MPCs. Shell-to-solid ties are not accepted: every body is TET10.
///
/// `mesh.bodies` is an array of `{ nodes, elements, material }`. Node indices
/// inside a body are local. Ties and boundary conditions use the concatenated
/// order: body 0, then body 1, and so on.
///
/// `mesh.ties` is optional. `slaveNodes` are concatenated node ids.
/// `masterFaces` is six node ids per TET10 face. `faceOffsets` and
/// `faceCounts` say which faces each slave may land on (face index, not a
/// node index). `gap` is the plane distance in millimetres that still counts
/// as on the face; the default is 0.05.
///
/// The safety factor is the minimum of yield/p95 over the bodies that have
/// both. `governingPart` is that body's index.
#[wasm_bindgen(js_name = solve_bonded)]
pub fn solve_bonded(mesh: &JsValue, bcs: &JsValue, options: &JsValue) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let (stored, tie_input) = read_bonded_mesh(mesh).map_err(fem_failure)?;
    let bodies: Vec<fem::SolidBody<'_>> = stored
        .iter()
        .map(|body| fem::SolidBody {
            nodes: &body.nodes,
            elements: &body.elements,
            material: body.material,
        })
        .collect();
    let mut nodes = Vec::new();
    for body in &stored {
        nodes.extend_from_slice(&body.nodes);
    }
    let (dirichlet, forces, pressures) = read_bcs(bcs, nodes.len()).map_err(fem_failure)?;
    let options = read_options(options, SolverChoice::Auto).map_err(fem_failure)?;
    let (ties, missed) = build_ties(&nodes, &tie_input).map_err(fem_failure)?;
    let output = fem::solve_bonded(&bodies, &ties, &dirichlet, &forces, &pressures, &options)
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
        missed_slaves: u32,
    }
    let mut warnings = output.fem.warnings.clone();
    if missed > 0 {
        warnings.push(fem::Warning {
            code: "tie-gap",
            msg: format!(
                "{missed} slave nodes were farther than the bond gap from every master face and were left untied"
            ),
        });
    }
    let wire = Wire {
        source: "fem",
        field: "von_mises",
        units: "MPa",
        min: output.fem.min,
        max: output.fem.max,
        p95: output.fem.p95,
        safety_factor: output.fem.safety_factor,
        fos: output.fem.safety_factor,
        warnings: &warnings,
        solver: output.fem.solver.as_str(),
        stats: FemStats {
            dofs: output.fem.dofs as u32,
            free_dofs: output.fem.free_dofs as u32,
            nodes: nodes.len() as u32,
            elements: stored.iter().map(|body| body.elements.len()).sum::<usize>() as u32,
            iterations: output.fem.iterations as u32,
            residual: output.fem.residual,
            assembly_ms: output.fem.assembly_secs * 1.0e3,
            solve_ms: output.fem.solve_secs * 1.0e3,
            ms: elapsed,
            missed_slaves: missed as u32,
        },
    };
    let value = serde_wasm_bindgen::to_value(&wire).map_err(|err| js_err(&err.to_string()))?;
    attach_f64(&value, "nodal", &output.fem.von_mises)?;
    attach_f64(&value, "displacement", &output.fem.displacement)?;
    set_number_or_null(&value, "safetyFactor", output.fem.safety_factor)?;
    set_number_or_null(&value, "fos", output.fem.safety_factor)?;
    let mut part_p95 = Vec::with_capacity(output.parts.len());
    let mut part_min = Vec::with_capacity(output.parts.len());
    let mut part_max = Vec::with_capacity(output.parts.len());
    let mut part_fos = Vec::with_capacity(output.parts.len());
    let mut part_offset = Vec::with_capacity(output.parts.len());
    let mut part_count = Vec::with_capacity(output.parts.len());
    for part in &output.parts {
        part_p95.push(part.p95);
        part_min.push(part.min);
        part_max.push(part.max);
        part_fos.push(part.safety_factor.unwrap_or(f64::NAN));
        part_offset.push(part.node_offset as u32);
        part_count.push(part.node_count as u32);
    }
    attach_f64(&value, "partP95", &part_p95)?;
    attach_f64(&value, "partMin", &part_min)?;
    attach_f64(&value, "partMax", &part_max)?;
    attach_f64(&value, "partSafety", &part_fos)?;
    let offsets = js_sys::Uint32Array::from(part_offset.as_slice());
    let counts = js_sys::Uint32Array::from(part_count.as_slice());
    js_sys::Reflect::set(&value, &JsValue::from_str("partNodeOffset"), &offsets)
        .map_err(|_| js_err("failed to attach part offsets"))?;
    js_sys::Reflect::set(&value, &JsValue::from_str("partNodeCount"), &counts)
        .map_err(|_| js_err("failed to attach part counts"))?;
    let governing = match output.governing {
        Some(index) => JsValue::from_f64(index as f64),
        None => JsValue::NULL,
    };
    js_sys::Reflect::set(&value, &JsValue::from_str("governingPart"), &governing)
        .map_err(|_| js_err("failed to attach the governing part"))?;
    Ok(value)
}

/// Frictionless or frictional contact, with bonded ties still eliminated.
///
/// `mesh.contacts` is one entry per pair: `slaves`, `masterFaces`, and
/// `slaveFaces` (six node ids per TET10 face), `law` (`frictionless` or
/// `frictional`), optional `mu` (default 0.2), and optional `gap`. Node ids
/// are concatenated in body order, the same numbering as [`solve_bonded`].
/// The safety factor stays yield / p95. Contact samples are the slave nodes
/// that carried a penalty, plus the master-face weights used to draw the
/// other side.
#[wasm_bindgen(js_name = solve_contact)]
pub fn solve_contact(mesh: &JsValue, bcs: &JsValue, options: &JsValue) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let (stored, tie_input) = read_bonded_mesh(mesh).map_err(fem_failure)?;
    let surfaces = read_contact_surfaces(mesh).map_err(fem_failure)?;
    if surfaces.is_empty() {
        return Err(js_err(
            "solve_contact needs at least one frictionless or frictional pair",
        ));
    }
    let bodies: Vec<fem::SolidBody<'_>> = stored
        .iter()
        .map(|body| fem::SolidBody {
            nodes: &body.nodes,
            elements: &body.elements,
            material: body.material,
        })
        .collect();
    let mut nodes = Vec::new();
    for body in &stored {
        nodes.extend_from_slice(&body.nodes);
    }
    let (dirichlet, forces, pressures) = read_bcs(bcs, nodes.len()).map_err(fem_failure)?;
    let solve = read_options(options, SolverChoice::Auto).map_err(fem_failure)?;
    let (ties, missed) = build_ties(&nodes, &tie_input).map_err(fem_failure)?;
    let options = fem::ContactOptions {
        solve,
        ..fem::ContactOptions::default()
    };
    let output = fem::solve_contact(
        &bodies, &ties, &surfaces, &dirichlet, &forces, &pressures, &options,
    )
    .map_err(fem_failure)?;
    let elapsed = js_sys::Date::now() - started;
    let mut warnings = output.bonded.fem.warnings.clone();
    if missed > 0 {
        warnings.push(fem::Warning {
            code: "tie-gap",
            msg: format!(
                "{missed} slave nodes were farther than the bond gap from every master face and were left untied"
            ),
        });
    }
    let value = assembly_wire(
        &output.bonded.fem,
        &warnings,
        nodes.len(),
        stored.iter().map(|body| body.elements.len()).sum(),
        missed,
        elapsed,
        output.iterations,
    )?;
    let mut ids = Vec::with_capacity(output.nodes.len());
    let mut pressure = Vec::with_capacity(output.nodes.len());
    let mut status = Vec::with_capacity(output.nodes.len());
    let mut masters = Vec::with_capacity(output.nodes.len() * 6);
    let mut weights = Vec::with_capacity(output.nodes.len() * 6);
    for node in &output.nodes {
        ids.push(node.node);
        pressure.push(node.pressure);
        status.push(node.status as u8);
        masters.extend_from_slice(&node.masters);
        weights.extend_from_slice(&node.weights);
    }
    let id_array = js_sys::Uint32Array::from(ids.as_slice());
    js_sys::Reflect::set(&value, &JsValue::from_str("contactNode"), &id_array)
        .map_err(|_| js_err("failed to attach contact nodes"))?;
    attach_f64(&value, "contactPressure", &pressure)?;
    let status_array = js_sys::Uint8Array::from(status.as_slice());
    js_sys::Reflect::set(&value, &JsValue::from_str("contactStatus"), &status_array)
        .map_err(|_| js_err("failed to attach contact status"))?;
    let master_array = js_sys::Uint32Array::from(masters.as_slice());
    js_sys::Reflect::set(&value, &JsValue::from_str("contactMasters"), &master_array)
        .map_err(|_| js_err("failed to attach contact masters"))?;
    attach_f64(&value, "contactWeights", &weights)?;
    attach_part_fields(&value, &output.bonded)?;
    Ok(value)
}

fn assembly_wire(
    fem: &fem::FemOutput,
    warnings: &[fem::Warning],
    n_nodes: usize,
    n_elements: usize,
    missed: usize,
    elapsed: f64,
    contact_iterations: usize,
) -> Result<JsValue, JsValue> {
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
        stats: WireStats,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WireStats {
        dofs: u32,
        free_dofs: u32,
        nodes: u32,
        elements: u32,
        iterations: u32,
        residual: f64,
        assembly_ms: f64,
        solve_ms: f64,
        ms: f64,
        missed_slaves: u32,
        contact_iterations: u32,
    }
    let wire = Wire {
        source: "fem",
        field: "von_mises",
        units: "MPa",
        min: fem.min,
        max: fem.max,
        p95: fem.p95,
        safety_factor: fem.safety_factor,
        fos: fem.safety_factor,
        warnings,
        solver: fem.solver.as_str(),
        stats: WireStats {
            dofs: fem.dofs as u32,
            free_dofs: fem.free_dofs as u32,
            nodes: n_nodes as u32,
            elements: n_elements as u32,
            iterations: fem.iterations as u32,
            residual: fem.residual,
            assembly_ms: fem.assembly_secs * 1.0e3,
            solve_ms: fem.solve_secs * 1.0e3,
            ms: elapsed,
            missed_slaves: missed as u32,
            contact_iterations: contact_iterations as u32,
        },
    };
    let value = serde_wasm_bindgen::to_value(&wire).map_err(|err| js_err(&err.to_string()))?;
    attach_f64(&value, "nodal", &fem.von_mises)?;
    attach_f64(&value, "displacement", &fem.displacement)?;
    set_number_or_null(&value, "safetyFactor", fem.safety_factor)?;
    set_number_or_null(&value, "fos", fem.safety_factor)?;
    Ok(value)
}

fn attach_part_fields(value: &JsValue, output: &fem::BondedOutput) -> Result<(), JsValue> {
    let mut part_p95 = Vec::with_capacity(output.parts.len());
    let mut part_min = Vec::with_capacity(output.parts.len());
    let mut part_max = Vec::with_capacity(output.parts.len());
    let mut part_fos = Vec::with_capacity(output.parts.len());
    let mut part_offset = Vec::with_capacity(output.parts.len());
    let mut part_count = Vec::with_capacity(output.parts.len());
    for part in &output.parts {
        part_p95.push(part.p95);
        part_min.push(part.min);
        part_max.push(part.max);
        part_fos.push(part.safety_factor.unwrap_or(f64::NAN));
        part_offset.push(part.node_offset as u32);
        part_count.push(part.node_count as u32);
    }
    attach_f64(value, "partP95", &part_p95)?;
    attach_f64(value, "partMin", &part_min)?;
    attach_f64(value, "partMax", &part_max)?;
    attach_f64(value, "partSafety", &part_fos)?;
    let offsets = js_sys::Uint32Array::from(part_offset.as_slice());
    let counts = js_sys::Uint32Array::from(part_count.as_slice());
    js_sys::Reflect::set(value, &JsValue::from_str("partNodeOffset"), &offsets)
        .map_err(|_| js_err("failed to attach part offsets"))?;
    js_sys::Reflect::set(value, &JsValue::from_str("partNodeCount"), &counts)
        .map_err(|_| js_err("failed to attach part counts"))?;
    let governing = match output.governing {
        Some(index) => JsValue::from_f64(index as f64),
        None => JsValue::NULL,
    };
    js_sys::Reflect::set(value, &JsValue::from_str("governingPart"), &governing)
        .map_err(|_| js_err("failed to attach the governing part"))?;
    Ok(())
}

fn read_contact_surfaces(mesh: &JsValue) -> Result<Vec<fem::ContactSurface>, fem::FemError> {
    if !has_field(mesh, "contacts") {
        return Ok(Vec::new());
    }
    let value = field(mesh, "contacts")?;
    if value.is_null() || value.is_undefined() {
        return Ok(Vec::new());
    }
    let list = js_sys::Array::from(&value);
    let mut surfaces = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let row = list.get(i);
        let law_name = object_string(&row, "law")
            .map_err(|err| fem::FemError::BadLoad(format!("contacts[{i}].law: {err}")))?;
        let law = match law_name.as_str() {
            "frictionless" => fem::ContactLaw::Frictionless,
            "frictional" => fem::ContactLaw::Frictional,
            other => {
                return Err(fem::FemError::BadLoad(format!(
                    "contacts[{i}].law must be \"frictionless\" or \"frictional\" (got {other})"
                )));
            }
        };
        let mu = if has_field(&row, "mu") {
            object_number(&row, "mu")?
        } else {
            fem::DEFAULT_FRICTION
        };
        let gap = if has_field(&row, "gap") {
            object_number(&row, "gap")?
        } else {
            0.05
        };
        let slaves = object_u32(&row, "slaves")
            .map_err(|err| fem::FemError::BadMesh(format!("contacts[{i}].slaves: {err}")))?;
        let master_faces = read_face_list(&row, "masterFaces", i)?;
        let slave_faces = read_face_list(&row, "slaveFaces", i)?;
        surfaces.push(fem::ContactSurface {
            slaves,
            master_faces,
            slave_faces,
            law,
            mu,
            gap,
        });
    }
    Ok(surfaces)
}

fn read_face_list(object: &JsValue, key: &str, index: u32) -> Result<Vec<[u32; 6]>, fem::FemError> {
    let flat = object_u32(object, key)
        .map_err(|err| fem::FemError::BadMesh(format!("contacts[{index}].{key}: {err}")))?;
    if flat.len() % 6 != 0 {
        return Err(fem::FemError::BadMesh(format!(
            "contacts[{index}].{key} must contain six node indices per face"
        )));
    }
    Ok(flat
        .chunks_exact(6)
        .map(|chunk| {
            let mut face = [0_u32; 6];
            face.copy_from_slice(chunk);
            face
        })
        .collect())
}

struct StoredBody {
    nodes: Vec<[f64; 3]>,
    elements: Vec<[u32; 10]>,
    material: fem::Material,
}

struct TieInput {
    slaves: Vec<u32>,
    faces: Vec<[u32; 6]>,
    offsets: Vec<u32>,
    counts: Vec<u32>,
    gap: f64,
}

fn read_bonded_mesh(mesh: &JsValue) -> Result<(Vec<StoredBody>, TieInput), fem::FemError> {
    let bodies_value = field(mesh, "bodies")?;
    let bodies = js_sys::Array::from(&bodies_value);
    if bodies.length() == 0 {
        return Err(fem::FemError::BadMesh(
            "mesh.bodies must list at least one solid".into(),
        ));
    }
    let mut stored = Vec::with_capacity(bodies.length() as usize);
    for i in 0..bodies.length() {
        let body = bodies.get(i);
        let nodes = read_nodes(&body)
            .map_err(|err| fem::FemError::BadMesh(format!("bodies[{i}]: {err}")))?;
        let elements = read_elements(&body, nodes.len())
            .map_err(|err| fem::FemError::BadMesh(format!("bodies[{i}]: {err}")))?;
        let material_js = field(&body, "material")?;
        let material = parse_material(&material_js)
            .map_err(|err| fem::FemError::BadMaterial(format!("bodies[{i}]: {err}")))?;
        stored.push(StoredBody {
            nodes,
            elements,
            material: fem::Material {
                young: material.e_mpa,
                poisson: material.nu,
                yield_mpa: material.yield_mpa,
            },
        });
    }
    let ties = if has_field(mesh, "ties") {
        let ties = field(mesh, "ties")?;
        if ties.is_null() || ties.is_undefined() {
            TieInput {
                slaves: Vec::new(),
                faces: Vec::new(),
                offsets: Vec::new(),
                counts: Vec::new(),
                gap: 0.05,
            }
        } else {
            let slaves = if has_field(&ties, "slaveNodes") {
                object_u32(&ties, "slaveNodes")?
            } else {
                Vec::new()
            };
            let flat = if has_field(&ties, "masterFaces") {
                object_u32(&ties, "masterFaces")?
            } else {
                Vec::new()
            };
            if flat.len() % 6 != 0 {
                return Err(fem::FemError::BadMesh(
                    "ties.masterFaces must contain six node indices per face".into(),
                ));
            }
            let faces: Vec<[u32; 6]> = flat
                .chunks_exact(6)
                .map(|chunk| {
                    let mut face = [0_u32; 6];
                    face.copy_from_slice(chunk);
                    face
                })
                .collect();
            let offsets = if has_field(&ties, "faceOffsets") {
                object_u32(&ties, "faceOffsets")?
            } else if slaves.is_empty() {
                Vec::new()
            } else {
                return Err(fem::FemError::BadMesh(
                    "ties.faceOffsets is required when slave nodes are tied".into(),
                ));
            };
            let counts = if has_field(&ties, "faceCounts") {
                object_u32(&ties, "faceCounts")?
            } else if slaves.is_empty() {
                Vec::new()
            } else {
                return Err(fem::FemError::BadMesh(
                    "ties.faceCounts is required when slave nodes are tied".into(),
                ));
            };
            if offsets.len() != slaves.len() || counts.len() != slaves.len() {
                return Err(fem::FemError::BadMesh(
                    "ties.faceOffsets and ties.faceCounts must have one entry per slave node"
                        .into(),
                ));
            }
            let gap = if has_field(&ties, "gap") {
                object_number(&ties, "gap")?
            } else {
                0.05
            };
            TieInput {
                slaves,
                faces,
                offsets,
                counts,
                gap,
            }
        }
    } else {
        TieInput {
            slaves: Vec::new(),
            faces: Vec::new(),
            offsets: Vec::new(),
            counts: Vec::new(),
            gap: 0.05,
        }
    };
    Ok((stored, ties))
}

fn build_ties(
    nodes: &[[f64; 3]],
    input: &TieInput,
) -> Result<(Vec<fem::SlaveTie>, usize), fem::FemError> {
    let mut ties = Vec::new();
    let mut missed = 0_usize;
    for (index, &slave) in input.slaves.iter().enumerate() {
        let start = input.offsets[index] as usize;
        let count = input.counts[index] as usize;
        if start + count > input.faces.len() {
            return Err(fem::FemError::BadMesh(format!(
                "slave {index} asks for master faces outside ties.masterFaces"
            )));
        }
        let built = fem::tie_slaves(
            nodes,
            &[slave],
            &input.faces[start..start + count],
            input.gap,
        )?;
        missed += built.missed.len();
        ties.extend(built.ties);
    }
    Ok((ties, missed))
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

fn read_shell_elements(mesh: &JsValue, n_nodes: usize) -> Result<Vec<[u32; 6]>, fem::FemError> {
    let flat = object_u32(mesh, "elements")?;
    if flat.len() % 6 != 0 {
        return Err(fem::FemError::BadMesh(
            "mesh.elements length must be a multiple of 6".into(),
        ));
    }
    let mut elements = Vec::with_capacity(flat.len() / 6);
    for chunk in flat.chunks_exact(6) {
        let mut elem = [0_u32; 6];
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

fn read_thickness(mesh: &JsValue, n_elem: usize) -> Result<Vec<f64>, fem::FemError> {
    let values = object_f64(mesh, "thickness")?;
    if values.len() == n_elem {
        return Ok(values);
    }
    if values.len() == 1 {
        return Ok(vec![values[0]; n_elem]);
    }
    Err(fem::FemError::BadMesh(format!(
        "mesh.thickness must contain one value per element or a single value, got {}",
        values.len()
    )))
}

fn read_shell_bcs(
    bcs: &JsValue,
    n_nodes: usize,
    n_elem: usize,
) -> Result<(Vec<Dirichlet>, Vec<NodalForce>, Vec<ShellPressure>), fem::FemError> {
    if bcs.is_null() || bcs.is_undefined() {
        return Err(fem::FemError::BadLoad(
            "bcs is required (clampedNodes / pinnedNodes, forces, pressures)".into(),
        ));
    }
    let n_dof = n_nodes * 6;
    let mut dirichlet = Vec::new();
    if has_field(bcs, "pinnedNodes") {
        for node in object_u32(bcs, "pinnedNodes")? {
            if node as usize >= n_nodes {
                return Err(fem::FemError::BadLoad(format!(
                    "pinnedNodes references node {node} outside the mesh"
                )));
            }
            fem::pin_node(node, &mut dirichlet);
        }
    }
    if has_field(bcs, "clampedNodes") {
        for node in object_u32(bcs, "clampedNodes")? {
            if node as usize >= n_nodes {
                return Err(fem::FemError::BadLoad(format!(
                    "clampedNodes references node {node} outside the mesh"
                )));
            }
            fem::clamp_node(node, &mut dirichlet);
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
                    "fixedDofs index {dof} is outside the shell mesh (node * 6 + component)"
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
    if has_field(bcs, "pressureElements") || has_field(bcs, "pressures") {
        let values = object_f64(bcs, "pressures")?;
        if has_field(bcs, "pressureElements") {
            let elems = object_u32(bcs, "pressureElements")?;
            if elems.len() != values.len() {
                return Err(fem::FemError::BadLoad(
                    "bcs.pressureElements must have one index per pressures entry".into(),
                ));
            }
            for (element, pressure) in elems.into_iter().zip(values) {
                if element as usize >= n_elem {
                    return Err(fem::FemError::BadLoad(format!(
                        "pressureElements references element {element} outside the mesh"
                    )));
                }
                pressures.push(ShellPressure { element, pressure });
            }
        } else if values.len() == n_elem || values.len() == 1 {
            let uniform = values.len() == 1;
            for element in 0..n_elem as u32 {
                let pressure = if uniform {
                    values[0]
                } else {
                    values[element as usize]
                };
                pressures.push(ShellPressure { element, pressure });
            }
        } else {
            return Err(fem::FemError::BadLoad(format!(
                "bcs.pressures must contain one value per element or a single value, got {}",
                values.len()
            )));
        }
    }
    Ok((dirichlet, forces, pressures))
}

fn read_options(
    options: &JsValue,
    default_solver: SolverChoice,
) -> Result<SolveOptions, fem::FemError> {
    if options.is_null() || options.is_undefined() {
        return Ok(SolveOptions {
            solver: default_solver,
            ..SolveOptions::default()
        });
    }
    let mut out = SolveOptions {
        solver: default_solver,
        ..SolveOptions::default()
    };
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
