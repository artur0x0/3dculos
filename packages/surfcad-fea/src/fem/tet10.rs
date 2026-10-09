//! Quadratic tetrahedron: shape functions, stiffness, face loads.
//!
//! Node order matches VTK `VTK_QUADRATIC_TETRA`:
//! corners 0, 1, 2, 3 and mids of edges 0-1, 1-2, 2-0, 0-3, 1-3, 2-3.

use super::{FacePressure, FemError, Material, NodalForce};

/// 4-point rule, exact for polynomials of degree ≤ 2.
/// Barycentric coordinates are permutations of (α, β, β, β).
fn gauss_tet() -> (f64, f64, f64) {
    let sqrt5 = 5.0_f64.sqrt();
    let alpha = (5.0 + 3.0 * sqrt5) / 20.0;
    let beta = (5.0 - sqrt5) / 20.0;
    // Each weight integrates to 1/24 over the reference coordinates
    // (L1, L2, L3), whose domain has measure 1/6.
    let weight = 1.0 / 24.0;
    (alpha, beta, weight)
}

/// 3-point triangle rule, exact for polynomials of degree ≤ 2.
/// Barycentric (L0, L1, L2) and the weight in dL1 dL2.
fn gauss_tri() -> [([f64; 3], f64); 3] {
    let w = 1.0 / 6.0;
    [
        ([2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0], w),
        ([1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0], w),
        ([1.0 / 6.0, 1.0 / 6.0, 2.0 / 3.0], w),
    ]
}

pub fn elasticity(material: Material) -> [f64; 36] {
    let e = material.young;
    let nu = material.poisson;
    let lam = e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    let mu = e / (2.0 * (1.0 + nu));
    let diag = lam + 2.0 * mu;
    let mut c = [0.0; 36];
    c[0] = diag;
    c[1] = lam;
    c[2] = lam;
    c[6] = lam;
    c[7] = diag;
    c[8] = lam;
    c[12] = lam;
    c[13] = lam;
    c[14] = diag;
    c[21] = mu;
    c[28] = mu;
    c[35] = mu;
    c
}

#[cfg(test)]
fn shape(l1: f64, l2: f64, l3: f64) -> [f64; 10] {
    let l0 = 1.0 - l1 - l2 - l3;
    [
        l0 * (2.0 * l0 - 1.0),
        l1 * (2.0 * l1 - 1.0),
        l2 * (2.0 * l2 - 1.0),
        l3 * (2.0 * l3 - 1.0),
        4.0 * l0 * l1,
        4.0 * l1 * l2,
        4.0 * l2 * l0,
        4.0 * l0 * l3,
        4.0 * l1 * l3,
        4.0 * l2 * l3,
    ]
}

