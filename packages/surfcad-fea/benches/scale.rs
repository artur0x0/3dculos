//! Native scale check. Not part of `cargo test` and not built for wasm.
//!
//! ```text
//! cargo bench --bench scale
//! cargo bench --bench scale -- 40000
//! cargo bench --bench scale -- 100000
//! cargo bench --bench scale -- shell
//! cargo bench --bench scale -- shell 120000
//! ```
//!
//! Prints DOFs, assembly time, solve time and peak resident memory. The
//! default auto selector uses Jacobi PCG above the Cholesky DOF threshold.
//! The shell case always uses supernodal Cholesky. One process keeps a
//! single high-water mark, so pass one size per invocation when the two
//! peaks must be separate.

use std::time::Instant;

use surfcad_fea::fem::{
    shell_solve_options, solve_bonded, solve_shell, solve_tet10, tie_slaves, Dirichlet, Material,
    NodalForce, ShellPressure, SolidBody, SolveOptions,
};
use surfcad_fea::meshgen::{brick_tet10, plate_shell};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("bonded") {
        let target = args
            .get(1)
            .and_then(|arg| arg.parse().ok())
            .unwrap_or(40_000);
        run_bonded(target);
        return;
    }
    if args.first().map(String::as_str) == Some("shell") {
        let target = args
            .get(1)
            .and_then(|arg| arg.parse().ok())
            .unwrap_or(120_000);
        run_shell(target);
        return;
    }
    let targets: Vec<usize> = args.iter().filter_map(|arg| arg.parse().ok()).collect();
    let targets = if targets.is_empty() {
        vec![40_000, 100_000]
    } else {
        targets
    };
    for target in targets {
        run(target);
    }
}

fn run(target: usize) {
    let (cells, mesh) = mesh_near(target);
    let dofs = mesh.nodes.len() * 3;
    let mut dirichlet = Vec::new();
    let mut tip = None;
    let mut tip_x = f64::NEG_INFINITY;
    for (i, node) in mesh.nodes.iter().enumerate() {
        if node[0].abs() <= 1e-9 {
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: 0.0,
                });
            }
        }
        if node[0] > tip_x {
            tip_x = node[0];
            tip = Some(i);
        }
    }
    let forces = [NodalForce {
        node: tip.expect("tip") as u32,
        force: [0.0, -1.0, 0.0],
    }];
    let material = Material {
        young: 210_000.0,
        poisson: 0.3,
        yield_mpa: None,
    };
    let started = Instant::now();
    let out = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        material,
        &dirichlet,
        &forces,
        &[],
        &SolveOptions {
            pcg_tol: 1.0e-6,
            pcg_max_iter: dofs.max(20_000),
            ..SolveOptions::default()
        },
    )
    .unwrap_or_else(|err| panic!("solve failed at {dofs} DOF: {err}"));
    let elapsed = started.elapsed().as_secs_f64();
    let (peak, rss) = linux_memory();
    println!(
        "target={target} cells={cells:?} nodes={} elements={} dofs={} free={} solver={} iters={} residual={:.3e} assembly_s={:.4} solve_s={:.4} total_s={:.4} peak_rss_mib={:.1} rss_mib={:.1}",
        mesh.nodes.len(),
        mesh.elements.len(),
        out.dofs,
        out.free_dofs,
        out.solver.as_str(),
        out.iterations,
        out.residual,
        out.assembly_secs,
        out.solve_secs,
        elapsed,
        peak as f64 / (1024.0 * 1024.0),
        rss as f64 / (1024.0 * 1024.0),
    );
}

