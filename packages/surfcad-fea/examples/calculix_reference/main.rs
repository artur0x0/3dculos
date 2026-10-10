//! Compare `solve_tet10` and `solve_shell` with an external CalculiX `ccx` run
//! on the same mesh and the same nodal loads.
//!
//! CalculiX is GPL-2.0-only. This example does not vendor, link, bundle, or
//! commit it. `ccx` has to already be on `PATH` (CI installs the Debian
//! `calculix-ccx` package). The example is not part of `cargo test`, so the
//! license gate and a build without `ccx` stay valid.
//!
//! Gates, relative to `ccx` on this mesh:
//! - peak translational displacement within 1%
//! - nearest-rank p95 von Mises within 3%
//!
//! S6 is not the same element as the MITC6 triangle: `ccx` expands it into a
//! solid wedge and extrapolates 3D stress to the outer nodes, while
//! `solve_shell` reports plane-stress von Mises at ζ = ±1. A 5% stress gate
//! would cover that recovery difference on a coarse mesh. These shell meshes
//! are fine enough that the measured p95 gap stays inside the same 3% gate as
//! C3D10, so the job does not loosen it.

mod ccx_io;
mod face_load;

use ccx_io::{ccx_bin, run_case, run_frequency, Deck, ElementKind, SurfaceContact, SurfaceTie};
use face_load::{face_pressure_forces, face_traction_forces};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use surfcad_fea::fem::{
    consistent_traction, modal_tet10, percentile_95_f64, pin_node, shell_solve_options,
    solve_bonded, solve_contact, solve_shell, solve_tet10, tie_slaves, ContactLaw, ContactOptions,
    ContactStatus, ContactSurface, Dirichlet, FacePressure, Material, NodalForce, ShellPressure,
    SolidBody, SolveOptions, SolverChoice,
};
use surfcad_fea::meshgen::{
    brick_tet10, cylinder_panel, plate_shell, quarter_cylinder, quarter_plate_hole,
};

const DISP_TOL: f64 = 0.01;
const VM_TOL: f64 = 0.03;

struct Row {
    name: &'static str,
    element: &'static str,
    nodes: usize,
    peak_ours: f64,
    peak_ccx: f64,
    disp_err: f64,
    disp_tol: f64,
    p95_ours: f64,
    p95_ccx: f64,
    vm_err: f64,
    vm_tol: f64,
    pass: bool,
}

