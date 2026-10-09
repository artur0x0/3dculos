//! Closed-form checks for the 6-node shell. Each case prints its error so a
//! failure log shows the percentage, not only the assertion.

use super::{
    clamp_node, consistent_traction, cross, element_matrices, pin_node, plane_stress,
    shell_solve_options, solve_shell, ShellOutput, ShellPressure, NDOF, NEN, SHELL_DOF_PER_NODE,
};
use crate::fem::{range_and_p95, Dirichlet, Material, NodalForce, SolverUsed};
use crate::meshgen::{cylinder_panel, disk_shell, plate_shell};

fn steel(nu: f64) -> Material {
    Material {
        young: 210_000.0,
        poisson: nu,
        yield_mpa: Some(250.0),
    }
}

fn rel(got: f64, exact: f64) -> f64 {
    (got - exact).abs() / exact.abs().max(1e-30)
}

fn report(name: &str, got: f64, exact: f64) -> f64 {
    let err = rel(got, exact);
    eprintln!(
        "shell {name}: got={got:.8e} exact={exact:.8e} error={:.4}%",
        err * 100.0
    );
    err
}

fn plate_flexural(e: f64, nu: f64, t: f64) -> f64 {
    e * t.powi(3) / (12.0 * (1.0 - nu * nu))
}

/// Centre deflection of a simply supported rectangle under uniform pressure.
fn navier_center(a: f64, b: f64, q: f64, flexural: f64) -> f64 {
    let mut sum = 0.0;
    let mut m = 1;
    while m <= 61 {
        let mut n = 1;
        while n <= 61 {
            let mf = m as f64;
            let nf = n as f64;
            let lap = mf * mf / (a * a) + nf * nf / (b * b);
            let sm = if ((m - 1) / 2) % 2 == 0 { 1.0 } else { -1.0 };
            let sn = if ((n - 1) / 2) % 2 == 0 { 1.0 } else { -1.0 };
            sum += sm * sn / (mf * nf * lap * lap);
            n += 2;
        }
        m += 2;
    }
    16.0 * q / (std::f64::consts::PI.powi(6) * flexural) * sum
}

fn timoshenko_tip(load: f64, length: f64, width: f64, t: f64, young: f64, nu: f64) -> f64 {
    let inertia = width * t.powi(3) / 12.0;
    let area = width * t;
    let g = young / (2.0 * (1.0 + nu));
    let bending = load * length.powi(3) / (3.0 * young * inertia);
    let shear = 1.2 * load * length / (g * area);
    bending + shear
}

