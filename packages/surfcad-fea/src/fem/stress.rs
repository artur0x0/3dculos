//! Gauss-point stress, extrapolated to the nodes and averaged.

use super::tet10::{self, elasticity};
use super::{FemError, Material};

pub fn von_mises(s: &[f64; 6]) -> f64 {
    let (xx, yy, zz, xy, yz, xz) = (s[0], s[1], s[2], s[3], s[4], s[5]);
    let dxy = xx - yy;
    let dyz = yy - zz;
    let dzx = zz - xx;
    (0.5 * (dxy * dxy + dyz * dyz + dzx * dzx) + 3.0 * (xy * xy + yz * yz + xz * xz)).sqrt()
}

/// Normal stress `n · σ · n` for a unit direction.
#[cfg(test)]
pub fn normal_stress(s: &[f64; 6], n: [f64; 3]) -> f64 {
    let (xx, yy, zz, xy, yz, xz) = (s[0], s[1], s[2], s[3], s[4], s[5]);
    n[0] * n[0] * xx
        + n[1] * n[1] * yy
        + n[2] * n[2] * zz
        + 2.0 * n[0] * n[1] * xy
        + 2.0 * n[1] * n[2] * yz
        + 2.0 * n[0] * n[2] * xz
}

pub fn nodal_stress(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    displacement: &[f64],
) -> Result<Vec<[f64; 6]>, FemError> {
    let c = elasticity(material);
    let mut acc = vec![[0.0; 6]; nodes.len()];
    let mut count = vec![0_u32; nodes.len()];
    for (element, elem) in elements.iter().enumerate() {
        let gauss = tet10::gauss_stress(nodes, elem, element, &c, displacement)?;
        for comp in 0..6 {
            let samples = [
                gauss[0][comp],
                gauss[1][comp],
                gauss[2][comp],
                gauss[3][comp],
            ];
            let nodal = tet10::extrapolate_to_nodes(samples);
            for a in 0..10 {
                let node = elem[a] as usize;
                acc[node][comp] += nodal[a];
            }
        }
        for a in 0..10 {
            count[elem[a] as usize] += 1;
        }
    }
    for (node, hits) in count.iter().enumerate() {
        if *hits == 0 {
            return Err(FemError::BadMesh(format!(
                "node {node} is not connected to an element"
            )));
        }
        let scale = f64::from(*hits);
        for comp in 0..6 {
            acc[node][comp] /= scale;
        }
    }
    Ok(acc)
}