fn main() {
    match run() {
        Ok(()) => {}
        Err(err) => {
            eprintln!("calculix reference: {err}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), String> {
    let bin = ccx_bin();
    let version = Command::new(&bin)
        .arg("-v")
        .output()
        .map_err(|err| {
            format!(
                "ccx is not runnable (`{bin}`: {err}). The comparison needs an external CalculiX binary and does not vendor one."
            )
        })?;
    let banner = format!(
        "{}{}",
        String::from_utf8_lossy(&version.stdout),
        String::from_utf8_lossy(&version.stderr)
    );
    let banner = banner
        .lines()
        .find(|line| line.contains("Version"))
        .unwrap_or("ccx")
        .trim()
        .to_string();
    eprintln!("reference solver: {banner} ({bin})");

    let mut rows = Vec::new();
    let mut failures = Vec::new();
    let only = env::var("CALCULIX_CASE").unwrap_or_default();
    for (label, case) in [
        ("cantilever", cantilever as fn() -> Result<Row, String>),
        ("bonded cantilever", bonded_cantilever),
        ("frictional contact", frictional_contact),
        ("plate with a hole", plate_with_hole),
        ("thick cylinder", thick_cylinder),
        ("simply supported plate", simply_supported_plate),
        ("Scordelis-Lo roof", scordelis_lo),
    ] {
        if !only.is_empty()
            && !label
                .to_ascii_lowercase()
                .contains(&only.to_ascii_lowercase())
        {
            continue;
        }
        match case() {
            Ok(row) => {
                eprintln!(
                    "{}: disp {:.3}% (gate {:.1}%), von Mises {:.3}% (gate {:.1}%) {}",
                    row.name,
                    row.disp_err * 100.0,
                    row.disp_tol * 100.0,
                    row.vm_err * 100.0,
                    row.vm_tol * 100.0,
                    if row.pass { "pass" } else { "FAIL" }
                );
                if !row.pass {
                    failures.push(row.name);
                }
                rows.push(row);
            }
            Err(err) => {
                eprintln!("case failed: {err}");
                failures.push("setup");
                // Keep going so the summary still lists the cases that ran.
            }
        }
    }
    print_table(&banner, &rows);
    if only.is_empty() || only.to_ascii_lowercase().contains("freq") {
        match frequency_cantilever() {
            Ok(()) => {}
            Err(err) => {
                eprintln!("frequency case failed: {err}");
                failures.push("frequency");
            }
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "{} case(s) outside the CalculiX gate",
            failures.len()
        ));
    }
    Ok(())
}

fn print_table(banner: &str, rows: &[Row]) {
    println!("CalculiX reference comparison ({banner})");
    println!();
    println!("`ccx` is GPL-2.0-only. This job runs it as an external binary (`apt install calculix-ccx`). It is not a Cargo dependency and it is not vendored, linked, bundled, or committed.");
    println!();
    println!("Peak displacement is the maximum nodal translation magnitude, except the frictional contact row, which compares the mean downward displacement of the loaded face. Von Mises p95 is the nearest-rank 95th percentile. Solids use one sample per node. Shells use the top and bottom fibres together, matched to the outer nodes of the expanded S6 wedge.");
    println!();
    println!("| Case | Element | Nodes | peak u ours (mm) | peak u ccx (mm) | disp err | p95 ours (MPa) | p95 ccx (MPa) | von Mises err | von Mises gate | Result |");
    println!("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for row in rows {
        println!(
            "| {name} | {element} | {nodes} | {ours:.6e} | {ccx:.6e} | {disp:.3}% | {p_ours:.6e} | {p_ccx:.6e} | {vm:.3}% | {gate:.1}% | {result} |",
            name = row.name,
            element = row.element,
            nodes = row.nodes,
            ours = row.peak_ours,
            ccx = row.peak_ccx,
            disp = row.disp_err * 100.0,
            p_ours = row.p95_ours,
            p_ccx = row.p95_ccx,
            vm = row.vm_err * 100.0,
            gate = row.vm_tol * 100.0,
            result = if row.pass { "pass" } else { "FAIL" },
        );
    }
    println!();
    println!(
        "Gates: peak displacement within 1% of ccx, and p95 von Mises within 3%, except the frictional contact row, which uses the gates in that row. Its pressure-overclosure slope is stiff, so the contact spring is not the compliance being compared."
    );
    println!("S6 in ccx is an expanded solid wedge, not the MITC6 triangle. On a coarse plate that recovery difference is several percent, which is why a 5% shell stress gate was the fallback. The plate mesh is 24 by 24 and the roof is 12 by 12, and on those meshes the p95 gap stays inside 3%, so the gate is not loosened.");
}

fn steel() -> Material {
    Material {
        young: 210_000.0,
        poisson: 0.3,
        yield_mpa: Some(250.0),
    }
}

fn cholesky() -> SolveOptions {
    SolveOptions {
        solver: SolverChoice::Cholesky,
        ..SolveOptions::default()
    }
}

fn cantilever() -> Result<Row, String> {
    let length = 100.0;
    let height = 10.0;
    let width = 10.0;
    let load = 100.0;
    let mesh = brick_tet10([10, 2, 2], [0.0, 0.0, 0.0], [length, height, width]);
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
    let faces = faces_on_plane(&mesh.nodes, &mesh.elements, 0, length, tol);
    let tau = load / (width * height);
    let forces = traction_forces(&mesh.nodes, &faces, [0.0, -tau, 0.0]);
    let out = solve_tet10(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &as_nodal(&forces),
        &[],
        &cholesky(),
    )
    .map_err(|err| format!("cantilever solve_tet10: {err}"))?;
    compare_solid(
        "cantilever",
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &forces,
        &out.displacement,
        out.p95,
    )
}

/// First three C3D10 frequencies of the same cantilever, against `modal_tet10`.
fn frequency_cantilever() -> Result<(), String> {
    let length = 100.0;
    let height = 10.0;
    let width = 10.0;
    let mesh = brick_tet10([10, 2, 2], [0.0, 0.0, 0.0], [length, height, width]);
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
    let density = 7800.0;
    let out = modal_tet10(&mesh.nodes, &mesh.elements, steel(), density, &dirichlet, 3)
        .map_err(|err| format!("frequency modal_tet10: {err}"))?;
    let deck = deck_solid(
        &mesh.nodes,
        &mesh.elements,
        steel(),
        &dirichlet,
        &vec![[0.0; 3]; mesh.nodes.len()],
    );
    let dir = env::temp_dir().join(format!("surfcad-ccx-freq-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let ccx = run_frequency(&dir, "case", &deck, density * 1.0e-12, 3)
        .map_err(|err| format!("frequency ccx: {err}"))?;
    if env::var("CALCULIX_KEEP").is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    println!();
    println!("CalculiX `*FREQUENCY` on the cantilever C3D10 mesh. Gate is 3% on each of the first three frequencies.");
    println!();
    println!("| Mode | ours (Hz) | ccx (Hz) | err | gate | Result |");
    println!("| --- | ---: | ---: | ---: | ---: | --- |");
    for i in 0..3 {
        let err = (out.frequencies_hz[i] - ccx[i]).abs() / ccx[i].abs().max(1e-30);
        let pass = err < 0.03;
        println!(
            "| {} | {:.6e} | {:.6e} | {:.3}% | 3.0% | {} |",
            i + 1,
            out.frequencies_hz[i],
            ccx[i],
            err * 100.0,
            if pass { "pass" } else { "FAIL" }
        );
        if !pass {
            return Err(format!(
                "mode {} is {:.3}% from ccx ({} Hz vs {} Hz)",
                i + 1,
                err * 100.0,
                out.frequencies_hz[i],
                ccx[i]
            ));
        }
    }
    Ok(())
}

fn plate_with_hole() -> Result<Row, String> {
    let radius = 5.0;
    let width = 40.0;
    let length = 40.0;
    let thickness = 2.0;
    let remote = 100.0;
    let plate = quarter_plate_hole(radius, width, length, thickness, [6, 12, 1]);
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
    let anchors = [
        anchor_z.ok_or("plate with a hole: no node on z = 0")?,
        plate
            .mesh
            .nodes
            .iter()
            .position(|p| p[0].abs() <= tol && (p[1] - radius).abs() < radius && p[2].abs() <= tol)
            .ok_or("plate with a hole: missing symmetry anchor")?,
        plate
            .mesh
            .nodes
            .iter()
            .position(|p| (p[0] - width).abs() <= tol && p[1].abs() <= tol && p[2].abs() <= tol)
            .ok_or("plate with a hole: missing far-corner anchor")?,
    ];
    for node in anchors {
        dirichlet.push(Dirichlet {
            dof: (node * 3 + 2) as u32,
            value: 0.0,
        });
    }
    let forces = traction_forces(&plate.mesh.nodes, &plate.tension_faces, [0.0, remote, 0.0]);
    let out = solve_tet10(
        &plate.mesh.nodes,
        &plate.mesh.elements,
        steel(),
        &dirichlet,
        &as_nodal(&forces),
        &[],
        &cholesky(),
    )
    .map_err(|err| format!("plate with a hole solve_tet10: {err}"))?;
    compare_solid(
        "plate with a hole",
        &plate.mesh.nodes,
        &plate.mesh.elements,
        steel(),
        &dirichlet,
        &forces,
        &out.displacement,
        out.p95,
    )
}

fn thick_cylinder() -> Result<Row, String> {
    let ri = 10.0;
    let ro = 20.0;
    let length = 4.0;
    let pressure = 40.0;
    let cylinder = quarter_cylinder(ri, ro, length, [4, 8, 2]);
    let tol = 1e-6 * ro;
    let mut dirichlet = Vec::new();
    for (i, p) in cylinder.mesh.nodes.iter().enumerate() {
        if p[2].abs() <= tol || (p[2] - length).abs() <= tol {
            dirichlet.push(Dirichlet {
                dof: (i * 3 + 2) as u32,
                value: 0.0,
            });
        }
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
    }
    let mut forces = vec![[0.0; 3]; cylinder.mesh.nodes.len()];
    for face in &cylinder.inner_faces {
        let mut xyz = [[0.0; 3]; 6];
        for slot in 0..6 {
            xyz[slot] = cylinder.mesh.nodes[face[slot] as usize];
        }
        let nodal = face_pressure_forces(&xyz, pressure);
        for slot in 0..6 {
            let node = face[slot] as usize;
            for axis in 0..3 {
                forces[node][axis] += nodal[slot][axis];
            }
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
        steel(),
        &dirichlet,
        &[],
        &pressures,
        &cholesky(),
    )
    .map_err(|err| format!("thick cylinder solve_tet10: {err}"))?;
    compare_solid(
        "thick cylinder",
        &cylinder.mesh.nodes,
        &cylinder.mesh.elements,
        steel(),
        &dirichlet,
        &forces,
        &out.displacement,
        out.p95,
    )
}

fn simply_supported_plate() -> Result<Row, String> {
    let side = 100.0;
    let thickness = 1.0;
    let pressure = 0.01;
    // 24×24 quads. An 8×8 mesh leaves the MITC6 triangle and ccx's expanded
    // S6 wedge about 10% apart on the peak displacement; 24×24 is inside 1%.
    let mesh = plate_shell(24, 24, side, side);
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let boundary = p[0] <= 1e-8
            || (p[0] - side).abs() <= 1e-8
            || p[1] <= 1e-8
            || (p[1] - side).abs() <= 1e-8;
        if boundary {
            pin_node(i as u32, &mut dirichlet);
        }
    }
    // Flat plate, right-hand normal +z. Positive solver pressure pushes
    // against that normal, which is the global traction (0, 0, -q).
    let forces = consistent_traction(&mesh.nodes, &mesh.elements, [0.0, 0.0, -pressure])
        .map_err(|err| format!("simply supported plate traction: {err}"))?;
    let pressures: Vec<ShellPressure> = (0..mesh.elements.len())
        .map(|e| ShellPressure {
            element: e as u32,
            pressure,
        })
        .collect();
    let thick = vec![thickness; mesh.elements.len()];
    let out = solve_shell(
        &mesh.nodes,
        &mesh.elements,
        &thick,
        steel(),
        &dirichlet,
        &[],
        &pressures,
        &shell_solve_options(),
    )
    .map_err(|err| format!("simply supported plate solve_shell: {err}"))?;
    compare_shell(
        "simply supported plate",
        &mesh.nodes,
        &mesh.elements,
        thickness,
        steel(),
        &dirichlet,
        &forces,
        &out.displacement,
        out.p95,
    )
}

fn scordelis_lo() -> Result<Row, String> {
    let radius = 25.0;
    let half = 25.0;
    let thickness = 0.25;
    let phi_max = 40.0_f64.to_radians();
    let mesh = cylinder_panel(12, 12, radius, half, 0.0, phi_max);
    let material = Material {
        young: 4.32e8,
        poisson: 0.0,
        yield_mpa: None,
    };
    let mut dirichlet = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        let node = i as u32;
        if p[0].abs() <= 1e-8 {
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
            // ux = 0. The classical quarter model also fixes θy and θz.
            // On this edge those global rotations include the shell drilling
            // axis. CalculiX applies shell rotations through mean-rotation
            // constraints and locks the expanded S6 wedge when the prescribed
            // rotation has a drilling component (ccx 2.15 and later). Both
            // solvers therefore keep only the translational symmetry here.
            dirichlet.push(Dirichlet {
                dof: node * 6,
                value: 0.0,
            });
        }
        if p[1].abs() <= 1e-8 {
            dirichlet.push(Dirichlet {
                dof: node * 6 + 1,
                value: 0.0,
            });
            // θx is the symmetry rotation about the cylinder axis. On this
            // plane the director is +z, so θx is not the drilling rotation.
            dirichlet.push(Dirichlet {
                dof: node * 6 + 3,
                value: 0.0,
            });
        }
    }
    let forces = consistent_traction(&mesh.nodes, &mesh.elements, [0.0, 0.0, -90.0])
        .map_err(|err| format!("Scordelis-Lo traction: {err}"))?;
    let nodal: Vec<NodalForce> = forces
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
        &nodal,
        &[],
        &shell_solve_options(),
    )
    .map_err(|err| format!("Scordelis-Lo solve_shell: {err}"))?;
    compare_shell(
        "Scordelis-Lo roof",
        &mesh.nodes,
        &mesh.elements,
        thickness,
        material,
        &dirichlet,
        &forces,
        &out.displacement,
        out.p95,
    )
}

/// Two non-matching TET10 bricks, bonded at the mid-plane. CalculiX sees the
/// same nodes, the same elements, and a `*TIE` on the interface faces.
/// Shell-to-solid is not in this comparison.
fn bonded_cantilever() -> Result<Row, String> {
    let length = 50.0;
    let height = 10.0;
    let width = 10.0;
    let left = brick_tet10([4, 2, 2], [0.0, 0.0, 0.0], [length, height, width]);
    let right = brick_tet10([3, 2, 2], [length, 0.0, 0.0], [length, height, width]);
    let tol = 1e-6;
    let material = steel();
    let mut nodes = left.nodes.clone();
    nodes.extend_from_slice(&right.nodes);
    let mut elements = left.elements.clone();
    let shift = left.nodes.len() as u32;
    for elem in &right.elements {
        elements.push(elem.map(|id| id + shift));
    }
    let master = interface_faces(&left.nodes, &left.elements, 0, length, tol, 0, 0);
    let slave = interface_faces(
        &right.nodes,
        &right.elements,
        0,
        length,
        tol,
        left.elements.len() as u32,
        shift,
    );
    if master.is_empty() || slave.is_empty() {
        return Err("bonded cantilever: the interface has no C3D10 faces".into());
    }
    let slave_nodes: Vec<u32> = {
        let mut ids = Vec::new();
        for face in &slave {
            ids.extend(face.nodes);
        }
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let master_faces: Vec<[u32; 6]> = master.iter().map(|face| face.nodes).collect();
    let tied = tie_slaves(&nodes, &slave_nodes, &master_faces, 0.05)
        .map_err(|err| format!("bonded cantilever tie: {err}"))?;
    if !tied.missed.is_empty() {
        return Err(format!(
            "bonded cantilever: {} slave nodes missed the master faces",
            tied.missed.len()
        ));
    }
    let mut dirichlet = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        if node[0].abs() <= tol {
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: 0.0,
                });
            }
        }
    }
    let load = 100.0;
    let tip = faces_on_plane(&right.nodes, &right.elements, 0, length * 2.0, tol);
    let tau = load / (width * height);
    let mut forces = vec![[0.0; 3]; nodes.len()];
    for (local, force) in traction_forces(&right.nodes, &tip, [0.0, -tau, 0.0])
        .into_iter()
        .enumerate()
    {
        let index = local + left.nodes.len();
        forces[index] = force;
    }
    let nodal: Vec<NodalForce> = forces
        .iter()
        .enumerate()
        .filter(|(_, force)| force.iter().any(|component| component.abs() > 0.0))
        .map(|(node, force)| NodalForce {
            node: node as u32,
            force: *force,
        })
        .collect();
    let bodies = [
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
    ];
    let out = solve_bonded(&bodies, &tied.ties, &dirichlet, &nodal, &[], &cholesky())
        .map_err(|err| format!("bonded cantilever solve_bonded: {err}"))?;
    let mut deck = deck_solid(&nodes, &elements, material, &dirichlet, &forces);
    deck.ties.push(SurfaceTie {
        name: "BOND".to_string(),
        slave: slave.iter().map(|face| (face.element, face.ccx)).collect(),
        master: master.iter().map(|face| (face.element, face.ccx)).collect(),
        tolerance: 0.05,
    });
    let ccx = execute("bonded cantilever", &deck)?;
    let ours = translations(&out.fem.displacement, 3);
    let vm_ccx = solid_von_mises(nodes.len(), &ccx.stress)?;
    let p95_ccx = percentile_95_f64(&vm_ccx);
    finish(
        "bonded cantilever",
        "C3D10 *TIE",
        &ours,
        &ccx.displacement,
        out.fem.p95,
        p95_ccx,
    )
}

