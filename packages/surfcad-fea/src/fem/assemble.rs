//! Symmetric sparse assembly of the free-DOF system.

use super::tet10::{self, elasticity};
use super::{FacePressure, FemError, Material, NodalForce};

/// Lower triangle of a symmetric CSC matrix, diagonal included.
pub struct LowerCsc {
    pub n: usize,
    pub col_ptr: Vec<usize>,
    pub row_idx: Vec<usize>,
    pub values: Vec<f64>,
    pub diag: Vec<f64>,
}

impl LowerCsc {
    pub fn sym_matvec(&self, x: &[f64], y: &mut [f64]) {
        y.fill(0.0);
        for col in 0..self.n {
            let xcol = x[col];
            for p in self.col_ptr[col]..self.col_ptr[col + 1] {
                let row = self.row_idx[p];
                let a = self.values[p];
                y[row] += a * xcol;
                if row != col {
                    y[col] += a * x[row];
                }
            }
        }
    }
}

pub struct Reduced {
    pub matrix: LowerCsc,
    pub rhs: Vec<f64>,
}

pub fn assemble(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    fixed: &[bool],
    prescribed: &[f64],
    forces: &[NodalForce],
    pressures: &[FacePressure],
) -> Result<Reduced, FemError> {
    let n_nodes = nodes.len();
    let n_dof = n_nodes * 3;
    let (free_index, free_dof) = free_maps(fixed);
    let n_free = free_dof.len();
    let neighbors = node_neighbors(n_nodes, elements);
    let (col_ptr, row_idx) = sparsity(&neighbors, &free_index, &free_dof)?;
    let mut values = vec![0.0; row_idx.len()];
    let mut rhs = vec![0.0; n_free];

    let mut global_force = vec![0.0; n_dof];
    tet10::assemble_forces(nodes, forces, pressures, &mut global_force)?;
    for (slot, &dof) in free_dof.iter().enumerate() {
        rhs[slot] = global_force[dof];
    }

    let c = elasticity(material);
    for (element, elem) in elements.iter().enumerate() {
        let (ke, _volume) = tet10::element_stiffness(nodes, elem, element, &c)?;
        for li in 0..30 {
            let gi = elem[li / 3] as usize * 3 + (li % 3);
            for lj in 0..=li {
                let gj = elem[lj / 3] as usize * 3 + (lj % 3);
                let k = ke[li * 30 + lj];
                let ii = free_index[gi];
                let jj = free_index[gj];
                match (ii >= 0, jj >= 0) {
                    (true, true) => {
                        let (row, col) = if ii >= jj {
                            (ii as usize, jj as usize)
                        } else {
                            (jj as usize, ii as usize)
                        };
                        let pos = locate(&col_ptr, &row_idx, row, col)?;
                        values[pos] += k;
                    }
                    (true, false) => {
                        rhs[ii as usize] -= k * prescribed[gj];
                    }
                    (false, true) => {
                        rhs[jj as usize] -= k * prescribed[gi];
                    }
                    (false, false) => {}
                }
            }
        }
    }

    let mut diag = vec![0.0; n_free];
    for col in 0..n_free {
        let mut found = false;
        for p in col_ptr[col]..col_ptr[col + 1] {
            if row_idx[p] == col {
                diag[col] = values[p];
                found = true;
                break;
            }
        }
        if !found || !(diag[col].is_finite() && diag[col] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "free DOF {col} has a non-positive diagonal ({}); the mesh is missing a support or an element is degenerate",
                diag[col]
            )));
        }
    }

    Ok(Reduced {
        matrix: LowerCsc {
            n: n_free,
            col_ptr,
            row_idx,
            values,
            diag,
        },
        rhs,
    })
}

fn free_maps(fixed: &[bool]) -> (Vec<i64>, Vec<usize>) {
    let mut free_index = vec![-1_i64; fixed.len()];
    let mut free_dof = Vec::new();
    for (dof, &is_fixed) in fixed.iter().enumerate() {
        if !is_fixed {
            free_index[dof] = free_dof.len() as i64;
            free_dof.push(dof);
        }
    }
    (free_index, free_dof)
}

fn node_neighbors(n_nodes: usize, elements: &[[u32; 10]]) -> Vec<Vec<u32>> {
    let mut neighbors = vec![Vec::new(); n_nodes];
    for elem in elements {
        let mut uniq = *elem;
        uniq.sort_unstable();
        let mut last = u32::MAX;
        let mut nodes = [0_u32; 10];
        let mut n = 0;
        for id in uniq {
            if id != last {
                nodes[n] = id;
                n += 1;
                last = id;
            }
        }
        for a in 0..n {
            for b in 0..n {
                neighbors[nodes[a] as usize].push(nodes[b]);
            }
        }
    }
    for list in &mut neighbors {
        list.sort_unstable();
        list.dedup();
    }
    neighbors
}

fn sparsity(
    neighbors: &[Vec<u32>],
    free_index: &[i64],
    free_dof: &[usize],
) -> Result<(Vec<usize>, Vec<usize>), FemError> {
    let n_free = free_dof.len();
    let mut col_rows: Vec<Vec<usize>> = Vec::with_capacity(n_free);
    let mut nnz = 0_usize;
    for &dof in free_dof {
        let mut rows = column_rows(dof, neighbors, free_index);
        rows.sort_unstable();
        rows.dedup();
        nnz += rows.len();
        col_rows.push(rows);
    }
    let mut col_ptr = Vec::with_capacity(n_free + 1);
    let mut row_idx = Vec::with_capacity(nnz);
    col_ptr.push(0);
    for rows in col_rows {
        row_idx.extend_from_slice(&rows);
        col_ptr.push(row_idx.len());
    }
    Ok((col_ptr, row_idx))
}

fn column_rows(global_dof: usize, neighbors: &[Vec<u32>], free_index: &[i64]) -> Vec<usize> {
    let node = global_dof / 3;
    let col = free_index[global_dof];
    debug_assert!(col >= 0);
    let col = col as usize;
    let mut rows = Vec::with_capacity(neighbors[node].len() * 3);
    for &nb in &neighbors[node] {
        for axis in 0..3 {
            let other = nb as usize * 3 + axis;
            let slot = free_index[other];
            if slot >= col as i64 {
                rows.push(slot as usize);
            }
        }
    }
    rows
}

fn locate(col_ptr: &[usize], row_idx: &[usize], row: usize, col: usize) -> Result<usize, FemError> {
    let start = col_ptr[col];
    let end = col_ptr[col + 1];
    row_idx[start..end]
        .binary_search(&row)
        .map(|offset| start + offset)
        .map_err(|_| {
            FemError::BadMesh(format!(
                "internal assembly missed the sparse entry ({row}, {col})"
            ))
        })
}