/// Two independently meshed bricks, tied across the mid-plane. The auto
/// selector uses Jacobi PCG once the free system is above 20 000 DOF.
/// Pass one size per process: the resident set is a high-water mark.
fn run_bonded(target: usize) {
    let half = target / 2;
    let (left_cells, _) = mesh_near(half);
    let (right_cells, _) = mesh_near(half.saturating_sub(half / 5).max(8_000));
    let size = [10.0, 10.0, 10.0];
    let left = brick_tet10(left_cells, [0.0, 0.0, 0.0], size);
    let right = brick_tet10(right_cells, [size[0], 0.0, 0.0], size);
    let mut nodes = left.nodes.clone();
    nodes.extend_from_slice(&right.nodes);
    let shift = left.nodes.len() as u32;
    let master = plane_faces(&left, 0, size[0], 1e-6, 0);
    let slave_faces = plane_faces(&right, 0, size[0], 1e-8, shift);
    let mut slave_nodes = Vec::new();
    for face in &slave_faces {
        slave_nodes.extend(face.iter().copied());
    }
    slave_nodes.sort_unstable();
    slave_nodes.dedup();
    let tied = tie_slaves(&nodes, &slave_nodes, &master, 0.05).expect("ties");
    let mut dirichlet = Vec::new();
    for (i, node) in left.nodes.iter().enumerate() {
        if node[0].abs() <= 1e-8 {
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: 0.0,
                });
            }
        }
    }
    let tip = right
        .nodes
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a[0].total_cmp(&b[0]))
        .map(|(index, _)| index as u32 + shift)
        .expect("tip");
    let bodies = [
        SolidBody {
            nodes: &left.nodes,
            elements: &left.elements,
            material: Material {
                young: 210_000.0,
                poisson: 0.3,
                yield_mpa: Some(250.0),
            },
        },
        SolidBody {
            nodes: &right.nodes,
            elements: &right.elements,
            material: Material {
                young: 70_000.0,
                poisson: 0.3,
                yield_mpa: Some(95.0),
            },
        },
    ];
    let dofs = nodes.len() * 3;
    let started = Instant::now();
    let out = solve_bonded(
        &bodies,
        &tied.ties,
        &dirichlet,
        &[NodalForce {
            node: tip,
            force: [0.0, -1.0, 0.0],
        }],
        &[],
        &SolveOptions {
            pcg_tol: 1.0e-6,
            pcg_max_iter: dofs.max(20_000),
            ..SolveOptions::default()
        },
    )
    .unwrap_or_else(|err| panic!("bonded solve failed at {dofs} DOF: {err}"));
    let elapsed = started.elapsed().as_secs_f64();
    let (peak, rss) = linux_memory();
    println!(
        "bonded target={target} left={left_cells:?} right={right_cells:?} nodes={} elements={} dofs={} free={} solver={} iters={} residual={:.3e} missed={} assembly_s={:.4} solve_s={:.4} total_s={:.4} peak_rss_mib={:.1} rss_mib={:.1}",
        nodes.len(),
        left.elements.len() + right.elements.len(),
        out.fem.dofs,
        out.fem.free_dofs,
        out.fem.solver.as_str(),
        out.fem.iterations,
        out.fem.residual,
        tied.missed.len(),
        out.fem.assembly_secs,
        out.fem.solve_secs,
        elapsed,
        peak as f64 / (1024.0 * 1024.0),
        rss as f64 / (1024.0 * 1024.0),
    );
}

