//! Linear-elastic statics for 10-node tetrahedra.
//!
//! Units are millimetres, newtons and megapascals. Those are consistent:
//! `1 MPa = 1 N/mm²`, so Young's modulus in MPa, coordinates in mm and forces
//! in N produce displacements in mm and stresses in MPa with no conversion.
//!
//! Each element is integrated with the 4-point tetrahedron rule (exact for
//! polynomials through degree 2). Straight-edged TET10 elements therefore have
//! an exact stiffness for linear elasticity. The global matrix is stored as
//! symmetric sparse CSC (lower triangle, including the diagonal).

mod assemble;
mod linear;
mod stress;
pub(crate) mod tet10;

#[cfg(test)]
mod tests;

use assemble::Reduced;
use linear::{pcg, supernodal_cholesky};

/// Free-DOF count at or below which [`SolverChoice::Auto`] uses supernodal
/// Cholesky. Larger systems use Jacobi-preconditioned CG.
pub const DEFAULT_CHOLESKY_MAX_DOFS: usize = 20_000;

/// Default relative residual `||r|| / ||b||` for Jacobi PCG.
pub const DEFAULT_PCG_TOL: f64 = 1e-8;

/// Default PCG iteration cap.
pub const DEFAULT_PCG_MAX_ITER: usize = 20_000;

/// Which factorization to run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolverChoice {
    /// Cholesky at or below [`SolveOptions::cholesky_max_dofs`], otherwise PCG.
    Auto,
    /// faer supernodal sparse Cholesky.
    Cholesky,
    /// Jacobi-preconditioned conjugate gradient.
    Pcg,
}

impl Default for SolverChoice {
    fn default() -> Self {
        Self::Auto
    }
}

/// Knobs for one solve. [`Default`] is auto selection and the crate defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolveOptions {
    pub solver: SolverChoice,
    pub pcg_tol: f64,
    pub pcg_max_iter: usize,
    pub cholesky_max_dofs: usize,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            solver: SolverChoice::Auto,
            pcg_tol: DEFAULT_PCG_TOL,
            pcg_max_iter: DEFAULT_PCG_MAX_ITER,
            cholesky_max_dofs: DEFAULT_CHOLESKY_MAX_DOFS,
        }
    }
}

/// Isotropic Hooke material. Modulus and yield are megapascals.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Material {
    pub young: f64,
    pub poisson: f64,
    pub yield_mpa: Option<f64>,
}

/// Homogeneous or prescribed Dirichlet condition on one DOF.
///
/// `dof` is `node * 3 + axis` with `axis` 0, 1, 2 for x, y, z.
/// `value` is the displacement in millimetres. Fixtures pass `0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dirichlet {
    pub dof: u32,
    pub value: f64,
}

/// Point force in newtons applied at a node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NodalForce {
    pub node: u32,
    pub force: [f64; 3],
}

/// Uniform pressure on a 6-node triangular face.
///
/// Node order is `(c0, c1, c2, mid01, mid12, mid20)`. The right-hand normal of
/// `(c0, c1, c2)` is the positive geometric normal. A positive `pressure` (MPa)
/// pushes against that normal (compression when the normal points out of the
/// solid).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FacePressure {
    pub nodes: [u32; 6],
    pub pressure: f64,
}

/// Solver that actually ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolverUsed {
    Cholesky,
    Pcg,
}

