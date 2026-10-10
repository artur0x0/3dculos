//! Six-node MITC shell triangle.
//!
//! A 3-node triangle cannot contain the quadratic transverse displacement of
//! a constant-curvature patch, so a linear MITC3 element only passes that
//! patch after extra constraints and still converges slowly on a curved roof.
//! This element is the 6-node triangle: quadratic displacements, quadratic
//! geometry, and a linear rotation field. Constant membrane strain and
//! constant curvature sit in the space, and a quadratic edge can follow a
//! cylinder.
//!
//! Transverse shear uses the MITC6-b tying of Lee and Bathe (2004). Along
//! each edge the tangential covariant shear is sampled at the two Gauss
//! points and replaced by a linear assumed field. That field still contains
//! every constant shear state, so the patch tests are unchanged, but a thin
//! element is no longer forced to satisfy the Kirchhoff constraint at every
//! quadrature point.
//!
//! The drilling rotation about the director has no bending energy.
//! A Hughes–Brezzi penalty `α G t (θ·n − ω)²`, with `ω` the midsurface
//! spin, removes those modes. `α = 1` puts the penalty on the scale of the
//! membrane stiffness and is zero for a rigid rotation.
//!
//! Kinematics are the degenerated Reissner–Mindlin shell: 6 global DOF per
//! node `(ux, uy, uz, θx, θy, θz)` in millimetres and radians. Thickness is
//! constant on an element. The constitutive law is plane stress plus shear
//! correction 5/6, integrated with a 7-point triangle rule and 2-point Gauss
//! through the thickness.

use super::assemble::{LowerCsc, Reduced};
use super::stress::von_mises;
use super::{
    dirichlet_map, range_and_p95, select_solver, solve_reduced, Clock, Dirichlet, FemError,
    Material, NodalForce, SolveOptions, SolverChoice, SolverUsed, Warning,
};

/// Translations then rotations, in that order, at each node.
pub const SHELL_DOF_PER_NODE: usize = 6;

/// Hughes–Brezzi scale on `G t`.
const DRILL_ALPHA: f64 = 1.0;

const SHEAR_FACTOR: f64 = 5.0 / 6.0;

const NEN: usize = 6;
const NDOF: usize = NEN * SHELL_DOF_PER_NODE;

/// Uniform normal pressure on one shell element.
///
/// Positive pressure pushes against the right-hand normal of corners
/// `(n0, n1, n2)`. The unit is MPa.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellPressure {
    pub element: u32,
    pub pressure: f64,
}

/// Shell solution. Von Mises samples are megapascals.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellOutput {
    /// `6 * nodes` displacements: `ux, uy, uz, θx, θy, θz` per node.
    /// Translations are millimetres, rotations are radians.
    pub displacement: Vec<f64>,
    /// Von Mises on the top surface (`ζ = +1`, along the director).
    pub von_mises_top: Vec<f64>,
    /// Von Mises on the mid-surface.
    pub von_mises_mid: Vec<f64>,
    /// Von Mises on the bottom surface (`ζ = -1`).
    pub von_mises_bottom: Vec<f64>,
    /// Pointwise maximum of the top and bottom values.
    pub von_mises_envelope: Vec<f64>,
    /// Min, max, and nearest-rank p95 of the top and bottom samples together.
    pub min: f64,
    pub max: f64,
    pub p95: f64,
    pub safety_factor: Option<f64>,
    pub warnings: Vec<Warning>,
    /// `6 * nodes`, including constrained DOFs.
    pub dofs: usize,
    pub free_dofs: usize,
    pub solver: SolverUsed,
    pub iterations: usize,
    pub residual: f64,
    pub assembly_secs: f64,
    pub solve_secs: f64,
}

/// Default options for a shell solve: supernodal Cholesky, whatever the
/// free-DOF count. PCG remains available when the caller asks for it.
pub fn shell_solve_options() -> SolveOptions {
    SolveOptions {
        solver: SolverChoice::Cholesky,
        ..SolveOptions::default()
    }
}

/// Fix all six DOFs of `node` at zero.
pub fn clamp_node(node: u32, out: &mut Vec<Dirichlet>) {
    for component in 0..SHELL_DOF_PER_NODE as u32 {
        out.push(Dirichlet {
            dof: node * SHELL_DOF_PER_NODE as u32 + component,
            value: 0.0,
        });
    }
}

/// Fix the three translations of `node` at zero and leave the rotations free.
pub fn pin_node(node: u32, out: &mut Vec<Dirichlet>) {
    for component in 0..3 {
        out.push(Dirichlet {
            dof: node * SHELL_DOF_PER_NODE as u32 + component,
            value: 0.0,
        });
    }
}