/// Two bricks in compression with Coulomb friction.
///
/// A frictionless pair leaves the upper brick free to slide, so the peak
/// translation is a rigid mode and not a contact result. The mid-plane `uy`
/// fixture removes that mode. The shear is `0.1 * pressure`, under `μ`, so
/// both solvers should stick. The displacement column is the mean downward
/// displacement of the loaded face. CalculiX's linear pressure-overclosure is
/// not the same penalty, so the gate is wider than the tied-mesh cases.
fn frictional_contact() -> Result<Row, String> {
    let size = [8.0, 8.0, 4.0];
    let lower = brick_tet10([2, 2, 1], [0.0, 0.0, 0.0], size);
    let upper = brick_tet10([2, 2, 1], [0.0, 0.0, size[2]], size);
    let material = Material {
        young: 10_000.0,
        poisson: 0.3,
        yield_mpa: Some(250.0),
    };
    let mut nodes = lower.nodes.clone();
    nodes.extend_from_slice(&upper.nodes);
    let mut elements = lower.elements.clone();
    let node_offset = lower.nodes.len() as u32;
    for elem in &upper.elements {
        elements.push(elem.map(|id| id + node_offset));
    }
    let master = interface_faces(&lower.nodes, &lower.elements, 2, size[2], 1e-6, 0, 0);
    let slave = interface_faces(
        &upper.nodes,
        &upper.elements,
        2,
        size[2],
        1e-6,
        lower.elements.len() as u32,
        node_offset,
    );
    let top = interface_faces(
        &upper.nodes,
        &upper.elements,
        2,
        size[2] * 2.0,
        1e-6,
        lower.elements.len() as u32,
        node_offset,
    );
    if master.is_empty() || slave.is_empty() || top.is_empty() {
        return Err("frictional contact: interface faces were not found".into());
    }
    let mut dirichlet = Vec::new();
    for (i, node) in lower.nodes.iter().enumerate() {
        if node[2].abs() <= 1e-6 {
            for axis in 0..3 {
                dirichlet.push(Dirichlet {
                    dof: (i * 3 + axis) as u32,
                    value: 0.0,
                });
            }
        }
    }
    let mid_y = size[1] * 0.5;
    for (i, node) in upper.nodes.iter().enumerate() {
        if (node[1] - mid_y).abs() <= 1e-6 {
            dirichlet.push(Dirichlet {
                dof: ((node_offset as usize + i) * 3 + 1) as u32,
                value: 0.0,
            });
        }
    }
    let applied = 5.0;
    let shear = 0.5;
    let mu = 0.3;
    let pressures: Vec<FacePressure> = top
        .iter()
        .map(|face| FacePressure {
            nodes: face.nodes,
            pressure: applied,
        })
        .collect();
    let mut shear_force = vec![[0.0; 3]; nodes.len()];
    for face in &top {
        let xyz = face.nodes.map(|id| nodes[id as usize]);
        let load = face_traction_forces(&xyz, [shear, 0.0, 0.0]);
        for (slot, node) in face.nodes.iter().enumerate() {
            for axis in 0..3 {
                shear_force[*node as usize][axis] += load[slot][axis];
            }
        }
    }
    let nodal: Vec<NodalForce> = shear_force
        .iter()
        .enumerate()
        .filter(|(_, force)| force.iter().any(|component| component.abs() > 1e-12))
        .map(|(node, force)| NodalForce {
            node: node as u32,
            force: *force,
        })
        .collect();
    let mut slave_nodes = Vec::new();
    let mut seen = HashSet::new();
    for face in &slave {
        for slot in 0..3 {
            if seen.insert(face.nodes[slot]) {
                slave_nodes.push(face.nodes[slot]);
            }
        }
    }
    let surface = ContactSurface {
        slaves: slave
            .iter()
            .flat_map(|face| face.nodes)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
        master_faces: master.iter().map(|face| face.nodes).collect(),
        slave_faces: slave.iter().map(|face| face.nodes).collect(),
        law: ContactLaw::Frictional,
        mu,
        gap: 0.05,
    };
    let bodies = [
        SolidBody {
            nodes: &lower.nodes,
            elements: &lower.elements,
            material,
        },
        SolidBody {
            nodes: &upper.nodes,
            elements: &upper.elements,
            material,
        },
    ];
    let options = ContactOptions {
        solve: SolveOptions {
            solver: SolverChoice::Cholesky,
            ..SolveOptions::default()
        },
        ..ContactOptions::default()
    };
    let solved = solve_contact(
        &bodies,
        &[],
        &[surface],
        &dirichlet,
        &nodal,
        &pressures,
        &options,
    )
    .map_err(|err| format!("frictional contact solve_contact: {err}"))?;
    let closed: Vec<_> = solved
        .nodes
        .iter()
        .filter(|node| node.status != ContactStatus::Open)
        .collect();
    let force: f64 = closed.iter().map(|node| node.normal_force).sum();
    let tangent: f64 = closed.iter().map(|node| node.tangent_force).sum();
    let area: f64 = closed.iter().map(|node| node.area).sum();
    let mean = if area > 0.0 { force / area } else { 0.0 };
    let mean_t = if area > 0.0 { tangent / area } else { 0.0 };
    let sticks = closed
        .iter()
        .filter(|node| node.status == ContactStatus::Stick)
        .count();
    eprintln!(
        "frictional contact: mean pressure {mean:.3} MPa (shear {mean_t:.3}) vs applied {applied:.3}, {sticks}/{} stick, {} iterations",
        closed.len(),
        solved.iterations
    );
    let mut forces = shear_force;
    for face in &top {
        let xyz = face.nodes.map(|id| nodes[id as usize]);
        let load = face_pressure_forces(&xyz, applied);
        for (slot, node) in face.nodes.iter().enumerate() {
            for axis in 0..3 {
                forces[*node as usize][axis] += load[slot][axis];
            }
        }
    }
    let mut deck = deck_solid(&nodes, &elements, material, &dirichlet, &forces);
    deck.contacts.push(SurfaceContact {
        name: "GAP".to_string(),
        slave_nodes,
        master: master.iter().map(|face| (face.element, face.ccx)).collect(),
        mu: Some(mu),
        penalty: 1.0e8,
        tension: 1.0e-3,
        stick_slope: 1.0e8,
        adjust: 0.05,
    });
    let ccx = execute("frictional contact", &deck)?;
    let ours = translations(&solved.bonded.fem.displacement, 3);
    let vm_ccx = solid_von_mises(nodes.len(), &ccx.stress)?;
    let p95_ccx = percentile_95_f64(&vm_ccx);
    let top_z = size[2] * 2.0;
    let mean_down = |field: &[[f64; 3]]| {
        let mut sum = 0.0;
        let mut count = 0.0;
        for (node, disp) in nodes.iter().zip(field.iter()) {
            if (node[2] - top_z).abs() <= 1e-6 {
                sum += -disp[2];
                count += 1.0;
            }
        }
        if count > 0.0 {
            sum / count
        } else {
            0.0
        }
    };
    let peak_ours = mean_down(&ours);
    let peak_ccx = mean_down(&ccx.displacement);
    if peak_ccx < 1e-12 || p95_ccx.abs() < 1e-8 {
        return Err(format!(
            "frictional contact: ccx compression {peak_ccx:.3e} p95 {p95_ccx:.3e}"
        ));
    }
    let disp_tol = 0.05;
    let vm_tol = 0.05;
    let disp_err = (peak_ours - peak_ccx).abs() / peak_ccx;
    let vm_err = (solved.bonded.fem.p95 - p95_ccx).abs() / p95_ccx.abs();
    let pressure_err = (mean - applied).abs() / applied;
    eprintln!(
        "frictional contact: pressure err {:.2}%, compression err {:.2}% ({peak_ours:.4e} vs {peak_ccx:.4e} mm), von Mises err {:.2}%",
        pressure_err * 100.0,
        disp_err * 100.0,
        vm_err * 100.0
    );
    Ok(Row {
        name: "frictional contact",
        element: "C3D10 *CONTACT PAIR",
        nodes: ours.len(),
        peak_ours,
        peak_ccx,
        disp_err,
        disp_tol,
        p95_ours: solved.bonded.fem.p95,
        p95_ccx,
        vm_err,
        vm_tol,
        pass: pressure_err <= 0.05 && disp_err <= disp_tol && vm_err <= vm_tol && sticks > 0,
    })
}