fn plane_faces(
    mesh: &surfcad_fea::meshgen::Tet10Mesh,
    axis: usize,
    value: f64,
    tol: f64,
    offset: u32,
) -> Vec<[u32; 6]> {
    const FACES: [[usize; 6]; 4] = [
        [0, 1, 2, 4, 5, 6],
        [0, 1, 3, 4, 8, 7],
        [1, 2, 3, 5, 9, 8],
        [0, 2, 3, 6, 9, 7],
    ];
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for elem in &mesh.elements {
        for local in FACES {
            let ids = local.map(|slot| elem[slot]);
            if !ids
                .iter()
                .all(|&id| (mesh.nodes[id as usize][axis] - value).abs() <= tol)
            {
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

/// Closest chunky TET10 brick to `target` DOFs. The count is
/// `3 * (2 nx + 1) * (2 ny + 1) * (2 nz + 1)`, so the search never builds a mesh.
fn mesh_near(target: usize) -> ([usize; 3], surfcad_fea::meshgen::Tet10Mesh) {
    let mut best_cells = [4_usize, 4, 4];
    let mut best_err = usize::MAX;
    for nx in 4..=20 {
        for ny in 4..=nx {
            for nz in 4..=ny {
                // Stay chunky so Jacobi is not fighting a long slender beam.
                if nx > nz * 2 {
                    continue;
                }
                let dofs = 3 * (2 * nx + 1) * (2 * ny + 1) * (2 * nz + 1);
                let err = (dofs as isize - target as isize).unsigned_abs();
                if err < best_err {
                    best_err = err;
                    best_cells = [nx, ny, nz];
                }
            }
        }
    }
    let mesh = brick_tet10(best_cells, [0.0, 0.0, 0.0], [20.0, 10.0, 10.0]);
    (best_cells, mesh)
}

/// Flat shell near `target` DOFs, clamped on one edge, uniform pressure.
/// Supernodal Cholesky, including when the system is far above the tet auto
/// threshold.
fn run_shell(target: usize) {
    let (cells, mesh) = shell_near(target);
    let dofs = mesh.nodes.len() * 6;
    let mut dirichlet = Vec::new();
    for (i, node) in mesh.nodes.iter().enumerate() {
        if node[0].abs() <= 1e-9 {
            surfcad_fea::fem::clamp_node(i as u32, &mut dirichlet);
        }
    }
    let pressures: Vec<ShellPressure> = (0..mesh.elements.len())
        .map(|element| ShellPressure {
            element: element as u32,
            pressure: 0.01,
        })
        .collect();
    let thickness = vec![1.0; mesh.elements.len()];
    let material = Material {
        young: 210_000.0,
        poisson: 0.3,
        yield_mpa: None,
    };
    let started = Instant::now();
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thickness,
        material,
        &dirichlet,
        &[],
        &pressures,
        &shell_solve_options(),
    )
    .unwrap_or_else(|err| panic!("shell solve failed at {dofs} DOF: {err}"));
    let elapsed = started.elapsed().as_secs_f64();
    let (peak, rss) = linux_memory();
    println!(
        "kind=shell target={target} cells={cells:?} nodes={} elements={} dofs={} free={} solver={} iters={} residual={:.3e} assembly_s={:.4} solve_s={:.4} total_s={:.4} peak_rss_mib={:.1} rss_mib={:.1} max_vm={:.4}",
        mesh.nodes.len(),
        mesh.elements.len(),
        out.dofs,
        out.free_dofs,
        out.solver.as_str(),
        out.iterations,
        out.residual,
        out.assembly_secs,
        out.solve_secs,
        elapsed,
        peak as f64 / (1024.0 * 1024.0),
        rss as f64 / (1024.0 * 1024.0),
        out.max,
    );
}

/// Closest square 6-node plate to `target` DOFs. The count is
/// `6 * (2 n + 1)²`.
fn shell_near(target: usize) -> (usize, surfcad_fea::meshgen::ShellMesh) {
    let mut best = 4_usize;
    let mut best_err = usize::MAX;
    for n in 4..=200 {
        let nodes = (2 * n + 1) * (2 * n + 1);
        let dofs = nodes * 6;
        let err = (dofs as isize - target as isize).unsigned_abs();
        if err < best_err {
            best_err = err;
            best = n;
        }
    }
    (best, plate_shell(best, best, 100.0, 100.0))
}

fn linux_memory() -> (u64, u64) {
    let text = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let mut peak = 0_u64;
    let mut rss = 0_u64;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            peak = kb_field(rest);
        } else if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss = kb_field(rest);
        }
    }
    (peak * 1024, rss * 1024)
}

fn kb_field(rest: &str) -> u64 {
    rest.split_whitespace()
        .next()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0)
}