/// Solve `K u = f` for a mesh of 6-node shell triangles.
///
/// `elements` are `(n0, n1, n2, mid01, mid12, mid20)`. `thickness[e]` is the
/// thickness of element `e` in millimetres. `Dirichlet::dof` is
/// `node * 6 + component` with components `(ux, uy, uz, θx, θy, θz)`.
pub fn solve_shell(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: &[f64],
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[NodalForce],
    pressures: &[ShellPressure],
    options: &SolveOptions,
) -> Result<ShellOutput, FemError> {
    super::validate_material(material)?;
    validate_shell(nodes, elements, thickness)?;
    let directors = nodal_directors(nodes, elements)?;
    let n_dof = nodes.len() * SHELL_DOF_PER_NODE;
    let (fixed, prescribed) = dirichlet_map(n_dof, dirichlet)?;
    validate_shell_loads(nodes.len(), elements.len(), forces, pressures)?;

    let mut displacement = prescribed.clone();
    let free_dofs: Vec<usize> = (0..n_dof).filter(|&dof| !fixed[dof]).collect();
    let choice = select_solver(options.solver, free_dofs.len(), options.cholesky_max_dofs);

    let (solver, iterations, residual, assembly_secs, solve_secs) = if free_dofs.is_empty() {
        (choice, 0, 0.0, 0.0, 0.0)
    } else {
        let t_asm = Clock::start();
        let reduced = assemble_shell(
            nodes,
            elements,
            thickness,
            &directors,
            material,
            &fixed,
            &prescribed,
            forces,
            pressures,
        )?;
        let assembly_secs = t_asm.elapsed_secs();
        let t_solve = Clock::start();
        let (u_free, iterations, residual) = solve_reduced(&reduced, choice, options)?;
        let solve_secs = t_solve.elapsed_secs();
        for (slot, &dof) in free_dofs.iter().enumerate() {
            displacement[dof] = u_free[slot];
        }
        (choice, iterations, residual, assembly_secs, solve_secs)
    };

    let (top, mid, bottom) = nodal_von_mises(
        nodes,
        elements,
        thickness,
        &directors,
        material,
        &displacement,
    )?;
    let mut envelope_samples = Vec::with_capacity(top.len() * 2);
    envelope_samples.extend_from_slice(&top);
    envelope_samples.extend_from_slice(&bottom);
    let (min, max, p95) = range_and_p95(&envelope_samples);
    let von_mises_envelope: Vec<f64> = top.iter().zip(&bottom).map(|(a, b)| a.max(*b)).collect();
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

    Ok(ShellOutput {
        displacement,
        von_mises_top: top,
        von_mises_mid: mid,
        von_mises_bottom: bottom,
        von_mises_envelope,
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

/// Consistent nodal forces for a uniform global traction (N/mm²).
///
/// The result is one force vector per node. Rotational DOFs are not loaded.
pub fn consistent_traction(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    traction: [f64; 3],
) -> Result<Vec<[f64; 3]>, FemError> {
    if traction.iter().any(|c| !c.is_finite()) {
        return Err(FemError::BadLoad(
            "a traction component is not finite".into(),
        ));
    }
    validate_shell_geometry(nodes, elements)?;
    let mut forces = vec![[0.0; 3]; nodes.len()];
    for (e, elem) in elements.iter().enumerate() {
        let xyz = elem_coords(nodes, elem);
        for gp in TRI_RULE {
            let surf = match midsurface(gp.r, gp.s, &xyz) {
                Some(surf) => surf,
                None => {
                    return Err(FemError::BadMesh(format!(
                        "shell element {e} has a degenerate mid-surface"
                    )))
                }
            };
            let scale = surf.area_jac * gp.w;
            for i in 0..NEN {
                let node = elem[i] as usize;
                let wi = surf.shape[i] * scale;
                for a in 0..3 {
                    forces[node][a] += wi * traction[a];
                }
            }
        }
    }
    Ok(forces)
}

fn validate_shell(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: &[f64],
) -> Result<(), FemError> {
    validate_shell_geometry(nodes, elements)?;
    if thickness.len() != elements.len() {
        return Err(FemError::BadMesh(format!(
            "thickness has length {} but there are {} shell elements",
            thickness.len(),
            elements.len()
        )));
    }
    for (e, &t) in thickness.iter().enumerate() {
        if !t.is_finite() || t <= 0.0 {
            return Err(FemError::BadMesh(format!(
                "element {e} thickness must be a finite number greater than 0 (millimetres)"
            )));
        }
    }
    Ok(())
}

fn validate_shell_geometry(nodes: &[[f64; 3]], elements: &[[u32; 6]]) -> Result<(), FemError> {
    if nodes.is_empty() || elements.is_empty() {
        return Err(FemError::BadMesh(
            "solve_shell needs at least one node and one shell element".into(),
        ));
    }
    if nodes.len() > (u32::MAX as usize) / 8 {
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
        for a in 0..NEN {
            for b in (a + 1)..NEN {
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

fn validate_shell_loads(
    n_nodes: usize,
    n_elem: usize,
    forces: &[NodalForce],
    pressures: &[ShellPressure],
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
    for (i, load) in pressures.iter().enumerate() {
        if load.element as usize >= n_elem {
            return Err(FemError::BadLoad(format!(
                "pressure {i} references element {} which is outside the mesh",
                load.element
            )));
        }
        if !load.pressure.is_finite() {
            return Err(FemError::BadLoad(format!("pressure {i} is not finite")));
        }
    }
    Ok(())
}

fn assemble_shell(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: &[f64],
    directors: &[[f64; 3]],
    material: Material,
    fixed: &[bool],
    prescribed: &[f64],
    forces: &[NodalForce],
    pressures: &[ShellPressure],
) -> Result<Reduced, FemError> {
    let n_nodes = nodes.len();
    let n_dof = n_nodes * SHELL_DOF_PER_NODE;
    let (free_index, free_dof) = free_maps(fixed);
    let n_free = free_dof.len();
    let neighbors = node_neighbors(n_nodes, elements);
    let (col_ptr, row_idx) = sparsity(&neighbors, &free_index, &free_dof)?;
    let mut values = vec![0.0; row_idx.len()];
    let mut rhs = vec![0.0; n_free];

    let mut global_force = vec![0.0; n_dof];
    for force in forces {
        let base = force.node as usize * SHELL_DOF_PER_NODE;
        for axis in 0..3 {
            global_force[base + axis] += force.force[axis];
        }
    }
    let mut pressure_on = vec![0.0; elements.len()];
    for load in pressures {
        pressure_on[load.element as usize] += load.pressure;
    }
    let c = plane_stress(material);
    let g_mod = material.young / (2.0 * (1.0 + material.poisson));

    for (e, elem) in elements.iter().enumerate() {
        let (ke, fe) = element_matrices(
            nodes,
            directors,
            elem,
            thickness[e],
            &c,
            g_mod,
            pressure_on[e],
        )
        .map_err(|_| {
            FemError::BadMesh(format!(
                "shell element {e} has a degenerate geometry or a folded director"
            ))
        })?;
        for i in 0..NEN {
            let node = elem[i] as usize;
            for axis in 0..3 {
                global_force[node * SHELL_DOF_PER_NODE + axis] += fe[i][axis];
            }
        }
        for li in 0..NDOF {
            let gi = elem[li / SHELL_DOF_PER_NODE] as usize * SHELL_DOF_PER_NODE
                + (li % SHELL_DOF_PER_NODE);
            for lj in 0..=li {
                let gj = elem[lj / SHELL_DOF_PER_NODE] as usize * SHELL_DOF_PER_NODE
                    + (lj % SHELL_DOF_PER_NODE);
                let k = ke[li * NDOF + lj];
                let ii = free_index[gi];
                let jj = free_index[gj];
                match (ii >= 0, jj >= 0) {
                    (true, true) => {
                        let (row, col) = if ii >= jj {
                            (ii as usize, jj as usize)
                        } else {
                            (jj as usize, ii as usize)
                        };
                        let pos = locate(&col_ptr, &row_idx, row, col)?;
                        values[pos] += k;
                    }
                    (true, false) => {
                        rhs[ii as usize] -= k * prescribed[gj];
                    }
                    (false, true) => {
                        rhs[jj as usize] -= k * prescribed[gi];
                    }
                    (false, false) => {}
                }
            }
        }
    }

    for (slot, &dof) in free_dof.iter().enumerate() {
        rhs[slot] += global_force[dof];
    }

    let mut diag = vec![0.0; n_free];
    for col in 0..n_free {
        let mut found = false;
        for p in col_ptr[col]..col_ptr[col + 1] {
            if row_idx[p] == col {
                diag[col] = values[p];
                found = true;
                break;
            }
        }
        if !found || !(diag[col].is_finite() && diag[col] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "free DOF {col} has a non-positive diagonal ({}); the shell is missing a support or an element is degenerate",
                diag[col]
            )));
        }
    }

    Ok(Reduced {
        matrix: LowerCsc {
            n: n_free,
            col_ptr,
            row_idx,
            values,
            diag,
        },
        rhs,
    })
}

fn nodal_von_mises(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: &[f64],
    directors: &[[f64; 3]],
    material: Material,
    displacement: &[f64],
) -> Result<(Vec<f64>, Vec<f64>, Vec<f64>), FemError> {
    let c = plane_stress(material);
    let mut acc_top = vec![[0.0; 6]; nodes.len()];
    let mut acc_mid = vec![[0.0; 6]; nodes.len()];
    let mut acc_bot = vec![[0.0; 6]; nodes.len()];
    let mut count = vec![0_u32; nodes.len()];
    for (e, elem) in elements.iter().enumerate() {
        let stresses = element_nodal_stress(nodes, directors, elem, thickness[e], &c, displacement)
            .map_err(|_| {
                FemError::BadMesh(format!(
                    "shell element {e} has a degenerate geometry while recovering stress"
                ))
            })?;
        for i in 0..NEN {
            let node = elem[i] as usize;
            add6(&mut acc_bot[node], stresses[i][0]);
            add6(&mut acc_mid[node], stresses[i][1]);
            add6(&mut acc_top[node], stresses[i][2]);
            count[node] += 1;
        }
    }
    let mut top = vec![0.0; nodes.len()];
    let mut mid = vec![0.0; nodes.len()];
    let mut bot = vec![0.0; nodes.len()];
    for node in 0..nodes.len() {
        if count[node] == 0 {
            return Err(FemError::BadMesh(format!(
                "node {node} is not connected to a shell element"
            )));
        }
        let scale = f64::from(count[node]);
        for comp in 0..6 {
            acc_top[node][comp] /= scale;
            acc_mid[node][comp] /= scale;
            acc_bot[node][comp] /= scale;
        }
        top[node] = von_mises(&acc_top[node]);
        mid[node] = von_mises(&acc_mid[node]);
        bot[node] = von_mises(&acc_bot[node]);
    }
    Ok((top, mid, bot))
}

fn add6(into: &mut [f64; 6], sample: [f64; 6]) {
    for comp in 0..6 {
        into[comp] += sample[comp];
    }
}

// --- element -----------------------------------------------------------------

#[derive(Clone, Copy)]
struct TriGp {
    r: f64,
    s: f64,
    w: f64,
}

/// Dunavant 7-point rule on the reference triangle of area 1/2.
const TRI_RULE: [TriGp; 7] = [
    TriGp {
        r: 1.0 / 3.0,
        s: 1.0 / 3.0,
        w: 0.1125,
    },
    TriGp {
        r: 0.059715871789770,
        s: 0.470142064105115,
        w: 0.066197076394253,
    },
    TriGp {
        r: 0.470142064105115,
        s: 0.059715871789770,
        w: 0.066197076394253,
    },
    TriGp {
        r: 0.470142064105115,
        s: 0.470142064105115,
        w: 0.066197076394253,
    },
    TriGp {
        r: 0.797426985353087,
        s: 0.101286507323456,
        w: 0.062969590272413,
    },
    TriGp {
        r: 0.101286507323456,
        s: 0.797426985353087,
        w: 0.062969590272413,
    },
    TriGp {
        r: 0.101286507323456,
        s: 0.101286507323456,
        w: 0.062969590272413,
    },
];

const ZETA: [(f64, f64); 2] = [(-0.5773502691896257, 1.0), (0.5773502691896257, 1.0)];

struct Mitc {
    a1: [f64; NDOF],
    b1: [f64; NDOF],
    c1: [f64; NDOF],
    a2: [f64; NDOF],
    b2: [f64; NDOF],
    c2: [f64; NDOF],
}

impl Mitc {
    fn eval(&self, r: f64, s: f64, dof: usize) -> (f64, f64) {
        (
            self.a1[dof] + self.b1[dof] * r + self.c1[dof] * s,
            self.a2[dof] + self.b2[dof] * r + self.c2[dof] * s,
        )
    }
}

struct Surf {
    g_r: [f64; 3],
    g_s: [f64; 3],
    g_z: [f64; 3],
    j_inv: [[f64; 3]; 3],
    det: f64,
    e1: [f64; 3],
    e2: [f64; 3],
    e3: [f64; 3],
    shape: [f64; NEN],
    dnr: [f64; NEN],
    dns: [f64; NEN],
    area_jac: f64,
}

struct ElemDof {
    u: [[f64; 3]; NEN],
    th: [[f64; 3]; NEN],
}

fn plane_stress(material: Material) -> [[f64; 5]; 5] {
    let e = material.young;
    let nu = material.poisson;
    let c = e / (1.0 - nu * nu);
    let g = e / (2.0 * (1.0 + nu));
    let ks = SHEAR_FACTOR * g;
    [
        [c, c * nu, 0.0, 0.0, 0.0],
        [c * nu, c, 0.0, 0.0, 0.0],
        [0.0, 0.0, g, 0.0, 0.0],
        [0.0, 0.0, 0.0, ks, 0.0],
        [0.0, 0.0, 0.0, 0.0, ks],
    ]
}

fn element_matrices(
    nodes: &[[f64; 3]],
    directors: &[[f64; 3]],
    elem: &[u32; 6],
    thickness: f64,
    c: &[[f64; 5]; 5],
    g_mod: f64,
    pressure: f64,
) -> Result<([f64; NDOF * NDOF], [[f64; 3]; NEN]), ()> {
    let xyz = elem_coords(nodes, elem);
    let dir = elem_dirs(directors, elem);
    let mitc = build_mitc(&xyz, &dir, thickness)?;
    let mut ke = [0.0; NDOF * NDOF];
    let mut fe = [[0.0; 3]; NEN];
    let mut strain = [[0.0; 5]; NDOF];

    for gp in TRI_RULE {
        let mid = at_zeta(gp.r, gp.s, 0.0, thickness, &xyz, &dir).ok_or(())?;
        let mut gamma = [(0.0, 0.0); NDOF];
        for dof in 0..NDOF {
            let (ert, est) = mitc.eval(gp.r, gp.s, dof);
            gamma[dof] = shear_engineering(ert, est, &mid);
        }
        if pressure != 0.0 {
            let normal = normalize(cross(mid.g_r, mid.g_s)).ok_or(())?;
            let scale = -pressure * mid.area_jac * gp.w;
            for i in 0..NEN {
                let wi = mid.shape[i] * scale;
                for a in 0..3 {
                    fe[i][a] += wi * normal[a];
                }
            }
        }
        // Drilling lives on the mid-surface, independent of ζ.
        let mut drill = [0.0; NDOF];
        for dof in 0..NDOF {
            drill[dof] = drilling_constraint(&mid, &dir, &unit_dof(dof));
        }
        let drill_scale = DRILL_ALPHA * g_mod * thickness * mid.area_jac * gp.w;
        for a in 0..NDOF {
            for b in 0..=a {
                ke[a * NDOF + b] += drill_scale * drill[a] * drill[b];
            }
        }

        for &(zeta, zw) in &ZETA {
            let surf = at_zeta(gp.r, gp.s, zeta, thickness, &xyz, &dir).ok_or(())?;
            for dof in 0..NDOF {
                let mut eps = engineering_from_disp(&surf, zeta, thickness, &dir, &unit_dof(dof));
                eps[3] = gamma[dof].0;
                eps[4] = gamma[dof].1;
                strain[dof] = eps;
            }
            let weight = surf.det * gp.w * zw;
            for a in 0..NDOF {
                for b in 0..=a {
                    let mut kab = 0.0;
                    for p in 0..5 {
                        for q in 0..5 {
                            kab += strain[a][p] * c[p][q] * strain[b][q];
                        }
                    }
                    ke[a * NDOF + b] += kab * weight;
                }
            }
        }
    }
    Ok((ke, fe))
}

/// Consistent translational and rotary inertia, `36×36`, row-major.
///
/// Translations carry `ρ t`. Rotations carry `ρ t³/12` on all three
/// components, which is the bending rotary inertia and the same inertia on
/// the drilling axis so the mass matrix stays positive definite on the
/// Hughes–Brezzi degree of freedom. `density` is tonne/mm³.
fn element_mass(
    nodes: &[[f64; 3]],
    elem: &[u32; 6],
    thickness: f64,
    density: f64,
) -> Result<[f64; NDOF * NDOF], ()> {
    let xyz = elem_coords(nodes, elem);
    let mut me = [0.0; NDOF * NDOF];
    let rotary = thickness * thickness / 12.0;
    for gp in TRI_RULE {
        let mid = midsurface(gp.r, gp.s, &xyz).ok_or(())?;
        let area = mid.area_jac * gp.w;
        let trans = density * thickness * area;
        let rot = density * thickness * rotary * area;
        for i in 0..NEN {
            for j in 0..=i {
                let nij = mid.shape[i] * mid.shape[j];
                for axis in 0..3 {
                    let li = i * SHELL_DOF_PER_NODE + axis;
                    let lj = j * SHELL_DOF_PER_NODE + axis;
                    me[li * NDOF + lj] += trans * nij;
                    let ri = i * SHELL_DOF_PER_NODE + 3 + axis;
                    let rj = j * SHELL_DOF_PER_NODE + 3 + axis;
                    me[ri * NDOF + rj] += rot * nij;
                }
            }
        }
    }
    Ok(me)
}

/// Global stress at the 6 nodes, each as bottom / mid / top.
fn element_nodal_stress(
    nodes: &[[f64; 3]],
    directors: &[[f64; 3]],
    elem: &[u32; 6],
    thickness: f64,
    c: &[[f64; 5]; 5],
    displacement: &[f64],
) -> Result<[[[f64; 6]; 3]; NEN], ()> {
    let xyz = elem_coords(nodes, elem);
    let dir = elem_dirs(directors, elem);
    let mitc = build_mitc(&xyz, &dir, thickness)?;
    let dof = elem_dof(elem, displacement);
    const NODES_RS: [(f64, f64); NEN] = [
        (0.0, 0.0),
        (1.0, 0.0),
        (0.0, 1.0),
        (0.5, 0.0),
        (0.5, 0.5),
        (0.0, 0.5),
    ];
    let mut out = [[[0.0; 6]; 3]; NEN];
    for (i, (r, s)) in NODES_RS.iter().enumerate() {
        let mid = at_zeta(*r, *s, 0.0, thickness, &xyz, &dir).ok_or(())?;
        let (ert, est) = {
            let mut ert = 0.0;
            let mut est = 0.0;
            let packed = pack_elem(&dof);
            for k in 0..NDOF {
                let (er, es) = mitc.eval(*r, *s, k);
                ert += er * packed[k];
                est += es * packed[k];
            }
            (ert, est)
        };
        let (g13, g23) = shear_engineering(ert, est, &mid);
        for (layer, zeta) in [(0_usize, -1.0), (1, 0.0), (2, 1.0)] {
            let surf = at_zeta(*r, *s, zeta, thickness, &xyz, &dir).ok_or(())?;
            let mut eps = engineering_from_disp(&surf, zeta, thickness, &dir, &dof);
            eps[3] = g13;
            eps[4] = g23;
            let sigma = apply_c(c, eps);
            out[i][layer] = local_to_global(sigma, &surf);
        }
    }
    Ok(out)
}

fn pack_elem(dof: &ElemDof) -> [f64; NDOF] {
    let mut out = [0.0; NDOF];
    for i in 0..NEN {
        for a in 0..3 {
            out[i * 6 + a] = dof.u[i][a];
            out[i * 6 + 3 + a] = dof.th[i][a];
        }
    }
    out
}

fn apply_c(c: &[[f64; 5]; 5], eps: [f64; 5]) -> [f64; 5] {
    let mut sigma = [0.0; 5];
    for p in 0..5 {
        for q in 0..5 {
            sigma[p] += c[p][q] * eps[q];
        }
    }
    sigma
}

fn local_to_global(sigma: [f64; 5], surf: &Surf) -> [f64; 6] {
    // σ_local Voigt: σ11, σ22, σ12, σ13, σ23. σ33 = 0.
    let s = [
        [sigma[0], sigma[2], sigma[3]],
        [sigma[2], sigma[1], sigma[4]],
        [sigma[3], sigma[4], 0.0],
    ];
    let q = [surf.e1, surf.e2, surf.e3];
    // S_g = Q^T S_l Q, Q rows are the local basis.
    let mut sg = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut sum = 0.0;
            for a in 0..3 {
                for b in 0..3 {
                    sum += q[a][i] * s[a][b] * q[b][j];
                }
            }
            sg[i][j] = sum;
        }
    }
    [sg[0][0], sg[1][1], sg[2][2], sg[0][1], sg[1][2], sg[0][2]]
}

fn build_mitc(xyz: &[[f64; 3]; NEN], dir: &[[f64; 3]; NEN], thickness: f64) -> Result<Mitc, ()> {
    let half = 0.5 / 3.0_f64.sqrt();
    let g1 = 0.5 - half;
    let g2 = 0.5 + half;
    // Edge samples of the covariant shear, per DOF.
    let e1_rt = edge_samples(g1, 0.0, g2, 0.0, true, xyz, dir, thickness)?;
    let e2_st = edge_samples(0.0, g1, 0.0, g2, false, xyz, dir, thickness)?;
    let e3_rt = edge_samples(1.0 - g1, g1, 1.0 - g2, g2, true, xyz, dir, thickness)?;
    let e3_st = edge_samples(1.0 - g1, g1, 1.0 - g2, g2, false, xyz, dir, thickness)?;

    let mut mitc = Mitc {
        a1: [0.0; NDOF],
        b1: [0.0; NDOF],
        c1: [0.0; NDOF],
        a2: [0.0; NDOF],
        b2: [0.0; NDOF],
        c2: [0.0; NDOF],
    };
    for k in 0..NDOF {
        let (m1, l1) = mean_slope(e1_rt[0][k], e1_rt[1][k]);
        let (m2, l2) = mean_slope(e2_st[0][k], e2_st[1][k]);
        let (m3_rt, l3_rt) = mean_slope(e3_rt[0][k], e3_rt[1][k]);
        let (m3_st, l3_st) = mean_slope(e3_st[0][k], e3_st[1][k]);
        let a1 = m1 - l1;
        let b1 = 2.0 * l1;
        let a2 = m2 - l2;
        let c2 = 2.0 * l2;
        // Tangential shear on the hypotenuse is E_st - E_rt.
        let m_q = m3_st - m3_rt;
        let l_q = l3_st - l3_rt;
        let c1 = (a2 + c2 - a1) - (m_q + l_q);
        let b2 = (a1 + b1 - a2) + (m_q - l_q);
        mitc.a1[k] = a1;
        mitc.b1[k] = b1;
        mitc.c1[k] = c1;
        mitc.a2[k] = a2;
        mitc.b2[k] = b2;
        mitc.c2[k] = c2;
    }
    Ok(mitc)
}

fn mean_slope(e1: f64, e2: f64) -> (f64, f64) {
    let m = 0.5 * (e1 + e2);
    let l = (3.0_f64.sqrt() / 2.0) * (e2 - e1);
    (m, l)
}

fn edge_samples(
    r1: f64,
    s1: f64,
    r2: f64,
    s2: f64,
    rt: bool,
    xyz: &[[f64; 3]; NEN],
    dir: &[[f64; 3]; NEN],
    thickness: f64,
) -> Result<[[f64; NDOF]; 2], ()> {
    let mut out = [[0.0; NDOF]; 2];
    for (slot, (r, s)) in [(r1, s1), (r2, s2)].iter().enumerate() {
        let surf = at_zeta(*r, *s, 0.0, thickness, xyz, dir).ok_or(())?;
        for k in 0..NDOF {
            let (ert, est) = covariant_shear(&surf, 0.0, thickness, dir, &unit_dof(k));
            out[slot][k] = if rt { ert } else { est };
        }
    }
    Ok(out)
}

fn engineering_from_disp(
    surf: &Surf,
    zeta: f64,
    thickness: f64,
    dir: &[[f64; 3]; NEN],
    dof: &ElemDof,
) -> [f64; 5] {
    let (du_dr, du_ds, du_dz) = disp_derivs(surf, zeta, thickness, dir, dof);
    let g = global_grad(surf, du_dr, du_ds, du_dz);
    let l = local_grad(surf, g);
    [
        l[0][0],
        l[1][1],
        l[0][1] + l[1][0],
        l[0][2] + l[2][0],
        l[1][2] + l[2][1],
    ]
}

fn covariant_shear(
    surf: &Surf,
    zeta: f64,
    thickness: f64,
    dir: &[[f64; 3]; NEN],
    dof: &ElemDof,
) -> (f64, f64) {
    let (du_dr, du_ds, du_dz) = disp_derivs(surf, zeta, thickness, dir, dof);
    (
        0.5 * (dot(surf.g_r, du_dz) + dot(surf.g_z, du_dr)),
        0.5 * (dot(surf.g_s, du_dz) + dot(surf.g_z, du_ds)),
    )
}

fn disp_derivs(
    surf: &Surf,
    zeta: f64,
    thickness: f64,
    dir: &[[f64; 3]; NEN],
    dof: &ElemDof,
) -> ([f64; 3], [f64; 3], [f64; 3]) {
    let mut du_dr = [0.0; 3];
    let mut du_ds = [0.0; 3];
    let mut du_dz = [0.0; 3];
    let half_t = 0.5 * thickness;
    for i in 0..NEN {
        let phi = cross(dof.th[i], dir[i]);
        let scale = zeta * half_t;
        for a in 0..3 {
            let along = dof.u[i][a] + scale * phi[a];
            du_dr[a] += surf.dnr[i] * along;
            du_ds[a] += surf.dns[i] * along;
            du_dz[a] += surf.shape[i] * half_t * phi[a];
        }
    }
    (du_dr, du_ds, du_dz)
}

fn drilling_constraint(surf: &Surf, _dir: &[[f64; 3]; NEN], dof: &ElemDof) -> f64 {
    let mut theta = [0.0; 3];
    let mut du_dr = [0.0; 3];
    let mut du_ds = [0.0; 3];
    for i in 0..NEN {
        for a in 0..3 {
            theta[a] += surf.shape[i] * dof.th[i][a];
            du_dr[a] += surf.dnr[i] * dof.u[i][a];
            du_ds[a] += surf.dns[i] * dof.u[i][a];
        }
    }
    let theta_n = dot(theta, surf.e3);
    let g = global_grad(surf, du_dr, du_ds, [0.0; 3]);
    let l = local_grad(surf, g);
    let omega = 0.5 * (l[1][0] - l[0][1]);
    theta_n - omega
}

fn shear_engineering(ert: f64, est: f64, surf: &Surf) -> (f64, f64) {
    let gr = [surf.j_inv[0][0], surf.j_inv[0][1], surf.j_inv[0][2]];
    let gs = [surf.j_inv[1][0], surf.j_inv[1][1], surf.j_inv[1][2]];
    let gz = [surf.j_inv[2][0], surf.j_inv[2][1], surf.j_inv[2][2]];
    let eps = |ea: [f64; 3]| {
        ert * (dot(gr, ea) * dot(gz, surf.e3) + dot(gz, ea) * dot(gr, surf.e3))
            + est * (dot(gs, ea) * dot(gz, surf.e3) + dot(gz, ea) * dot(gs, surf.e3))
    };
    (2.0 * eps(surf.e1), 2.0 * eps(surf.e2))
}

fn global_grad(surf: &Surf, du_dr: [f64; 3], du_ds: [f64; 3], du_dz: [f64; 3]) -> [[f64; 3]; 3] {
    let u = [du_dr, du_ds, du_dz];
    let mut g = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            // G = U J^{-1}, U columns are ∂u/∂ξ.
            g[i][j] = u[0][i] * surf.j_inv[0][j]
                + u[1][i] * surf.j_inv[1][j]
                + u[2][i] * surf.j_inv[2][j];
        }
    }
    g
}

