//! Verification against closed-form elasticity. Meshes are built in-process.

use super::*;
use crate::fem::tet10::face_traction_forces;
use crate::meshgen::{brick_tet10, quarter_cylinder, quarter_plate_hole};
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
    (num.sqrt()) / den.sqrt().max(1e-30)
}

fn faces_on_plane(
    mesh: &crate::meshgen::Tet10Mesh,
    axis: usize,
    value: f64,
    tol: f64,
) -> Vec<[u32; 6]> {
    const FACES: [[usize; 6]; 4] = [
        [0, 1, 2, 4, 5, 6],
        [0, 1, 3, 4, 8, 7],
        [0, 2, 3, 6, 9, 7],
        [1, 2, 3, 5, 9, 8],
    ];
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
                found.push(ids);
            }
        }
    }
    found
}

#[test]
fn patch_reproduces_a_constant_strain_field() {
    let mesh = brick_tet10([2, 2, 2], [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let eps = 1.0e-3;
    let exact_u = |p: [f64; 3]| [eps * p[0], 0.0, 0.0];
    let mut dirichlet = Vec::new();
    let mut interior = 0_usize;
    for (i, p) in mesh.nodes.iter().enumerate() {
        let on_box = p[0] <= 1e-9
            || (p[0] - 10.0).abs() <= 1e-9
            || p[1] <= 1e-9
            || (p[1] - 10.0).abs() <= 1e-9
            || p[2] <= 1e-9
            || (p[2] - 10.0).abs() <= 1e-9;
        if !on_box {
            interior += 1;
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
    assert!(interior > 0, "the patch mesh has no interior node");
    let out = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &[],
        &[],
        &SolveOptions::default(),
    )
    .unwrap();
    assert_eq!(out.solver, SolverUsed::Cholesky);
    let mut exact = vec![0.0; out.displacement.len()];
    for (i, p) in mesh.nodes.iter().enumerate() {
        let u = exact_u(*p);
        exact[i * 3] = u[0];
        exact[i * 3 + 1] = u[1];
        exact[i * 3 + 2] = u[2];
    }
    let disp_err = rel_l2(&out.displacement, &exact);
    let c = tet10::elasticity(steel());
    // Uniaxial strain εxx = eps. σ = C · ε.
    let mut sigma = [0.0; 6];
    for s in 0..6 {
        sigma[s] = c[s * 6] * eps;
    }
    let mut got_stress = Vec::with_capacity(mesh.nodes.len() * 6);
    let mut exact_stress = Vec::with_capacity(mesh.nodes.len() * 6);
    for node in &out.stress {
        for comp in 0..6 {
            got_stress.push(node[comp]);
            exact_stress.push(sigma[comp]);
        }
    }
    let stress_err = rel_l2(&got_stress, &exact_stress);
    eprintln!(
        "patch interior_nodes={interior} disp_rel={disp_err:.3e} stress_rel={stress_err:.3e}"
    );
    assert!(
        disp_err < 1e-8,
        "constant-strain displacement error {disp_err:.3e} exceeds 1e-8"
    );
    assert!(
        stress_err < 1e-8,
        "constant-strain stress error {stress_err:.3e} exceeds 1e-8"
    );
}

#[test]
fn cholesky_and_pcg_agree() {
    let mesh = brick_tet10([2, 2, 2], [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let eps = 1.0e-3;
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let on_box = p[0] <= 1e-9
            || (p[0] - 10.0).abs() <= 1e-9
            || p[1] <= 1e-9
            || (p[1] - 10.0).abs() <= 1e-9
            || p[2] <= 1e-9
            || (p[2] - 10.0).abs() <= 1e-9;
        if !on_box {
            continue;
        }
        for axis in 0..3 {
            let value = if axis == 0 { eps * p[0] } else { 0.0 };
            dirichlet.push(Dirichlet {
                dof: (i * 3 + axis) as u32,
                value,
            });
        }
    }
    let direct = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &[],
        &[],
        &SolveOptions {
            solver: SolverChoice::Cholesky,
            ..SolveOptions::default()
        },
    )
    .unwrap();
    let iterative = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &[],
        &[],
        &SolveOptions {
            solver: SolverChoice::Pcg,
            pcg_tol: 1e-12,
            pcg_max_iter: 5_000,
            ..SolveOptions::default()
        },
    )
    .unwrap();
    let err = rel_l2(&iterative.displacement, &direct.displacement);
    eprintln!(
        "pcg_vs_cholesky rel={err:.3e} iters={} residual={:.3e}",
        iterative.iterations, iterative.residual
    );
    assert!(
        err < 1e-6,
        "Cholesky and PCG differ by {err:.3e}, above 1e-6"
    );
    let auto_pcg = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &[],
        &[],
        &SolveOptions {
            solver: SolverChoice::Auto,
            cholesky_max_dofs: 0,
            pcg_tol: 1e-12,
            pcg_max_iter: 5_000,
        },
    )
    .unwrap();
    assert_eq!(auto_pcg.solver, SolverUsed::Pcg);
}

#[test]
fn cantilever_tip_deflection_and_root_bending_stress() {
    // L/h = 10. Shear is about 0.8% of bending, so the reference includes the
    // Timoshenko correction (fs = 6/5 for a rectangle).
    let length = 100.0_f64;
    let height = 10.0_f64;
    let width = 10.0_f64;
    let load = 100.0_f64;
    let material = steel();
    let inertia = width * height.powi(3) / 12.0;
    let area = width * height;
    let shear_modulus = material.young / (2.0 * (1.0 + material.poisson));
    let bending = load * length.powi(3) / (3.0 * material.young * inertia);
    let shear = 1.2 * load * length / (shear_modulus * area);
    let tip_ref = bending + shear;
    let root_stress = load * length * (height / 2.0) / inertia;
    eprintln!(
        "cantilever ref tip={tip_ref:.6} mm (bending={bending:.6}, shear={shear:.6}, shear/bend={:.3}%) root_σ={root_stress:.4} MPa",
        100.0 * shear / bending
    );

    let refinements = [[6, 2, 2], [10, 2, 2], [14, 3, 3]];
    let mut tip_errors = Vec::new();
    let mut stress_errors = Vec::new();
    for cells in refinements {
        let mesh = brick_tet10(cells, [0.0, 0.0, 0.0], [length, height, width]);
        let tol = 1e-8 * length;
        let mut dirichlet = Vec::new();
        for (i, p) in mesh.nodes.iter().enumerate() {
            if p[0].abs() <= tol {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        let faces = faces_on_plane(&mesh, 0, length, tol);
        assert!(!faces.is_empty(), "no tip faces");
        let tau = load / area;
        let mut force_at = vec![[0.0; 3]; mesh.nodes.len()];
        for face in &faces {
            let mut xyz = [[0.0; 3]; 6];
            for a in 0..6 {
                xyz[a] = mesh.nodes[face[a] as usize];
            }
            let nodal = face_traction_forces(&xyz, [0.0, -tau, 0.0]);
            for a in 0..6 {
                for k in 0..3 {
                    force_at[face[a] as usize][k] += nodal[a][k];
                }
            }
        }
        let forces: Vec<NodalForce> = force_at
            .iter()
            .enumerate()
            .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
            .map(|(node, f)| NodalForce {
                node: node as u32,
                force: *f,
            })
            .collect();
        let out = solve_tet10(
            &mesh.nodes,
            &mesh.elements,
            material,
            &dirichlet,
            &forces,
            &[],
            &SolveOptions::default(),
        )
        .unwrap();

        let mut tip = None;
        let mut tip_dist = f64::INFINITY;
        let target = [length, height / 2.0, width / 2.0];
        for (i, p) in mesh.nodes.iter().enumerate() {
            let d = (p[0] - target[0]).powi(2)
                + (p[1] - target[1]).powi(2)
                + (p[2] - target[2]).powi(2);
            if d < tip_dist {
                tip_dist = d;
                tip = Some(i);
            }
        }
        let tip = tip.unwrap();
        let uy = -out.displacement[tip * 3 + 1];
        let tip_err = (uy - tip_ref).abs() / tip_ref;

        // Nodal extrapolation on the constrained face overshoots. The root
        // bending stress is the top-fiber σxx at the first station off that
        // face, compared with M(x) c / I at the same station.
        let z_band = width / cells[2] as f64;
        let mut station_x = f64::INFINITY;
        for p in &mesh.nodes {
            if (p[1] - height).abs() <= tol && p[0] > tol && (p[2] - width / 2.0).abs() <= z_band {
                station_x = station_x.min(p[0]);
            }
        }
        let mut stress_sum = 0.0;
        let mut stress_n = 0.0;
        for (i, p) in mesh.nodes.iter().enumerate() {
            if (p[1] - height).abs() <= tol
                && (p[0] - station_x).abs() <= tol
                && (p[2] - width / 2.0).abs() <= z_band
            {
                stress_sum += out.stress[i][0];
                stress_n += 1.0;
            }
        }
        assert!(stress_n > 0.0, "no root-region top-fiber nodes");
        if cells == *refinements.last().unwrap() {
            assert!(
                station_x < height,
                "bending-stress sample at x={station_x} is outside the root region"
            );
        }
        let sigma = stress_sum / stress_n;
        let section = load * (length - station_x) * (height / 2.0) / inertia;
        let stress_err = (sigma - section).abs() / section;
        eprintln!(
            "cantilever cells={cells:?} dofs={} tip={uy:.6} mm err={:.3}% root_σxx={sigma:.4} at x={station_x:.3} (beam {section:.4}, wall nominal {root_stress:.4}) err={:.3}%",
            out.dofs,
            100.0 * tip_err,
            100.0 * stress_err
        );
        tip_errors.push(tip_err);
        stress_errors.push(stress_err);
    }
    let tip_err = *tip_errors.last().unwrap();
    let stress_err = *stress_errors.last().unwrap();
    assert!(
        tip_err < 0.02,
        "tip deflection error {:.3}% exceeds 2% (ref {tip_ref:.6} mm)",
        100.0 * tip_err
    );
    assert!(
        stress_err < 0.05,
        "root bending stress error {:.3}% exceeds 5% (ref {root_stress:.4} MPa)",
        100.0 * stress_err
    );
}

#[test]
fn thick_cylinder_matches_lame() {
    let ri = 10.0;
    let ro = 20.0;
    let length = 4.0;
    let pressure = 40.0;
    let material = steel();
    let cells = [5, 10, 2];
    let cylinder = quarter_cylinder(ri, ro, length, cells);
    assert!(!cylinder.inner_faces.is_empty());
    let tol = 1e-6 * ro;
    let mut dirichlet = Vec::new();
    for (i, p) in cylinder.mesh.nodes.iter().enumerate() {
        // Plane strain: uz = 0 on both ends.
        if p[2].abs() <= tol || (p[2] - length).abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3 + 2) as u32,
                value: 0.0,
            });
        }
        // θ = 0 is the plane y = 0.
        if p[1].abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3 + 1) as u32,
                value: 0.0,
            });
        }
        // θ = π/2 is the plane x = 0.
        if p[0].abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3) as u32,
                value: 0.0,
            });
        }
    }
    let pressures: Vec<FacePressure> = cylinder
        .inner_faces
        .iter()
        .copied()
        .map(|nodes| FacePressure { nodes, pressure })
        .collect();
    let out = solve_tet10(
        &cylinder.mesh.nodes,
        &cylinder.mesh.elements,
        material,
        &dirichlet,
        &[],
        &pressures,
        &SolveOptions::default(),
    )
    .unwrap();

    let a2 = ri * ri;
    let b2 = ro * ro;
    let big_a = pressure * a2 / (b2 - a2);
    let big_b = pressure * a2 * b2 / (b2 - a2);
    let hoop_ref = big_a + big_b / a2;
    let ur_ref = (1.0 + material.poisson) / material.young
        * ((1.0 - 2.0 * material.poisson) * big_a * ri + big_b / ri);

    let mut ur_sum = 0.0;
    let mut hoop_sum = 0.0;
    let mut n = 0.0;
    for (i, p) in cylinder.mesh.nodes.iter().enumerate() {
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        if (r - ri).abs() > 1e-6 * ro {
            continue;
        }
        // Skip the end planes, where the plane-strain constraint pollutes the stress.
        if p[2].abs() <= tol || (p[2] - length).abs() <= tol {
            continue;
        }
        let theta = p[1].atan2(p[0]);
        let er = [theta.cos(), theta.sin(), 0.0];
        let et = [-theta.sin(), theta.cos(), 0.0];
        let ur = out.displacement[i * 3] * er[0] + out.displacement[i * 3 + 1] * er[1];
        let hoop = crate::fem::stress::normal_stress(&out.stress[i], et);
        ur_sum += ur;
        hoop_sum += hoop;
        n += 1.0;
    }
    assert!(n > 0.0, "no interior inner-surface nodes");
    let ur = ur_sum / n;
    let hoop = hoop_sum / n;
    let ur_err = (ur - ur_ref).abs() / ur_ref;
    let hoop_err = (hoop - hoop_ref).abs() / hoop_ref;
    eprintln!(
        "lame cells={cells:?} dofs={} ur={ur:.6e} ref={ur_ref:.6e} err={:.3}% hoop={hoop:.4} ref={hoop_ref:.4} err={:.3}%",
        out.dofs,
        100.0 * ur_err,
        100.0 * hoop_err
    );
    assert!(
        ur_err < 0.03,
        "radial displacement error {:.3}% exceeds 3%",
        100.0 * ur_err
    );
    assert!(
        hoop_err < 0.03,
        "hoop stress error {:.3}% exceeds 3%",
        100.0 * hoop_err
    );
}

