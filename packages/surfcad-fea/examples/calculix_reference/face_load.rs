//! Consistent face loads, copied from the solver's TET10 quadrature.
//!
//! `face_traction_forces` and `face_pressure_forces` live in a crate-private
//! module and are not part of the wasm build. Keeping this copy in the
//! example means the reference harness does not change the committed wasm.
//! The weights and shape functions match `fem::tet10` so the nodal forces
//! written to CalculiX are the ones `solve_tet10` assembles.

fn gauss_tri() -> [([f64; 3], f64); 3] {
    let w = 1.0 / 6.0;
    [
        ([2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0], w),
        ([1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0], w),
        ([1.0 / 6.0, 1.0 / 6.0, 2.0 / 3.0], w),
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

/// Consistent nodal forces for a constant traction (N/mm²) on a 6-node face.
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