fn local_grad(surf: &Surf, g: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    // L = Q G Q^T.
    let q = [surf.e1, surf.e2, surf.e3];
    let mut l = [[0.0; 3]; 3];
    for a in 0..3 {
        for b in 0..3 {
            let mut sum = 0.0;
            for i in 0..3 {
                for j in 0..3 {
                    sum += q[a][i] * g[i][j] * q[b][j];
                }
            }
            l[a][b] = sum;
        }
    }
    l
}

fn midsurface(r: f64, s: f64, xyz: &[[f64; 3]; NEN]) -> Option<Surf> {
    // Directors are not needed for the tangent metric. g_z is filled by the
    // caller that knows the thickness; pressure and traction only need area.
    let (shape, dnr, dns) = shape(r, s);
    let mut g_r = [0.0; 3];
    let mut g_s = [0.0; 3];
    for i in 0..NEN {
        for a in 0..3 {
            g_r[a] += dnr[i] * xyz[i][a];
            g_s[a] += dns[i] * xyz[i][a];
        }
    }
    let area_vec = cross(g_r, g_s);
    let area_jac = norm(area_vec);
    if !(area_jac.is_finite() && area_jac > 0.0) {
        return None;
    }
    Some(Surf {
        g_r,
        g_s,
        g_z: [0.0; 3],
        j_inv: [[0.0; 3]; 3],
        det: 0.0,
        e1: [0.0; 3],
        e2: [0.0; 3],
        e3: [0.0; 3],
        shape,
        dnr,
        dns,
        area_jac,
    })
}

