//! Cholesky fill measured in 64-bit arithmetic.
//!
//! faer sums the symbolic factor in `I::Signed`. For a `usize` matrix that is
//! `isize`, which is `i32` on wasm32. The dense triangle `n(n+1)/2` crosses
//! that limit at 65,536 unknowns, but a sparse factor usually does not. This
//! pass repeats faer's AMD ordering and then counts the nonzero entries of
//! `L` with the elimination tree, accumulating in `u64`, and refuses Cholesky
//! only when that count or AMD's intermediate length sum would not fit.

use super::assemble::LowerCsc;
use super::SolverUsed;
use faer::dyn_stack::{MemBuffer, MemStack};
use faer::perm::PermRef;
use faer::sparse::linalg::amd::{self, Control};
use faer::sparse::utils::permute_self_adjoint_to_unsorted;
use faer::sparse::{FaerError, SparseColMatRef, SymbolicSparseColMatRef};
use faer::Side;

/// What the 64-bit fill pass found, compared with `signed_max`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CholeskyFill {
    /// `nnz` is the number of nonzeros in `L`, diagonal included.
    Fits { nnz: u64 },
    /// An index faer would accumulate does not fit in `signed_max`.
    Overflow { count: u128 },
}

pub(crate) fn cholesky_fill(matrix: &LowerCsc, signed_max: u128) -> CholeskyFill {
    let n = matrix.n;
    if n == 0 {
        return CholeskyFill::Fits { nnz: 0 };
    }
    let diag = n as u128;
    if diag > signed_max {
        return CholeskyFill::Overflow { count: diag };
    }
    match amd_length_sum(matrix) {
        None => {
            return CholeskyFill::Overflow {
                count: signed_max + 1,
            }
        }
        Some(sum) if sum > signed_max => return CholeskyFill::Overflow { count: sum },
        Some(_) => {}
    }
    let Some(upper) = amd_upper_pattern(matrix) else {
        return CholeskyFill::Overflow {
            count: signed_max + 1,
        };
    };
    let nnz = factor_nnz(&upper.0, &upper.1);
    if nnz > signed_max {
        CholeskyFill::Overflow { count: nnz }
    } else {
        CholeskyFill::Fits { nnz: nnz as u64 }
    }
}

pub(crate) fn cholesky_fill_fits(matrix: &LowerCsc, signed_max: u128) -> bool {
    matches!(cholesky_fill(matrix, signed_max), CholeskyFill::Fits { .. })
}

/// Keep a requested Cholesky solve when its real fill fits in `signed_max`.
pub(crate) fn guard_cholesky_index_for(
    choice: SolverUsed,
    matrix: &LowerCsc,
    signed_max: u128,
) -> SolverUsed {
    if choice == SolverUsed::Cholesky && !cholesky_fill_fits(matrix, signed_max) {
        SolverUsed::Pcg
    } else {
        choice
    }
}

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
static TEST_INDEX_LIMIT: AtomicU64 = AtomicU64::new(0);

/// `Some(limit)` makes the production guard compare fill with `limit` instead
/// of `isize::MAX`. `None` restores the production limit. Test only.
#[cfg(test)]
pub(crate) fn set_test_index_limit(limit: Option<u64>) {
    TEST_INDEX_LIMIT.store(limit.unwrap_or(0), Ordering::Relaxed);
}

fn production_index_limit() -> u128 {
    #[cfg(test)]
    {
        let over = TEST_INDEX_LIMIT.load(Ordering::Relaxed);
        if over > 0 {
            return over as u128;
        }
    }
    isize::MAX as u128
}

pub(crate) fn guard_cholesky_index(choice: SolverUsed, matrix: &LowerCsc) -> SolverUsed {
    guard_cholesky_index_for(choice, matrix, production_index_limit())
}

