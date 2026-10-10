//! Lowest modes of a symmetric generalized pencil `K φ = λ M φ`.
//!
//! The iteration is a locally optimal block preconditioned conjugate gradient
//! (LOBPCG) step: the trial space is the current block, the preconditioned
//! residual, and the previous search direction. The preconditioner is one
//! supernodal Cholesky factorization of `K − σ M`. A zero shift is used when
//! `K` is positive definite. A free-free model makes `K` singular, so `σ` is
//! a small negative multiple of a diagonal Rayleigh quotient and `K − σ M`
//! stays positive definite. The eigenvalues that are returned are those of
//! the original pencil, not of the shifted matrix.
//!
//! The small projected problem is a Jacobi symmetric eigensolver. Both pieces
//! are the published algorithms, written here. Nothing in this module is
//! taken from a GPL or AGPL library.

use super::assemble::LowerCsc;
use super::linear::SupernodalFactor;
use super::FemError;

/// Result of one modal factorization.
pub struct Spectrum {
    /// `ω²` in rad²/s², ascending, one per returned mode.
    pub eigenvalues: Vec<f64>,
    /// Mass-normalized eigenvectors, column-major (`i + mode * n`).
    pub vectors: Vec<f64>,
    pub iterations: usize,
    /// Largest matrix-scaled residual of the returned modes.
    pub residual: f64,
    /// Shift used in `K − σ M`. Zero when `K` itself factored.
    pub shift: f64,
    /// Stored Cholesky entries, for a memory report.
    pub factor_entries: usize,
}

const DEFAULT_TOL: f64 = 1.0e-6;
const DEFAULT_MAX_ITER: usize = 48;