fn at_zeta(
    r: f64,
    s: f64,
    zeta: f64,
    thickness: f64,
    xyz: &[[f64; 3]; NEN],
    dir: &[[f64; 3]; NEN],
) -> Option<Surf> {
    let (shape, dnr, dns) = shape(r, s);
    let half_t = 0.5 * thickness;
    let mut g_r = [0.0; 3];
    let mut g_s = [0.0; 3];
    let mut g_z = [0.0; 3];
    let mut area_r = [0.0; 3];
    let mut area_s = [0.0; 3];
    for i in 0..NEN {
        for a in 0..3 {
            area_r[a] += dnr[i] * xyz[i][a];
            area_s[a] += dns[i] * xyz[i][a];
            g_r[a] += dnr[i] * (xyz[i][a] + zeta * half_t * dir[i][a]);
            g_s[a] += dns[i] * (xyz[i][a] + zeta * half_t * dir[i][a]);
            g_z[a] += shape[i] * half_t * dir[i][a];
        }
    }
    let area_jac = norm(cross(area_r, area_s));
    let j = [
        [g_r[0], g_s[0], g_z[0]],
        [g_r[1], g_s[1], g_z[1]],
        [g_r[2], g_s[2], g_z[2]],
    ];
    let (j_inv, det) = invert3(j)?;
    if det <= 0.0 || area_jac <= 0.0 {
        return None;
    }
    let e3 = normalize(g_z)?;
    let t1 = sub(g_r, scale(e3, dot(g_r, e3)));
    let e1 = normalize(t1).or_else(|| normalize(sub(g_s, scale(e3, dot(g_s, e3)))))?;
    let e2 = cross(e3, e1);
    let e2 = normalize(e2)?;
    Some(Surf {
        g_r,
        g_s,
        g_z,
        j_inv,
        det,
        e1,
        e2,
        e3,
        shape,
        dnr,
        dns,
        area_jac,
    })
}