impl SolverUsed {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cholesky => "cholesky",
            Self::Pcg => "pcg",
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Warning {
    pub code: &'static str,
    pub msg: String,
}

/// Displacement, averaged nodal stress, and von Mises summary.
#[derive(Clone, Debug, PartialEq)]
pub struct FemOutput {
    /// `3 * nodes` displacements in millimetres, xyzxyz…
    pub displacement: Vec<f64>,
    /// Averaged Cauchy stress at each node, Voigt
    /// `[σxx, σyy, σzz, σxy, σyz, σxz]` in MPa.
    pub stress: Vec<[f64; 6]>,
    /// Von Mises stress at each node, MPa.
    pub von_mises: Vec<f64>,
    pub min: f64,
    pub max: f64,
    pub p95: f64,
    pub safety_factor: Option<f64>,
    pub warnings: Vec<Warning>,
    /// `3 * nodes`, including constrained DOFs.
    pub dofs: usize,
    pub free_dofs: usize,
    pub solver: SolverUsed,
    /// PCG iterations. Zero for Cholesky.
    pub iterations: usize,
    /// Relative residual after PCG. Zero for Cholesky.
    pub residual: f64,
    pub assembly_secs: f64,
    pub solve_secs: f64,
}

#[derive(Debug)]
pub enum FemError {
    BadMesh(String),
    BadMaterial(String),
    BadLoad(String),
    NotSpd(String),
    NotConverged { iterations: usize, residual: f64 },
    Solver(String),
}

impl std::fmt::Display for FemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMesh(msg) | Self::BadMaterial(msg) | Self::BadLoad(msg) => {
                write!(f, "{msg}")
            }
            Self::NotSpd(msg) => write!(f, "{msg}"),
            Self::NotConverged {
                iterations,
                residual,
            } => write!(
                f,
                "PCG stopped after {iterations} iterations with relative residual {residual:.3e}"
            ),
            Self::Solver(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for FemError {}

/// Solve `K u = f` for a TET10 mesh.
///
/// `nodes` are xyz coordinates in millimetres. `elements` are 10 node indices
/// in VTK order: corners 0-1-2-3, then mids of edges 0-1, 1-2, 2-0, 0-3, 1-3,
/// 2-3.
pub fn solve_tet10(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[NodalForce],
    pressures: &[FacePressure],
    options: &SolveOptions,
) -> Result<FemOutput, FemError> {
    validate_material(material)?;
    validate_mesh(nodes, elements)?;
    let n_dof = nodes.len() * 3;
    let (fixed, prescribed) = dirichlet_map(n_dof, dirichlet)?;
    validate_loads(nodes.len(), forces, pressures)?;

    let mut displacement = prescribed.clone();
    let free_dofs: Vec<usize> = (0..n_dof).filter(|&dof| !fixed[dof]).collect();
    let choice = select_solver(options.solver, free_dofs.len(), options.cholesky_max_dofs);

    let (solver, iterations, residual, assembly_secs, solve_secs) = if free_dofs.is_empty() {
        (choice, 0, 0.0, 0.0, 0.0)
    } else {
        let t_asm = Clock::start();
        let reduced = assemble::assemble(
            nodes,
            elements,
            material,
            &fixed,
            &prescribed,
            forces,
            pressures,
        )?;
        let assembly_secs = t_asm.elapsed_secs();
        debug_assert_eq!(reduced.rhs.len(), free_dofs.len());
        let t_solve = Clock::start();
        let (u_free, iterations, residual) = solve_reduced(&reduced, choice, options)?;
        let solve_secs = t_solve.elapsed_secs();
        for (slot, &dof) in free_dofs.iter().enumerate() {
            displacement[dof] = u_free[slot];
        }
        (choice, iterations, residual, assembly_secs, solve_secs)
    };

    let stress = stress::nodal_stress(nodes, elements, material, &displacement)?;
    let von_mises: Vec<f64> = stress.iter().map(|s| stress::von_mises(s)).collect();
    let (min, max, p95) = range_and_p95(&von_mises);
    let mut warnings = Vec::new();
    let safety_factor = match material.yield_mpa {
        Some(yield_mpa) if p95.is_finite() && p95 > 0.0 => Some(yield_mpa / p95),
        Some(_) => {
            warnings.push(Warning {
                code: "zero-stress",
                msg: "p95 is 0, so safetyFactor is null (yield / p95 is undefined)".into(),
            });
            None
        }
        None => {
            warnings.push(Warning {
                code: "missing-yield",
                msg: "material.yield_MPa is null, so safetyFactor is null".into(),
            });
            None
        }
    };

    Ok(FemOutput {
        displacement,
        stress,
        von_mises,
        min,
        max,
        p95,
        safety_factor,
        warnings,
        dofs: n_dof,
        free_dofs: free_dofs.len(),
        solver,
        iterations,
        residual,
        assembly_secs,
        solve_secs,
    })
}

/// Elapsed-time source.
///
/// `std::time::Instant` panics on `wasm32-unknown-unknown` ("time not
/// implemented on this platform"), so the wasm build uses `Date.now`.
struct Clock {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    start_ms: f64,
}

impl Clock {
    fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: std::time::Instant::now(),
            #[cfg(target_arch = "wasm32")]
            start_ms: js_sys::Date::now(),
        }
    }

    fn elapsed_secs(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_secs_f64()
        }
        #[cfg(target_arch = "wasm32")]
        {
            (js_sys::Date::now() - self.start_ms) / 1.0e3
        }
    }
}

fn select_solver(choice: SolverChoice, free_dofs: usize, limit: usize) -> SolverUsed {
    match choice {
        SolverChoice::Cholesky => SolverUsed::Cholesky,
        SolverChoice::Pcg => SolverUsed::Pcg,
        SolverChoice::Auto => {
            if free_dofs <= limit {
                SolverUsed::Cholesky
            } else {
                SolverUsed::Pcg
            }
        }
    }
}

fn solve_reduced(
    reduced: &Reduced,
    choice: SolverUsed,
    options: &SolveOptions,
) -> Result<(Vec<f64>, usize, f64), FemError> {
    match choice {
        SolverUsed::Cholesky => {
            let u = supernodal_cholesky(&reduced.matrix, &reduced.rhs)?;
            Ok((u, 0, 0.0))
        }
        SolverUsed::Pcg => {
            if !(options.pcg_tol.is_finite() && options.pcg_tol > 0.0) {
                return Err(FemError::BadLoad(
                    "options.tol must be a finite number greater than 0".into(),
                ));
            }
            if options.pcg_max_iter == 0 {
                return Err(FemError::BadLoad(
                    "options.maxIter must be at least 1".into(),
                ));
            }
            let (u, iterations, residual) = pcg(
                &reduced.matrix,
                &reduced.rhs,
                options.pcg_tol,
                options.pcg_max_iter,
            )?;
            Ok((u, iterations, residual))
        }
    }
}