/// Lowest `k` eigenpairs. `k` is clamped to the matrix order by the caller.
pub fn lowest_modes(stiffness: &LowerCsc, mass: &LowerCsc, k: usize) -> Result<Spectrum, FemError> {
    let n = stiffness.n;
    if mass.n != n {
        return Err(FemError::Solver(
            "stiffness and mass have different free-DOF counts".into(),
        ));
    }
    if k == 0 || k > n {
        return Err(FemError::BadLoad(format!(
            "modal analysis asked for {k} modes on {n} free degrees of freedom"
        )));
    }
    let (mut factor, shift) = factor_shifted(stiffness, mass)?;
    let mut x = random_block(n, k, 0x5EED_u64);
    x = m_orthonormalize(x, mass);
    if x.len() < k {
        return Err(FemError::Solver(
            "the mass matrix could not orthonormalize the starting block".into(),
        ));
    }
    let mut direction: Vec<Vec<f64>> = Vec::new();
    let mut residual = f64::MAX;
    let mut eigenvalues = vec![0.0; k];
    let mut iterations = 0;
    for iter in 1..=DEFAULT_MAX_ITER {
        iterations = iter;
        let kx = apply_columns(stiffness, &x);
        let (_theta, coeff) = jacobi_eigen(&gram(&x, &kx), x.len());
        x = rotate_columns(&x, &coeff, k);
        x = m_orthonormalize(x, mass);
        if x.len() < k {
            return Err(FemError::NotConverged {
                iterations: iter,
                residual,
            });
        }
        let kx = apply_columns(stiffness, &x);
        let mx = apply_columns(mass, &x);
        for j in 0..k {
            eigenvalues[j] = dot(&x[j], &kx[j]);
        }
        let mut residuals = Vec::with_capacity(k);
        let mut worst = 0.0_f64;
        for j in 0..k {
            let rel = pair_residual(&kx[j], &mx[j], eigenvalues[j], stiffness, &x[j]);
            worst = worst.max(rel);
            residuals.push(rel);
        }
        residual = worst;
        if residuals.iter().all(|rel| *rel < DEFAULT_TOL) {
            break;
        }
        let mut preconditioned = Vec::with_capacity(k);
        for j in 0..k {
            let mut r = vec![0.0; n];
            for i in 0..n {
                r[i] = kx[j][i] - eigenvalues[j] * mx[j][i];
            }
            let mut w = vec![0.0; n];
            factor.solve_into(&r, &mut w)?;
            preconditioned.push(w);
        }
        let mut extra = preconditioned;
        extra.extend(direction.drain(..));
        let q = m_orthogonalize_against(extra, &x, mass);
        if q.is_empty() {
            if iter == DEFAULT_MAX_ITER {
                break;
            }
            continue;
        }
        let mut basis = x.clone();
        let n_x = basis.len();
        basis.extend(q.iter().cloned());
        let kb = apply_columns(stiffness, &basis);
        let (theta, coeff) = jacobi_eigen(&gram(&basis, &kb), basis.len());
        let n_s = basis.len();
        let mut x_new = vec![vec![0.0; n]; k];
        let mut p_new = vec![vec![0.0; n]; k];
        for mode in 0..k {
            eigenvalues[mode] = theta[mode];
            for i in 0..n {
                let mut acc_x = 0.0;
                let mut acc_p = 0.0;
                for col in 0..n_s {
                    let c = coeff[col + mode * n_s];
                    acc_x += c * basis[col][i];
                    if col >= n_x {
                        acc_p += c * basis[col][i];
                    }
                }
                x_new[mode][i] = acc_x;
                p_new[mode][i] = acc_p;
            }
        }
        x = m_orthonormalize(x_new, mass);
        direction = m_orthonormalize(p_new, mass);
        if x.len() < k {
            return Err(FemError::NotConverged {
                iterations: iter,
                residual,
            });
        }
    }
    // One more Rayleigh quotient on the returned, reorthonormalized block.
    let kx = apply_columns(stiffness, &x);
    for j in 0..k {
        eigenvalues[j] = dot(&x[j], &kx[j]);
    }
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by(|&a, &b| {
        eigenvalues[a]
            .partial_cmp(&eigenvalues[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let eigenvalues: Vec<f64> = order.iter().map(|&j| eigenvalues[j]).collect();
    let mut vectors = vec![0.0; n * k];
    for (slot, &j) in order.iter().enumerate() {
        vectors[slot * n..(slot + 1) * n].copy_from_slice(&x[j]);
    }
    let mx = {
        let cols: Vec<Vec<f64>> = order.iter().map(|&j| x[j].clone()).collect();
        apply_columns(mass, &cols)
    };
    let mut worst = 0.0_f64;
    for j in 0..k {
        let rel = pair_residual(
            &apply_one(stiffness, &vectors[j * n..(j + 1) * n]),
            &mx[j],
            eigenvalues[j],
            stiffness,
            &vectors[j * n..(j + 1) * n],
        );
        worst = worst.max(rel);
    }
    if !(worst < DEFAULT_TOL * 50.0) && worst > 1.0e-3 {
        return Err(FemError::NotConverged {
            iterations,
            residual: worst,
        });
    }
    Ok(Spectrum {
        eigenvalues,
        vectors,
        iterations,
        residual: worst,
        shift,
        factor_entries: factor.value_count(),
    })
}

fn factor_shifted(
    stiffness: &LowerCsc,
    mass: &LowerCsc,
) -> Result<(SupernodalFactor, f64), FemError> {
    if let Ok(factor) = SupernodalFactor::factorize(stiffness) {
        return Ok((factor, 0.0));
    }
    let mut ratios = Vec::new();
    for i in 0..stiffness.n {
        if mass.diag[i] > 0.0 && stiffness.diag[i] > 0.0 {
            ratios.push(stiffness.diag[i] / mass.diag[i]);
        }
    }
    if ratios.is_empty() {
        return Err(FemError::NotSpd(
            "the stiffness matrix is singular and has no positive diagonal to shift against"
                .into(),
        ));
    }
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let scale = ratios[ratios.len() / 2];
    let mut last = FemError::NotSpd("shift-invert factorization did not start".into());
    for exp in [8, 6, 5, 4, 3] {
        let sigma = -scale * 10_f64.powi(-exp);
        match SupernodalFactor::factorize(&shifted(stiffness, mass, sigma)) {
            Ok(factor) => return Ok((factor, sigma)),
            Err(err) => last = err,
        }
    }
    Err(last)
}

fn shifted(stiffness: &LowerCsc, mass: &LowerCsc, sigma: f64) -> LowerCsc {
    let mut values = stiffness.values.clone();
    for (value, mass_value) in values.iter_mut().zip(&mass.values) {
        *value -= sigma * *mass_value;
    }
    let mut diag = stiffness.diag.clone();
    for (value, mass_value) in diag.iter_mut().zip(&mass.diag) {
        *value -= sigma * *mass_value;
    }
    LowerCsc {
        n: stiffness.n,
        col_ptr: stiffness.col_ptr.clone(),
        row_idx: stiffness.row_idx.clone(),
        values,
        diag,
    }
}

fn pair_residual(kx: &[f64], mx: &[f64], lambda: f64, stiffness: &LowerCsc, x: &[f64]) -> f64 {
    let mut num = 0.0;
    let mut x2 = 0.0;
    for i in 0..kx.len() {
        let r = kx[i] - lambda * mx[i];
        num += r * r;
        x2 += x[i] * x[i];
    }
    let k_scale = stiffness
        .diag
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    let scale = k_scale * x2.sqrt().max(1e-30);
    num.sqrt() / scale
}

fn apply_one(matrix: &LowerCsc, x: &[f64]) -> Vec<f64> {
    let mut y = vec![0.0; x.len()];
    matrix.sym_matvec(x, &mut y);
    y
}

fn apply_columns(matrix: &LowerCsc, columns: &[Vec<f64>]) -> Vec<Vec<f64>> {
    columns.iter().map(|column| apply_one(matrix, column)).collect()
}

fn gram(columns: &[Vec<f64>], images: &[Vec<f64>]) -> Vec<f64> {
    let m = columns.len();
    let mut g = vec![0.0; m * m];
    for j in 0..m {
        for i in 0..=j {
            let dot = dot(&columns[i], &images[j]);
            g[i * m + j] = dot;
            g[j * m + i] = dot;
        }
    }
    g
}

fn rotate_columns(columns: &[Vec<f64>], coeff: &[f64], k: usize) -> Vec<Vec<f64>> {
    let n = columns[0].len();
    let m = columns.len();
    let take = k.min(m);
    let mut out = vec![vec![0.0; n]; take];
    for mode in 0..take {
        for col in 0..m {
            let c = coeff[col + mode * m];
            let src = &columns[col];
            let dst = &mut out[mode];
            for i in 0..n {
                dst[i] += c * src[i];
            }
        }
    }
    out
}

fn m_orthonormalize(columns: Vec<Vec<f64>>, mass: &LowerCsc) -> Vec<Vec<f64>> {
    let mut kept: Vec<Vec<f64>> = Vec::new();
    let mut images: Vec<Vec<f64>> = Vec::new();
    let mass_scale = mass
        .diag
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()))
        .sqrt();
    for column in columns {
        let mut w = column;
        for _pass in 0..2 {
            for (q, mq) in kept.iter().zip(images.iter()) {
                let proj = dot(&w, mq);
                axpy(-proj, q, &mut w);
            }
        }
        let mut mw = vec![0.0; w.len()];
        mass.sym_matvec(&w, &mut mw);
        let nrm2 = dot(&w, &mw);
        let eu = dot(&w, &w).sqrt();
        let floor = 1e-10 * eu * mass_scale.max(1e-30);
        if !(nrm2.is_finite() && nrm2.sqrt() > floor) {
            continue;
        }
        let nrm = nrm2.sqrt();
        for value in &mut w {
            *value /= nrm;
        }
        for value in &mut mw {
            *value /= nrm;
        }
        kept.push(w);
        images.push(mw);
    }
    kept
}

fn m_orthogonalize_against(
    columns: Vec<Vec<f64>>,
    against: &[Vec<f64>],
    mass: &LowerCsc,
) -> Vec<Vec<f64>> {
    let mut images: Vec<Vec<f64>> = against
        .iter()
        .map(|column| apply_one(mass, column))
        .collect();
    let mut kept = against.to_vec();
    let mut fresh = Vec::new();
    let mass_scale = mass
        .diag
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()))
        .sqrt();
    for column in columns {
        let mut w = column;
        for _pass in 0..2 {
            for (q, mq) in kept.iter().zip(images.iter()) {
                let proj = dot(&w, mq);
                axpy(-proj, q, &mut w);
            }
        }
        let mut mw = vec![0.0; w.len()];
        mass.sym_matvec(&w, &mut mw);
        let nrm2 = dot(&w, &mw);
        let eu = dot(&w, &w).sqrt();
        let floor = 1e-8 * eu * mass_scale.max(1e-30);
        if !(nrm2.is_finite() && nrm2.sqrt() > floor) {
            continue;
        }
        let nrm = nrm2.sqrt();
        for value in &mut w {
            *value /= nrm;
        }
        for value in &mut mw {
            *value /= nrm;
        }
        fresh.push(w.clone());
        kept.push(w);
        images.push(mw);
    }
    fresh
}