fn shape(r: f64, s: f64) -> ([f64; NEN], [f64; NEN], [f64; NEN]) {
    let l1 = 1.0 - r - s;
    let l2 = r;
    let l3 = s;
    let n = [
        l1 * (2.0 * l1 - 1.0),
        l2 * (2.0 * l2 - 1.0),
        l3 * (2.0 * l3 - 1.0),
        4.0 * l1 * l2,
        4.0 * l2 * l3,
        4.0 * l3 * l1,
    ];
    let d_l1 = 4.0 * l1 - 1.0;
    let d_l2 = 4.0 * l2 - 1.0;
    let d_l3 = 4.0 * l3 - 1.0;
    let dnr = [
        d_l1 * -1.0,
        d_l2 * 1.0,
        0.0,
        4.0 * (-1.0 * l2 + l1 * 1.0),
        4.0 * (1.0 * l3 + l2 * 0.0),
        4.0 * (0.0 * l1 + l3 * -1.0),
    ];
    let dns = [
        d_l1 * -1.0,
        0.0,
        d_l3 * 1.0,
        4.0 * (-1.0 * l2 + l1 * 0.0),
        4.0 * (0.0 * l3 + l2 * 1.0),
        4.0 * (1.0 * l1 + l3 * -1.0),
    ];
    (n, dnr, dns)
}