pub(crate) fn validate_material(material: Material) -> Result<(), FemError> {
    if !material.young.is_finite() || material.young <= 0.0 {
        return Err(FemError::BadMaterial(
            "material.E_MPa must be a finite number greater than 0 (megapascals)".into(),
        ));
    }
    if !material.poisson.is_finite() || material.poisson <= -1.0 || material.poisson >= 0.5 {
        return Err(FemError::BadMaterial(
            "material.nu must be finite and in the open interval (-1, 0.5)".into(),
        ));
    }
    if let Some(yield_mpa) = material.yield_mpa {
        if !yield_mpa.is_finite() || yield_mpa < 0.0 {
            return Err(FemError::BadMaterial(
                "material.yield_MPa must be a finite number greater than or equal to 0 (megapascals), or null when yield is unknown".into(),
            ));
        }
    }
    Ok(())
}

fn validate_mesh(nodes: &[[f64; 3]], elements: &[[u32; 10]]) -> Result<(), FemError> {
    if nodes.is_empty() || elements.is_empty() {
        return Err(FemError::BadMesh(
            "solve_tet10 needs at least one node and one TET10 element".into(),
        ));
    }
    if nodes.len() > (u32::MAX as usize) / 4 {
        return Err(FemError::BadMesh(
            "node count does not fit in a 32-bit index".into(),
        ));
    }
    for (i, node) in nodes.iter().enumerate() {
        if node.iter().any(|c| !c.is_finite()) {
            return Err(FemError::BadMesh(format!(
                "node {i} has a non-finite coordinate"
            )));
        }
    }
    let n = nodes.len() as u32;
    for (e, elem) in elements.iter().enumerate() {
        for (k, &id) in elem.iter().enumerate() {
            if id >= n {
                return Err(FemError::BadMesh(format!(
                    "element {e} node {k} index {id} is outside the node list"
                )));
            }
        }
        for a in 0..10 {
            for b in (a + 1)..10 {
                if elem[a] == elem[b] {
                    return Err(FemError::BadMesh(format!(
                        "element {e} repeats node index {}",
                        elem[a]
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_loads(
    n_nodes: usize,
    forces: &[NodalForce],
    pressures: &[FacePressure],
) -> Result<(), FemError> {
    for force in forces {
        if force.node as usize >= n_nodes {
            return Err(FemError::BadLoad(format!(
                "nodal force references node {} which is outside the mesh",
                force.node
            )));
        }
        if force.force.iter().any(|c| !c.is_finite()) {
            return Err(FemError::BadLoad(
                "a nodal force component is not finite".into(),
            ));
        }
    }
    for (i, face) in pressures.iter().enumerate() {
        if !face.pressure.is_finite() {
            return Err(FemError::BadLoad(format!(
                "pressure on face {i} is not finite"
            )));
        }
        for &id in &face.nodes {
            if id as usize >= n_nodes {
                return Err(FemError::BadLoad(format!(
                    "pressure face {i} references node {id} which is outside the mesh"
                )));
            }
        }
    }
    Ok(())
}

fn dirichlet_map(n_dof: usize, dirichlet: &[Dirichlet]) -> Result<(Vec<bool>, Vec<f64>), FemError> {
    let mut fixed = vec![false; n_dof];
    let mut prescribed = vec![0.0; n_dof];
    for bc in dirichlet {
        let dof = bc.dof as usize;
        if dof >= n_dof {
            return Err(FemError::BadLoad(format!(
                "Dirichlet DOF {} is outside the mesh ({} DOFs)",
                bc.dof, n_dof
            )));
        }
        if !bc.value.is_finite() {
            return Err(FemError::BadLoad(format!(
                "Dirichlet value on DOF {} is not finite",
                bc.dof
            )));
        }
        if fixed[dof] && prescribed[dof] != bc.value {
            return Err(FemError::BadLoad(format!(
                "Dirichlet DOF {} is prescribed twice with different values",
                bc.dof
            )));
        }
        fixed[dof] = true;
        prescribed[dof] = bc.value;
    }
    Ok((fixed, prescribed))
}

fn range_and_p95(von_mises: &[f64]) -> (f64, f64, f64) {
    if von_mises.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let min = von_mises.iter().copied().fold(f64::INFINITY, f64::min);
    let max = von_mises.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    // Nearest-rank on the f64 values, same rank rule as the stub.
    let p95 = percentile_95_f64(von_mises);
    (min, max, p95)
}

/// Nearest-rank 95th percentile. Same rank rule as [`crate::stub::percentile_95`].
pub fn percentile_95_f64(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((values.len() as f64) * 0.95).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[index]
}
