//! Supernodal sparse Cholesky (faer) and Jacobi-preconditioned CG.
//!
//! Both run single-threaded. faer is built without its rayon feature, and the
//! factorization asks for [`faer::Par::Seq`].
//!
//! faer sums the symbolic factor in `I::Signed`. For a `usize` matrix that is
//! `isize`, which is `i32` in the wasm32 build, so a fill count past
//! `i32::MAX` is `FaerError::IndexOverflow`. The static solver counts that
//! fill in 64-bit arithmetic first and uses PCG when the real factor, or
//! AMD's intermediate length sum, would not fit. This mapping is the backstop
//! when the symbolic factorization still reports the overflow.

use super::assemble::LowerCsc;
use super::FemError;
use faer::dyn_stack::{MemBuffer, MemStack};
use faer::mat::AsMatMut;
use faer::sparse::linalg::cholesky::{
    factorize_symbolic_cholesky, CholeskySymbolicParams, LltRef, SymbolicCholesky,
    SymbolicCholeskyRaw, SymmetricOrdering,
};
use faer::sparse::linalg::SupernodalThreshold;
use faer::sparse::FaerError;
use faer::sparse::{SparseColMat, SymbolicSparseColMat};
use faer::{Conj, Mat, Par, Side};

fn symbolic_cholesky_error(err: FaerError) -> FemError {
    match err {
        FaerError::IndexOverflow => FemError::CholeskyIndexLimit,
        other => FemError::Solver(format!("symbolic Cholesky failed: {other}")),
    }
}

/// Supernodal Cholesky factor of one symmetric positive-definite matrix.
///
/// Built once and then applied to many right-hand sides. Modal analysis uses
/// it as the shift-invert operator. The static solver uses one solve.
pub struct SupernodalFactor {
    symbolic: SymbolicCholesky<usize>,
    values: Vec<f64>,
    scratch: MemBuffer,
}

impl SupernodalFactor {
    pub fn factorize(matrix: &LowerCsc) -> Result<Self, FemError> {
        let n = matrix.n;
        let symbolic = SymbolicSparseColMat::<usize>::new_checked(
            n,
            n,
            matrix.col_ptr.clone(),
            None,
            matrix.row_idx.clone(),
        );
        let mat = SparseColMat::<usize, f64>::new(symbolic, matrix.values.clone());
        let params = CholeskySymbolicParams {
            supernodal_flop_ratio_threshold: SupernodalThreshold::FORCE_SUPERNODAL,
            ..CholeskySymbolicParams::default()
        };
        let mut symbolic = factorize_symbolic_cholesky(
            mat.symbolic(),
            Side::Lower,
            SymmetricOrdering::Amd,
            params,
        )
        .map_err(symbolic_cholesky_error)?;
        // AMD's flop estimate is zero on a diagonal pattern, and faer then
        // keeps a simplicial factor even when the threshold asks for a
        // supernode. Identity ordering counts the same pattern and selects
        // the supernodal factor. Meshes with fill stay on AMD.
        if !matches!(symbolic.raw(), SymbolicCholeskyRaw::Supernodal(_)) {
            symbolic = factorize_symbolic_cholesky(
                mat.symbolic(),
                Side::Lower,
                SymmetricOrdering::Identity,
                params,
            )
            .map_err(symbolic_cholesky_error)?;
        }
        if !matches!(symbolic.raw(), SymbolicCholeskyRaw::Supernodal(_)) {
            return Err(FemError::Solver(
                "faer selected a simplicial factor; this solver requires the supernodal Cholesky"
                    .into(),
            ));
        }
        let mut values = vec![0.0; symbolic.len_val()];
        let par = Par::Seq;
        let scratch = symbolic.factorize_numeric_llt_scratch::<f64>(par, Default::default());
        let mut buffer = MemBuffer::try_new(scratch)
            .map_err(|_| FemError::Solver("not enough memory for the Cholesky factor".into()))?;
        {
            let mut stack = MemStack::new(&mut buffer);
            symbolic
                .factorize_numeric_llt(
                    &mut values,
                    mat.as_ref(),
                    Side::Lower,
                    Default::default(),
                    par,
                    &mut stack,
                    Default::default(),
                )
                .map_err(|err| {
                    FemError::NotSpd(format!(
                        "supernodal Cholesky failed ({err}); the system is not positive definite, which usually means a rigid-body mode is still free"
                    ))
                })?;
        }
        let solve_scratch = symbolic.solve_in_place_scratch::<f64>(1, par);
        let scratch = MemBuffer::try_new(solve_scratch)
            .map_err(|_| FemError::Solver("not enough memory for the Cholesky solve".into()))?;
        Ok(Self {
            symbolic,
            values,
            scratch,
        })
    }