struct InterfaceFace {
    element: u32,
    ccx: u8,
    nodes: [u32; 6],
}

fn interface_faces(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    axis: usize,
    value: f64,
    tol: f64,
    element_offset: u32,
    node_offset: u32,
) -> Vec<InterfaceFace> {
    const LOCAL: [([usize; 6], u8); 4] = [
        ([0, 1, 2, 4, 5, 6], 1),
        ([0, 1, 3, 4, 8, 7], 2),
        ([1, 2, 3, 5, 9, 8], 3),
        ([0, 2, 3, 6, 9, 7], 4),
    ];
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (index, elem) in elements.iter().enumerate() {
        for (local, ccx) in LOCAL {
            let ids = local.map(|slot| elem[slot]);
            if !ids
                .iter()
                .all(|&id| (nodes[id as usize][axis] - value).abs() <= tol)
            {
                continue;
            }
            let mut key = [ids[0], ids[1], ids[2]];
            key.sort_unstable();
            if !seen.insert(key) {
                continue;
            }
            found.push(InterfaceFace {
                element: index as u32 + element_offset,
                ccx,
                nodes: ids.map(|id| id + node_offset),
            });
        }
    }
    found
}

fn compare_solid(
    name: &'static str,
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[[f64; 3]],
    displacement: &[f64],
    p95_ours: f64,
) -> Result<Row, String> {
    let ccx = execute(
        name,
        &deck_solid(nodes, elements, material, dirichlet, forces),
    )?;
    let ours = translations(displacement, 3);
    let vm_ccx = solid_von_mises(nodes.len(), &ccx.stress)?;
    let p95_ccx = percentile_95_f64(&vm_ccx);
    finish(name, "C3D10", &ours, &ccx.displacement, p95_ours, p95_ccx)
}