fn nodal_directors(nodes: &[[f64; 3]], elements: &[[u32; 6]]) -> Result<Vec<[f64; 3]>, FemError> {
    let mut acc = vec![[0.0; 3]; nodes.len()];
    const RS: [(f64, f64); NEN] = [
        (0.0, 0.0),
        (1.0, 0.0),
        (0.0, 1.0),
        (0.5, 0.0),
        (0.5, 0.5),
        (0.0, 0.5),
    ];
    for (e, elem) in elements.iter().enumerate() {
        let xyz = elem_coords(nodes, elem);
        for (i, (r, s)) in RS.iter().enumerate() {
            let Some(surf) = midsurface(*r, *s, &xyz) else {
                return Err(FemError::BadMesh(format!(
                    "shell element {e} has a degenerate mid-surface"
                )));
            };
            let n = cross(surf.g_r, surf.g_s);
            let node = elem[i] as usize;
            for a in 0..3 {
                acc[node][a] += n[a];
            }
        }
    }
    for (i, n) in acc.iter_mut().enumerate() {
        match normalize(*n) {
            Some(unit) => *n = unit,
            None => {
                return Err(FemError::BadMesh(format!(
                    "node {i} has no shell normal; elements around it cancel or are degenerate"
                )))
            }
        }
    }
    Ok(acc)
}

