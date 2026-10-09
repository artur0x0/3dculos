//! Programmatic TET10 meshes for the native tests and the scale bench.
//!
//! A hex grid is split into six tetrahedra around the space diagonal, then
//! each edge (including the diagonals the split introduces) gets a midside
//! node. Curved boundaries pass a per-edge radius so those midsides sit on
//! the cylinder or the hole instead of on the chord.

use std::collections::HashMap;

/// VTK TET10 connectivity.
#[derive(Clone, Debug)]
pub struct Tet10Mesh {
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 10]>,
}

/// Quarter of a thick-walled cylinder, θ from 0 to π/2, axis along z.
#[derive(Clone, Debug)]
pub struct QuarterCylinder {
    pub mesh: Tet10Mesh,
    /// Inner-surface faces. The right-hand normal points out of the solid
    /// (toward the axis), so a positive pressure is internal pressure.
    pub inner_faces: Vec<[u32; 6]>,
    pub ri: f64,
    pub ro: f64,
    pub length: f64,
}

/// Quarter plate in the first quadrant with a circular hole at the origin.
#[derive(Clone, Debug)]
pub struct QuarterPlateHole {
    pub mesh: Tet10Mesh,
    /// Faces on y = `length`, wound so the right-hand normal is +y.
    pub tension_faces: Vec<[u32; 6]>,
    pub radius: f64,
    pub width: f64,
    pub length: f64,
    pub thickness: f64,
}

/// Six positive-volume tets around diagonal 0–6. The same template on every
/// hex of a grid shares diagonals across faces.
const HEX_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
];

const TET_EDGES: [(usize, usize, usize); 6] = [
    (0, 1, 4),
    (1, 2, 5),
    (2, 0, 6),
    (0, 3, 7),
    (1, 3, 8),
    (2, 3, 9),
];

/// Axis-aligned brick split into TET10 elements.
///
/// `cells` is the number of hexes along x, y, z. `origin` is the minimum
/// corner and `size` is the full edge length of the brick.
pub fn brick_tet10(cells: [usize; 3], origin: [f64; 3], size: [f64; 3]) -> Tet10Mesh {
    assert!(
        cells.iter().all(|&n| n >= 1),
        "brick needs at least one cell per axis"
    );
    let (nodes, tets) = linear_hex_grid(cells, |i, j, k| {
        [
            origin[0] + size[0] * (i as f64 / cells[0] as f64),
            origin[1] + size[1] * (j as f64 / cells[1] as f64),
            origin[2] + size[2] * (k as f64 / cells[2] as f64),
        ]
    });
    upgrade(&nodes, &tets, &HashMap::new())
}

/// Quarter cylinder. `cells` is `(radial, circumferential, axial)`.
///
/// Circumferential and radial midsides that lie on r = ri or r = ro are
/// placed on the cylinder.
pub fn quarter_cylinder(ri: f64, ro: f64, length: f64, cells: [usize; 3]) -> QuarterCylinder {
    assert!(ro > ri && ri > 0.0 && length > 0.0);
    assert!(cells.iter().all(|&n| n >= 1));
    let (nr, nt, nz) = (cells[0], cells[1], cells[2]);
    let (nodes, tets) = linear_hex_grid([nr, nt, nz], |ir, it, iz| {
        let theta = std::f64::consts::FRAC_PI_2 * (it as f64 / nt as f64);
        let r = ri + (ro - ri) * (ir as f64 / nr as f64);
        let mut x = r * theta.cos();
        let mut y = r * theta.sin();
        if it == 0 {
            y = 0.0;
        }
        if it == nt {
            x = 0.0;
        }
        let z = length * (iz as f64 / nz as f64);
        [x, y, z]
    });
    let linear_faces = outward_boundary(&nodes, &tets);
    let mut project = HashMap::new();
    let tol = 1e-8 * ro;
    for face in &linear_faces {
        let radii = face.map(|id| radius_xy(nodes[id as usize]));
        let on = |target: f64| radii.iter().all(|r| (r - target).abs() <= tol);
        let target = if on(ri) {
            Some(ri)
        } else if on(ro) {
            Some(ro)
        } else {
            None
        };
        if let Some(target) = target {
            for edge in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])] {
                project.insert(edge_key(edge.0, edge.1), target);
            }
        }
    }
    let (mesh, mids) = upgrade_with_mids(&nodes, &tets, &project);
    let inner_faces = linear_faces
        .into_iter()
        .filter(|face| {
            face.iter()
                .all(|&id| (radius_xy(nodes[id as usize]) - ri).abs() <= tol)
        })
        .map(|face| quadratic_face(face, &mids))
        .collect();
    QuarterCylinder {
        mesh,
        inner_faces,
        ri,
        ro,
        length,
    }
}