fn compare_shell(
    name: &'static str,
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: f64,
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[[f64; 3]],
    displacement: &[f64],
    p95_ours: f64,
) -> Result<Row, String> {
    let ccx = execute(
        name,
        &deck_shell(nodes, elements, thickness, material, dirichlet, forces),
    )?;
    let ours = translations(displacement, 6);
    let vm_ccx = shell_outer_von_mises(nodes, thickness, &ccx.expanded, &ccx.stress)?;
    let p95_ccx = percentile_95_f64(&vm_ccx);
    finish(name, "S6", &ours, &ccx.displacement, p95_ours, p95_ccx)
}

fn finish(
    name: &'static str,
    element: &'static str,
    ours: &[[f64; 3]],
    ccx: &[[f64; 3]],
    p95_ours: f64,
    p95_ccx: f64,
) -> Result<Row, String> {
    if ours.len() != ccx.len() {
        return Err(format!(
            "{name}: {} translations vs {} from ccx",
            ours.len(),
            ccx.len()
        ));
    }
    let peak_ours = peak_translation(ours);
    let peak_ccx = peak_translation(ccx);
    if peak_ccx < 1e-12 {
        return Err(format!(
            "{name}: ccx peak displacement is {peak_ccx:.3e}, so the relative gate is meaningless"
        ));
    }
    if p95_ccx.abs() < 1e-8 {
        return Err(format!(
            "{name}: ccx p95 von Mises is {p95_ccx:.3e}, so the relative gate is meaningless"
        ));
    }
    let disp_err = (peak_ours - peak_ccx).abs() / peak_ccx;
    let vm_err = (p95_ours - p95_ccx).abs() / p95_ccx.abs();
    let pass = disp_err <= DISP_TOL * (1.0 + 1e-9) && vm_err <= VM_TOL * (1.0 + 1e-9);
    Ok(Row {
        name,
        element,
        nodes: ours.len(),
        peak_ours,
        peak_ccx,
        disp_err,
        disp_tol: DISP_TOL,
        p95_ours,
        p95_ccx,
        vm_err,
        vm_tol: VM_TOL,
        pass,
    })
}