fn elem_coords(nodes: &[[f64; 3]], elem: &[u32; 6]) -> [[f64; 3]; NEN] {
    let mut xyz = [[0.0; 3]; NEN];
    for i in 0..NEN {
        xyz[i] = nodes[elem[i] as usize];
    }
    xyz
}

fn elem_dirs(directors: &[[f64; 3]], elem: &[u32; 6]) -> [[f64; 3]; NEN] {
    let mut dir = [[0.0; 3]; NEN];
    for i in 0..NEN {
        dir[i] = directors[elem[i] as usize];
    }
    dir
}

fn elem_dof(elem: &[u32; 6], displacement: &[f64]) -> ElemDof {
    let mut dof = ElemDof {
        u: [[0.0; 3]; NEN],
        th: [[0.0; 3]; NEN],
    };
    for i in 0..NEN {
        let base = elem[i] as usize * SHELL_DOF_PER_NODE;
        dof.u[i] = [
            displacement[base],
            displacement[base + 1],
            displacement[base + 2],
        ];
        dof.th[i] = [
            displacement[base + 3],
            displacement[base + 4],
            displacement[base + 5],
        ];
    }
    dof
}

fn unit_dof(k: usize) -> ElemDof {
    let mut dof = ElemDof {
        u: [[0.0; 3]; NEN],
        th: [[0.0; 3]; NEN],
    };
    let node = k / SHELL_DOF_PER_NODE;
    let comp = k % SHELL_DOF_PER_NODE;
    if comp < 3 {
        dof.u[node][comp] = 1.0;
    } else {
        dof.th[node][comp - 3] = 1.0;
    }
    dof
}

fn free_maps(fixed: &[bool]) -> (Vec<i64>, Vec<usize>) {
    let mut free_index = vec![-1_i64; fixed.len()];
    let mut free_dof = Vec::new();
    for (dof, &is_fixed) in fixed.iter().enumerate() {
        if !is_fixed {
            free_index[dof] = free_dof.len() as i64;
            free_dof.push(dof);
        }
    }
    (free_index, free_dof)
}