#[test]
fn rigid_body_modes_have_no_strain_energy() {
    let nodes = [
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [0.0, 2.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
    ];
    let elem = [0, 1, 2, 3, 4, 5];
    let directors = [[0.0, 0.0, 1.0]; 6];
    let material = steel(0.3);
    let c = plane_stress(material);
    let g = material.young / (2.0 * (1.0 + material.poisson));
    let (ke, _) = element_matrices(&nodes, &directors, &elem, 1.0, &c, g, 0.0).unwrap();
    let centroid = [1.0, 2.0 / 3.0, 0.0];
    let modes: [[f64; 3]; 6] = [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    for (mode, axis) in modes.iter().enumerate() {
        let mut u = [0.0; NDOF];
        for i in 0..NEN {
            let r = [
                nodes[i][0] - centroid[0],
                nodes[i][1] - centroid[1],
                nodes[i][2] - centroid[2],
            ];
            if mode < 3 {
                u[i * 6 + mode] = 1.0;
            } else {
                let disp = cross(*axis, r);
                for a in 0..3 {
                    u[i * 6 + a] = disp[a];
                    u[i * 6 + 3 + a] = axis[a];
                }
            }
        }
        let mut energy = 0.0;
        for a in 0..NDOF {
            for b in 0..=a {
                let k = ke[a * NDOF + b];
                let term = u[a] * k * u[b];
                energy += if a == b { term } else { 2.0 * term };
            }
        }
        assert!(energy.abs() < 1e-6, "rigid mode {mode} energy {energy:.3e}");
    }
}

#[test]
fn membrane_patch_reproduces_uniaxial_stress() {
    let mesh = plate_shell(2, 2, 10.0, 10.0);
    let t = 1.0;
    let material = steel(0.3);
    let sigma = 100.0;
    let ex = sigma / material.young;
    let ey = -material.poisson * ex;
    let mut dirichlet = Vec::new();
    let mut interior = 0_usize;
    for (i, p) in mesh.nodes.iter().enumerate() {
        let boundary = p[0] <= 1e-9
            || (p[0] - 10.0).abs() <= 1e-9
            || p[1] <= 1e-9
            || (p[1] - 10.0).abs() <= 1e-9;
        if !boundary {
            interior += 1;
            continue;
        }
        let u = [ex * p[0], ey * p[1], 0.0];
        for axis in 0..3 {
            dirichlet.push(Dirichlet {
                dof: (i * SHELL_DOF_PER_NODE + axis) as u32,
                value: u[axis],
            });
        }
        for axis in 3..6 {
            dirichlet.push(Dirichlet {
                dof: (i * SHELL_DOF_PER_NODE + axis) as u32,
                value: 0.0,
            });
        }
    }
    assert!(interior > 0, "membrane patch has no interior node");
    let thickness = vec![t; mesh.elements.len()];
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thickness,
        material,
        &dirichlet,
        &[],
        &[],
        &shell_solve_options(),
    )
    .unwrap();
    assert_eq!(out.solver, SolverUsed::Cholesky);
    for (i, p) in mesh.nodes.iter().enumerate() {
        let base = i * SHELL_DOF_PER_NODE;
        let expect = [ex * p[0], ey * p[1], 0.0, 0.0, 0.0, 0.0];
        for axis in 0..6 {
            let err = (out.displacement[base + axis] - expect[axis]).abs();
            assert!(err < 1e-8, "node {i} dof {axis} err {err:.3e}");
        }
        for sample in [
            out.von_mises_top[i],
            out.von_mises_mid[i],
            out.von_mises_bottom[i],
        ] {
            assert!(
                rel(sample, sigma) < 1e-6,
                "node {i} von Mises {sample} expected {sigma}"
            );
        }
    }
    assert!(rel(out.max, sigma) < 1e-6);
    assert!(rel(out.min, sigma) < 1e-6);
}

#[test]
fn bending_patch_reproduces_constant_curvature() {
    let mesh = plate_shell(2, 2, 10.0, 10.0);
    let t = 1.0;
    let material = steel(0.3);
    let kappa = 1.0e-4;
    let mut dirichlet = Vec::new();
    let mut interior = 0_usize;
    for (i, p) in mesh.nodes.iter().enumerate() {
        let boundary = p[0] <= 1e-9
            || (p[0] - 10.0).abs() <= 1e-9
            || p[1] <= 1e-9
            || (p[1] - 10.0).abs() <= 1e-9;
        if !boundary {
            interior += 1;
            continue;
        }
        // w = κ x² / 2, θy = −κ x, every other DOF zero.
        let w = 0.5 * kappa * p[0] * p[0];
        let values = [0.0, 0.0, w, 0.0, -kappa * p[0], 0.0];
        for (axis, value) in values.iter().enumerate() {
            dirichlet.push(Dirichlet {
                dof: (i * SHELL_DOF_PER_NODE + axis) as u32,
                value: *value,
            });
        }
    }
    assert!(interior > 0);
    let thickness = vec![t; mesh.elements.len()];
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thickness,
        material,
        &dirichlet,
        &[],
        &[],
        &shell_solve_options(),
    )
    .unwrap();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let base = i * SHELL_DOF_PER_NODE;
        let expect = [0.0, 0.0, 0.5 * kappa * p[0] * p[0], 0.0, -kappa * p[0], 0.0];
        for axis in 0..6 {
            let err = (out.displacement[base + axis] - expect[axis]).abs();
            assert!(
                err < 1e-8,
                "node {i} dof {axis} got {} err {err:.3e}",
                out.displacement[base + axis]
            );
        }
    }
    let z = 0.5 * t;
    let ex = -kappa * z;
    let c = material.young / (1.0 - material.poisson * material.poisson);
    let sx = c * ex;
    let sy = material.poisson * sx;
    let vm = (sx * sx - sx * sy + sy * sy).sqrt();
    eprintln!("shell bending patch expected von Mises {vm:.6}");
    for i in 0..mesh.nodes.len() {
        assert!(
            rel(out.von_mises_top[i], vm) < 1e-5,
            "top {} expected {vm}",
            out.von_mises_top[i]
        );
        assert!(
            rel(out.von_mises_bottom[i], vm) < 1e-5,
            "bottom {}",
            out.von_mises_bottom[i]
        );
        assert!(
            out.von_mises_mid[i] < 1e-4 * vm,
            "mid {} should be the neutral surface",
            out.von_mises_mid[i]
        );
    }
    assert!(rel(out.max, vm) < 1e-5);
    assert!(rel(out.min, vm) < 1e-5);
    let envelope_p95 = percentile_check(&out);
    assert!(rel(envelope_p95, vm) < 1e-5);
}