/// Column-length sum of the pattern AMD builds for `A + Aᵀ`.
///
/// faer accumulates this in `I::Signed` and returns `IndexOverflow` when the
/// sum does not fit. `None` means a single column length passed `u64::MAX`,
/// which is past any index we ship.
fn amd_length_sum(matrix: &LowerCsc) -> Option<u128> {
    let n = matrix.n;
    let col_ptr = &matrix.col_ptr;
    let row_idx = &matrix.row_idx;
    // Offset of the next unconsumed row inside each column. faer's `t_p`.
    let mut cursor = vec![0usize; n];
    let mut total = 0u128;
    let add = |total: &mut u128| -> Option<()> {
        *total = total.checked_add(1)?;
        Some(())
    };
    for k in 0..n {
        let mut seen = 0usize;
        let mut j_prev = usize::MAX;
        for p in col_ptr[k]..col_ptr[k + 1] {
            let j = row_idx[p];
            if j_prev == j {
                continue;
            }
            j_prev = j;
            if j < k {
                seen += 1;
                add(&mut total)?;
                add(&mut total)?;
            } else {
                if j == k {
                    seen += 1;
                }
                break;
            }
            let mut seen_j = 0usize;
            let mut i_prev = usize::MAX;
            let start = col_ptr[j] + cursor[j];
            for q in start..col_ptr[j + 1] {
                let i = row_idx[q];
                if i_prev == i {
                    continue;
                }
                i_prev = i;
                if i < k {
                    add(&mut total)?;
                    add(&mut total)?;
                    seen_j += 1;
                } else {
                    if i == k {
                        seen_j += 1;
                    }
                    break;
                }
            }
            cursor[j] += seen_j;
        }
        cursor[k] = seen;
    }
    for j in 0..n {
        let mut i_prev = usize::MAX;
        for q in (col_ptr[j] + cursor[j])..col_ptr[j + 1] {
            let i = row_idx[q];
            if i_prev == i {
                continue;
            }
            i_prev = i;
            add(&mut total)?;
            add(&mut total)?;
        }
    }
    Some(total)
}

/// AMD permutation of the lower pattern, stored as the upper triangle faer
/// then factorizes. `None` when AMD itself reports `IndexOverflow`.
fn amd_upper_pattern(matrix: &LowerCsc) -> Option<(Vec<usize>, Vec<usize>)> {
    let n = matrix.n;
    let nnz = matrix.row_idx.len();
    let symbolic =
        SymbolicSparseColMatRef::<usize>::new_checked(n, n, &matrix.col_ptr, None, &matrix.row_idx);
    let mut perm = vec![0usize; n];
    let mut perm_inv = vec![0usize; n];
    let amd_req = amd::order_maybe_unsorted_scratch::<usize>(n, nnz);
    let mut amd_buf = MemBuffer::try_new(amd_req).ok()?;
    let mut amd_stack = MemStack::new(&mut amd_buf);
    let mat = SparseColMatRef::<usize, f64>::new(symbolic, &matrix.values);
    if let Err(err) = amd::order_maybe_unsorted(
        &mut perm,
        &mut perm_inv,
        mat.symbolic(),
        Control::default(),
        &mut amd_stack,
    ) {
        return match err {
            FaerError::IndexOverflow => None,
            // A non-index failure is left for the numeric call to report.
            _ => Some(identity_upper(matrix)),
        };
    }
    let perm_ref = PermRef::<usize>::new_checked(&perm, &perm_inv, n);
    let mut new_val = vec![0.0; nnz];
    let mut new_col_ptr = vec![0usize; n + 1];
    let mut new_row_idx = vec![0usize; nnz];
    let scratch = faer::dyn_stack::StackReq::new::<usize>(n);
    let mut buf = MemBuffer::try_new(scratch).ok()?;
    let mut stack = MemStack::new(&mut buf);
    permute_self_adjoint_to_unsorted(
        &mut new_val,
        &mut new_col_ptr,
        &mut new_row_idx,
        mat,
        perm_ref,
        Side::Lower,
        Side::Upper,
        &mut stack,
    );
    let kept = new_col_ptr[n];
    new_row_idx.truncate(kept);
    sort_columns(&new_col_ptr, &mut new_row_idx);
    Some((new_col_ptr, new_row_idx))
}

fn sort_columns(col_ptr: &[usize], row_idx: &mut [usize]) {
    let n = col_ptr.len() - 1;
    for col in 0..n {
        row_idx[col_ptr[col]..col_ptr[col + 1]].sort_unstable();
    }
}

fn identity_upper(matrix: &LowerCsc) -> (Vec<usize>, Vec<usize>) {
    let n = matrix.n;
    let mut counts = vec![0usize; n];
    for col in 0..n {
        for p in matrix.col_ptr[col]..matrix.col_ptr[col + 1] {
            let row = matrix.row_idx[p];
            counts[row.max(col)] += 1;
        }
    }
    let mut col_ptr = vec![0usize; n + 1];
    for j in 0..n {
        col_ptr[j + 1] = col_ptr[j] + counts[j];
    }
    let mut row_idx = vec![0usize; col_ptr[n]];
    let mut cursor = col_ptr.clone();
    for col in 0..n {
        for p in matrix.col_ptr[col]..matrix.col_ptr[col + 1] {
            let row = matrix.row_idx[p];
            let (r, c) = if row >= col { (col, row) } else { (row, col) };
            let dest = cursor[c];
            row_idx[dest] = r;
            cursor[c] += 1;
        }
    }
    sort_columns(&col_ptr, &mut row_idx);
    (col_ptr, row_idx)
}