fn node_neighbors(n_nodes: usize, elements: &[[u32; 6]]) -> Vec<Vec<u32>> {
    let mut neighbors = vec![Vec::new(); n_nodes];
    for elem in elements {
        for a in 0..NEN {
            for b in 0..NEN {
                neighbors[elem[a] as usize].push(elem[b]);
            }
        }
    }
    for list in &mut neighbors {
        list.sort_unstable();
        list.dedup();
    }
    neighbors
}

fn sparsity(
    neighbors: &[Vec<u32>],
    free_index: &[i64],
    free_dof: &[usize],
) -> Result<(Vec<usize>, Vec<usize>), FemError> {
    let mut col_ptr = Vec::with_capacity(free_dof.len() + 1);
    let mut row_idx = Vec::new();
    col_ptr.push(0);
    for &global in free_dof {
        let node = global / SHELL_DOF_PER_NODE;
        let col = free_index[global] as usize;
        let mut rows = Vec::new();
        for &nb in &neighbors[node] {
            for axis in 0..SHELL_DOF_PER_NODE {
                let other = nb as usize * SHELL_DOF_PER_NODE + axis;
                let slot = free_index[other];
                if slot >= col as i64 {
                    rows.push(slot as usize);
                }
            }
        }
        rows.sort_unstable();
        rows.dedup();
        row_idx.extend_from_slice(&rows);
        col_ptr.push(row_idx.len());
    }
    Ok((col_ptr, row_idx))
}

fn locate(col_ptr: &[usize], row_idx: &[usize], row: usize, col: usize) -> Result<usize, FemError> {
    let start = col_ptr[col];
    let end = col_ptr[col + 1];
    row_idx[start..end]
        .binary_search(&row)
        .map(|offset| start + offset)
        .map_err(|_| {
            FemError::BadMesh(format!(
                "internal assembly missed the sparse entry ({row}, {col})"
            ))
        })
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn normalize(a: [f64; 3]) -> Option<[f64; 3]> {
    let n = norm(a);
    if !n.is_finite() || n <= 1e-14 {
        None
    } else {
        Some(scale(a, 1.0 / n))
    }
}

fn invert3(m: [[f64; 3]; 3]) -> Option<([[f64; 3]; 3], f64)> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if !det.is_finite() || det.abs() < 1e-30 {
        return None;
    }
    let inv_det = 1.0 / det;
    let inv = [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ];
    Some((inv, det))
}

/// Lowest modes of a MITC6 shell mesh.
///
/// `density_kg_m3` is kilograms per cubic metre. Rotary inertia is `ρ t³/12`
/// on every rotation, including drilling, so the mass matrix stays positive
/// definite. `modes == 0` means [`super::DEFAULT_MODES`].
pub fn modal_shell(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: &[f64],
    material: Material,
    density_kg_m3: f64,
    dirichlet: &[Dirichlet],
    modes: usize,
) -> Result<super::ModalOutput, FemError> {
    super::validate_material(material)?;
    validate_shell(nodes, elements, thickness)?;
    let density = super::modal::density_tonne_per_mm3(density_kg_m3)?;
    let directors = nodal_directors(nodes, elements)?;
    let n_dof = nodes.len() * SHELL_DOF_PER_NODE;
    let (fixed, _prescribed, mut warnings) =
        super::modal::homogeneous_fixtures(n_dof, dirichlet)?;
    let k = super::modal::requested_modes(modes, &fixed, &mut warnings)?;
    let c = plane_stress(material);
    let g_mod = material.young / (2.0 * (1.0 + material.poisson));
    let t_asm = Clock::start();
    let km = super::pair::assemble_pair(
        nodes.len(),
        SHELL_DOF_PER_NODE,
        elements,
        &fixed,
        |element, elem| {
            let t = thickness[element];
            let (ke, _) = element_matrices(nodes, &directors, elem, t, &c, g_mod, 0.0).map_err(|_| {
                FemError::BadMesh(format!("shell element {element} has a degenerate mid-surface"))
            })?;
            let me = element_mass(nodes, elem, t, density).map_err(|_| {
                FemError::BadMesh(format!("shell element {element} has a degenerate mid-surface"))
            })?;
            Ok([ke.to_vec(), me.to_vec()])
        },
    )?;
    let assembly_secs = t_asm.elapsed_secs();
    let t_solve = Clock::start();
    let spectrum = super::eigen::lowest_modes(&km.stiffness, &km.mass, k)?;
    let solve_secs = t_solve.elapsed_secs();
    Ok(super::modal::complete(
        n_dof,
        SHELL_DOF_PER_NODE,
        &fixed,
        spectrum,
        &km.mass,
        warnings,
        assembly_secs,
        solve_secs,
    ))
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod shell_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_functions_partition_unity() {
        for (r, s) in [
            (0.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
            (0.5, 0.0),
            (1.0 / 3.0, 1.0 / 3.0),
        ] {
            let (n, dnr, dns) = shape(r, s);
            let sum: f64 = n.iter().sum();
            let dr: f64 = dnr.iter().sum();
            let ds: f64 = dns.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12, "sum {sum} at {r},{s}");
            assert!(dr.abs() < 1e-12 && ds.abs() < 1e-12, "dN {dr} {ds}");
        }
        let (n, _, _) = shape(0.0, 0.0);
        assert!((n[0] - 1.0).abs() < 1e-12);
        let (n, _, _) = shape(0.5, 0.5);
        assert!((n[4] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn triangle_rule_integrates_quadratics() {
        let mut area = 0.0;
        let mut r2 = 0.0;
        for gp in TRI_RULE {
            area += gp.w;
            r2 += gp.w * gp.r * gp.r;
        }
        assert!((area - 0.5).abs() < 1e-12, "area {area}");
        // ∫ r^2 dr ds over the reference triangle = 1/12.
        assert!((r2 - 1.0 / 12.0).abs() < 1e-12, "r2 {r2}");
    }
}
