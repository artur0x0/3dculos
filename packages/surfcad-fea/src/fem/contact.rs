//! Frictionless and frictional contact between independently meshed solids.
//!
//! Node-to-surface, small sliding, small strain. Each slave node keeps the
//! master face it projected onto at the start. A mortar (segment-to-segment)
//! coupling would fill in the interface and force a refactor on a denser
//! pattern; the active-set loop already refactorizes whenever stick, slip, or
//! open changes, and the phone cap is a few tens of thousands of degrees of
//! freedom, so the extra cost is not justified.
//!
//! The contact contribution is a penalty plus an Uzawa update of the
//! multiplier (augmented Lagrangian on the primal). The tangent is symmetric
//! positive definite: open nodes add nothing, a closed node adds
//! `ε n ⊗ n`, stick adds the same in the tangent plane, and slip keeps a
//! small tangential stabilization so a block that has started to slide does
//! not leave a rigid mode. faer's supernodal Cholesky is reused while that
//! active set is unchanged and rebuilt when it changes. Jacobi PCG is the
//! fallback above the usual free-DOF threshold; it has no factor to reuse.
//!
//! Coulomb friction uses a stick/slip return map. Frictionless contact is the
//! same loop with `μ = 0`, so a closed node is always slip. The safety factor
//! is still yield / p95 of the von Mises field.

use std::collections::{HashMap, HashSet};

use super::assemble::LowerCsc;
use super::linear::{pcg, SupernodalFactor};
use super::stress::{self, von_mises};
use super::tet10::{self, elasticity};
use super::tie::SlaveTie;
use super::{
    dirichlet_map, range_and_p95, select_solver, validate_loads, validate_material, validate_mesh,
    Clock, Dirichlet, FacePressure, FemError, FemOutput, NodalForce, SolidBody, SolveOptions,
    SolverUsed, Warning,
};

/// Default Coulomb coefficient when a frictional pair omits `mu`.
pub const DEFAULT_FRICTION: f64 = 0.2;

/// Penalty multiplier on `E √A`. Large enough that one Uzawa pass closes the
/// gap, small enough that the augmented system stays factorable.
pub const DEFAULT_PENALTY_SCALE: f64 = 40.0;

/// Active-set / Uzawa iterations before [`FemError::ContactNotConverged`].
pub const DEFAULT_CONTACT_ITERATIONS: usize = 40;

/// How the pair transmits tangential force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContactLaw {
    Frictionless,
    Frictional,
}

/// One independently meshed pair. Node ids are concatenated across bodies,
/// the same numbering as [`super::solve_bonded`].
#[derive(Clone, Debug)]
pub struct ContactSurface {
    pub slaves: Vec<u32>,
    pub master_faces: Vec<[u32; 6]>,
    /// Slave faces used only to give each node a tributary area.
    pub slave_faces: Vec<[u32; 6]>,
    pub law: ContactLaw,
    pub mu: f64,
    /// Largest initial separation, in millimetres, that is still a candidate.
    pub gap: f64,
}

/// Knobs for one contact solve. [`Default`] matches the crate defaults.
#[derive(Clone, Debug)]
pub struct ContactOptions {
    pub solve: SolveOptions,
    pub max_iterations: usize,
    pub penalty_scale: f64,
}

impl Default for ContactOptions {
    fn default() -> Self {
        Self {
            solve: SolveOptions::default(),
            max_iterations: DEFAULT_CONTACT_ITERATIONS,
            penalty_scale: DEFAULT_PENALTY_SCALE,
        }
    }
}

/// Open, stick, or slip. Frictionless contact reports slip for a closed node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ContactStatus {
    Open = 0,
    Stick = 1,
    Slip = 2,
}

impl ContactStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Stick => "stick",
            Self::Slip => "slip",
        }
    }
}

/// One slave node after the last accepted iteration.
#[derive(Clone, Debug)]
pub struct ContactNode {
    pub node: u32,
    pub pressure: f64,
    pub status: ContactStatus,
    pub gap: f64,
    /// Compression, newtons.
    pub normal_force: f64,
    /// Magnitude of the Coulomb traction, newtons. The slip stabilization
    /// is not included.
    pub tangent_force: f64,
    pub area: f64,
    /// Tangential relative displacement, millimetres.
    pub tangent_slip: f64,
    /// Master-face nodes, so the same pressure can be drawn on both faces.
    pub masters: [u32; 6],
    pub weights: [f64; 6],
}

/// Bonded-style stress field plus the contact samples.
#[derive(Clone, Debug)]
pub struct ContactSolve {
    pub bonded: super::BondedOutput,
    pub nodes: Vec<ContactNode>,
    pub iterations: usize,
    pub refactors: usize,
    pub reused: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Open,
    Stick,
    Slip,
}

struct Combo {
    terms: Vec<(usize, f64)>,
    prescribed: f64,
}

struct DirOp {
    terms: Vec<(usize, f64)>,
    prescribed: f64,
}

struct Point {
    slave: u32,
    masters: [u32; 6],
    weights: [f64; 6],
    normal: [f64; 3],
    tangent: [[f64; 3]; 2],
    g0: f64,
    area: f64,
    eps_n: f64,
    eps_t: f64,
    eps_stab: f64,
    mu: f64,
    frictional: bool,
    normal_op: DirOp,
    tangent_op: [DirOp; 2],
    status: Status,
    lambda_n: f64,
    lambda_t: [f64; 3],
}

struct Elastic {
    cols: Vec<HashMap<usize, f64>>,
    rhs: Vec<f64>,
}

