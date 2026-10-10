//! Stiffness and consistent mass on the same free-DOF sparsity pattern.

use super::assemble::LowerCsc;
use super::FemError;

pub struct Km {
    pub stiffness: LowerCsc,
    pub mass: LowerCsc,
}

/// Assemble element stiffness and mass into matching symmetric CSC matrices.
///
/// `element_km` returns two full `n_local × n_local` matrices, row-major.
/// Only the triangle `local_row >= local_col` is read, which is how the
/// static assembler reads a symmetric element matrix. `local` indexes
/// `node_in_element * dof_per_node + component`.
pub fn assemble_pair<const N: usize>(
    n_nodes: usize,
    dof_per_node: usize,
    elements: &[[u32; N]],
    fixed: &[bool],
    mut element_km: impl FnMut(usize, &[u32; N]) -> Result<[Vec<f64>; 2], FemError>,
) -> Result<Km, FemError> {
    let n_dof = n_nodes * dof_per_node;
    if fixed.len() != n_dof {
        return Err(FemError::BadLoad(
            "the fixture list does not match the degrees of freedom".into(),
        ));
    }
    let (free_index, free_dof) = free_maps(fixed);
    let n_free = free_dof.len();
    if n_free == 0 {
        return Err(FemError::BadLoad(
            "every degree of freedom is fixed, so there is no mode to find".into(),
        ));
    }
    let neighbors = node_neighbors(n_nodes, elements);
    let (col_ptr, row_idx) = sparsity(dof_per_node, &neighbors, &free_index, &free_dof)?;
    let mut k_values = vec![0.0; row_idx.len()];
    let mut m_values = vec![0.0; row_idx.len()];
    let n_local = N * dof_per_node;

    for (e, elem) in elements.iter().enumerate() {
        let [ke, me] = element_km(e, elem)?;
        if ke.len() != n_local * n_local || me.len() != n_local * n_local {
            return Err(FemError::Solver(
                "an element matrix does not match its connectivity".into(),
            ));
        }
        for li in 0..n_local {
            let gi = elem[li / dof_per_node] as usize * dof_per_node + (li % dof_per_node);
            for lj in 0..=li {
                let gj = elem[lj / dof_per_node] as usize * dof_per_node + (lj % dof_per_node);
                let k = ke[li * n_local + lj];
                let m = me[li * n_local + lj];
                let ii = free_index[gi];
                let jj = free_index[gj];
                if ii >= 0 && jj >= 0 {
                    let (row, col) = if ii >= jj {
                        (ii as usize, jj as usize)
                    } else {
                        (jj as usize, ii as usize)
                    };
                    let pos = locate(&col_ptr, &row_idx, row, col)?;
                    k_values[pos] += k;
                    m_values[pos] += m;
                }
            }
        }
    }

    let k_diag = diagonal(&col_ptr, &row_idx, &k_values);
    let m_diag = diagonal(&col_ptr, &row_idx, &m_values);
    for col in 0..n_free {
        if !(k_diag[col].is_finite() && k_diag[col] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "free DOF {col} has a non-positive stiffness diagonal ({})",
                k_diag[col]
            )));
        }
        if !(m_diag[col].is_finite() && m_diag[col] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "free DOF {col} has a non-positive mass diagonal ({})",
                m_diag[col]
            )));
        }
    }

    Ok(Km {
        stiffness: LowerCsc {
            n: n_free,
            col_ptr: col_ptr.clone(),
            row_idx: row_idx.clone(),
            values: k_values,
            diag: k_diag,
        },
        mass: LowerCsc {
            n: n_free,
            col_ptr,
            row_idx,
            values: m_values,
            diag: m_diag,
        },
    })
}

fn diagonal(col_ptr: &[usize], row_idx: &[usize], values: &[f64]) -> Vec<f64> {
    let n = col_ptr.len() - 1;
    let mut diag = vec![0.0; n];
    for col in 0..n {
        for p in col_ptr[col]..col_ptr[col + 1] {
            if row_idx[p] == col {
                diag[col] = values[p];
                break;
            }
        }
    }
    diag
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

fn node_neighbors<const N: usize>(n_nodes: usize, elements: &[[u32; N]]) -> Vec<Vec<u32>> {
    let mut neighbors = vec![Vec::new(); n_nodes];
    for elem in elements {
        let mut uniq = *elem;
        uniq.sort_unstable();
        let mut last = u32::MAX;
        let mut nodes = [0_u32; N];
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
    dof_per_node: usize,
    neighbors: &[Vec<u32>],
    free_index: &[i64],
    free_dof: &[usize],
) -> Result<(Vec<usize>, Vec<usize>), FemError> {
    let mut col_ptr = Vec::with_capacity(free_dof.len() + 1);
    let mut row_idx = Vec::new();
    col_ptr.push(0);
    for &dof in free_dof {
        let mut rows = column_rows(dof, dof_per_node, neighbors, free_index);
        rows.sort_unstable();
        rows.dedup();
        row_idx.extend_from_slice(&rows);
        col_ptr.push(row_idx.len());
    }
    Ok((col_ptr, row_idx))
}

fn column_rows(
    global_dof: usize,
    dof_per_node: usize,
    neighbors: &[Vec<u32>],
    free_index: &[i64],
) -> Vec<usize> {
    let node = global_dof / dof_per_node;
    let col = free_index[global_dof];
    debug_assert!(col >= 0);
    let col = col as usize;
    let mut rows = Vec::with_capacity(neighbors[node].len() * dof_per_node);
    for &nb in &neighbors[node] {
        for axis in 0..dof_per_node {
            let other = nb as usize * dof_per_node + axis;
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