/// Nonzeros in `L`, diagonal included, for an upper CSC pattern.
fn factor_nnz(col_ptr: &[usize], row_idx: &[usize]) -> u128 {
    let n = col_ptr.len() - 1;
    let parent = elimination_tree(n, col_ptr, row_idx);
    let post = postorder(&parent);
    column_counts(n, col_ptr, row_idx, &parent, &post)
        .into_iter()
        .map(|c| c as u128)
        .sum()
}

/// Elimination tree of the upper triangle. `parent[j] == -1` is a root.
fn elimination_tree(n: usize, col_ptr: &[usize], row_idx: &[usize]) -> Vec<i64> {
    let mut parent = vec![-1i64; n];
    let mut ancestor = vec![-1i64; n];
    for k in 0..n {
        let k_i = k as i64;
        for p in col_ptr[k]..col_ptr[k + 1] {
            let mut i = row_idx[p] as i64;
            while i != -1 && i < k_i {
                let next = ancestor[i as usize];
                ancestor[i as usize] = k_i;
                if next == -1 {
                    parent[i as usize] = k_i;
                }
                i = next;
            }
        }
    }
    parent
}

fn postorder(parent: &[i64]) -> Vec<usize> {
    let n = parent.len();
    let mut head = vec![-1i64; n];
    let mut next = vec![-1i64; n];
    for j in (0..n).rev() {
        let p = parent[j];
        if p == -1 {
            continue;
        }
        next[j] = head[p as usize];
        head[p as usize] = j as i64;
    }
    let mut post = vec![0usize; n];
    let mut stack = Vec::with_capacity(n);
    let mut k = 0usize;
    for j in 0..n {
        if parent[j] != -1 {
            continue;
        }
        stack.clear();
        stack.push(j as i64);
        while let Some(&node) = stack.last() {
            let child = head[node as usize];
            if child == -1 {
                stack.pop();
                post[k] = node as usize;
                k += 1;
            } else {
                head[node as usize] = next[child as usize];
                stack.push(child);
            }
        }
    }
    debug_assert_eq!(k, n);
    post
}

/// Gilbert–Ng–Peyton column counts. Each entry is at most `n`.
fn column_counts(
    n: usize,
    col_ptr: &[usize],
    row_idx: &[usize],
    parent: &[i64],
    post: &[usize],
) -> Vec<u64> {
    let (at_ptr, at_idx) = transpose(n, col_ptr, row_idx);
    let mut first = vec![-1i64; n];
    let mut maxfirst = vec![-1i64; n];
    let mut prevleaf = vec![-1i64; n];
    let mut ancestor = vec![0i64; n];
    let mut delta = vec![0i64; n];
    for k in 0..n {
        let mut j = post[k] as i64;
        delta[j as usize] = if first[j as usize] == -1 { 1 } else { 0 };
        while j != -1 && first[j as usize] == -1 {
            first[j as usize] = k as i64;
            j = parent[j as usize];
        }
    }
    for i in 0..n {
        ancestor[i] = i as i64;
    }
    for k in 0..n {
        let j = post[k];
        if parent[j] != -1 {
            delta[parent[j] as usize] -= 1;
        }
        for p in at_ptr[j]..at_ptr[j + 1] {
            let i = at_idx[p] as i64;
            let (jleaf, q) = leaf(
                i,
                j as i64,
                &first,
                &mut maxfirst,
                &mut prevleaf,
                &mut ancestor,
            );
            if jleaf >= 1 {
                delta[j] += 1;
            }
            if jleaf == 2 {
                delta[q as usize] -= 1;
            }
        }
        if parent[j] != -1 {
            ancestor[j] = parent[j];
        }
    }
    let mut colcount = delta;
    for j in 0..n {
        if parent[j] != -1 {
            let parent_j = parent[j] as usize;
            colcount[parent_j] += colcount[j];
        }
    }
    colcount
        .into_iter()
        .map(|c| {
            debug_assert!(c > 0);
            c as u64
        })
        .collect()
}