#[test]
fn plate_with_a_hole_has_kt_near_three() {
    let radius = 5.0;
    let width = 40.0;
    let length = 40.0;
    let thickness = 2.0;
    let remote = 100.0;
    let material = Material {
        young: 210_000.0,
        poisson: 0.3,
        yield_mpa: Some(250.0),
    };
    // Even circumferential count puts a node on the corner ray of the square.
    let cells = [8, 16, 1];
    let plate = quarter_plate_hole(radius, width, length, thickness, cells);
    assert!(!plate.tension_faces.is_empty());
    let tol = 1e-7 * width;
    let mut dirichlet = Vec::new();
    let mut anchor_z = None;
    for (i, p) in plate.mesh.nodes.iter().enumerate() {
        if p[1].abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3 + 1) as u32,
                value: 0.0,
            });
        }
        if p[0].abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3) as u32,
                value: 0.0,
            });
        }
        if anchor_z.is_none() && p[2].abs() <= tol {
            anchor_z = Some(i);
        }
    }
    // Three non-collinear uz supports kill the rigid mode without enforcing
    // plane strain through the thickness. Kirsch's Kt is an in-plane stress.
    let anchors = [
        anchor_z.expect("a node on z = 0"),
        plate
            .mesh
            .nodes
            .iter()
            .position(|p| p[0].abs() <= tol && (p[1] - radius).abs() < radius && p[2].abs() <= tol)
            .expect("symmetry node"),
        plate
            .mesh
            .nodes
            .iter()
            .position(|p| (p[0] - width).abs() <= tol && p[1].abs() <= tol && p[2].abs() <= tol)
            .expect("far corner"),
    ];
    for node in anchors {
        dirichlet.push(Dirichlet {
            dof: (node * 3 + 2) as u32,
            value: 0.0,
        });
    }
    let mut force_at = vec![[0.0; 3]; plate.mesh.nodes.len()];
    let mut total_fy = 0.0;
    for face in &plate.tension_faces {
        let mut xyz = [[0.0; 3]; 6];
        for a in 0..6 {
            xyz[a] = plate.mesh.nodes[face[a] as usize];
        }
        let nodal = face_traction_forces(&xyz, [0.0, remote, 0.0]);
        for a in 0..6 {
            for k in 0..3 {
                force_at[face[a] as usize][k] += nodal[a][k];
            }
            total_fy += nodal[a][1];
        }
    }
    let expected_force = remote * width * thickness;
    assert!(
        (total_fy - expected_force).abs() / expected_force < 1e-8,
        "tension resultant {total_fy} vs {expected_force}"
    );
    let forces: Vec<NodalForce> = force_at
        .iter()
        .enumerate()
        .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
        .map(|(node, f)| NodalForce {
            node: node as u32,
            force: *f,
        })
        .collect();
    let out = solve_tet10(
        &plate.mesh.nodes,
        &plate.mesh.elements,
        material,
        &dirichlet,
        &forces,
        &[],
        &SolveOptions::default(),
    )
    .unwrap();

    // Hot spot of the quarter model: (R, 0), where the hoop direction is +y
    // and Kirsch gives σyy = 3 σ. Sample nodes on the hole nearest that point,
    // off the z faces' single layer by using every node at that station.
    let mut best = f64::INFINITY;
    let mut sigma = 0.0;
    let mut samples = 0.0;
    let mut sigma_sum = 0.0;
    for (i, p) in plate.mesh.nodes.iter().enumerate() {
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        if (r - radius).abs() > 1e-5 * radius {
            continue;
        }
        if p[1].abs() > 0.15 * radius {
            continue;
        }
        let hoop = out.stress[i][1];
        sigma_sum += hoop;
        samples += 1.0;
        let score = p[1].abs() + (p[2] - thickness / 2.0).abs();
        if score < best {
            best = score;
            sigma = hoop;
        }
    }
    assert!(samples > 0.0, "no hot-spot nodes on the hole");
    let mean = sigma_sum / samples;
    let kt_node = sigma / remote;
    let kt_mean = mean / remote;
    let kt = kt_node;
    let err = (kt - 3.0).abs() / 3.0;
    eprintln!(
        "kt cells={cells:?} dofs={} samples={samples} node_Kt={kt_node:.4} mean_Kt={kt_mean:.4} err={:.3}%",
        out.dofs,
        100.0 * err
    );
    assert!(
        err < 0.10,
        "Kt {kt:.4} is {:.3}% away from 3, above 10%",
        100.0 * err
    );
}