/// Solve several solids with bonded ties eliminated and unilateral contact
/// enforced by a penalty / Uzawa active set.
pub fn solve_contact(
    bodies: &[SolidBody<'_>],
    ties: &[SlaveTie],
    surfaces: &[ContactSurface],
    dirichlet: &[Dirichlet],
    forces: &[NodalForce],
    pressures: &[FacePressure],
    options: &ContactOptions,
) -> Result<ContactSolve, FemError> {
    if bodies.is_empty() {
        return Err(FemError::BadMesh(
            "solve_contact needs at least one solid".into(),
        ));
    }
    if options.max_iterations == 0 {
        return Err(FemError::BadLoad(
            "contact max iterations must be at least 1".into(),
        ));
    }
    if !(options.penalty_scale.is_finite() && options.penalty_scale > 0.0) {
        return Err(FemError::BadLoad(
            "contact penalty scale must be a finite number greater than 0".into(),
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
    let mut young_of_node = Vec::new();
    for (index, body) in bodies.iter().enumerate() {
        let offset = nodes.len() as u32;
        ranges.push((nodes.len(), body.nodes.len()));
        nodes.extend_from_slice(body.nodes);
        young_of_node.extend(std::iter::repeat(body.material.young).take(body.nodes.len()));
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

    let (combos, free_dof, tied) = reduction(&nodes, ties, &fixed, &prescribed)?;
    let mut points = project_surfaces(&nodes, &elements, &young_of_node, surfaces, options)?;
    let missed = points.iter().filter(|point| point.area <= 0.0).count();
    points.retain(|point| point.area > 0.0);
    for point in &points {
        if tied[point.slave as usize] {
            return Err(FemError::BadMesh(format!(
                "node {} is a bonded slave and a contact slave",
                point.slave
            )));
        }
    }
    bind_operators(&mut points, &combos);

    let choice = select_solver(
        options.solve.solver,
        free_dof.len(),
        options.solve.cholesky_max_dofs,
    );
    let mut displacement = vec![0.0; n_dof];
    for dof in 0..n_dof {
        if fixed[dof] {
            displacement[dof] = prescribed[dof];
        }
    }

    let mut iterations = 0;
    let mut refactors = 0;
    let mut reused = 0;
    let mut assembly_secs = 0.0;
    let mut solve_secs = 0.0;
    let mut residual = 0.0;
    let mut factor: Option<SupernodalFactor> = None;
    let mut cached_pattern: Option<Vec<u8>> = None;
    let mut cached_matrix: Option<LowerCsc> = None;

    if !free_dof.is_empty() {
        let t_asm = Clock::start();
        let elastic = assemble_elastic(
            &nodes,
            &elements,
            &body_of_element,
            bodies,
            &combos,
            free_dof.len(),
            forces,
            pressures,
        )?;
        assembly_secs += t_asm.elapsed_secs();

        let mut converged = false;
        let mut stage_hint = "uzawa";
        for iter in 1..=options.max_iterations {
            iterations = iter;
            let pattern = pattern_of(&points);
            let t_asm = Clock::start();
            let rhs = contact_rhs(&elastic, &points);
            let rebuild = cached_pattern.as_ref() != Some(&pattern);
            if rebuild {
                let mut cols = elastic.cols.clone();
                add_contact_matrix(&mut cols, &points);
                let matrix = finish_matrix(cols)?;
                assembly_secs += t_asm.elapsed_secs();
                let t_solve = Clock::start();
                let (u_free, inner_iters, inner_res) =
                    solve_system(&matrix, &rhs, choice, options, &mut factor, true)?;
                solve_secs += t_solve.elapsed_secs();
                write_back(&mut displacement, &free_dof, &u_free);
                refactors += 1;
                cached_pattern = Some(pattern);
                cached_matrix = Some(matrix);
                if choice == SolverUsed::Pcg {
                    let _ = (inner_iters, inner_res);
                }
            } else {
                assembly_secs += t_asm.elapsed_secs();
                let t_solve = Clock::start();
                let (u_free, inner_iters, inner_res) = if choice == SolverUsed::Cholesky {
                    let factor = factor.as_mut().ok_or_else(|| {
                        FemError::Solver(
                            "Cholesky factor was missing for a reused active set".into(),
                        )
                    })?;
                    let mut u_free = vec![0.0; rhs.len()];
                    factor.solve_into(&rhs, &mut u_free)?;
                    (u_free, 0, 0.0)
                } else {
                    let matrix = cached_matrix.as_ref().ok_or_else(|| {
                        FemError::Solver(
                            "contact matrix was missing for a reused active set".into(),
                        )
                    })?;
                    solve_system(matrix, &rhs, choice, options, &mut factor, false)?
                };
                solve_secs += t_solve.elapsed_secs();
                write_back(&mut displacement, &free_dof, &u_free);
                reused += 1;
                if choice == SolverUsed::Pcg {
                    let _ = (inner_iters, inner_res);
                }
            }
            reconstruct_ties(&mut displacement, ties, &tied);

            let (same, jump, penetration, friction_miss, changed_open, changed_slip) =
                update_multipliers(&mut points, &displacement);
            let force_scale = force_scale_of(&points);
            let gap_tol = length_scale_of(&points);
            residual = (penetration / gap_tol)
                .max(jump / force_scale)
                .max(friction_miss / force_scale);
            stage_hint = if changed_open {
                "active-set"
            } else if changed_slip {
                "friction"
            } else {
                "uzawa"
            };
            if std::env::var_os("CONTACT_DEBUG").is_some() {
                let open = points
                    .iter()
                    .filter(|point| point.status == Status::Open)
                    .count();
                let stick = points
                    .iter()
                    .filter(|point| point.status == Status::Stick)
                    .count();
                let slip = points
                    .iter()
                    .filter(|point| point.status == Status::Slip)
                    .count();
                let mut umax = 0.0_f64;
                for value in &displacement {
                    umax = umax.max(value.abs());
                }
                eprintln!(
                    "contact iter={iter} open={open} stick={stick} slip={slip} pen={penetration:.3e} jump={jump:.3e} fric={friction_miss:.3e} gap_tol={gap_tol:.3e} force={force_scale:.3e} umax={umax:.3e} stage={stage_hint}"
                );
            }
            if same
                && penetration <= gap_tol
                && jump <= 2.0e-2 * force_scale
                && friction_miss <= 2.0e-2 * force_scale
            {
                converged = true;
                break;
            }
        }
        if !converged {
            return Err(FemError::ContactNotConverged {
                stage: stage_hint,
                iterations,
                residual,
            });
        }
    }

    let (output, warnings) = recover_stress(
        &nodes,
        bodies,
        &ranges,
        &displacement,
        free_dof.len(),
        choice,
        iterations,
        residual,
        assembly_secs,
        solve_secs,
    )?;
    let mut warnings = warnings;
    if missed > 0 {
        warnings.push(Warning {
            code: "contact-gap",
            msg: format!(
                "{missed} slave nodes had no tributary area on the contact face and were left out of the pair"
            ),
        });
    }
    let mut fem = output.fem;
    fem.warnings.append(&mut warnings);
    let samples = points
        .iter()
        .map(|point| ContactNode {
            node: point.slave,
            pressure: if point.area > 0.0 {
                point.lambda_n / point.area
            } else {
                0.0
            },
            status: match point.status {
                Status::Open => ContactStatus::Open,
                Status::Stick => ContactStatus::Stick,
                Status::Slip => ContactStatus::Slip,
            },
            gap: point.g0 + dot(point.normal, relative_disp(point, &displacement)),
            normal_force: point.lambda_n,
            tangent_force: norm(point.lambda_t),
            area: point.area,
            tangent_slip: {
                let rel = relative_disp(point, &displacement);
                let tangential = sub(rel, scale(point.normal, dot(point.normal, rel)));
                norm(tangential)
            },
            masters: point.masters,
            weights: point.weights,
        })
        .collect();

    Ok(ContactSolve {
        bonded: super::BondedOutput {
            fem,
            governing: output.governing,
            parts: output.parts,
        },
        nodes: samples,
        iterations,
        refactors,
        reused,
    })
}

fn force_scale_of(points: &[Point]) -> f64 {
    let mut scale = 1.0_f64;
    for point in points {
        scale = scale.max(point.lambda_n.abs());
        scale = scale.max(norm(point.lambda_t));
    }
    scale
}

fn length_scale_of(points: &[Point]) -> f64 {
    let mut scale = 1.0e-3_f64;
    for point in points {
        scale = scale.max(point.area.sqrt() * 1.0e-2);
    }
    scale
}

fn pattern_of(points: &[Point]) -> Vec<u8> {
    points
        .iter()
        .map(|point| match point.status {
            Status::Open => 0,
            Status::Stick => 1,
            Status::Slip => 2,
        })
        .collect()
}

fn write_back(displacement: &mut [f64], free_dof: &[usize], u_free: &[f64]) {
    for (slot, &dof) in free_dof.iter().enumerate() {
        displacement[dof] = u_free[slot];
    }
}

fn solve_system(
    matrix: &LowerCsc,
    rhs: &[f64],
    choice: SolverUsed,
    options: &ContactOptions,
    factor: &mut Option<SupernodalFactor>,
    store_factor: bool,
) -> Result<(Vec<f64>, usize, f64), FemError> {
    match choice {
        SolverUsed::Cholesky => {
            let mut built = SupernodalFactor::factorize(matrix)?;
            let mut u = vec![0.0; rhs.len()];
            built.solve_into(rhs, &mut u)?;
            if store_factor {
                *factor = Some(built);
            }
            Ok((u, 0, 0.0))
        }
        SolverUsed::Pcg => {
            if !(options.solve.pcg_tol.is_finite() && options.solve.pcg_tol > 0.0) {
                return Err(FemError::BadLoad(
                    "options.tol must be a finite number greater than 0".into(),
                ));
            }
            pcg(
                matrix,
                rhs,
                options.solve.pcg_tol,
                options.solve.pcg_max_iter,
            )
        }
    }
}

/// Under-relaxation for the Uzawa multiplier. A full step chatters on a
/// quadratic face: one node separates by a fraction of a micron, the penalty
/// calls that tension, and the next factorization loses the contact.
const UZAWA_RELAX: f64 = 0.5;

/// Status unchanged, multiplier jump, penetration, friction residual, and
/// whether the open set or only the stick/slip set moved.
fn update_multipliers(
    points: &mut [Point],
    displacement: &[f64],
) -> (bool, f64, f64, f64, bool, bool) {
    let mut same = true;
    let mut jump = 0.0_f64;
    let mut changed_open = false;
    let mut changed_slip = false;
    for point in points.iter_mut() {
        let rel = relative_disp(point, displacement);
        let g = point.g0 + dot(point.normal, rel);
        let u_t = sub(rel, scale(point.normal, dot(point.normal, rel)));
        let previous = point.status;
        let lambda_n_prev = point.lambda_n;
        let lambda_t_prev = point.lambda_t;
        let predicted = point.lambda_n - point.eps_n * g;
        let band = gap_band(point);
        // A closed node stays closed until the gap is clearly open. An open
        // node closes only after it has penetrated the band. The sign of
        // `predicted` alone is not enough: ε·g for a 1e-8 mm gap is already
        // a large tensile number.
        let release = match previous {
            Status::Open => g >= -band,
            _ => g > band && predicted <= 0.0,
        };
        if release {
            point.status = Status::Open;
            point.lambda_n = 0.0;
            point.lambda_t = [0.0; 3];
        } else if !point.frictional {
            point.status = Status::Slip;
            let target = predicted.max(0.0);
            point.lambda_n = lambda_n_prev + UZAWA_RELAX * (target - lambda_n_prev);
            point.lambda_t = [0.0; 3];
        } else {
            let target_n = predicted.max(0.0);
            let trial = sub(lambda_t_prev, scale(u_t, point.eps_t));
            let trial_norm = norm(trial);
            let limit = point.mu * target_n;
            let (status, target_t) = friction_return(
                trial,
                trial_norm,
                limit,
                target_n,
                point.eps_n,
                previous,
                lambda_t_prev,
            );
            point.status = status;
            point.lambda_n = lambda_n_prev + UZAWA_RELAX * (target_n - lambda_n_prev);
            point.lambda_t = add(
                lambda_t_prev,
                scale(sub(target_t, lambda_t_prev), UZAWA_RELAX),
            );
        }
        jump = jump.max((point.lambda_n - lambda_n_prev).abs());
        jump = jump.max(norm(sub(point.lambda_t, lambda_t_prev)));
        if point.status != previous {
            same = false;
            let opened = (previous == Status::Open) != (point.status == Status::Open);
            if opened {
                changed_open = true;
            } else {
                changed_slip = true;
            }
        }
    }
    let mut friction_miss = 0.0_f64;
    for point in points.iter() {
        if !point.frictional || point.status == Status::Open {
            continue;
        }
        let excess = (norm(point.lambda_t) - point.mu * point.lambda_n).max(0.0);
        friction_miss = friction_miss.max(excess);
    }
    (
        same,
        jump,
        penetration_of(points, displacement),
        friction_miss,
        changed_open,
        changed_slip,
    )
}

fn gap_band(point: &Point) -> f64 {
    (point.area.sqrt() * 1.0e-4).max(1.0e-5)
}

/// Coulomb return map. A closed node with essentially no pressure cannot
/// stick; calling it slip avoids a stick/slip refactor on roundoff.
///
/// Once a node is slipping, the traction direction is held. Re-reading it
/// from `λ - ε u_t` swings by tens of degrees: the tangential penalty turns
/// a few hundredths of a micron of elastic shear into a huge trial vector,
/// and that vector is not a stable slide direction.
fn friction_return(
    trial: [f64; 3],
    trial_norm: f64,
    limit: f64,
    target_n: f64,
    eps_n: f64,
    previous: Status,
    lambda_t_prev: [f64; 3],
) -> (Status, [f64; 3]) {
    if target_n <= 1.0e-8 * eps_n.max(1.0) {
        return (Status::Slip, [0.0; 3]);
    }
    if trial_norm <= limit.max(1.0e-12) {
        return (Status::Stick, trial);
    }
    let prev_norm = norm(lambda_t_prev);
    let dir = if previous == Status::Slip && prev_norm > 1.0e-10 {
        scale(lambda_t_prev, 1.0 / prev_norm)
    } else if trial_norm > 1.0e-14 {
        scale(trial, 1.0 / trial_norm)
    } else {
        [0.0; 3]
    };
    (Status::Slip, scale(dir, limit))
}

fn penetration_of(points: &[Point], displacement: &[f64]) -> f64 {
    let mut penetration = 0.0_f64;
    for point in points {
        let g = point.g0 + dot(point.normal, relative_disp(point, displacement));
        if point.status == Status::Open {
            if g < 0.0 {
                penetration = penetration.max(-g);
            }
        } else {
            penetration = penetration.max((-g).max(0.0));
        }
    }
    penetration
}

fn relative_disp(point: &Point, displacement: &[f64]) -> [f64; 3] {
    let mut rel = node_disp(displacement, point.slave);
    for i in 0..6 {
        let master = node_disp(displacement, point.masters[i]);
        rel = sub(rel, scale(master, point.weights[i]));
    }
    rel
}

fn node_disp(displacement: &[f64], node: u32) -> [f64; 3] {
    let base = node as usize * 3;
    [
        displacement[base],
        displacement[base + 1],
        displacement[base + 2],
    ]
}

fn contact_rhs(elastic: &Elastic, points: &[Point]) -> Vec<f64> {
    let mut rhs = elastic.rhs.clone();
    for point in points {
        if point.status == Status::Open {
            continue;
        }
        let g_pres = point.normal_op.prescribed;
        let load = point.lambda_n - point.eps_n * (point.g0 + g_pres);
        add_dir(&mut rhs, &point.normal_op, load);
        let (t1, t2) = tangential_load(point);
        add_dir(&mut rhs, &point.tangent_op[0], t1);
        add_dir(&mut rhs, &point.tangent_op[1], t2);
    }
    rhs
}

fn tangential_load(point: &Point) -> (f64, f64) {
    let l1 = dot(point.lambda_t, point.tangent[0]);
    let l2 = dot(point.lambda_t, point.tangent[1]);
    // Stabilization lives in the matrix, not in the Coulomb load.
    (l1, l2)
}

fn add_dir(rhs: &mut [f64], op: &DirOp, load: f64) {
    if load == 0.0 {
        return;
    }
    for &(slot, weight) in &op.terms {
        rhs[slot] += weight * load;
    }
}

fn add_contact_matrix(cols: &mut [HashMap<usize, f64>], points: &[Point]) {
    for point in points {
        if point.status == Status::Open {
            continue;
        }
        add_outer(cols, &point.normal_op, point.eps_n);
        let eps_t = if point.status == Status::Stick && point.frictional {
            point.eps_t
        } else {
            point.eps_stab
        };
        add_outer(cols, &point.tangent_op[0], eps_t);
        add_outer(cols, &point.tangent_op[1], eps_t);
    }
}

fn add_outer(cols: &mut [HashMap<usize, f64>], op: &DirOp, eps: f64) {
    if !(eps > 0.0) {
        return;
    }
    for &(p, wp) in &op.terms {
        for &(q, wq) in &op.terms {
            if p >= q {
                let value = eps * wp * wq;
                if value != 0.0 {
                    *cols[q].entry(p).or_insert(0.0) += value;
                }
            }
        }
    }
}

fn finish_matrix(cols: Vec<HashMap<usize, f64>>) -> Result<LowerCsc, FemError> {
    let n = cols.len();
    let mut col_ptr = Vec::with_capacity(n + 1);
    let mut row_idx = Vec::new();
    let mut values = Vec::new();
    let mut diag = vec![0.0; n];
    col_ptr.push(0);
    for col in 0..n {
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
                "free DOF {col} has a non-positive diagonal ({}); the contact set or the supports left a rigid mode",
                diag[col]
            )));
        }
        col_ptr.push(row_idx.len());
    }
    Ok(LowerCsc {
        n,
        col_ptr,
        row_idx,
        values,
        diag,
    })
}

fn bind_operators(points: &mut [Point], combos: &[Combo]) {
    for point in points {
        let mut weights = vec![(point.slave, 1.0)];
        for i in 0..6 {
            weights.push((point.masters[i], -point.weights[i]));
        }
        point.normal_op = direction_op(&weights, point.normal, combos);
        point.tangent_op[0] = direction_op(&weights, point.tangent[0], combos);
        point.tangent_op[1] = direction_op(&weights, point.tangent[1], combos);
    }
}

fn direction_op(weights: &[(u32, f64)], dir: [f64; 3], combos: &[Combo]) -> DirOp {
    let mut acc: HashMap<usize, f64> = HashMap::new();
    let mut prescribed = 0.0;
    for &(node, weight) in weights {
        if weight == 0.0 {
            continue;
        }
        for axis in 0..3 {
            let coef = weight * dir[axis];
            if coef == 0.0 {
                continue;
            }
            let combo = &combos[node as usize * 3 + axis];
            for &(slot, master_weight) in &combo.terms {
                *acc.entry(slot).or_insert(0.0) += coef * master_weight;
            }
            prescribed += coef * combo.prescribed;
        }
    }
    let mut terms: Vec<(usize, f64)> = acc
        .into_iter()
        .filter(|(_, value)| value.abs() > 1.0e-14)
        .collect();
    terms.sort_unstable_by_key(|(slot, _)| *slot);
    DirOp { terms, prescribed }
}

fn project_surfaces(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    young_of_node: &[f64],
    surfaces: &[ContactSurface],
    options: &ContactOptions,
) -> Result<Vec<Point>, FemError> {
    let mut areas = vec![0.0; nodes.len()];
    for surface in surfaces {
        if !(surface.gap.is_finite() && surface.gap >= 0.0) {
            return Err(FemError::BadLoad(
                "contact gap must be a finite distance greater than or equal to 0".into(),
            ));
        }
        if surface.law == ContactLaw::Frictional && !(surface.mu.is_finite() && surface.mu >= 0.0) {
            return Err(FemError::BadLoad(
                "friction coefficient must be a finite number greater than or equal to 0".into(),
            ));
        }
        for face in &surface.slave_faces {
            add_face_area(&mut areas, nodes, *face)?;
        }
    }
    let mut points = Vec::new();
    let mut seen = HashSet::new();
    for surface in surfaces {
        let mu = match surface.law {
            ContactLaw::Frictionless => 0.0,
            ContactLaw::Frictional => surface.mu,
        };
        let frictional = surface.law == ContactLaw::Frictional && mu > 0.0;
        // Quadratic node-to-surface oscillates when midside nodes are slaves
        // (the face shape functions are negative at the corners). Corners
        // carry the contact; the master side still uses all six weights.
        let mut corners = HashSet::new();
        for face in &surface.slave_faces {
            corners.insert(face[0]);
            corners.insert(face[1]);
            corners.insert(face[2]);
        }
        for &slave in &surface.slaves {
            if !corners.is_empty() && !corners.contains(&slave) {
                continue;
            }
            if slave as usize >= nodes.len() {
                return Err(FemError::BadMesh(format!(
                    "slave node {slave} is outside the mesh"
                )));
            }
            // Adjacent Manifold faces of one physical patch share edge nodes.
            // The first pair that projects the node owns it. A miss leaves
            // the node free for a later pair.
            if seen.contains(&slave) {
                continue;
            }
            let Some(hit) =
                project_node(nodes, elements, slave, &surface.master_faces, surface.gap)?
            else {
                continue;
            };
            seen.insert(slave);
            let area = areas[slave as usize];
            if !(area > 0.0) {
                points.push(placeholder(slave, hit, area));
                continue;
            }
            let h = area.sqrt();
            let young = young_of_node[slave as usize];
            let eps_n = options.penalty_scale * young * h;
            let close = hit.gap <= 1.0e-4;
            let status = if !close {
                Status::Open
            } else if frictional {
                Status::Stick
            } else {
                Status::Slip
            };
            let (t1, t2) = tangent_basis(hit.normal);
            points.push(Point {
                slave,
                masters: hit.masters,
                weights: hit.weights,
                normal: hit.normal,
                tangent: [t1, t2],
                g0: hit.gap,
                area,
                eps_n,
                eps_t: eps_n,
                eps_stab: eps_n * 1.0e-3,
                mu,
                frictional,
                normal_op: DirOp {
                    terms: Vec::new(),
                    prescribed: 0.0,
                },
                tangent_op: [
                    DirOp {
                        terms: Vec::new(),
                        prescribed: 0.0,
                    },
                    DirOp {
                        terms: Vec::new(),
                        prescribed: 0.0,
                    },
                ],
                status,
                lambda_n: 0.0,
                lambda_t: [0.0; 3],
            });
        }
    }
    Ok(points)
}

fn placeholder(slave: u32, hit: Hit, area: f64) -> Point {
    Point {
        slave,
        masters: hit.masters,
        weights: hit.weights,
        normal: hit.normal,
        tangent: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        g0: hit.gap,
        area,
        eps_n: 0.0,
        eps_t: 0.0,
        eps_stab: 0.0,
        mu: 0.0,
        frictional: false,
        normal_op: DirOp {
            terms: Vec::new(),
            prescribed: 0.0,
        },
        tangent_op: [
            DirOp {
                terms: Vec::new(),
                prescribed: 0.0,
            },
            DirOp {
                terms: Vec::new(),
                prescribed: 0.0,
            },
        ],
        status: Status::Open,
        lambda_n: 0.0,
        lambda_t: [0.0; 3],
    }
}

struct Hit {
    masters: [u32; 6],
    weights: [f64; 6],
    normal: [f64; 3],
    gap: f64,
}

fn project_node(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    slave: u32,
    faces: &[[u32; 6]],
    gap: f64,
) -> Result<Option<Hit>, FemError> {
    let point = nodes[slave as usize];
    let mut best: Option<(f64, usize, [f64; 3], [f64; 3])> = None;
    for (index, face) in faces.iter().enumerate() {
        for &id in face {
            if id as usize >= nodes.len() {
                return Err(FemError::BadMesh(format!(
                    "master face {index} references node {id} outside the mesh"
                )));
            }
            if id == slave {
                return Err(FemError::BadMesh(format!(
                    "node {slave} is both a slave and a master of the same contact"
                )));
            }
        }
        let corners = [face[0], face[1], face[2]];
        let a = nodes[corners[0] as usize];
        let b = nodes[corners[1] as usize];
        let c = nodes[corners[2] as usize];
        let Some((bary, dist, corner_n)) = plane_hit(point, a, b, c) else {
            continue;
        };
        if bary.iter().any(|w| *w < -1.0e-7) || dist.abs() > gap {
            continue;
        }
        let outward = outward_normal(nodes, elements, corners).unwrap_or(corner_n);
        let signed = dist * dot(corner_n, outward);
        let rank = signed.abs();
        let replace = match best {
            None => true,
            Some((best_dist, best_index, _, _)) => {
                rank < best_dist - 1.0e-15 || (rank <= best_dist + 1.0e-15 && index < best_index)
            }
        };
        if replace {
            best = Some((rank, index, bary, outward));
        }
    }
    let Some((_, index, bary, outward)) = best else {
        return Ok(None);
    };
    let weights = shape_weights(bary);
    let sum: f64 = weights.iter().sum();
    if (sum - 1.0).abs() > 1.0e-6 {
        return Ok(None);
    }
    let mut proj = [0.0; 3];
    for i in 0..6 {
        let node = nodes[faces[index][i] as usize];
        proj = add(proj, scale(node, weights[i]));
    }
    let gap_signed = dot(sub(point, proj), outward);
    Ok(Some(Hit {
        masters: faces[index],
        weights,
        normal: outward,
        gap: gap_signed,
    }))
}

fn outward_normal(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    corners: [u32; 3],
) -> Option<[f64; 3]> {
    let mut key = corners;
    key.sort_unstable();
    const LOCAL: [[usize; 4]; 4] = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 3, 1], [1, 2, 3, 0]];
    for elem in elements {
        for face in LOCAL {
            let ids = [elem[face[0]], elem[face[1]], elem[face[2]]];
            let mut sorted = ids;
            sorted.sort_unstable();
            if sorted != key {
                continue;
            }
            let opposite = elem[face[3]];
            let a = nodes[ids[0] as usize];
            let b = nodes[ids[1] as usize];
            let c = nodes[ids[2] as usize];
            let mut n = cross(sub(b, a), sub(c, a));
            let nn = norm(n);
            if nn < 1.0e-16 {
                return None;
            }
            n = scale(n, 1.0 / nn);
            if dot(n, sub(nodes[opposite as usize], a)) > 0.0 {
                n = scale(n, -1.0);
            }
            return Some(n);
        }
    }
    None
}