fn execute(name: &str, deck: &Deck) -> Result<ccx_io::CcxResult, String> {
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir: PathBuf = env::temp_dir().join(format!("surfcad-ccx-{}-{}", slug, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let result = run_case(&dir, "case", deck).map_err(|err| format!("{name}: {err}"));
    if result.is_ok() && env::var("CALCULIX_KEEP").is_err() {
        let _ = fs::remove_dir_all(&dir);
    } else {
        eprintln!("{name}: left ccx files in {}", dir.display());
    }
    result
}

fn deck_solid(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[[f64; 3]],
) -> Deck {
    Deck {
        kind: ElementKind::C3d10,
        nodes: nodes.to_vec(),
        elements: elements.iter().map(|e| e.to_vec()).collect(),
        thickness: 0.0,
        young: material.young,
        poisson: material.poisson,
        fixed: solid_fixed(dirichlet),
        forces: forces.to_vec(),
        ties: Vec::new(),
        contacts: Vec::new(),
    }
}

fn deck_shell(
    nodes: &[[f64; 3]],
    elements: &[[u32; 6]],
    thickness: f64,
    material: Material,
    dirichlet: &[Dirichlet],
    forces: &[[f64; 3]],
) -> Deck {
    Deck {
        kind: ElementKind::S6,
        nodes: nodes.to_vec(),
        elements: elements.iter().map(|e| e.to_vec()).collect(),
        thickness,
        young: material.young,
        poisson: material.poisson,
        fixed: shell_fixed(dirichlet),
        forces: forces.to_vec(),
        ties: Vec::new(),
        contacts: Vec::new(),
    }
}

fn solid_fixed(dirichlet: &[Dirichlet]) -> Vec<(u32, u32)> {
    dirichlet
        .iter()
        .map(|bc| {
            let node = bc.dof / 3;
            let axis = bc.dof % 3;
            (node, axis + 1)
        })
        .collect()
}

fn shell_fixed(dirichlet: &[Dirichlet]) -> Vec<(u32, u32)> {
    dirichlet
        .iter()
        .map(|bc| {
            let node = bc.dof / 6;
            let component = bc.dof % 6;
            (node, component + 1)
        })
        .collect()
}

fn translations(displacement: &[f64], stride: usize) -> Vec<[f64; 3]> {
    displacement
        .chunks(stride)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

fn peak_translation(u: &[[f64; 3]]) -> f64 {
    u.iter()
        .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
        .fold(0.0, f64::max)
}

fn von_mises(s: &[f64; 6]) -> f64 {
    let (xx, yy, zz, xy, yz, xz) = (s[0], s[1], s[2], s[3], s[4], s[5]);
    let dxy = xx - yy;
    let dyz = yy - zz;
    let dzx = zz - xx;
    (0.5 * (dxy * dxy + dyz * dyz + dzx * dzx) + 3.0 * (xy * xy + yz * yz + xz * xz)).sqrt()
}

fn solid_von_mises(
    n_nodes: usize,
    stress: &std::collections::HashMap<u32, [f64; 6]>,
) -> Result<Vec<f64>, String> {
    let mut out = Vec::with_capacity(n_nodes);
    for node in 0..n_nodes {
        let id = (node + 1) as u32;
        let tensor = stress
            .get(&id)
            .ok_or_else(|| format!("ccx frd has no stress for solid node {id}"))?;
        out.push(von_mises(tensor));
    }
    Ok(out)
}

/// Outer-fibre von Mises of an expanded S6 mesh.
///
/// `ccx` writes the wedge, not the shell. Each shell node becomes a pair of
/// nodes at ±t/2 along the director (corners also keep a mid-surface node).
/// The two outer samples are what `solve_shell` folds into p95.
fn shell_outer_von_mises(
    nodes: &[[f64; 3]],
    thickness: f64,
    expanded: &[(u32, [f64; 3])],
    stress: &std::collections::HashMap<u32, [f64; 6]>,
) -> Result<Vec<f64>, String> {
    let half = 0.5 * thickness;
    // `.frd` coordinates are written with six significant digits. The
    // tolerance has to cover that rounding and still sit well below t/2,
    // so a mid-surface node is not taken for an outer fibre.
    let tol = 0.05 * half;
    let mut hits = vec![0_u32; nodes.len()];
    let mut samples = Vec::with_capacity(nodes.len() * 2);
    for &(id, xyz) in expanded {
        let Some(tensor) = stress.get(&id) else {
            continue;
        };
        let (nearest, dist, second) = nearest_node(nodes, xyz);
        if (dist - half).abs() > tol {
            if dist > tol {
                return Err(format!(
                    "expanded node {id} is {dist:.4e} from the nearest shell node, expected ~0 or ~{half:.4e}"
                ));
            }
            continue;
        }
        if second - dist < half {
            return Err(format!(
                "expanded node {id} is ambiguous: nearest {dist:.4e}, second {second:.4e}"
            ));
        }
        hits[nearest] += 1;
        samples.push(von_mises(tensor));
    }
    for (node, count) in hits.iter().enumerate() {
        if *count != 2 {
            return Err(format!(
                "shell node {node} matched {count} outer ccx nodes, expected 2"
            ));
        }
    }
    Ok(samples)
}

fn nearest_node(nodes: &[[f64; 3]], xyz: [f64; 3]) -> (usize, f64, f64) {
    let mut best_i = 0;
    let mut best = f64::MAX;
    let mut second = f64::MAX;
    for (i, node) in nodes.iter().enumerate() {
        let d = dist(*node, xyz);
        if d < best {
            second = best;
            best = d;
            best_i = i;
        } else if d < second {
            second = d;
        }
    }
    (best_i, best, second)
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

fn as_nodal(forces: &[[f64; 3]]) -> Vec<NodalForce> {
    forces
        .iter()
        .enumerate()
        .filter(|(_, f)| f.iter().any(|c| c.abs() > 0.0))
        .map(|(node, f)| NodalForce {
            node: node as u32,
            force: *f,
        })
        .collect()
}

fn traction_forces(nodes: &[[f64; 3]], faces: &[[u32; 6]], traction: [f64; 3]) -> Vec<[f64; 3]> {
    let mut forces = vec![[0.0; 3]; nodes.len()];
    for face in faces {
        let mut xyz = [[0.0; 3]; 6];
        for slot in 0..6 {
            xyz[slot] = nodes[face[slot] as usize];
        }
        let nodal = face_traction_forces(&xyz, traction);
        for slot in 0..6 {
            let node = face[slot] as usize;
            for axis in 0..3 {
                forces[node][axis] += nodal[slot][axis];
            }
        }
    }
    forces
}

fn faces_on_plane(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
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
    for elem in elements {
        for local in FACES {
            let ids = local.map(|slot| elem[slot]);
            let on = ids
                .iter()
                .all(|&id| (nodes[id as usize][axis] - value).abs() <= tol);
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