    /// Number of stored factor entries. Eight bytes each, plus the index.
    pub fn value_count(&self) -> usize {
        self.values.len()
    }

    pub fn solve_into(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), FemError> {
        let n = rhs.len();
        if out.len() != n || self.symbolic.nrows() != n {
            return Err(FemError::Solver(
                "Cholesky right-hand side does not match the factor".into(),
            ));
        }
        let mut rhs_mat = Mat::<f64>::from_fn(n, 1, |i, _| rhs[i]);
        let par = Par::Seq;
        {
            let SupernodalFactor {
                symbolic,
                values,
                scratch,
            } = self;
            let llt = LltRef::new(symbolic, values);
            let mut stack = MemStack::new(scratch);
            llt.solve_in_place_with_conj(Conj::No, rhs_mat.as_mat_mut(), par, &mut stack);
        }
        for i in 0..n {
            out[i] = rhs_mat[(i, 0)];
            if !out[i].is_finite() {
                return Err(FemError::Solver(
                    "Cholesky produced a non-finite vector".into(),
                ));
            }
        }
        Ok(())
    }
}

pub fn supernodal_cholesky(matrix: &LowerCsc, rhs: &[f64]) -> Result<Vec<f64>, FemError> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(FemError::Solver(
            "Cholesky right-hand side does not match the matrix".into(),
        ));
    }
    let mut factor = SupernodalFactor::factorize(matrix)?;
    let mut out = vec![0.0; n];
    factor.solve_into(rhs, &mut out)?;
    Ok(out)
}

/// Jacobi-preconditioned conjugate gradient.
///
/// Stops when `||r|| / ||b|| < tol` or when `max_iter` is exhausted.
/// Returns `(x, iterations, relative residual)`.
pub fn pcg(
    matrix: &LowerCsc,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
) -> Result<(Vec<f64>, usize, f64), FemError> {
    let n = matrix.n;
    let mut x = vec![0.0; n];
    if n == 0 {
        return Ok((x, 0, 0.0));
    }
    let bnorm = norm(rhs);
    if bnorm == 0.0 {
        return Ok((x, 0, 0.0));
    }
    let mut r = rhs.to_vec();
    let mut z = vec![0.0; n];
    apply_jacobi(&matrix.diag, &r, &mut z)?;
    let mut p = z.clone();
    let mut rho = dot(&r, &z);
    let mut ap = vec![0.0; n];
    let mut rel = 1.0;
    for iter in 1..=max_iter {
        matrix.sym_matvec(&p, &mut ap);
        let pap = dot(&p, &ap);
        if !(pap.is_finite() && pap > 0.0) {
            return Err(FemError::NotSpd(
                "PCG curvature p·Kp is not positive; the system is not positive definite".into(),
            ));
        }
        let alpha = rho / pap;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        rel = norm(&r) / bnorm;
        if rel < tol {
            if x.iter().any(|v| !v.is_finite()) {
                return Err(FemError::Solver(
                    "PCG produced a non-finite displacement".into(),
                ));
            }
            return Ok((x, iter, rel));
        }
        apply_jacobi(&matrix.diag, &r, &mut z)?;
        let rho_new = dot(&r, &z);
        if !rho_new.is_finite() {
            return Err(FemError::Solver(
                "PCG produced a non-finite search direction".into(),
            ));
        }
        let beta = rho_new / rho;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        rho = rho_new;
    }
    Err(FemError::NotConverged {
        iterations: max_iter,
        residual: rel,
    })
}

fn apply_jacobi(diag: &[f64], r: &[f64], z: &mut [f64]) -> Result<(), FemError> {
    for i in 0..diag.len() {
        if !(diag[i].is_finite() && diag[i] > 0.0) {
            return Err(FemError::NotSpd(format!(
                "Jacobi preconditioner has a non-positive diagonal at DOF {i}"
            )));
        }
        z[i] = r[i] / diag[i];
    }
    Ok(())
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut sum = 0.0;
    for i in 0..a.len() {
        sum += a[i] * b[i];
    }
    sum
}

fn norm(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}