/// Quarter plate with a hole. `cells` is `(radial, circumferential, through-thickness)`.
///
/// `n_theta` should be even when `width == length`, so a node sits on the
/// square's corner ray and no cell straddles the kink.
pub fn quarter_plate_hole(
    radius: f64,
    width: f64,
    length: f64,
    thickness: f64,
    cells: [usize; 3],
) -> QuarterPlateHole {
    assert!(width > radius && length > radius && radius > 0.0 && thickness > 0.0);
    assert!(cells.iter().all(|&n| n >= 1));
    let (nr, nt, nz) = (cells[0], cells[1], cells[2]);
    let (nodes, tets) = linear_hex_grid([nr, nt, nz], |ir, it, iz| {
        let theta = std::f64::consts::FRAC_PI_2 * (it as f64 / nt as f64);
        let t = bias_toward_start(ir as f64 / nr as f64, 2.4);
        let mut inner = [radius * theta.cos(), radius * theta.sin()];
        let mut outer = ray_hit_rectangle(theta, width, length);
        if it == 0 {
            inner[1] = 0.0;
            outer = [width, 0.0];
        }
        if it == nt {
            inner[0] = 0.0;
            outer = [0.0, length];
        }
        let x = inner[0] + t * (outer[0] - inner[0]);
        let y = inner[1] + t * (outer[1] - inner[1]);
        let z = thickness * (iz as f64 / nz as f64);
        [x, y, z]
    });
    let linear_faces = outward_boundary(&nodes, &tets);
    let mut project = HashMap::new();
    let tol = 1e-8 * radius.max(width);
    for face in &linear_faces {
        let on_hole = face
            .iter()
            .all(|&id| (radius_xy(nodes[id as usize]) - radius).abs() <= tol);
        if on_hole {
            for edge in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])] {
                project.insert(edge_key(edge.0, edge.1), radius);
            }
        }
    }
    let (mesh, mids) = upgrade_with_mids(&nodes, &tets, &project);
    let ytol = 1e-8 * length;
    let tension_faces = linear_faces
        .into_iter()
        .filter(|face| {
            face.iter()
                .all(|&id| (nodes[id as usize][1] - length).abs() <= ytol)
        })
        .map(|face| quadratic_face(face, &mids))
        .collect();
    QuarterPlateHole {
        mesh,
        tension_faces,
        radius,
        width,
        length,
        thickness,
    }
}

fn bias_toward_start(t: f64, growth: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    (growth.powf(t) - 1.0) / (growth - 1.0)
}

fn ray_hit_rectangle(theta: f64, width: f64, length: f64) -> [f64; 2] {
    let (s, c) = (theta.sin(), theta.cos());
    let dx = if c > 1e-14 { width / c } else { f64::INFINITY };
    let dy = if s > 1e-14 { length / s } else { f64::INFINITY };
    let d = dx.min(dy);
    [d * c, d * s]
}

fn radius_xy(p: [f64; 3]) -> f64 {
    (p[0] * p[0] + p[1] * p[1]).sqrt()
}

fn edge_key(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn linear_hex_grid(
    cells: [usize; 3],
    position: impl Fn(usize, usize, usize) -> [f64; 3],
) -> (Vec<[f64; 3]>, Vec<[u32; 4]>) {
    let (nx, ny, nz) = (cells[0], cells[1], cells[2]);
    let sx = nx + 1;
    let sy = ny + 1;
    let mut nodes = Vec::with_capacity(sx * sy * (nz + 1));
    for k in 0..=nz {
        for j in 0..=ny {
            for i in 0..=nx {
                nodes.push(position(i, j, k));
            }
        }
    }
    let vid = |i: usize, j: usize, k: usize| -> u32 { (i + sx * (j + sy * k)) as u32 };
    let mut tets = Vec::with_capacity(nx * ny * nz * 6);
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let c = [
                    vid(i, j, k),
                    vid(i + 1, j, k),
                    vid(i + 1, j + 1, k),
                    vid(i, j + 1, k),
                    vid(i, j, k + 1),
                    vid(i + 1, j, k + 1),
                    vid(i + 1, j + 1, k + 1),
                    vid(i, j + 1, k + 1),
                ];
                for tet in HEX_TETS {
                    tets.push([c[tet[0]], c[tet[1]], c[tet[2]], c[tet[3]]]);
                }
            }
        }
    }
    (nodes, tets)
}

fn upgrade(nodes: &[[f64; 3]], tets: &[[u32; 4]], project: &HashMap<(u32, u32), f64>) -> Tet10Mesh {
    upgrade_with_mids(nodes, tets, project).0
}

