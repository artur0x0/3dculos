//! Time and memory for a modal solve near 40k solid DOF and 30k shell DOF.
//!
//! Not part of `cargo test`. Run with `cargo run --release --example modal_scale`.
//! The solid is a slender beam so the supernodal factor stays banded. Memory is
//! the process VmHWM from `/proc/self/status` plus the stored factor entries.

use std::time::Instant;
use surfcad_fea::fem::{modal_shell, modal_tet10, pin_node, Dirichlet, Material};
use surfcad_fea::meshgen::{brick_tet10, plate_shell};

fn steel() -> Material {
    Material {
        young: 210_000.0,
        poisson: 0.3,
        yield_mpa: Some(250.0),
    }
}

fn rss_kib() -> u64 {
    let text = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for key in ["VmHWM:", "VmRSS:"] {
        if let Some(line) = text.lines().find(|line| line.starts_with(key)) {
            let n: u64 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            if key.starts_with("VmHWM") && n > 0 {
                return n;
            }
            if key.starts_with("VmRSS") {
                return n;
            }
        }
    }
    0
}

fn main() {
    // Shell first: VmHWM never falls, so a later case cannot report its own peak.
    let shell = shell_case();
    let solid = solid_case();
    println!("modal scale, k = 6");
    println!();
    println!("| Path | DOF | free | modes | assembly s | solve s | factor MiB | VmHWM MiB |");
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    println!("{}", solid);
    println!("{}", shell);
}

fn solid_case() -> String {
    // A [n, 2, 2] TET10 brick is 150 DOF per length cell. n = 267 is 40,125 DOF.
    let cells = 267_usize;
    let mesh = brick_tet10([cells, 2, 2], [0.0, 0.0, 0.0], [cells as f64 * 10.0, 20.0, 10.0]);
    eprintln!("solid candidate {cells} cells, {} DOF", mesh.nodes.len() * 3);
    let mut fixed = Vec::new();
    for (i, node) in mesh.nodes.iter().enumerate() {
        if node[0].abs() <= 1e-8 {
            for axis in 0..3 {
                fixed.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: 0.0,
                });
            }
        }
    }
    let before = rss_kib();
    let started = Instant::now();
    let out = modal_tet10(&mesh.nodes, &mesh.elements, steel(), 7800.0, &fixed, 6)
        .expect("solid modal");
    let wall = started.elapsed().as_secs_f64();
    let after = rss_kib();
    let factor_mib = out.factor_entries as f64 * 8.0 / (1024.0 * 1024.0);
    let hwm_mib = after.max(before) as f64 / 1024.0;
    eprintln!(
        "solid f1={:.3} Hz wall={wall:.2}s dofs={} factor_entries={}",
        out.frequencies_hz.first().copied().unwrap_or(0.0),
        out.dofs,
        out.factor_entries
    );
    format!(
        "| TET10 beam | {} | {} | {} | {:.2} | {:.2} | {:.1} | {:.1} |",
        out.dofs,
        out.free_dofs,
        out.frequencies_hz.len(),
        out.assembly_secs,
        out.solve_secs,
        factor_mib,
        hwm_mib
    )
}

fn shell_case() -> String {
    // (2*35+1)^2 = 5041 nodes, 30246 DOF.
    let mesh = plate_shell(35, 35, 200.0, 200.0);
    let mut fixed = Vec::new();
    for (i, node) in mesh.nodes.iter().enumerate() {
        let edge = node[0].abs() <= 1e-8 || (node[0] - 200.0).abs() <= 1e-8;
        if edge {
            pin_node(i as u32, &mut fixed);
        }
    }
    let thickness = vec![1.0; mesh.elements.len()];
    let started = Instant::now();
    let out = modal_shell(
        &mesh.nodes,
        &mesh.elements,
        &thickness,
        steel(),
        7800.0,
        &fixed,
        6,
    )
    .expect("shell modal");
    let wall = started.elapsed().as_secs_f64();
    let hwm_mib = rss_kib() as f64 / 1024.0;
    let factor_mib = out.factor_entries as f64 * 8.0 / (1024.0 * 1024.0);
    eprintln!(
        "shell f1={:.3} Hz wall={wall:.2}s dofs={} factor_entries={}",
        out.frequencies_hz.first().copied().unwrap_or(0.0),
        out.dofs,
        out.factor_entries
    );
    format!(
        "| MITC6 plate | {} | {} | {} | {:.2} | {:.2} | {:.1} | {:.1} |",
        out.dofs,
        out.free_dofs,
        out.frequencies_hz.len(),
        out.assembly_secs,
        out.solve_secs,
        factor_mib,
        hwm_mib
    )
}
