//! Bonded contact between independently meshed solids.
//!
//! Each slave node is tied to one master TET10 face by a projection
//! multipoint constraint. The face is the 6-node triangle of a quadratic
//! tetrahedron (corners, then the three edge midpoints). Its shape
//! functions reproduce every linear field, so a constant-stress patch is
//! transmitted exactly across a planar interface even when the two meshes
//! do not share nodes.
//!
//! The constraints are eliminated before the solve. Substituting
//! `u_slave = Σ N_i u_master_i` into `K u = f` leaves a smaller symmetric
//! positive-definite matrix on the independent degrees of freedom. faer's
//! supernodal Cholesky and the Jacobi PCG both factor that matrix. A
//! penalty, or a penalty-augmented Lagrangian, leaves an interface gap of
//! order load/penalty, which cannot meet a 1e-8 patch test without a
//! penalty large enough to destroy the condition number. The saddle-point
//! form of an augmented Lagrangian is indefinite, so the Cholesky path
//! cannot take it.
//!
//! Shell-to-solid ties are not implemented. A shell node carries rotations.
//! Tying only its translations would leave the joint's bending and drilling
//! rotations unconstrained, and the shell's 6-DOF stencil is not the TET10
//! face this projector builds. Solid-to-solid is the bonded path.

use std::collections::{HashMap, HashSet};

use super::assemble::{LowerCsc, Reduced};
use super::stress::{self, von_mises};
use super::tet10::{self, elasticity};
use super::{
    dirichlet_map, range_and_p95, select_solver, solve_reduced, validate_loads, validate_material,
    validate_mesh, Clock, Dirichlet, FacePressure, FemError, FemOutput, Material, NodalForce,
    SolveOptions, Warning,
};

/// One independently meshed solid. Node indices in `elements` are local.
#[derive(Clone, Copy)]
pub struct SolidBody<'a> {
    pub nodes: &'a [[f64; 3]],
    pub elements: &'a [[u32; 10]],
    pub material: Material,
}

/// Slave node tied to a 6-node master face. `weights` are the quadratic
/// triangle shape functions at the projection of the slave node.
#[derive(Clone, Debug)]
pub struct SlaveTie {
    pub slave: u32,
    pub masters: [u32; 6],
    pub weights: [f64; 6],
}

/// Ties that landed on a master face, and slave nodes that did not.
#[derive(Clone, Debug)]
pub struct TieBuild {
    pub ties: Vec<SlaveTie>,
    pub missed: Vec<u32>,
}

/// Von Mises summary of one body inside a bonded solve.
#[derive(Clone, Debug)]
pub struct PartStress {
    pub node_offset: usize,
    pub node_count: usize,
    pub min: f64,
    pub max: f64,
    pub p95: f64,
    pub safety_factor: Option<f64>,
}

/// Combined field plus the per-part stress that the study safety factor uses.
#[derive(Clone, Debug)]
pub struct BondedOutput {
    pub fem: FemOutput,
    /// Index into [`BondedOutput::parts`] of the minimum yield/p95, if any.
    pub governing: Option<usize>,
    pub parts: Vec<PartStress>,
}

struct Combo {
    terms: Vec<(usize, f64)>,
    prescribed: f64,
}

/// Project each slave node onto the closest master face that contains it.
///
/// `gap` is the largest plane distance, in millimetres, that still counts
/// as on the face. A node that only meets the face along an extended plane
/// outside the triangle is a miss: clamping the barycentric coordinates
/// would not reproduce a linear field at that node.
pub fn tie_slaves(
    nodes: &[[f64; 3]],
    slaves: &[u32],
    faces: &[[u32; 6]],
    gap: f64,
) -> Result<TieBuild, FemError> {
    if !gap.is_finite() || gap < 0.0 {
        return Err(FemError::BadLoad(
            "bonded gap must be a finite distance greater than or equal to 0".into(),
        ));
    }
    let n = nodes.len() as u32;
    let mut ties = Vec::new();
    let mut missed = Vec::new();
    let mut seen = HashSet::new();
    for &slave in slaves {
        if slave >= n {
            return Err(FemError::BadMesh(format!(
                "slave node {slave} is outside the mesh"
            )));
        }
        if !seen.insert(slave) {
            continue;
        }
        match project_node(nodes, slave, faces, gap)? {
            Some(tie) => ties.push(tie),
            None => missed.push(slave),
        }
    }
    Ok(TieBuild { ties, missed })
}