fn upgrade_with_mids(
    nodes: &[[f64; 3]],
    tets: &[[u32; 4]],
    project: &HashMap<(u32, u32), f64>,
) -> (Tet10Mesh, HashMap<(u32, u32), u32>) {
    let mut out_nodes = nodes.to_vec();
    let mut mids: HashMap<(u32, u32), u32> = HashMap::new();
    let mut elements = Vec::with_capacity(tets.len());
    for tet in tets {
        let mut elem = [0_u32; 10];
        elem[0] = tet[0];
        elem[1] = tet[1];
        elem[2] = tet[2];
        elem[3] = tet[3];
        for (a, b, slot) in TET_EDGES {
            let ia = tet[a];
            let ib = tet[b];
            let key = edge_key(ia, ib);
            let id = if let Some(&existing) = mids.get(&key) {
                existing
            } else {
                let p = nodes[ia as usize];
                let q = nodes[ib as usize];
                let mid = if let Some(&radius) = project.get(&key) {
                    project_to_radius(p, q, radius)
                } else {
                    [
                        0.5 * (p[0] + q[0]),
                        0.5 * (p[1] + q[1]),
                        0.5 * (p[2] + q[2]),
                    ]
                };
                let id = out_nodes.len() as u32;
                out_nodes.push(mid);
                mids.insert(key, id);
                id
            };
            elem[slot] = id;
        }
        elements.push(elem);
    }
    (
        Tet10Mesh {
            nodes: out_nodes,
            elements,
        },
        mids,
    )
}

fn project_to_radius(p: [f64; 3], q: [f64; 3], radius: f64) -> [f64; 3] {
    let a0 = p[1].atan2(p[0]);
    let a1 = q[1].atan2(q[0]);
    let mut da = a1 - a0;
    if da > std::f64::consts::PI {
        da -= 2.0 * std::f64::consts::PI;
    }
    if da < -std::f64::consts::PI {
        da += 2.0 * std::f64::consts::PI;
    }
    let ang = a0 + 0.5 * da;
    let z = 0.5 * (p[2] + q[2]);
    [radius * ang.cos(), radius * ang.sin(), z]
}

fn quadratic_face(face: [u32; 3], mids: &HashMap<(u32, u32), u32>) -> [u32; 6] {
    let mid = |a: u32, b: u32| mids[&edge_key(a, b)];
    [
        face[0],
        face[1],
        face[2],
        mid(face[0], face[1]),
        mid(face[1], face[2]),
        mid(face[2], face[0]),
    ]
}

fn outward_boundary(nodes: &[[f64; 3]], tets: &[[u32; 4]]) -> Vec<[u32; 3]> {
    let mut map: HashMap<[u32; 3], ([u32; 3], u8)> = HashMap::new();
    for tet in tets {
        let corners = [
            (tet[1], tet[2], tet[3], tet[0]),
            (tet[0], tet[3], tet[2], tet[1]),
            (tet[0], tet[1], tet[3], tet[2]),
            (tet[0], tet[2], tet[1], tet[3]),
        ];
        for (i, j, k, opposite) in corners {
            let oriented = orient_away(nodes, [i, j, k], opposite);
            let mut key = oriented;
            key.sort_unstable();
            let entry = map.entry(key).or_insert((oriented, 0));
            entry.1 = entry.1.saturating_add(1);
        }
    }
    map.into_iter()
        .filter(|(_, (_, count))| *count == 1)
        .map(|(_, (face, _))| face)
        .collect()
}

fn orient_away(nodes: &[[f64; 3]], face: [u32; 3], opposite: u32) -> [u32; 3] {
    let a = nodes[face[0] as usize];
    let b = nodes[face[1] as usize];
    let c = nodes[face[2] as usize];
    let n = cross(sub(b, a), sub(c, a));
    let toward = sub(nodes[opposite as usize], a);
    if dot(n, toward) > 0.0 {
        [face[0], face[2], face[1]]
    } else {
        face
    }
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

    fn tet_volume(nodes: &[[f64; 3]], tet: [u32; 4]) -> f64 {
        let a = nodes[tet[0] as usize];
        let b = nodes[tet[1] as usize];
        let c = nodes[tet[2] as usize];
        let d = nodes[tet[3] as usize];
        let ab = sub(b, a);
        let ac = sub(c, a);
        let ad = sub(d, a);
        dot(cross(ab, ac), ad) / 6.0
    }

    #[test]
    fn brick_linear_tets_fill_the_volume_without_inverted_cells() {
        let cells = [2_usize, 2, 2];
        let (nodes, tets) = linear_hex_grid(cells, |i, j, k| [i as f64, j as f64, k as f64]);
        let mut volume = 0.0;
        for tet in tets {
            let v = tet_volume(&nodes, tet);
            assert!(v > 0.0, "inverted tet {tet:?} volume {v}");
            volume += v;
        }
        assert!((volume - 8.0).abs() < 1e-9, "volume {volume}");
    }
}