#[test]
fn cholesky_refuses_fill_that_overflows_a_wasm32_index() {
    // faer sums the factor in I::Signed. usize on wasm32 signs to isize, i.e. i32.
    // 65535*65536/2 = 2_147_450_880 <= i32::MAX. The next order does not.
    let max = i32::MAX as u128;
    assert_eq!(max_cholesky_order(max), 65_535);
    assert!(cholesky_triangle_fits(65_535, max));
    assert!(!cholesky_triangle_fits(65_536, max));
    assert_eq!(
        guard_cholesky_index_for(SolverUsed::Cholesky, 80_000, max),
        SolverUsed::Pcg
    );
    assert_eq!(
        guard_cholesky_index_for(SolverUsed::Cholesky, 40_000, max),
        SolverUsed::Cholesky
    );
    assert_eq!(
        guard_cholesky_index_for(SolverUsed::Pcg, 200_000, max),
        SolverUsed::Pcg
    );
    let n = 80_000usize;
    let fits = (n as u128) * (n as u128 + 1) / 2 <= isize::MAX as u128;
    let got = guard_cholesky_index(SolverUsed::Cholesky, n);
    if fits {
        assert_eq!(got, SolverUsed::Cholesky);
    } else {
        assert_eq!(got, SolverUsed::Pcg);
    }
}