/// Solve several solids as one model. `ties` use concatenated node indices:
/// body 0 keeps its indices, body 1 starts at `bodies[0].nodes.len()`, and
/// so on. Dirichlet, forces, and pressures use that same numbering.
pub fn solve_bonded(
    bodies: &[SolidBody<'_>],
    ties: &[SlaveTie],
    dirichlet: &[Dirichlet],
    forces: &[NodalForce],
    pressures: &[FacePressure],
    options: &SolveOptions,
) -> Result<BondedOutput, FemError> {
    if bodies.is_empty() {
        return Err(FemError::BadMesh(
            "solve_bonded needs at least one solid".into(),
        ));
    }
    for body in bodies {
        validate_material(body.material)?;
        validate_mesh(body.nodes, body.elements)?;
    }

    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    let mut body_of_element = Vec::new();
    let mut ranges = Vec::with_capacity(bodies.len());
    for (index, body) in bodies.iter().enumerate() {
        let offset = nodes.len() as u32;
        ranges.push((nodes.len(), body.nodes.len()));
        nodes.extend_from_slice(body.nodes);
        for elem in body.elements {
            let mut global = [0_u32; 10];
            for (slot, &id) in elem.iter().enumerate() {
                global[slot] = id + offset;
            }
            elements.push(global);
            body_of_element.push(index);
        }
    }

    let n_dof = nodes.len() * 3;
    let (fixed, prescribed) = dirichlet_map(n_dof, dirichlet)?;
    validate_loads(nodes.len(), forces, pressures)?;

    let mut slave_nodes = HashSet::new();
    let mut master_nodes = HashSet::new();
    for tie in ties {
        if tie.slave as usize >= nodes.len() {
            return Err(FemError::BadMesh(format!(
                "slave node {} is outside the mesh",
                tie.slave
            )));
        }
        if tie.weights.iter().any(|w| !w.is_finite()) {
            return Err(FemError::BadLoad(format!(
                "slave node {} has a non-finite tie weight",
                tie.slave
            )));
        }
        for &id in &tie.masters {
            if id as usize >= nodes.len() {
                return Err(FemError::BadMesh(format!(
                    "master node {id} is outside the mesh"
                )));
            }
            master_nodes.insert(id);
        }
        slave_nodes.insert(tie.slave);
    }
    for &id in &slave_nodes {
        if master_nodes.contains(&id) {
            return Err(FemError::BadMesh(format!(
                "node {id} is both a slave and a master; pick one side of the bond as the master"
            )));
        }
    }

    // A fixture wins over a tie. The node is already prescribed, and
    // eliminating it as well would either duplicate that value or fight it.
    let active: Vec<&SlaveTie> = ties
        .iter()
        .filter(|tie| {
            let base = tie.slave as usize * 3;
            !(fixed[base] || fixed[base + 1] || fixed[base + 2])
        })
        .collect();
    let mut tied = vec![false; nodes.len()];
    for tie in &active {
        tied[tie.slave as usize] = true;
    }

    let mut free_dof = Vec::new();
    let mut slot_of = vec![-1_i64; n_dof];
    for dof in 0..n_dof {
        let node = dof / 3;
        if fixed[dof] || tied[node] {
            continue;
        }
        slot_of[dof] = free_dof.len() as i64;
        free_dof.push(dof);
    }

    let mut combos = Vec::with_capacity(n_dof);
    for dof in 0..n_dof {
        if fixed[dof] {
            combos.push(Combo {
                terms: Vec::new(),
                prescribed: prescribed[dof],
            });
        } else if tied[dof / 3] {
            combos.push(Combo {
                terms: Vec::new(),
                prescribed: 0.0,
            });
        } else {
            combos.push(Combo {
                terms: vec![(slot_of[dof] as usize, 1.0)],
                prescribed: 0.0,
            });
        }
    }
    for tie in &active {
        for axis in 0..3 {
            let slave_dof = tie.slave as usize * 3 + axis;
            let mut acc: HashMap<usize, f64> = HashMap::new();
            let mut prescribed_sum = 0.0;
            for i in 0..6 {
                let weight = tie.weights[i];
                if weight == 0.0 {
                    continue;
                }
                let master = &combos[tie.masters[i] as usize * 3 + axis];
                for &(slot, master_weight) in &master.terms {
                    *acc.entry(slot).or_insert(0.0) += weight * master_weight;
                }
                prescribed_sum += weight * master.prescribed;
            }
            let mut terms: Vec<(usize, f64)> = acc.into_iter().collect();
            terms.sort_unstable_by_key(|(slot, _)| *slot);
            combos[slave_dof] = Combo {
                terms,
                prescribed: prescribed_sum,
            };
        }
    }

    let choice = select_solver(options.solver, free_dof.len(), options.cholesky_max_dofs);
    let mut displacement = vec![0.0; n_dof];
    for dof in 0..n_dof {
        if fixed[dof] {
            displacement[dof] = prescribed[dof];
        }
    }

    let (solver, iterations, residual, assembly_secs, solve_secs) = if free_dof.is_empty() {
        (choice, 0, 0.0, 0.0, 0.0)
    } else {
        let t_asm = Clock::start();
        let reduced = assemble_bonded(
            &nodes,
            &elements,
            &body_of_element,
            bodies,
            &combos,
            free_dof.len(),
            forces,
            pressures,
        )?;
        let assembly_secs = t_asm.elapsed_secs();
        let t_solve = Clock::start();
        let (u_free, iterations, residual, solver) = solve_reduced(&reduced, choice, options)?;
        let solve_secs = t_solve.elapsed_secs();
        for (slot, &dof) in free_dof.iter().enumerate() {
            displacement[dof] = u_free[slot];
        }
        (solver, iterations, residual, assembly_secs, solve_secs)
    };
    let index_fallback = solver != choice;

    for tie in &active {
        for axis in 0..3 {
            let mut value = 0.0;
            for i in 0..6 {
                let master = tie.masters[i] as usize * 3 + axis;
                value += tie.weights[i] * displacement[master];
            }
            displacement[tie.slave as usize * 3 + axis] = value;
        }
    }

    let mut von = Vec::with_capacity(nodes.len());
    let mut stress = Vec::with_capacity(nodes.len());
    let mut parts = Vec::with_capacity(bodies.len());
    let mut warnings = Vec::new();
    if index_fallback {
        warnings.push(Warning {
            code: "cholesky-index",
            msg: super::CHOLESKY_INDEX_NOTE.into(),
        });
    }
    let mut governing = None;
    let mut governing_factor = f64::INFINITY;
    for (index, body) in bodies.iter().enumerate() {
        let (offset, count) = ranges[index];
        let local_disp = &displacement[offset * 3..(offset + count) * 3];
        let local_stress =
            stress::nodal_stress(body.nodes, body.elements, body.material, local_disp)?;
        let local_von: Vec<f64> = local_stress.iter().map(|row| von_mises(row)).collect();
        let (min, max, p95) = range_and_p95(&local_von);
        let safety_factor = match body.material.yield_mpa {
            Some(yield_mpa) if p95.is_finite() && p95 > 0.0 => {
                let factor = yield_mpa / p95;
                if factor < governing_factor {
                    governing_factor = factor;
                    governing = Some(index);
                }
                Some(factor)
            }
            Some(_) => {
                warnings.push(Warning {
                    code: "zero-stress",
                    msg: format!("part {index} has p95 0, so its yield / p95 is undefined"),
                });
                None
            }
            None => {
                warnings.push(Warning {
                    code: "missing-yield",
                    msg: format!(
                        "part {index} has no yield_MPa, so it does not enter the study safety factor"
                    ),
                });
                None
            }
        };
        stress.extend(local_stress);
        von.extend(local_von);
        parts.push(PartStress {
            node_offset: offset,
            node_count: count,
            min,
            max,
            p95,
            safety_factor,
        });
    }
    let (min, max, p95) = range_and_p95(&von);
    let safety_factor = governing.map(|_| governing_factor);

    Ok(BondedOutput {
        fem: FemOutput {
            displacement,
            stress,
            von_mises: von,
            min,
            max,
            p95,
            safety_factor,
            warnings,
            dofs: n_dof,
            free_dofs: free_dof.len(),
            solver,
            iterations,
            residual,
            assembly_secs,
            solve_secs,
        },
        governing,
        parts,
    })
}

fn assemble_bonded(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    body_of_element: &[usize],
    bodies: &[SolidBody<'_>],
    combos: &[Combo],
    n_free: usize,
    forces: &[NodalForce],
    pressures: &[FacePressure],
) -> Result<Reduced, FemError> {
    let mut cols: Vec<HashMap<usize, f64>> = vec![HashMap::new(); n_free];
    let mut rhs = vec![0.0; n_free];
    let mut global_force = vec![0.0; nodes.len() * 3];
    tet10::assemble_forces(nodes, forces, pressures, &mut global_force)?;

    let mut elasticity_of: Vec<[f64; 36]> = Vec::with_capacity(bodies.len());
    for body in bodies {
        elasticity_of.push(elasticity(body.material));
    }

    for (element, elem) in elements.iter().enumerate() {
        let body = body_of_element[element];
        let (ke, _volume) = tet10::element_stiffness(nodes, elem, element, &elasticity_of[body])?;
        for li in 0..30 {
            let gi = elem[li / 3] as usize * 3 + (li % 3);
            let left = &combos[gi];
            for lj in 0..30 {
                let k = ke[li * 30 + lj];
                if k == 0.0 {
                    continue;
                }
                let gj = elem[lj / 3] as usize * 3 + (lj % 3);
                let right = &combos[gj];
                for &(p, wp) in &left.terms {
                    if right.prescribed != 0.0 {
                        rhs[p] -= wp * k * right.prescribed;
                    }
                    for &(q, wq) in &right.terms {
                        // A_pq gets this term. The lower triangle stores A_row,col
                        // for row >= col, and the matvec mirrors it. Adding the
                        // swapped pair as well would count K_ij and K_ji twice.
                        if p >= q {
                            let value = wp * k * wq;
                            if value != 0.0 {
                                *cols[q].entry(p).or_insert(0.0) += value;
                            }
                        }
                    }
                }
            }
        }
    }

    for (dof, &force) in global_force.iter().enumerate() {
        if force == 0.0 {
            continue;
        }
        for &(slot, weight) in &combos[dof].terms {
            rhs[slot] += weight * force;
        }
    }

    let mut col_ptr = Vec::with_capacity(n_free + 1);
    let mut row_idx = Vec::new();
    let mut values = Vec::new();
    let mut diag = vec![0.0; n_free];
    col_ptr.push(0);
    for col in 0..n_free {
        let mut rows: Vec<usize> = cols[col].keys().copied().collect();
        rows.sort_unstable();
        let mut found = false;
        for row in rows {
            let value = cols[col][&row];
            if row == col {
                diag[col] = value;
                found = true;
            }
            row_idx.push(row);
            values.push(value);
        }
        if !found || !(diag[col].is_finite() && diag[col] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "free DOF {col} has a non-positive diagonal ({}); the bond or the supports left a rigid mode",
                diag[col]
            )));
        }
        col_ptr.push(row_idx.len());
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

fn project_node(
    nodes: &[[f64; 3]],
    slave: u32,
    faces: &[[u32; 6]],
    gap: f64,
) -> Result<Option<SlaveTie>, FemError> {
    let point = nodes[slave as usize];
    let mut best: Option<(f64, usize, [f64; 3])> = None;
    for (index, face) in faces.iter().enumerate() {
        for &id in face {
            if id as usize >= nodes.len() {
                return Err(FemError::BadMesh(format!(
                    "master face {index} references node {id} outside the mesh"
                )));
            }
        }
        let a = nodes[face[0] as usize];
        let b = nodes[face[1] as usize];
        let c = nodes[face[2] as usize];
        let Some((bary, dist)) = plane_barycentric(point, a, b, c) else {
            continue;
        };
        if bary.iter().any(|w| *w < -1.0e-7) || dist.abs() > gap {
            continue;
        }
        let rank = dist.abs();
        let replace = match best {
            None => true,
            Some((best_dist, best_index, _)) => {
                rank < best_dist - 1.0e-15 || (rank <= best_dist + 1.0e-15 && index < best_index)
            }
        };
        if replace {
            best = Some((rank, index, bary));
        }
    }
    let Some((_, index, bary)) = best else {
        return Ok(None);
    };
    let weights = shape_weights(bary);
    let sum: f64 = weights.iter().sum();
    if (sum - 1.0).abs() > 1.0e-6 {
        return Ok(None);
    }
    Ok(Some(SlaveTie {
        slave,
        masters: faces[index],
        weights,
    }))
}

/// Area coordinates and the signed distance from `point` to the corner plane.
fn plane_barycentric(
    point: [f64; 3],
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
) -> Option<([f64; 3], f64)> {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let n = cross(ab, ac);
    let nn = dot(n, n);
    if nn < 1.0e-24 {
        return None;
    }
    let dist = dot(sub(point, a), n) / nn.sqrt();
    let q = [
        point[0] - n[0] / nn.sqrt() * dist,
        point[1] - n[1] / nn.sqrt() * dist,
        point[2] - n[2] / nn.sqrt() * dist,
    ];
    let aq = sub(q, a);
    let d00 = dot(ab, ab);
    let d01 = dot(ab, ac);
    let d11 = dot(ac, ac);
    let d20 = dot(aq, ab);
    let d21 = dot(aq, ac);
    let denom = d00 * d11 - d01 * d01;
    if denom.abs() < 1.0e-24 {
        return None;
    }
    let v = (d11 * d20 - d01 * d21) / denom;
    let w = (d00 * d21 - d01 * d20) / denom;
    let u = 1.0 - v - w;
    Some(([u, v, w], dist))
}

/// Quadratic triangle. `bary` is `(ξ0, ξ1, ξ2)` on corners `(c0, c1, c2)`.
/// Weights follow the TET10 face order `(c0, c1, c2, mid01, mid12, mid20)`.
fn shape_weights(bary: [f64; 3]) -> [f64; 6] {
    let (u, v, w) = (bary[0], bary[1], bary[2]);
    [
        u * (2.0 * u - 1.0),
        v * (2.0 * v - 1.0),
        w * (2.0 * w - 1.0),
        4.0 * u * v,
        4.0 * v * w,
        4.0 * w * u,
    ]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::tet10::face_traction_forces;
    use crate::fem::{Dirichlet, SolveOptions, SolverUsed};
    use crate::meshgen::brick_tet10;
    use std::collections::HashSet;

    fn steel() -> Material {
        Material {
            young: 210_000.0,
            poisson: 0.3,
            yield_mpa: Some(250.0),
        }
    }

    fn rel_l2(got: &[f64], exact: &[f64]) -> f64 {
        let mut num = 0.0;
        let mut den = 0.0;
        for (a, b) in got.iter().zip(exact) {
            let d = a - b;
            num += d * d;
            den += b * b;
        }
        num.sqrt() / den.sqrt().max(1e-30)
    }

    const FACES: [[usize; 6]; 4] = [
        [0, 1, 2, 4, 5, 6],
        [0, 1, 3, 4, 8, 7],
        [0, 2, 3, 6, 9, 7],
        [1, 2, 3, 5, 9, 8],
    ];

    fn faces_on_plane(
        mesh: &crate::meshgen::Tet10Mesh,
        axis: usize,
        value: f64,
        tol: f64,
        offset: u32,
    ) -> Vec<[u32; 6]> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        for elem in &mesh.elements {
            for local in FACES {
                let ids = local.map(|slot| elem[slot]);
                let on = ids
                    .iter()
                    .all(|&id| (mesh.nodes[id as usize][axis] - value).abs() <= tol);
                if !on {
                    continue;
                }
                let mut key = [ids[0], ids[1], ids[2]];
                key.sort_unstable();
                if seen.insert(key) {
                    found.push(ids.map(|id| id + offset));
                }
            }
        }
        found
    }

    fn nodes_on_plane(
        mesh: &crate::meshgen::Tet10Mesh,
        axis: usize,
        value: f64,
        tol: f64,
        offset: u32,
    ) -> Vec<u32> {
        let mut ids = Vec::new();
        for (i, node) in mesh.nodes.iter().enumerate() {
            if (node[axis] - value).abs() <= tol {
                ids.push(i as u32 + offset);
            }
        }
        ids
    }

    #[test]
    fn quadratic_face_reproduces_a_linear_field() {
        let mesh = brick_tet10([1, 1, 1], [0.0, 0.0, 0.0], [2.0, 3.0, 4.0]);
        let faces = faces_on_plane(&mesh, 0, 2.0, 1e-9, 0);
        assert!(!faces.is_empty());
        let face = faces[0];
        let corners = [
            mesh.nodes[face[0] as usize],
            mesh.nodes[face[1] as usize],
            mesh.nodes[face[2] as usize],
        ];
        let samples = [
            [0.2_f64, 0.3, 0.5],
            [0.0, 0.0, 1.0],
            [0.5, 0.5, 0.0],
            [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
        ];
        for bary in samples {
            let mut point = [0.0; 3];
            for k in 0..3 {
                point[0] += bary[k] * corners[k][0];
                point[1] += bary[k] * corners[k][1];
                point[2] += bary[k] * corners[k][2];
            }
            let weights = shape_weights(bary);
            let mut got = [0.0; 3];
            for i in 0..6 {
                let node = mesh.nodes[face[i] as usize];
                for k in 0..3 {
                    got[k] += weights[i] * node[k];
                }
            }
            for k in 0..3 {
                assert!(
                    (got[k] - point[k]).abs() < 1e-12,
                    "shape functions missed a linear coordinate"
                );
            }
            let sum: f64 = weights.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn bonded_patch_matches_constant_stress_to_1e_8() {
        let left = brick_tet10([2, 2, 2], [0.0, 0.0, 0.0], [5.0, 10.0, 10.0]);
        let right = brick_tet10([3, 2, 2], [5.0, 0.0, 0.0], [5.0, 10.0, 10.0]);
        let material = steel();
        let owned = [left, right];
        let mut nodes = Vec::new();
        for mesh in &owned {
            nodes.extend_from_slice(&mesh.nodes);
        }
        let bodies = [
            SolidBody {
                nodes: &owned[0].nodes,
                elements: &owned[0].elements,
                material,
            },
            SolidBody {
                nodes: &owned[1].nodes,
                elements: &owned[1].elements,
                material,
            },
        ];
        let master = faces_on_plane(&owned[0], 0, 5.0, 1e-8, 0);
        let slaves = nodes_on_plane(&owned[1], 0, 5.0, 1e-8, owned[0].nodes.len() as u32);
        let built = tie_slaves(&nodes, &slaves, &master, 1e-6).unwrap();
        assert!(built.missed.is_empty(), "missed {}", built.missed.len());
        assert!(built.ties.len() >= 4, "expected interior and edge slaves");

        let eps = 1.0e-3;
        let exact_u = |p: [f64; 3]| [eps * p[0], 0.0, 0.0];
        let mut dirichlet = Vec::new();
        for (i, p) in nodes.iter().enumerate() {
            let outer = p[0] <= 1e-8
                || (p[0] - 10.0).abs() <= 1e-8
                || p[1] <= 1e-8
                || (p[1] - 10.0).abs() <= 1e-8
                || p[2] <= 1e-8
                || (p[2] - 10.0).abs() <= 1e-8;
            if !outer {
                continue;
            }
            let u = exact_u(*p);
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: u[axis],
                });
            }
        }
        let out = solve_bonded(
            &bodies,
            &built.ties,
            &dirichlet,
            &[],
            &[],
            &SolveOptions {
                solver: super::super::SolverChoice::Cholesky,
                ..SolveOptions::default()
            },
        )
        .unwrap();
        assert_eq!(out.fem.solver, SolverUsed::Cholesky);
        let mut exact = vec![0.0; out.fem.displacement.len()];
        for (i, p) in nodes.iter().enumerate() {
            let u = exact_u(*p);
            exact[i * 3] = u[0];
            exact[i * 3 + 1] = u[1];
            exact[i * 3 + 2] = u[2];
        }
        let disp_err = rel_l2(&out.fem.displacement, &exact);
        let c = elasticity(material);
        let mut sigma = [0.0; 6];
        for s in 0..6 {
            sigma[s] = c[s * 6] * eps;
        }
        let mut got_stress = Vec::new();
        let mut exact_stress = Vec::new();
        for row in &out.fem.stress {
            for comp in 0..6 {
                got_stress.push(row[comp]);
                exact_stress.push(sigma[comp]);
            }
        }
        let stress_err = rel_l2(&got_stress, &exact_stress);
        eprintln!("bonded patch disp_rel={disp_err:.3e} stress_rel={stress_err:.3e}");
        assert!(disp_err < 1e-8, "displacement error {disp_err:.3e}");
        assert!(stress_err < 1e-8, "stress error {stress_err:.3e}");

        let iterative = solve_bonded(
            &bodies,
            &built.ties,
            &dirichlet,
            &[],
            &[],
            &SolveOptions {
                solver: super::super::SolverChoice::Pcg,
                pcg_tol: 1e-14,
                pcg_max_iter: 5_000,
                ..SolveOptions::default()
            },
        )
        .unwrap();
        let pcg_err = rel_l2(&iterative.fem.displacement, &out.fem.displacement);
        eprintln!(
            "bonded patch pcg rel={pcg_err:.3e} iters={}",
            iterative.fem.iterations
        );
        assert!(
            pcg_err < 1e-8,
            "PCG left the Cholesky field by {pcg_err:.3e}"
        );
    }

    fn tip_load(
        mesh: &crate::meshgen::Tet10Mesh,
        offset: u32,
        length: f64,
        area: f64,
        load: f64,
    ) -> Vec<NodalForce> {
        let faces = faces_on_plane(mesh, 0, length, 1e-8 * length, offset);
        let tau = load / area;
        let mut force_at = vec![[0.0; 3]; mesh.nodes.len()];
        for face in &faces {
            let mut xyz = [[0.0; 3]; 6];
            for a in 0..6 {
                xyz[a] = mesh.nodes[(face[a] - offset) as usize];
            }
            let nodal = face_traction_forces(&xyz, [0.0, -tau, 0.0]);
            for a in 0..6 {
                let local = (face[a] - offset) as usize;
                for k in 0..3 {
                    force_at[local][k] += nodal[a][k];
                }
            }
        }
        force_at
            .iter()
            .enumerate()
            .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
            .map(|(node, f)| NodalForce {
                node: node as u32 + offset,
                force: *f,
            })
            .collect()
    }

    fn closest_uy(nodes: &[[f64; 3]], displacement: &[f64], target: [f64; 3]) -> f64 {
        let mut best = 0_usize;
        let mut dist = f64::INFINITY;
        for (i, p) in nodes.iter().enumerate() {
            let d = (p[0] - target[0]).powi(2)
                + (p[1] - target[1]).powi(2)
                + (p[2] - target[2]).powi(2);
            if d < dist {
                dist = d;
                best = i;
            }
        }
        -displacement[best * 3 + 1]
    }

    #[test]
    fn split_cantilever_matches_the_one_piece() {
        let length = 100.0;
        let height = 10.0;
        let width = 10.0;
        let load = 100.0;
        let material = steel();
        let whole = brick_tet10([12, 4, 4], [0.0, 0.0, 0.0], [length, height, width]);
        let mut fixed = Vec::new();
        for (i, p) in whole.nodes.iter().enumerate() {
            if p[0].abs() <= 1e-8 {
                for axis in 0..3 {
                    fixed.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let forces = tip_load(&whole, 0, length, height * width, load);
        let one = solve_bonded(
            &[SolidBody {
                nodes: &whole.nodes,
                elements: &whole.elements,
                material,
            }],
            &[],
            &fixed,
            &forces,
            &[],
            &SolveOptions::default(),
        )
        .unwrap();
        let one_tip = closest_uy(
            &whole.nodes,
            &one.fem.displacement,
            [length, height / 2.0, width / 2.0],
        );

        let left = brick_tet10([6, 4, 4], [0.0, 0.0, 0.0], [length / 2.0, height, width]);
        // Same cross-section family as the one-piece, with a different
        // division so the interface nodes do not coincide.
        let right = brick_tet10(
            [6, 3, 4],
            [length / 2.0, 0.0, 0.0],
            [length / 2.0, height, width],
        );
        let mut nodes = Vec::new();
        nodes.extend_from_slice(&left.nodes);
        nodes.extend_from_slice(&right.nodes);
        let master = faces_on_plane(&left, 0, length / 2.0, 1e-6, 0);
        let slaves = nodes_on_plane(&right, 0, length / 2.0, 1e-6, left.nodes.len() as u32);
        let built = tie_slaves(&nodes, &slaves, &master, 1e-4).unwrap();
        assert!(
            built.missed.is_empty(),
            "missed slaves {}",
            built.missed.len()
        );
        let mut split_fixed = Vec::new();
        for (i, p) in left.nodes.iter().enumerate() {
            if p[0].abs() <= 1e-8 {
                for axis in 0..3 {
                    split_fixed.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let split_forces = tip_load(
            &right,
            left.nodes.len() as u32,
            length,
            height * width,
            load,
        );
        let split = solve_bonded(
            &[
                SolidBody {
                    nodes: &left.nodes,
                    elements: &left.elements,
                    material,
                },
                SolidBody {
                    nodes: &right.nodes,
                    elements: &right.elements,
                    material,
                },
            ],
            &built.ties,
            &split_fixed,
            &split_forces,
            &[],
            &SolveOptions::default(),
        )
        .unwrap();
        let split_tip = closest_uy(
            &nodes,
            &split.fem.displacement,
            [length, height / 2.0, width / 2.0],
        );
        let disp_err = (split_tip - one_tip).abs() / one_tip.abs();
        let p95_err = (split.fem.p95 - one.fem.p95).abs() / one.fem.p95.abs();
        eprintln!(
            "cantilever one_tip={one_tip:.6} split_tip={split_tip:.6} disp_err={disp_err:.4} one_p95={:.4} split_p95={:.4} p95_err={p95_err:.4}",
            one.fem.p95, split.fem.p95
        );
        assert!(disp_err < 0.01, "tip displacement error {disp_err:.4}");
        assert!(p95_err < 0.03, "p95 error {p95_err:.4}");
    }

    #[test]
    fn bimetal_beam_matches_composite_theory() {
        // Two layers of equal thickness, different moduli, bonded on z = h/2.
        // The tip load is -z. Composite-beam theory uses the transformed
        // section about the shifted neutral axis. Shear is a fraction of a
        // percent at L/h = 20, inside the 5% gate.
        let length = 200.0_f64;
        let width = 10.0;
        let half = 5.0;
        let load = 50.0;
        let e1 = 210_000.0;
        let e2 = 70_000.0;
        let nu = 0.3;
        let bottom_m = Material {
            young: e1,
            poisson: nu,
            yield_mpa: Some(250.0),
        };
        let top_m = Material {
            young: e2,
            poisson: nu,
            yield_mpa: Some(95.0),
        };
        let n = e2 / e1;
        let a1 = width * half;
        let a2 = n * width * half;
        let y1 = half / 2.0;
        let y2 = half + half / 2.0;
        let ybar = (a1 * y1 + a2 * y2) / (a1 + a2);
        let i1 = width * half.powi(3) / 12.0 + a1 * (y1 - ybar).powi(2);
        let i2 = n * (width * half.powi(3) / 12.0 + (width * half) * (y2 - ybar).powi(2));
        let ieq = i1 + i2;
        let tip_ref = load * length.powi(3) / (3.0 * e1 * ieq);
        // Outer fibre of the stiffer layer (z = 0), transformed back.
        eprintln!("bimetal ybar={ybar:.4} Ieq={ieq:.4} tip_ref={tip_ref:.6}");

        let bottom = brick_tet10([20, 4, 3], [0.0, 0.0, 0.0], [length, width, half]);
        let top = brick_tet10([16, 3, 2], [0.0, 0.0, half], [length, width, half]);
        let mut nodes = Vec::new();
        nodes.extend_from_slice(&bottom.nodes);
        nodes.extend_from_slice(&top.nodes);
        let master = faces_on_plane(&bottom, 2, half, 1e-6, 0);
        let slaves = nodes_on_plane(&top, 2, half, 1e-6, bottom.nodes.len() as u32);
        let built = tie_slaves(&nodes, &slaves, &master, 1e-4).unwrap();
        assert!(built.missed.is_empty(), "missed {}", built.missed.len());

        let mut dirichlet = Vec::new();
        for (i, p) in bottom.nodes.iter().enumerate() {
            if p[0].abs() <= 1e-8 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        for (i, p) in top.nodes.iter().enumerate() {
            if p[0].abs() <= 1e-8 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: ((bottom.nodes.len() + i) * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let mut forces = tip_traction(&bottom, 0, length, [0.0, 0.0, -load / 2.0]);
        forces.extend(tip_traction(
            &top,
            bottom.nodes.len() as u32,
            length,
            [0.0, 0.0, -load / 2.0],
        ));
        let out = solve_bonded(
            &[
                SolidBody {
                    nodes: &bottom.nodes,
                    elements: &bottom.elements,
                    material: bottom_m,
                },
                SolidBody {
                    nodes: &top.nodes,
                    elements: &top.elements,
                    material: top_m,
                },
            ],
            &built.ties,
            &dirichlet,
            &forces,
            &[],
            &SolveOptions::default(),
        )
        .unwrap();
        let mut tip_sum = 0.0;
        let mut tip_n = 0.0;
        for (i, p) in nodes.iter().enumerate() {
            if (p[0] - length).abs() <= 1e-6 {
                tip_sum += -out.fem.displacement[i * 3 + 2];
                tip_n += 1.0;
            }
        }
        let tip = tip_sum / tip_n;
        let disp_err = (tip - tip_ref).abs() / tip_ref;
        // Sample the fibre stress at the station nearest the root, not on
        // the fixed face, where extrapolation overshoots.
        let mut station = f64::INFINITY;
        for p in &bottom.nodes {
            if p[2].abs() <= 1e-8 && p[0] > 1e-6 {
                station = station.min(p[0]);
            }
        }
        let mut sigma = 0.0;
        let mut sigma_n = 0.0;
        let y_band = width / 4.0;
        for (i, p) in bottom.nodes.iter().enumerate() {
            if p[2].abs() <= 1e-8
                && (p[0] - station).abs() <= 1e-6
                && (p[1] - width / 2.0).abs() <= y_band
            {
                sigma += out.fem.stress[i][0].abs();
                sigma_n += 1.0;
            }
        }
        assert!(sigma_n > 0.0, "no bottom-fibre sample");
        let sigma = sigma / sigma_n;
        let moment = load * (length - station);
        let sigma_at = moment * ybar / ieq;
        let stress_err = (sigma - sigma_at).abs() / sigma_at.abs();
        eprintln!(
            "bimetal tip={tip:.6} ref={tip_ref:.6} disp_err={disp_err:.4} sigma={sigma:.4} theory={sigma_at:.4} stress_err={stress_err:.4} fos={:?} governs={:?}",
            out.fem.safety_factor, out.governing
        );
        assert!(disp_err < 0.05, "tip error {disp_err:.4}");
        assert!(stress_err < 0.05, "fibre stress error {stress_err:.4}");
        let bottom_fos = bottom_m.yield_mpa.unwrap() / out.parts[0].p95;
        let top_fos = top_m.yield_mpa.unwrap() / out.parts[1].p95;
        let expect = if bottom_fos <= top_fos { 0 } else { 1 };
        assert_eq!(out.governing, Some(expect));
        assert!((out.fem.safety_factor.unwrap() - bottom_fos.min(top_fos)).abs() < 1e-9);
    }

    fn tip_traction(
        mesh: &crate::meshgen::Tet10Mesh,
        offset: u32,
        length: f64,
        total: [f64; 3],
    ) -> Vec<NodalForce> {
        let faces = faces_on_plane(mesh, 0, length, 1e-6, offset);
        let mut area = 0.0;
        for face in &faces {
            let a = mesh.nodes[(face[0] - offset) as usize];
            let b = mesh.nodes[(face[1] - offset) as usize];
            let c = mesh.nodes[(face[2] - offset) as usize];
            area += cross(sub(b, a), sub(c, a))
                .iter()
                .map(|c| c * c)
                .sum::<f64>()
                .sqrt()
                * 0.5;
        }
        let tau = [total[0] / area, total[1] / area, total[2] / area];
        let mut force_at = vec![[0.0; 3]; mesh.nodes.len()];
        for face in &faces {
            let mut xyz = [[0.0; 3]; 6];
            for a in 0..6 {
                xyz[a] = mesh.nodes[(face[a] - offset) as usize];
            }
            let nodal = face_traction_forces(&xyz, tau);
            for a in 0..6 {
                let local = (face[a] - offset) as usize;
                for k in 0..3 {
                    force_at[local][k] += nodal[a][k];
                }
            }
        }
        force_at
            .iter()
            .enumerate()
            .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
            .map(|(node, f)| NodalForce {
                node: node as u32 + offset,
                force: *f,
            })
            .collect()
    }
}