/// ∂N/∂(L1, L2, L3). L0 = 1 - L1 - L2 - L3.
fn dshape(l1: f64, l2: f64, l3: f64) -> [[f64; 3]; 10] {
    let l0 = 1.0 - l1 - l2 - l3;
    let mut d = [[0.0; 3]; 10];
    let d0 = -(4.0 * l0 - 1.0);
    d[0] = [d0, d0, d0];
    d[1] = [4.0 * l1 - 1.0, 0.0, 0.0];
    d[2] = [0.0, 4.0 * l2 - 1.0, 0.0];
    d[3] = [0.0, 0.0, 4.0 * l3 - 1.0];
    d[4] = [4.0 * (l0 - l1), -4.0 * l1, -4.0 * l1];
    d[5] = [4.0 * l2, 4.0 * l1, 0.0];
    d[6] = [-4.0 * l2, 4.0 * (l0 - l2), -4.0 * l2];
    d[7] = [-4.0 * l3, -4.0 * l3, 4.0 * (l0 - l3)];
    d[8] = [4.0 * l3, 0.0, 4.0 * l1];
    d[9] = [0.0, 4.0 * l3, 4.0 * l2];
    d
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

/// Physical shape-function gradients and det(J) at one quadrature point.
///
/// `det_j` is ∂(x,y,z)/∂(L1,L2,L3). For a positive straight tet it equals `6V`.
fn gradients(xyz: &[[f64; 3]; 10], l1: f64, l2: f64, l3: f64) -> Result<([[f64; 3]; 10], f64), ()> {
    let dn = dshape(l1, l2, l3);
    let mut jac = [[0.0; 3]; 3];
    for a in 0..10 {
        for row in 0..3 {
            jac[row][0] += dn[a][0] * xyz[a][row];
            jac[row][1] += dn[a][1] * xyz[a][row];
            jac[row][2] += dn[a][2] * xyz[a][row];
        }
    }
    let (inv, det) = invert3(jac).ok_or(())?;
    let mut grad = [[0.0; 3]; 10];
    for a in 0..10 {
        for axis in 0..3 {
            grad[a][axis] =
                inv[0][axis] * dn[a][0] + inv[1][axis] * dn[a][1] + inv[2][axis] * dn[a][2];
        }
    }
    Ok((grad, det))
}

fn elem_coords(nodes: &[[f64; 3]], elem: &[u32; 10]) -> [[f64; 3]; 10] {
    let mut xyz = [[0.0; 3]; 10];
    for a in 0..10 {
        xyz[a] = nodes[elem[a] as usize];
    }
    xyz
}

/// Integrated element volume. Positive for a right-handed element.
#[cfg(test)]
pub fn tet_volume(xyz: &[[f64; 3]; 10]) -> Result<f64, ()> {
    let (_alpha, beta, weight) = gauss_tet();
    let points = [
        (beta, beta, beta),
        (_alpha, beta, beta),
        (beta, _alpha, beta),
        (beta, beta, _alpha),
    ];
    let mut volume = 0.0;
    for (l1, l2, l3) in points {
        let (_g, det) = gradients(xyz, l1, l2, l3)?;
        if det <= 0.0 {
            return Err(());
        }
        volume += det * weight;
    }
    Ok(volume)
}

/// 30×30 element stiffness, row-major. Returns the element volume too.
pub fn element_stiffness(
    nodes: &[[f64; 3]],
    elem: &[u32; 10],
    c: &[f64; 36],
) -> Result<([f64; 900], f64), FemError> {
    let xyz = elem_coords(nodes, elem);
    let (alpha, beta, weight) = gauss_tet();
    let points = [
        (beta, beta, beta),
        (alpha, beta, beta),
        (beta, alpha, beta),
        (beta, beta, alpha),
    ];
    let mut ke = [0.0; 900];
    let mut volume = 0.0;
    for (l1, l2, l3) in points {
        let (grad, det) = gradients(&xyz, l1, l2, l3).map_err(|_| {
            FemError::BadMesh(
                "a TET10 element has a singular Jacobian (collapsed or inverted)".into(),
            )
        })?;
        if det <= 0.0 {
            return Err(FemError::BadMesh(
                "a TET10 element has a non-positive Jacobian; node order must be right-handed"
                    .into(),
            ));
        }
        let wdet = det * weight;
        volume += wdet;
        let mut b = [0.0; 180];
        for a in 0..10 {
            let (dx, dy, dz) = (grad[a][0], grad[a][1], grad[a][2]);
            let col = a * 3;
            b[0 * 30 + col] = dx;
            b[1 * 30 + col + 1] = dy;
            b[2 * 30 + col + 2] = dz;
            b[3 * 30 + col] = dy;
            b[3 * 30 + col + 1] = dx;
            b[4 * 30 + col + 1] = dz;
            b[4 * 30 + col + 2] = dy;
            b[5 * 30 + col] = dz;
            b[5 * 30 + col + 2] = dx;
        }
        let mut cb = [0.0; 180];
        for col in 0..30 {
            for s in 0..6 {
                let mut acc = 0.0;
                for t in 0..6 {
                    acc += c[s * 6 + t] * b[t * 30 + col];
                }
                cb[s * 30 + col] = acc;
            }
        }
        for i in 0..30 {
            for j in 0..30 {
                let mut acc = 0.0;
                for s in 0..6 {
                    acc += b[s * 30 + i] * cb[s * 30 + j];
                }
                ke[i * 30 + j] += acc * wdet;
            }
        }
    }
    Ok((ke, volume))
}

/// Strain-displacement at the 4 Gauss points and the matching stresses.
///
/// `gauss_stress[g]` is Voigt `[σxx, σyy, σzz, σxy, σyz, σxz]` at the point
/// whose large barycentric coordinate is α on vertex `g`.
pub fn gauss_stress(
    nodes: &[[f64; 3]],
    elem: &[u32; 10],
    c: &[f64; 36],
    displacement: &[f64],
) -> Result<[[f64; 6]; 4], FemError> {
    let xyz = elem_coords(nodes, elem);
    let mut ue = [0.0; 30];
    for a in 0..10 {
        let base = elem[a] as usize * 3;
        ue[a * 3] = displacement[base];
        ue[a * 3 + 1] = displacement[base + 1];
        ue[a * 3 + 2] = displacement[base + 2];
    }
    let (alpha, beta, _) = gauss_tet();
    let points = [
        (beta, beta, beta),
        (alpha, beta, beta),
        (beta, alpha, beta),
        (beta, beta, alpha),
    ];
    let mut out = [[0.0; 6]; 4];
    for (g, (l1, l2, l3)) in points.into_iter().enumerate() {
        let (grad, det) = gradients(&xyz, l1, l2, l3)
            .map_err(|_| FemError::BadMesh("a TET10 element has a singular Jacobian".into()))?;
        if det <= 0.0 {
            return Err(FemError::BadMesh(
                "a TET10 element has a non-positive Jacobian".into(),
            ));
        }
        let mut strain = [0.0; 6];
        for a in 0..10 {
            let (dx, dy, dz) = (grad[a][0], grad[a][1], grad[a][2]);
            let (u, v, w) = (ue[a * 3], ue[a * 3 + 1], ue[a * 3 + 2]);
            strain[0] += dx * u;
            strain[1] += dy * v;
            strain[2] += dz * w;
            strain[3] += dy * u + dx * v;
            strain[4] += dz * v + dy * w;
            strain[5] += dz * u + dx * w;
        }
        for s in 0..6 {
            let mut acc = 0.0;
            for t in 0..6 {
                acc += c[s * 6 + t] * strain[t];
            }
            out[g][s] = acc;
        }
    }
    Ok(out)
}

/// Extrapolate the 4 Gauss-point values of one stress component to the 10 nodes.
///
/// The map is exact for a linear field, which is the stress inside a
/// straight-sided TET10 element.
pub fn extrapolate_to_nodes(gauss: [f64; 4]) -> [f64; 10] {
    let (alpha, beta, _) = gauss_tet();
    let sum = gauss[0] + gauss[1] + gauss[2] + gauss[3];
    let denom = alpha - beta;
    let mut corner = [0.0; 4];
    for i in 0..4 {
        corner[i] = (gauss[i] - beta * sum) / denom;
    }
    [
        corner[0],
        corner[1],
        corner[2],
        corner[3],
        0.5 * (corner[0] + corner[1]),
        0.5 * (corner[1] + corner[2]),
        0.5 * (corner[2] + corner[0]),
        0.5 * (corner[0] + corner[3]),
        0.5 * (corner[1] + corner[3]),
        0.5 * (corner[2] + corner[3]),
    ]
}

fn tri_shape(l0: f64, l1: f64, l2: f64) -> [f64; 6] {
    [
        l0 * (2.0 * l0 - 1.0),
        l1 * (2.0 * l1 - 1.0),
        l2 * (2.0 * l2 - 1.0),
        4.0 * l0 * l1,
        4.0 * l1 * l2,
        4.0 * l2 * l0,
    ]
}

fn tri_dshape(l0: f64, l1: f64, l2: f64) -> [[f64; 2]; 6] {
    // Derivatives w.r.t. independent coordinates (L1, L2), L0 = 1 - L1 - L2.
    let mut d = [[0.0; 2]; 6];
    let d0 = -(4.0 * l0 - 1.0);
    d[0] = [d0, d0];
    d[1] = [4.0 * l1 - 1.0, 0.0];
    d[2] = [0.0, 4.0 * l2 - 1.0];
    d[3] = [4.0 * (l0 - l1), -4.0 * l1];
    d[4] = [4.0 * l2, 4.0 * l1];
    d[5] = [-4.0 * l2, 4.0 * (l0 - l2)];
    d
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn face_coords(nodes: &[[f64; 3]], face: &[u32; 6]) -> [[f64; 3]; 6] {
    let mut xyz = [[0.0; 3]; 6];
    for a in 0..6 {
        xyz[a] = nodes[face[a] as usize];
    }
    xyz
}

/// Consistent nodal forces for a constant traction (N/mm²) on a 6-node face.
///
/// The returned forces are newtons on the six face nodes, in face order.
/// Compiled only for the native target. The CalculiX reference example uses
/// it so both solvers see the same discrete traction. It is not a wasm export.
#[cfg(not(target_arch = "wasm32"))]
pub fn face_traction_forces(xyz: &[[f64; 3]; 6], traction: [f64; 3]) -> [[f64; 3]; 6] {
    let mut force = [[0.0; 3]; 6];
    for (bary, weight) in gauss_tri() {
        let (l0, l1, l2) = (bary[0], bary[1], bary[2]);
        let n = tri_shape(l0, l1, l2);
        let d = tri_dshape(l0, l1, l2);
        let mut dr_dl1 = [0.0; 3];
        let mut dr_dl2 = [0.0; 3];
        for a in 0..6 {
            for k in 0..3 {
                dr_dl1[k] += d[a][0] * xyz[a][k];
                dr_dl2[k] += d[a][1] * xyz[a][k];
            }
        }
        let nvec = cross(dr_dl1, dr_dl2);
        let scale = (nvec[0] * nvec[0] + nvec[1] * nvec[1] + nvec[2] * nvec[2]).sqrt();
        for a in 0..6 {
            let w = n[a] * scale * weight;
            force[a][0] += traction[0] * w;
            force[a][1] += traction[1] * w;
            force[a][2] += traction[2] * w;
        }
    }
    force
}

/// Consistent nodal forces for a uniform normal pressure.
///
/// Positive pressure acts against the right-hand normal of `(c0, c1, c2)`.
pub fn face_pressure_forces(xyz: &[[f64; 3]; 6], pressure: f64) -> [[f64; 3]; 6] {
    let mut force = [[0.0; 3]; 6];
    for (bary, weight) in gauss_tri() {
        let (l0, l1, l2) = (bary[0], bary[1], bary[2]);
        let n = tri_shape(l0, l1, l2);
        let d = tri_dshape(l0, l1, l2);
        let mut dr_dl1 = [0.0; 3];
        let mut dr_dl2 = [0.0; 3];
        for a in 0..6 {
            for k in 0..3 {
                dr_dl1[k] += d[a][0] * xyz[a][k];
                dr_dl2[k] += d[a][1] * xyz[a][k];
            }
        }
        // n dA = ∂r/∂L1 × ∂r/∂L2. Traction contributes -p * n dA.
        let nvec = cross(dr_dl1, dr_dl2);
        for a in 0..6 {
            let w = n[a] * weight * (-pressure);
            force[a][0] += nvec[0] * w;
            force[a][1] += nvec[1] * w;
            force[a][2] += nvec[2] * w;
        }
    }
    force
}

/// Add pressure and nodal forces into a global force vector of length `3 * nodes`.
pub fn assemble_forces(
    nodes: &[[f64; 3]],
    forces: &[NodalForce],
    pressures: &[FacePressure],
    out: &mut [f64],
) -> Result<(), FemError> {
    for force in forces {
        let base = force.node as usize * 3;
        out[base] += force.force[0];
        out[base + 1] += force.force[1];
        out[base + 2] += force.force[2];
    }
    for face in pressures {
        let xyz = face_coords(nodes, &face.nodes);
        let nodal = face_pressure_forces(&xyz, face.pressure);
        for a in 0..6 {
            let base = face.nodes[a] as usize * 3;
            out[base] += nodal[a][0];
            out[base + 1] += nodal[a][1];
            out[base + 2] += nodal[a][2];
        }
    }
    if out.iter().any(|v| !v.is_finite()) {
        return Err(FemError::BadLoad(
            "a load integrated to a non-finite force".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_tet() -> [[f64; 3]; 10] {
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5, 0.0, 0.0],
            [0.5, 0.5, 0.0],
            [0.0, 0.5, 0.0],
            [0.0, 0.0, 0.5],
            [0.5, 0.0, 0.5],
            [0.0, 0.5, 0.5],
        ]
    }

    #[test]
    fn shape_functions_partition_unity_and_hit_nodes() {
        let samples = [(0.2, 0.3, 0.1), (0.0, 0.0, 0.0), (0.5, 0.5, 0.0)];
        for (l1, l2, l3) in samples {
            let n = shape(l1, l2, l3);
            let sum: f64 = n.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12, "sum {sum}");
            let d = dshape(l1, l2, l3);
            let mut ds = [0.0; 3];
            for a in 0..10 {
                ds[0] += d[a][0];
                ds[1] += d[a][1];
                ds[2] += d[a][2];
            }
            assert!(ds.iter().all(|v| v.abs() < 1e-12), "{ds:?}");
        }
        let corner = shape(0.0, 0.0, 0.0);
        assert!((corner[0] - 1.0).abs() < 1e-12);
        let mid = shape(0.5, 0.0, 0.0);
        assert!((mid[4] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn straight_tet_volume_is_one_sixth() {
        let v = tet_volume(&unit_tet()).unwrap();
        assert!((v - 1.0 / 6.0).abs() < 1e-12, "volume {v}");
    }

    #[test]
    fn uniform_pressure_on_a_flat_face_loads_only_the_mids() {
        // Triangle (0,0,0), (2,0,0), (0,2,0). Area = 2.
        let xyz = [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        let p = 5.0;
        let f = face_pressure_forces(&xyz, p);
        let mut total = [0.0; 3];
        for node in &f {
            total[0] += node[0];
            total[1] += node[1];
            total[2] += node[2];
        }
        // Right-hand normal is +z. Positive pressure pushes in -z.
        // Area = 2, so total force = (0, 0, -10).
        assert!(total[0].abs() < 1e-12 && total[1].abs() < 1e-12);
        assert!((total[2] + 10.0).abs() < 1e-10, "fz {}", total[2]);
        for corner in 0..3 {
            assert!(
                f[corner].iter().all(|c| c.abs() < 1e-10),
                "corner {corner} {f:?}"
            );
        }
        for mid in 3..6 {
            assert!(
                (f[mid][2] + 10.0 / 3.0).abs() < 1e-10,
                "mid {mid} {:?}",
                f[mid]
            );
        }
    }
}