fn add_face_area(areas: &mut [f64], nodes: &[[f64; 3]], face: [u32; 6]) -> Result<(), FemError> {
    for &id in &face {
        if id as usize >= nodes.len() {
            return Err(FemError::BadMesh(format!(
                "slave face references node {id} outside the mesh"
            )));
        }
    }
    let p = |slot: usize| nodes[face[slot] as usize];
    // Four subtriangles of the quadratic face. The area is lumped onto the
    // three corners because only those nodes are contact slaves.
    let tris = [[0, 3, 5], [1, 4, 3], [2, 5, 4], [3, 4, 5]];
    let mut total = 0.0;
    for tri in tris {
        let area = triangle_area(p(tri[0]), p(tri[1]), p(tri[2]));
        if area > 0.0 {
            total += area;
        }
    }
    if total > 0.0 {
        let share = total / 3.0;
        for slot in 0..3 {
            areas[face[slot] as usize] += share;
        }
    }
    Ok(())
}

fn triangle_area(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    0.5 * norm(cross(sub(b, a), sub(c, a)))
}

fn plane_hit(
    point: [f64; 3],
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
) -> Option<([f64; 3], f64, [f64; 3])> {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let n = cross(ab, ac);
    let nn = dot(n, n);
    if nn < 1.0e-24 {
        return None;
    }
    let inv = 1.0 / nn.sqrt();
    let unit = scale(n, inv);
    let dist = dot(sub(point, a), unit);
    let q = sub(point, scale(unit, dist));
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
    Some(([u, v, w], dist, unit))
}

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