fn percentile_check(out: &ShellOutput) -> f64 {
    let mut samples = Vec::new();
    samples.extend_from_slice(&out.von_mises_top);
    samples.extend_from_slice(&out.von_mises_bottom);
    let (_, _, p95) = range_and_p95(&samples);
    assert!((p95 - out.p95).abs() < 1e-12);
    p95
}

#[test]
fn simply_supported_square_plate_matches_navier() {
    let a = 100.0;
    let t = 1.0;
    let q = 0.01;
    let material = steel(0.3);
    let mesh = plate_shell(12, 12, a, a);
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let boundary =
            p[0] <= 1e-8 || (p[0] - a).abs() <= 1e-8 || p[1] <= 1e-8 || (p[1] - a).abs() <= 1e-8;
        if boundary {
            pin_node(i as u32, &mut dirichlet);
        }
    }
    let pressures: Vec<ShellPressure> = (0..mesh.elements.len())
        .map(|e| ShellPressure {
            element: e as u32,
            pressure: q,
        })
        .collect();
    let thickness = vec![t; mesh.elements.len()];
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
    .unwrap();
    let cells = 12_usize;
    let nu = 2 * cells + 1;
    let center = cells * nu + cells;
    let uz = out.displacement[center * SHELL_DOF_PER_NODE + 2];
    let exact = -navier_center(a, a, q, plate_flexural(material.young, material.poisson, t));
    let err = report("simply supported plate", uz, exact);
    assert!(
        uz < 0.0,
        "pressure against +z should deflect downward, got {uz}"
    );
    assert!(err < 0.03, "Navier error {:.3}%", err * 100.0);
}

#[test]
fn clamped_circular_plate_matches_analytic() {
    let radius = 50.0;
    let t = 1.0;
    let q = 0.01;
    let material = steel(0.3);
    let mesh = disk_shell(12, 48, radius);
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        if r > radius - 1e-8 {
            clamp_node(i as u32, &mut dirichlet);
        }
    }
    let pressures: Vec<ShellPressure> = (0..mesh.elements.len())
        .map(|e| ShellPressure {
            element: e as u32,
            pressure: q,
        })
        .collect();
    let thickness = vec![t; mesh.elements.len()];
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
    .unwrap();
    let uz = out.displacement[2];
    let exact = -q * radius.powi(4) / (64.0 * plate_flexural(material.young, material.poisson, t));
    let err = report("clamped circular plate", uz, exact);
    assert!(uz < 0.0);
    assert!(err < 0.03, "circular plate error {:.3}%", err * 100.0);
}

#[test]
fn cantilever_strip_matches_euler_bernoulli() {
    let length = 100.0;
    let width = 10.0;
    let t = 1.0;
    let load = 1.0;
    let material = steel(0.0);
    let mesh = plate_shell(8, 1, length, width);
    let mut dirichlet = Vec::new();
    let mut tip = None;
    let mut tip_x = f64::NEG_INFINITY;
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] <= 1e-9 {
            clamp_node(i as u32, &mut dirichlet);
        }
        if (p[1] - 0.5 * width).abs() <= 1e-9 && p[0] >= tip_x {
            tip_x = p[0];
            tip = Some(i);
        }
    }
    let tip = tip.expect("tip node");
    let forces = [NodalForce {
        node: tip as u32,
        force: [0.0, 0.0, -load],
    }];
    let thickness = vec![t; mesh.elements.len()];
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thickness,
        material,
        &dirichlet,
        &forces,
        &[],
        &shell_solve_options(),
    )
    .unwrap();
    let uz = out.displacement[tip * SHELL_DOF_PER_NODE + 2];
    let inertia = width * t.powi(3) / 12.0;
    let exact = -load * length.powi(3) / (3.0 * material.young * inertia);
    let err = report("cantilever strip", uz, exact);
    assert!(err < 0.02, "cantilever error {:.3}%", err * 100.0);

    let mut station = None;
    let mut station_err = f64::MAX;
    for (i, p) in mesh.nodes.iter().enumerate() {
        if (p[1] - 0.5 * width).abs() > 1e-9 {
            continue;
        }
        let miss = (p[0] - 0.5 * length).abs();
        if miss < station_err {
            station_err = miss;
            station = Some(i);
        }
    }
    let station = station.expect("midspan");
    let x = mesh.nodes[station][0];
    let moment = load * (length - x);
    let sigma = moment * (0.5 * t) / inertia;
    let top_err = report("cantilever top stress", out.von_mises_top[station], sigma);
    let bot_err = report(
        "cantilever bottom stress",
        out.von_mises_bottom[station],
        sigma,
    );
    assert!(top_err < 0.05, "top stress error {:.3}%", top_err * 100.0);
    assert!(
        bot_err < 0.05,
        "bottom stress error {:.3}%",
        bot_err * 100.0
    );
    assert!(
        out.von_mises_mid[station] < 0.05 * sigma,
        "midspan mid-surface von Mises {} should stay near the neutral axis",
        out.von_mises_mid[station]
    );
}

