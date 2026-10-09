//! Native scale check. Not part of `cargo test` and not built for wasm.
//!
//! ```text
//! cargo bench --bench scale
//! cargo bench --bench scale -- 40000
//! cargo bench --bench scale -- 100000
//! ```
//!
//! Prints DOFs, assembly time, solve time and peak resident memory. The
//! default auto selector uses Jacobi PCG above the Cholesky DOF threshold.
//! One process keeps a single high-water mark, so pass one size per
//! invocation when the two peaks must be separate.

use std::time::Instant;

use surfcad_fea::fem::{solve_tet10, Dirichlet, Material, NodalForce, SolveOptions};
use surfcad_fea::meshgen::brick_tet10;

fn main() {
    let targets: Vec<usize> = std::env::args()
        .skip(1)
        .filter_map(|arg| arg.parse().ok())
        .collect();
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