fn tangent_basis(normal: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let axis = if normal[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let t1 = normalize(cross(normal, axis));
    let t2 = cross(normal, t1);
    (t1, t2)
}

fn reduction(
    nodes: &[[f64; 3]],
    ties: &[SlaveTie],
    fixed: &[bool],
    prescribed: &[f64],
) -> Result<(Vec<Combo>, Vec<usize>, Vec<bool>), FemError> {
    let n_dof = nodes.len() * 3;
    let mut slave_nodes = HashSet::new();
    let mut master_nodes = HashSet::new();
    for tie in ties {
        if tie.slave as usize >= nodes.len() {
            return Err(FemError::BadMesh(format!(
                "slave node {} is outside the mesh",
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
    Ok((combos, free_dof, tied))
}

fn reconstruct_ties(displacement: &mut [f64], ties: &[SlaveTie], tied: &[bool]) {
    for tie in ties {
        if !tied[tie.slave as usize] {
            continue;
        }
        for axis in 0..3 {
            let mut value = 0.0;
            for i in 0..6 {
                let master = tie.masters[i] as usize * 3 + axis;
                value += tie.weights[i] * displacement[master];
            }
            displacement[tie.slave as usize * 3 + axis] = value;
        }
    }
}

fn assemble_elastic(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    body_of_element: &[usize],
    bodies: &[SolidBody<'_>],
    combos: &[Combo],
    n_free: usize,
    forces: &[NodalForce],
    pressures: &[FacePressure],
) -> Result<Elastic, FemError> {
    let mut cols: Vec<HashMap<usize, f64>> = vec![HashMap::new(); n_free];
    let mut rhs = vec![0.0; n_free];
    let mut global_force = vec![0.0; nodes.len() * 3];
    tet10::assemble_forces(nodes, forces, pressures, &mut global_force)?;
    let mut elasticity_of = Vec::with_capacity(bodies.len());
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
    Ok(Elastic { cols, rhs })
}

struct Recovered {
    fem: FemOutput,
    governing: Option<usize>,
    parts: Vec<super::PartStress>,
}

fn recover_stress(
    nodes: &[[f64; 3]],
    bodies: &[SolidBody<'_>],
    ranges: &[(usize, usize)],
    displacement: &[f64],
    free_dofs: usize,
    solver: SolverUsed,
    iterations: usize,
    residual: f64,
    assembly_secs: f64,
    solve_secs: f64,
) -> Result<(Recovered, Vec<Warning>), FemError> {
    let mut von = Vec::with_capacity(nodes.len());
    let mut stress = Vec::with_capacity(nodes.len());
    let mut parts = Vec::with_capacity(bodies.len());
    let mut warnings = Vec::new();
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
        parts.push(super::PartStress {
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
    Ok((
        Recovered {
            fem: FemOutput {
                displacement: displacement.to_vec(),
                stress,
                von_mises: von,
                min,
                max,
                p95,
                safety_factor,
                warnings: Vec::new(),
                dofs: nodes.len() * 3,
                free_dofs,
                solver,
                iterations: if solver == SolverUsed::Pcg {
                    iterations
                } else {
                    0
                },
                residual: if solver == SolverUsed::Pcg {
                    residual
                } else {
                    0.0
                },
                assembly_secs,
                solve_secs,
            },
            governing,
            parts,
        },
        warnings,
    ))
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
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

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn normalize(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a).max(1.0e-30);
    scale(a, 1.0 / n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::{Material, SolidBody, SolverChoice};
    use crate::meshgen::{brick_tet10, half_cylinder};
    use std::collections::HashSet;

    fn material(young: f64) -> Material {
        Material {
            young,
            poisson: 0.3,
            yield_mpa: Some(250.0),
        }
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

    fn nodes_of(faces: &[[u32; 6]]) -> Vec<u32> {
        let mut ids = Vec::new();
        for face in faces {
            ids.extend(face);
        }
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn cholesky() -> ContactOptions {
        ContactOptions {
            solve: SolveOptions {
                solver: SolverChoice::Cholesky,
                ..SolveOptions::default()
            },
            ..ContactOptions::default()
        }
    }

    fn linux_memory() -> (u64, u64) {
        let text = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let mut peak = 0_u64;
        let mut rss = 0_u64;
        for line in text.lines() {
            let (label, slot) = if let Some(rest) = line.strip_prefix("VmHWM:") {
                (rest, &mut peak)
            } else if let Some(rest) = line.strip_prefix("VmRSS:") {
                (rest, &mut rss)
            } else {
                continue;
            };
            let kb: u64 = label
                .split_whitespace()
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            *slot = kb * 1024;
        }
        (peak, rss)
    }

    fn stack(
        bottom: [usize; 3],
        top: [usize; 3],
        size: [f64; 3],
    ) -> (crate::meshgen::Tet10Mesh, crate::meshgen::Tet10Mesh) {
        let lower = brick_tet10(bottom, [0.0, 0.0, 0.0], size);
        let upper = brick_tet10(top, [0.0, 0.0, size[2]], size);
        (lower, upper)
    }

    #[test]
    fn frictionless_punch_pressure_is_uniform() {
        let size = [10.0, 8.0, 6.0];
        let (lower, upper) = stack([3, 2, 2], [4, 3, 2], size);
        let applied = 2.5;
        let out = compress(
            &lower,
            &upper,
            applied,
            ContactLaw::Frictionless,
            0.0,
            &cholesky(),
        )
        .expect("punch");
        let closed: Vec<_> = out
            .nodes
            .iter()
            .filter(|node| node.status != ContactStatus::Open)
            .collect();
        assert!(!closed.is_empty());
        assert!(closed.iter().all(|node| node.status == ContactStatus::Slip));
        let mean = closed.iter().map(|node| node.pressure).sum::<f64>() / closed.len() as f64;
        let min = closed
            .iter()
            .map(|node| node.pressure)
            .fold(f64::INFINITY, f64::min);
        let max = closed
            .iter()
            .map(|node| node.pressure)
            .fold(0.0_f64, f64::max);
        let err = (mean - applied).abs() / applied;
        let (peak, rss) = linux_memory();
        eprintln!(
            "punch P={applied:.3} mean={mean:.3} min={min:.3} max={max:.3} err={err:.3e} nodes={} iters={} refactors={} reused={} assembly_s={:.4} solve_s={:.4} peak_rss_mib={:.1} rss_mib={:.1}",
            closed.len(),
            out.iterations,
            out.refactors,
            out.reused,
            out.bonded.fem.assembly_secs,
            out.bonded.fem.solve_secs,
            peak as f64 / (1024.0 * 1024.0),
            rss as f64 / (1024.0 * 1024.0),
        );
        let weighted = closed.iter().map(|node| node.normal_force).sum::<f64>()
            / closed.iter().map(|node| node.area).sum::<f64>();
        let werr = (weighted - applied).abs() / applied;
        eprintln!("punch weighted={weighted:.3} werr={werr:.3e}");
        assert!(err < 0.08, "mean pressure {mean} vs {applied}");
        assert!(
            werr < 0.05,
            "area-weighted pressure {weighted} vs {applied}"
        );
        assert!(out.reused + 1 >= out.refactors || out.iterations > 1);
        assert!(out.bonded.fem.safety_factor.is_some());
    }

    fn compress(
        lower: &crate::meshgen::Tet10Mesh,
        upper: &crate::meshgen::Tet10Mesh,
        pressure: f64,
        law: ContactLaw,
        mu: f64,
        options: &ContactOptions,
    ) -> Result<ContactSolve, FemError> {
        let mat = material(10_000.0);
        let bodies = [
            SolidBody {
                nodes: &lower.nodes,
                elements: &lower.elements,
                material: mat,
            },
            SolidBody {
                nodes: &upper.nodes,
                elements: &upper.elements,
                material: mat,
            },
        ];
        let z_top = lower.nodes.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
        let master = faces_on_plane(lower, 2, z_top, 1e-8, 0);
        let offset = lower.nodes.len() as u32;
        let slave_faces = faces_on_plane(upper, 2, z_top, 1e-8, offset);
        let slaves = nodes_of(&slave_faces);
        let top = upper.nodes.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
        let load_faces = faces_on_plane(upper, 2, top, 1e-8, offset);
        let mut dirichlet = Vec::new();
        for (i, node) in lower.nodes.iter().enumerate() {
            if node[2].abs() <= 1e-8 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let pressures: Vec<FacePressure> = load_faces
            .iter()
            .map(|face| FacePressure {
                nodes: *face,
                pressure,
            })
            .collect();
        let surface = ContactSurface {
            slaves,
            master_faces: master,
            slave_faces,
            law,
            mu,
            gap: 0.05,
        };
        solve_contact(
            &bodies,
            &[],
            &[surface],
            &dirichlet,
            &[],
            &pressures,
            options,
        )
    }

    #[test]
    fn incline_sticks_above_tan_theta_and_slips_below() {
        let theta = 25.0_f64.to_radians();
        let tan = theta.tan();
        let stick_mu = tan * 1.8;
        let slip_mu = tan * 0.45;
        let stick = incline(theta, stick_mu).expect("stick");
        let slip = incline(theta, slip_mu).expect("slip");
        let (stick_n, stick_t, stick_u) = traction(&stick);
        let (slip_n, slip_t, slip_u) = traction(&slip);
        let (peak, rss) = linux_memory();
        eprintln!(
            "incline theta_deg={:.2} tan={tan:.4} mu_stick={stick_mu:.4} T/N={:.4} stick_mm={stick_u:.4e} mu_slip={slip_mu:.4} T/N={:.4} slip_mm={slip_u:.4e} iters_stick={} iters_slip={} peak_rss_mib={:.1} rss_mib={:.1}",
            theta.to_degrees(),
            stick_t / stick_n.max(1e-9),
            slip_t / slip_n.max(1e-9),
            stick.iterations,
            slip.iterations,
            peak as f64 / (1024.0 * 1024.0),
            rss as f64 / (1024.0 * 1024.0),
        );
        let stick_closed = stick
            .nodes
            .iter()
            .filter(|node| node.status != ContactStatus::Open)
            .count();
        let stick_stick = stick
            .nodes
            .iter()
            .filter(|node| node.status == ContactStatus::Stick)
            .count();
        let slip_slip = slip
            .nodes
            .iter()
            .filter(|node| node.status == ContactStatus::Slip)
            .count();
        assert!(stick_closed > 0);
        assert!(
            stick_stick * 2 >= stick_closed,
            "expected stick, got {stick_stick}/{stick_closed}"
        );
        assert!((stick_t / stick_n - tan).abs() / tan < 0.2, "stick T/N");
        assert!(slip_slip > 0, "expected slip");
        assert!(
            (slip_t / slip_n - slip_mu).abs() / slip_mu < 0.2,
            "slip T/N {} vs {slip_mu}",
            slip_t / slip_n
        );
        assert!(
            slip_u > stick_u.max(1e-8) * 5.0,
            "slip {slip_u} vs stick {stick_u}"
        );
    }

    fn traction(out: &ContactSolve) -> (f64, f64, f64) {
        let mut normal = 0.0;
        let mut tangent = 0.0;
        let mut slip = 0.0;
        let mut n = 0.0;
        for node in &out.nodes {
            if node.status == ContactStatus::Open {
                continue;
            }
            normal += node.normal_force;
            tangent += node.tangent_force;
            slip += node.tangent_slip;
            n += 1.0;
        }
        (normal, tangent, if n > 0.0 { slip / n } else { 0.0 })
    }

    fn incline(theta: f64, mu: f64) -> Result<ContactSolve, FemError> {
        let size = [12.0, 8.0, 5.0];
        let lower = brick_tet10([3, 2, 2], [0.0, 0.0, 0.0], size);
        let upper = brick_tet10([3, 2, 2], [1.0, 0.0, size[2]], [10.0, 8.0, 4.0]);
        let mut lower_nodes = lower.nodes.clone();
        let mut upper_nodes = upper.nodes.clone();
        let c = theta.cos();
        let s = theta.sin();
        let spin = |p: [f64; 3]| [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
        for node in &mut lower_nodes {
            *node = spin(*node);
        }
        for node in &mut upper_nodes {
            *node = spin(*node);
        }
        let mat = material(20_000.0);
        let bodies = [
            SolidBody {
                nodes: &lower_nodes,
                elements: &lower.elements,
                material: mat,
            },
            SolidBody {
                nodes: &upper_nodes,
                elements: &upper.elements,
                material: mat,
            },
        ];
        let z_interface = size[2];
        let master = faces_on_plane(&lower, 2, z_interface, 1e-8, 0);
        let offset = lower.nodes.len() as u32;
        let slave_faces = faces_on_plane(&upper, 2, z_interface, 1e-8, offset);
        // Faces were collected in the unrotated frame; node ids still match.
        let slaves = nodes_of(&slave_faces);
        let mut dirichlet = Vec::new();
        for (i, node) in lower.nodes.iter().enumerate() {
            if node[2].abs() <= 1e-8 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let top = upper.nodes.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
        let load_nodes = upper
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| (node[2] - top).abs() <= 1e-8)
            .map(|(i, _)| i as u32 + offset)
            .collect::<Vec<_>>();
        let each = 40.0 / load_nodes.len() as f64;
        let forces: Vec<NodalForce> = load_nodes
            .iter()
            .map(|&node| NodalForce {
                node,
                force: [0.0, 0.0, -each],
            })
            .collect();
        let surface = ContactSurface {
            slaves,
            master_faces: master,
            slave_faces,
            law: ContactLaw::Frictional,
            mu,
            gap: 0.2,
        };
        solve_contact(
            &bodies,
            &[],
            &[surface],
            &dirichlet,
            &forces,
            &[],
            &cholesky(),
        )
    }

    #[test]
    fn hertz_cylinder_on_flat_converges_with_refinement() {
        let young = 200.0;
        let nu = 0.3;
        let radius = 10.0;
        let length = 2.0;
        let force = 40.0;
        let e_star = young / (2.0 * (1.0 - nu * nu));
        let a = (4.0 * force * radius / (std::f64::consts::PI * length * e_star)).sqrt();
        let p0 = 2.0 * force / (std::f64::consts::PI * a * length);
        let coarse =
            hertz_case(radius, length, young, force, [24, 4, 1], [24, 1, 3]).expect("coarse");
        let fine = hertz_case(radius, length, young, force, [36, 5, 1], [36, 1, 4]).expect("fine");
        let (a_c, p_c) = (coarse.radius, coarse.peak);
        let (a_f, p_f) = (fine.radius, fine.peak);
        let err = |got: f64, exact: f64| (got - exact).abs() / exact;
        let (peak, rss) = linux_memory();
        eprintln!(
            "hertz a={a:.4} p0={p0:.4} coarse_a={a_c:.4} err_a={:.3e} coarse_p={p_c:.4} err_p={:.3e} dofs={} iters={} refactors={} reused={} assembly_s={:.4} solve_s={:.4}",
            err(a_c, a),
            err(p_c, p0),
            coarse.solve.bonded.fem.dofs,
            coarse.solve.iterations,
            coarse.solve.refactors,
            coarse.solve.reused,
            coarse.solve.bonded.fem.assembly_secs,
            coarse.solve.bonded.fem.solve_secs,
        );
        eprintln!(
            "hertz fine_a={a_f:.4} err_a={:.3e} fine_p={p_f:.4} err_p={:.3e} dofs={} iters={} refactors={} reused={} assembly_s={:.4} solve_s={:.4} peak_rss_mib={:.1} rss_mib={:.1}",
            err(a_f, a),
            err(p_f, p0),
            fine.solve.bonded.fem.dofs,
            fine.solve.iterations,
            fine.solve.refactors,
            fine.solve.reused,
            fine.solve.bonded.fem.assembly_secs,
            fine.solve.bonded.fem.solve_secs,
            peak as f64 / (1024.0 * 1024.0),
            rss as f64 / (1024.0 * 1024.0),
        );
        assert!(err(p_f, p0) < 0.10, "fine peak pressure");
        assert!(err(a_f, a) < 0.10, "fine contact radius");
        assert!(
            err(p_f, p0) <= err(p_c, p0) + 0.03,
            "pressure should not get worse"
        );
        assert!(
            err(a_f, a) <= err(a_c, a) + 0.03,
            "radius should not get worse"
        );
    }

    struct HertzRow {
        solve: ContactSolve,
        radius: f64,
        peak: f64,
    }

    fn hertz_case(
        radius: f64,
        length: f64,
        young: f64,
        force: f64,
        cyl_cells: [usize; 3],
        flat_cells: [usize; 3],
    ) -> Result<HertzRow, FemError> {
        let cyl = half_cylinder(radius, length, cyl_cells);
        let width = radius * 1.6;
        let thick = radius * 0.6;
        let flat = brick_tet10(
            flat_cells,
            [-width * 0.5, 0.0, -thick],
            [width, length, thick],
        );
        let mat = material(young);
        let bodies = [
            SolidBody {
                nodes: &flat.nodes,
                elements: &flat.elements,
                material: mat,
            },
            SolidBody {
                nodes: &cyl.mesh.nodes,
                elements: &cyl.mesh.elements,
                material: mat,
            },
        ];
        let master = faces_on_plane(&flat, 2, 0.0, 1e-6, 0);
        let offset = flat.nodes.len() as u32;
        let slave_faces = cylinder_bottom_faces(&cyl.mesh, radius, offset, 2.0);
        let slaves = nodes_of(&slave_faces);
        let mut dirichlet = Vec::new();
        for (i, node) in flat.nodes.iter().enumerate() {
            if (node[2] + thick).abs() <= 1e-6 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
            dirichlet.push(Dirichlet {
                dof: (i * 3 + 1) as u32,
                value: 0.0,
            });
        }
        for (i, node) in cyl.mesh.nodes.iter().enumerate() {
            let base = (i + flat.nodes.len()) * 3;
            // Plane strain.
            dirichlet.push(Dirichlet {
                dof: (base + 1) as u32,
                value: 0.0,
            });
            // The contact generator is the pivot of a rigid roll. Frictionless
            // pressure does not resist it, so the symmetry plane keeps ux = 0.
            if node[0].abs() <= 1.0e-8 * radius.max(1.0) {
                dirichlet.push(Dirichlet {
                    dof: base as u32,
                    value: 0.0,
                });
            }
        }
        let load = cyl
            .mesh
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| (node[2] - radius).abs() <= 1e-5 * radius)
            .map(|(i, _)| i as u32 + offset)
            .collect::<Vec<_>>();
        let each = force / load.len().max(1) as f64;
        let forces: Vec<NodalForce> = load
            .iter()
            .map(|&node| NodalForce {
                node,
                force: [0.0, 0.0, -each],
            })
            .collect();
        let surface = ContactSurface {
            slaves,
            master_faces: master,
            slave_faces,
            law: ContactLaw::Frictionless,
            mu: 0.0,
            gap: 2.0,
        };
        let mut options = cholesky();
        options.max_iterations = 30;
        let solved = solve_contact(&bodies, &[], &[surface], &dirichlet, &forces, &[], &options)?;
        let mut peak = 0.0_f64;
        for node in &solved.nodes {
            peak = peak.max(node.pressure);
        }
        // The contact radius is read from the Hertz profile
        // p = p0 sqrt(1 - (x/a)^2), inverted on the shoulder where the
        // slope is real. The outermost node above a pressure gate sits
        // inside the true radius by about one element, on both meshes.
        let mut acc = 0.0;
        let mut n = 0.0;
        if peak > 0.0 {
            for node in &solved.nodes {
                let ratio = node.pressure / peak;
                if !(0.25..=0.85).contains(&ratio) {
                    continue;
                }
                let local = node.node as usize - flat.nodes.len();
                if local >= cyl.mesh.nodes.len() {
                    continue;
                }
                let x = cyl.mesh.nodes[local][0].abs();
                if x < 1.0e-6 {
                    continue;
                }
                acc += x / (1.0 - ratio * ratio).sqrt();
                n += 1.0;
            }
        }
        Ok(HertzRow {
            solve: solved,
            radius: if n > 0.0 { acc / n } else { 0.0 },
            peak,
        })
    }

    fn cylinder_bottom_faces(
        mesh: &crate::meshgen::Tet10Mesh,
        radius: f64,
        offset: u32,
        z_max: f64,
    ) -> Vec<[u32; 6]> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        let tol = 1e-4 * radius;
        for elem in &mesh.elements {
            for local in FACES {
                let ids = local.map(|slot| elem[slot]);
                let on = ids.iter().all(|&id| {
                    let p = mesh.nodes[id as usize];
                    let radial = (p[0] * p[0] + (p[2] - radius) * (p[2] - radius)).sqrt();
                    (radial - radius).abs() <= tol && p[2] <= z_max
                });
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

    #[test]
    fn contact_reports_the_stage_when_the_iteration_cap_hits() {
        let size = [8.0, 8.0, 4.0];
        let (lower, upper) = stack([2, 2, 2], [2, 2, 2], size);
        let mut options = cholesky();
        options.max_iterations = 1;
        options.penalty_scale = 1.0e-4;
        let err = compress(&lower, &upper, 5.0, ContactLaw::Frictionless, 0.0, &options)
            .expect_err("a tiny penalty cannot finish in one pass");
        let text = err.to_string();
        assert!(
            text.contains("did not converge") && text.contains("after 1 iterations"),
            "{text}"
        );
        assert!(
            text.contains("active-set")
                || text.contains("uzawa")
                || text.contains("friction")
                || text.contains("linear"),
            "{text}"
        );
    }
}