#[test]
fn scordelis_lo_roof_against_reference() {
    let radius = 25.0;
    let full_length = 50.0;
    let half = full_length * 0.5;
    let thickness = 0.25;
    let phi_max = 40.0_f64.to_radians();
    let mesh = cylinder_panel(10, 10, radius, half, 0.0, phi_max);
    let material = Material {
        young: 4.32e8,
        poisson: 0.0,
        yield_mpa: None,
    };
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let node = i as u32;
        if p[0].abs() <= 1e-8 {
            // Rigid diaphragm: in-plane (y, z) displacements fixed.
            dirichlet.push(Dirichlet {
                dof: node * 6 + 1,
                value: 0.0,
            });
            dirichlet.push(Dirichlet {
                dof: node * 6 + 2,
                value: 0.0,
            });
        }
        if (p[0] - half).abs() <= 1e-8 {
            // Symmetry on the mid-span plane.
            for component in [0, 4, 5] {
                dirichlet.push(Dirichlet {
                    dof: node * 6 + component,
                    value: 0.0,
                });
            }
        }
        if p[1].abs() <= 1e-8 {
            // Symmetry on the crown plane.
            for component in [1, 3, 5] {
                dirichlet.push(Dirichlet {
                    dof: node * 6 + component,
                    value: 0.0,
                });
            }
        }
    }
    let traction = consistent_traction(&mesh.nodes, &mesh.elements, [0.0, 0.0, -90.0]).unwrap();
    let forces: Vec<NodalForce> = traction
        .iter()
        .enumerate()
        .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
        .map(|(node, f)| NodalForce {
            node: node as u32,
            force: *f,
        })
        .collect();
    let thick = vec![thickness; mesh.elements.len()];
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thick,
        material,
        &dirichlet,
        &forces,
        &[],
        &shell_solve_options(),
    )
    .unwrap();
    let y_free = radius * phi_max.sin();
    let z_free = radius * phi_max.cos();
    let mut best = 0_usize;
    let mut best_d = f64::MAX;
    for (i, p) in mesh.nodes.iter().enumerate() {
        let d = (p[0] - half).abs() + (p[1] - y_free).abs() + (p[2] - z_free).abs();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    assert!(
        best_d < 1e-6,
        "free-edge midpoint missing, distance {best_d}"
    );
    let uz = out.displacement[best * SHELL_DOF_PER_NODE + 2];
    let reference = -0.3024;
    let err = report("Scordelis-Lo free edge", uz, reference);
    assert!(
        err < 0.03,
        "Scordelis-Lo error {:.3}% (reference 0.3024); got uz={uz:.6}",
        err * 100.0
    );
}

#[test]
fn shear_locking_stays_bounded_from_one_tenth_to_one_thousandth() {
    let length = 100.0;
    let width = 10.0;
    let load = 1.0;
    let material = steel(0.0);
    let mesh = plate_shell(8, 1, length, width);
    let ratios = [0.1, 0.01, 0.001];
    for ratio in ratios {
        let t = length * ratio;
        let mut dirichlet = Vec::new();
        let mut tip = 0_usize;
        for (i, p) in mesh.nodes.iter().enumerate() {
            if p[0] <= 1e-9 {
                clamp_node(i as u32, &mut dirichlet);
            }
            if (p[1] - 0.5 * width).abs() <= 1e-9 && (p[0] - length).abs() <= 1e-9 {
                tip = i;
            }
        }
        let forces = [NodalForce {
            node: tip as u32,
            force: [0.0, 0.0, -load],
        }];
        let thickness = vec![t; mesh.elements.len()];
        let out = solve_shell(
            &mesh.nodes,
            &mesh.elements,
            &thickness,
            material,
            &dirichlet,
            &forces,
            &[],
            &shell_solve_options(),
        )
        .unwrap();
        let uz = out.displacement[tip * SHELL_DOF_PER_NODE + 2];
        let exact = -timoshenko_tip(load, length, width, t, material.young, material.poisson);
        let err = report(&format!("locking t/L={ratio}"), uz, exact);
        assert!(
            err < 0.05,
            "thickness ratio {ratio} locked or drifted, error {:.3}%",
            err * 100.0
        );
    }
}