fn random_block(n: usize, m: usize, mut state: u64) -> Vec<Vec<f64>> {
    let mut columns = Vec::with_capacity(m);
    for _ in 0..m {
        let mut column = vec![0.0; n];
        for value in &mut column {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let unit = (state >> 11) as f64 / ((1_u64 << 53) as f64);
            *value = unit * 2.0 - 1.0;
        }
        columns.push(column);
    }
    columns
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut sum = 0.0;
    for i in 0..a.len() {
        sum += a[i] * b[i];
    }
    sum
}

fn axpy(alpha: f64, x: &[f64], y: &mut [f64]) {
    for i in 0..y.len() {
        y[i] += alpha * x[i];
    }
}

/// Symmetric Jacobi. Returns eigenvalues ascending and orthonormal
/// eigenvectors, column-major, so column `j` is `coeff[j * n ..]`.
fn jacobi_eigen(matrix: &[f64], n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut a = matrix.to_vec();
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i + i * n] = 1.0;
    }
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    if n == 1 {
        return (vec![a[0]], vec![1.0]);
    }
    let mut scale = 0.0_f64;
    for value in &a {
        scale = scale.max(value.abs());
    }
    scale = scale.max(1.0);
    for _sweep in 0..48 {
        let mut off = 0.0;
        for p in 0..n {
            for q in (p + 1)..n {
                let apq = a[p * n + q];
                off += apq * apq;
                if apq.abs() <= 1e-15 * scale {
                    continue;
                }
                let app = a[p * n + p];
                let aqq = a[q * n + q];
                let tau = (aqq - app) / (2.0 * apq);
                let t = if tau >= 0.0 {
                    1.0 / (tau + (1.0 + tau * tau).sqrt())
                } else {
                    -1.0 / (-tau + (1.0 + tau * tau).sqrt())
                };
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = t * c;
                for k in 0..n {
                    if k == p || k == q {
                        continue;
                    }
                    let aik = a[p * n + k];
                    let aqk = a[q * n + k];
                    let new_p = c * aik - s * aqk;
                    let new_q = s * aik + c * aqk;
                    a[p * n + k] = new_p;
                    a[k * n + p] = new_p;
                    a[q * n + k] = new_q;
                    a[k * n + q] = new_q;
                }
                let new_pp = c * c * app - 2.0 * s * c * apq + s * s * aqq;
                let new_qq = s * s * app + 2.0 * s * c * apq + c * c * aqq;
                a[p * n + p] = new_pp;
                a[q * n + q] = new_qq;
                a[p * n + q] = 0.0;
                a[q * n + p] = 0.0;
                for row in 0..n {
                    let vp = v[row + p * n];
                    let vq = v[row + q * n];
                    v[row + p * n] = c * vp - s * vq;
                    v[row + q * n] = s * vp + c * vq;
                }
            }
        }
        if off.sqrt() <= 1e-14 * scale {
            break;
        }
    }
    let mut evals: Vec<(f64, usize)> = (0..n).map(|i| (a[i * n + i], i)).collect();
    evals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut values = Vec::with_capacity(n);
    let mut vectors = vec![0.0; n * n];
    for (slot, (value, src)) in evals.into_iter().enumerate() {
        values.push(value);
        for row in 0..n {
            vectors[row + slot * n] = v[row + src * n];
        }
    }
    (values, vectors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagonal(diag: &[f64]) -> LowerCsc {
        let n = diag.len();
        let mut col_ptr = Vec::with_capacity(n + 1);
        let mut row_idx = Vec::with_capacity(n);
        col_ptr.push(0);
        for i in 0..n {
            row_idx.push(i);
            col_ptr.push(i + 1);
        }
        LowerCsc {
            n,
            col_ptr,
            row_idx,
            values: diag.to_vec(),
            diag: diag.to_vec(),
        }
    }

    #[test]
    fn jacobi_sorts_a_diagonal() {
        let (values, vectors) = jacobi_eigen(&[3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2.0], 3);
        assert!((values[0] - 1.0).abs() < 1e-10);
        assert!((values[1] - 2.0).abs() < 1e-10);
        assert!((values[2] - 3.0).abs() < 1e-10);
        let mut seen = [false; 3];
        for mode in 0..3 {
            let mut peak = 0;
            for i in 1..3 {
                if vectors[i + mode * 3].abs() > vectors[peak + mode * 3].abs() {
                    peak = i;
                }
            }
            seen[peak] = true;
        }
        assert_eq!(seen, [true, true, true]);
    }

    #[test]
    fn lowest_modes_of_a_diagonal_pencil() {
        let k = diagonal(&[1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]);
        let m = diagonal(&[1.0; 8]);
        let spectrum = lowest_modes(&k, &m, 3).unwrap();
        assert!((spectrum.eigenvalues[0] - 1.0).abs() < 1e-6, "{:?}", spectrum.eigenvalues);
        assert!((spectrum.eigenvalues[1] - 4.0).abs() < 1e-6, "{:?}", spectrum.eigenvalues);
        assert!((spectrum.eigenvalues[2] - 9.0).abs() < 1e-6, "{:?}", spectrum.eigenvalues);
        assert!(spectrum.shift == 0.0);
        assert!(spectrum.residual < 1e-6, "residual {}", spectrum.residual);
    }

    #[test]
    fn a_singular_pencil_returns_the_null_vector_first() {
        // K = I − 11ᵀ/3 has a positive diagonal and one zero eigenvalue
        // along (1, 1, 1). The other two eigenvalues are 1.
        let n = 3;
        let mut values = vec![0.0; 6];
        let col_ptr = vec![0, 3, 5, 6];
        let row_idx = vec![0, 1, 2, 1, 2, 2];
        let full = [
            [2.0 / 3.0, -1.0 / 3.0, -1.0 / 3.0],
            [-1.0 / 3.0, 2.0 / 3.0, -1.0 / 3.0],
            [-1.0 / 3.0, -1.0 / 3.0, 2.0 / 3.0],
        ];
        let mut slot = 0;
        for col in 0..n {
            for row in col..n {
                values[slot] = full[row][col];
                slot += 1;
            }
        }
        let k = LowerCsc {
            n,
            col_ptr,
            row_idx,
            diag: vec![2.0 / 3.0; 3],
            values,
        };
        let m = diagonal(&[1.0; 3]);
        let spectrum = lowest_modes(&k, &m, 3).unwrap();
        assert!(
            spectrum.eigenvalues[0].abs() < 1e-6,
            "rigid eigenvalue {}",
            spectrum.eigenvalues[0]
        );
        assert!((spectrum.eigenvalues[1] - 1.0).abs() < 1e-5, "{:?}", spectrum.eigenvalues);
        assert!((spectrum.eigenvalues[2] - 1.0).abs() < 1e-5, "{:?}", spectrum.eigenvalues);
    }
}