fn leaf(
    i: i64,
    j: i64,
    first: &[i64],
    maxfirst: &mut [i64],
    prevleaf: &mut [i64],
    ancestor: &mut [i64],
) -> (i32, i64) {
    if i <= j || first[j as usize] <= maxfirst[i as usize] {
        return (0, -1);
    }
    maxfirst[i as usize] = first[j as usize];
    let jprev = prevleaf[i as usize];
    prevleaf[i as usize] = j;
    if jprev == -1 {
        return (1, i);
    }
    let mut q = jprev;
    while q != ancestor[q as usize] {
        q = ancestor[q as usize];
    }
    let mut s = jprev;
    while s != q {
        let sparent = ancestor[s as usize];
        ancestor[s as usize] = q;
        s = sparent;
    }
    (2, q)
}

fn transpose(n: usize, col_ptr: &[usize], row_idx: &[usize]) -> (Vec<usize>, Vec<usize>) {
    let mut counts = vec![0usize; n];
    for &row in row_idx {
        counts[row] += 1;
    }
    let mut at_ptr = vec![0usize; n + 1];
    for i in 0..n {
        at_ptr[i + 1] = at_ptr[i] + counts[i];
    }
    let mut at_idx = vec![0usize; row_idx.len()];
    let mut cursor = at_ptr.clone();
    for col in 0..n {
        for p in col_ptr[col]..col_ptr[col + 1] {
            let row = row_idx[p];
            let dest = cursor[row];
            at_idx[dest] = col;
            cursor[row] += 1;
        }
    }
    (at_ptr, at_idx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use faer::sparse::linalg::cholesky::simplicial::prefactorize_symbolic_cholesky;

    fn lower_from_edges(n: usize, edges: &[(usize, usize)]) -> LowerCsc {
        let mut rows = vec![Vec::new(); n];
        for i in 0..n {
            rows[i].push(i);
        }
        for &(a, b) in edges {
            let (row, col) = if a >= b { (a, b) } else { (b, a) };
            rows[col].push(row);
        }
        for list in &mut rows {
            list.sort_unstable();
            list.dedup();
        }
        let mut col_ptr = Vec::with_capacity(n + 1);
        let mut row_idx = Vec::new();
        col_ptr.push(0);
        for list in &rows {
            row_idx.extend_from_slice(list);
            col_ptr.push(row_idx.len());
        }
        let nnz = row_idx.len();
        LowerCsc {
            n,
            col_ptr,
            row_idx,
            values: vec![1.0; nnz],
            diag: vec![1.0; n],
        }
    }

    fn faer_nnz(col_ptr: &[usize], row_idx: &[usize]) -> u128 {
        let n = col_ptr.len() - 1;
        let symbolic = SymbolicSparseColMatRef::<usize>::new_checked(n, n, col_ptr, None, row_idx);
        let mut etree = vec![0isize; n];
        let mut counts = vec![0usize; n];
        let scratch =
            faer::sparse::linalg::cholesky::simplicial::prefactorize_symbolic_cholesky_scratch::<
                usize,
            >(n, row_idx.len());
        let mut buf = MemBuffer::try_new(scratch).unwrap();
        let mut stack = MemStack::new(&mut buf);
        prefactorize_symbolic_cholesky::<usize>(&mut etree, &mut counts, symbolic, &mut stack);
        counts.iter().map(|&c| c as u128).sum()
    }

    #[test]
    fn dense_and_tridiagonal_fill_match_the_closed_form() {
        let dense = lower_from_edges(6, &{
            let mut e = Vec::new();
            for i in 0..6 {
                for j in 0..i {
                    e.push((i, j));
                }
            }
            e
        });
        match cholesky_fill(&dense, i32::MAX as u128) {
            CholeskyFill::Fits { nnz } => assert_eq!(nnz, 21),
            other => panic!("dense 6 should fit, got {other:?}"),
        }
        let mut band = Vec::new();
        for i in 1..8 {
            band.push((i, i - 1));
        }
        let tri = lower_from_edges(8, &band);
        match cholesky_fill(&tri, i32::MAX as u128) {
            CholeskyFill::Fits { nnz } => assert_eq!(nnz, 15),
            other => panic!("tridiagonal should not fill, got {other:?}"),
        }
    }

    #[test]
    fn column_counts_match_faer_on_the_amd_pattern() {
        let mut edges = Vec::new();
        for i in 0..12 {
            for j in 0..i {
                if (i + 3 * j) % 4 != 0 {
                    edges.push((i, j));
                }
            }
        }
        let matrix = lower_from_edges(12, &edges);
        let upper = amd_upper_pattern(&matrix).unwrap();
        let ours = factor_nnz(&upper.0, &upper.1);
        let faer = faer_nnz(&upper.0, &upper.1);
        assert_eq!(ours, faer);
    }
}
