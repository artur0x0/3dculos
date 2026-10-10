//! Natural frequencies and mode shapes.
//!
//! `K φ = ω² M φ`. Frequencies are hertz. Mode shapes are expanded onto the
//! full mesh, signed so the largest translation is positive, then scaled so
//! the largest translational component is 1. Effective-mass fractions use the
//! mass-normalized vectors, before that scaling, against the three free
//! translational rigid-body directions.

use super::assemble::LowerCsc;
use super::eigen::{lowest_modes, Spectrum};
use super::pair::assemble_pair;
use super::tet10::{self, KG_M3_TO_TONNE_MM3};
use super::{dirichlet_map, validate_material, validate_mesh, Clock, Dirichlet, FemError, Material, Warning};

/// Default number of modes when the caller does not ask for a count.
pub const DEFAULT_MODES: usize = 6;

/// One modal analysis.
#[derive(Clone, Debug, PartialEq)]
pub struct ModalOutput {
    /// Hertz, ascending.
    pub frequencies_hz: Vec<f64>,
    /// `ω²` in (rad/s)², same order as the frequencies. A rigid-body
    /// eigenvalue can be a tiny negative from roundoff; the frequency uses 0.
    pub eigenvalues: Vec<f64>,
    /// Full-DOF mode shapes, mode-major. `modes[mode * dofs + dof]`.
    /// Translations are scaled so the largest one has absolute value 1.
    pub modes: Vec<f64>,
    /// `modes * 3` fractions of the free translational mass, mode-major,
    /// axes x, y, z. A complete basis sums to 1 on each axis.
    pub effective_mass: Vec<f64>,
    pub warnings: Vec<Warning>,
    pub dofs: usize,
    pub free_dofs: usize,
    pub iterations: usize,
    pub residual: f64,
    pub assembly_secs: f64,
    pub solve_secs: f64,
    /// Shift in `K − σ M`. Zero when `K` itself factored.
    pub shift: f64,
    /// Stored Cholesky entries of the shift-invert factor.
    pub factor_entries: usize,
}

/// Lowest modes of a TET10 mesh.
///
/// `density_kg_m3` is kilograms per cubic metre. The mass matrix is stored in
/// tonnes so that `K` in N/mm and `M` in tonne give `ω²` in rad²/s².
/// `modes == 0` means [`DEFAULT_MODES`]. Fixtures are homogeneous: a nonzero
/// prescribed displacement is dropped and reported.
pub fn modal_tet10(
    nodes: &[[f64; 3]],
    elements: &[[u32; 10]],
    material: Material,
    density_kg_m3: f64,
    dirichlet: &[Dirichlet],
    modes: usize,
) -> Result<ModalOutput, FemError> {
    validate_material(material)?;
    validate_mesh(nodes, elements)?;
    let density = density_tonne_per_mm3(density_kg_m3)?;
    let n_dof = nodes.len() * 3;
    let (fixed, _prescribed, mut warnings) = homogeneous_fixtures(n_dof, dirichlet)?;
    let k = requested_modes(modes, &fixed, &mut warnings)?;
    let c = tet10::elasticity(material);
    let t_asm = Clock::start();
    let km = assemble_pair(nodes.len(), 3, elements, &fixed, |element, elem| {
        let (ke, _) = tet10::element_stiffness(nodes, elem, element, &c)?;
        let me = tet10::element_mass(nodes, elem, element, density)?;
        Ok([ke.to_vec(), me.to_vec()])
    })?;
    let assembly_secs = t_asm.elapsed_secs();
    let t_solve = Clock::start();
    let spectrum = lowest_modes(&km.stiffness, &km.mass, k)?;
    let solve_secs = t_solve.elapsed_secs();
    Ok(complete(
        n_dof,
        3,
        &fixed,
        spectrum,
        &km.mass,
        warnings,
        assembly_secs,
        solve_secs,
    ))
}

pub(crate) fn density_tonne_per_mm3(density_kg_m3: f64) -> Result<f64, FemError> {
    if !(density_kg_m3.is_finite() && density_kg_m3 > 0.0) {
        return Err(FemError::BadMaterial(
            "material.density_kg_m3 must be a finite number greater than 0 (kg/m³)".into(),
        ));
    }
    Ok(density_kg_m3 * KG_M3_TO_TONNE_MM3)
}

pub(crate) fn homogeneous_fixtures(
    n_dof: usize,
    dirichlet: &[Dirichlet],
) -> Result<(Vec<bool>, Vec<f64>, Vec<Warning>), FemError> {
    let (fixed, prescribed) = dirichlet_map(n_dof, dirichlet)?;
    let mut warnings = Vec::new();
    if prescribed.iter().any(|value| value.abs() > 0.0) {
        warnings.push(Warning {
            code: "modal-fixture",
            msg: "a modal study uses homogeneous fixtures; prescribed displacements are ignored"
                .into(),
        });
    }
    Ok((fixed, prescribed, warnings))
}

pub(crate) fn requested_modes(
    modes: usize,
    fixed: &[bool],
    warnings: &mut Vec<Warning>,
) -> Result<usize, FemError> {
    let n_free = fixed.iter().filter(|is_fixed| !**is_fixed).count();
    if n_free == 0 {
        return Err(FemError::BadLoad(
            "every degree of freedom is fixed, so there is no mode to find".into(),
        ));
    }
    let mut k = if modes == 0 { DEFAULT_MODES } else { modes };
    if k > n_free {
        warnings.push(Warning {
            code: "modal-count",
            msg: format!(
                "asked for {k} modes but only {n_free} degrees of freedom are free; returning {n_free}"
            ),
        });
        k = n_free;
    }
    Ok(k)
}

pub(crate) fn complete(
    n_dof: usize,
    dof_per_node: usize,
    fixed: &[bool],
    spectrum: Spectrum,
    mass: &LowerCsc,
    warnings: Vec<Warning>,
    assembly_secs: f64,
    solve_secs: f64,
) -> ModalOutput {
    let free_dof: Vec<usize> = (0..n_dof).filter(|&dof| !fixed[dof]).collect();
    let k = spectrum.eigenvalues.len();
    let n_free = free_dof.len();
    debug_assert_eq!(spectrum.vectors.len(), n_free * k);
    let effective_mass = effective_mass_fractions(mass, &free_dof, &spectrum.vectors, k, dof_per_node);
    let mut modes = vec![0.0; n_dof * k];
    for mode in 0..k {
        for (slot, &dof) in free_dof.iter().enumerate() {
            modes[mode * n_dof + dof] = spectrum.vectors[mode * n_free + slot];
        }
        normalize_mode(&mut modes[mode * n_dof..(mode + 1) * n_dof], dof_per_node);
    }
    let frequencies_hz = spectrum
        .eigenvalues
        .iter()
        .map(|lambda| lambda.max(0.0).sqrt() / (2.0 * std::f64::consts::PI))
        .collect();
    ModalOutput {
        frequencies_hz,
        eigenvalues: spectrum.eigenvalues,
        modes,
        effective_mass,
        warnings,
        dofs: n_dof,
        free_dofs: n_free,
        iterations: spectrum.iterations,
        residual: spectrum.residual,
        assembly_secs,
        solve_secs,
        shift: spectrum.shift,
        factor_entries: spectrum.factor_entries,
    }
}

fn effective_mass_fractions(
    mass: &LowerCsc,
    free_dof: &[usize],
    vectors: &[f64],
    k: usize,
    dof_per_node: usize,
) -> Vec<f64> {
    let n = free_dof.len();
    let mut fractions = vec![0.0; k * 3];
    for axis in 0..3 {
        let mut rigid = vec![0.0; n];
        for (slot, &dof) in free_dof.iter().enumerate() {
            if dof % dof_per_node == axis {
                rigid[slot] = 1.0;
            }
        }
        let mut mr = vec![0.0; n];
        mass.sym_matvec(&rigid, &mut mr);
        let total = dot(&rigid, &mr);
        if !(total.is_finite() && total > 0.0) {
            continue;
        }
        for mode in 0..k {
            let phi = &vectors[mode * n..(mode + 1) * n];
            let gamma = dot(phi, &mr);
            fractions[mode * 3 + axis] = gamma * gamma / total;
        }
    }
    fractions
}

fn normalize_mode(mode: &mut [f64], dof_per_node: usize) {
    let mut best_trans = 0.0;
    let mut best_trans_at = 0;
    let mut best_any = 0.0;
    let mut best_any_at = 0;
    for (i, value) in mode.iter().enumerate() {
        let abs = value.abs();
        if abs > best_any {
            best_any = abs;
            best_any_at = i;
        }
        if i % dof_per_node < 3 && abs > best_trans {
            best_trans = abs;
            best_trans_at = i;
        }
    }
    let (peak, at) = if best_trans > 0.0 && best_trans >= 1e-8 * best_any.max(1e-30) {
        (best_trans, best_trans_at)
    } else if best_any > 0.0 {
        (best_any, best_any_at)
    } else {
        return;
    };
    let sign = if mode[at] < 0.0 { -1.0 } else { 1.0 };
    let scale = sign / peak;
    for value in mode.iter_mut() {
        *value *= scale;
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshgen::brick_tet10;

    fn steel() -> Material {
        Material {
            young: 210_000.0,
            poisson: 0.3,
            yield_mpa: Some(250.0),
        }
    }

    #[test]
    fn consistent_mass_matches_the_quadratic_tet_integrals() {
        // Straight tet, V = 6. Corner N0² integrates to V/70, edge N4² to 8V/105.
        let nodes = [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 3.0, 0.0],
            [0.0, 0.0, 6.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.5, 0.0],
            [0.0, 1.5, 0.0],
            [0.0, 0.0, 3.0],
            [1.0, 0.0, 3.0],
            [0.0, 1.5, 3.0],
        ];
        let elem = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        let density = 1.0e-9;
        let me = tet10::element_mass(&nodes, &elem, 0, density).unwrap();
        let volume = 6.0;
        let corner = me[0] / density;
        let edge = me[12 * 30 + 12] / density;
        assert!((corner - volume / 70.0).abs() < 1e-9 * volume, "corner {corner}");
        assert!((edge - 8.0 * volume / 105.0).abs() < 1e-9 * volume, "edge {edge}");
        let mut total = 0.0;
        for a in 0..10 {
            for b in 0..10 {
                total += me[(a * 3) * 30 + (b * 3)];
            }
        }
        assert!((total / density - volume).abs() < 1e-8 * volume, "mass {total}");
    }

    fn euler_bernoulli_hz(beta_l: f64, young: f64, inertia: f64, mu: f64, length: f64) -> f64 {
        let omega = beta_l * beta_l * (young * inertia / (mu * length.powi(4))).sqrt();
        omega / (2.0 * std::f64::consts::PI)
    }

    fn clamp_root(mesh: &crate::meshgen::Tet10Mesh) -> Vec<Dirichlet> {
        let mut dirichlet = Vec::new();
        for (i, node) in mesh.nodes.iter().enumerate() {
            if node[0].abs() <= 1e-8 {
                for axis in 0..3 {
                    dirichlet.push(Dirichlet {
                        dof: (i * 3 + axis) as u32,
                        value: 0.0,
                    });
                }
            }
        }
        dirichlet
    }

    /// First three bending frequencies of a slender rectangular cantilever.
    ///
    /// The section is 20 × 10, so the weak-axis frequency is half the strong-axis
    /// one and the second weak-axis frequency is about 6.27 times the first.
    /// Modes are identified by which way the tip moves, not by index.
    fn cantilever_bending(cells_x: usize) -> (ModalOutput, [f64; 3]) {
        let length = 400.0;
        let width = 20.0;
        let height = 10.0;
        let mesh = brick_tet10([cells_x, 2, 1], [0.0, 0.0, 0.0], [length, width, height]);
        let density = 7800.0;
        let out = modal_tet10(
            &mesh.nodes,
            &mesh.elements,
            steel(),
            density,
            &clamp_root(&mesh),
            6,
        )
        .unwrap();
        let young = 210_000.0;
        let area = width * height;
        let mu = density * KG_M3_TO_TONNE_MM3 * area;
        let i_weak = width * height.powi(3) / 12.0;
        let i_strong = height * width.powi(3) / 12.0;
        let betas = [1.875_104_068_4, 4.694_091_133, 7.854_757_438];
        let weak: Vec<f64> = betas
            .iter()
            .map(|beta| euler_bernoulli_hz(*beta, young, i_weak, mu, length))
            .collect();
        let strong1 = euler_bernoulli_hz(betas[0], young, i_strong, mu, length);
        let expected = [weak[0], strong1, weak[1]];

        let mut tip = Vec::new();
        for (i, node) in mesh.nodes.iter().enumerate() {
            if (node[0] - length).abs() <= 1e-6 {
                tip.push(i);
            }
        }
        let mut classified = Vec::new();
        for mode in 0..out.frequencies_hz.len() {
            let base = mode * out.dofs;
            let mut uy = 0.0;
            let mut uz = 0.0;
            for &node in &tip {
                uy += out.modes[base + node * 3 + 1].abs();
                uz += out.modes[base + node * 3 + 2].abs();
            }
            let kind = if uz > 2.0 * uy {
                "weak"
            } else if uy > 2.0 * uz {
                "strong"
            } else {
                "other"
            };
            classified.push((kind, out.frequencies_hz[mode]));
        }
        let weak_modes: Vec<f64> = classified
            .iter()
            .filter(|(kind, _)| *kind == "weak")
            .map(|(_, f)| *f)
            .collect();
        let strong_modes: Vec<f64> = classified
            .iter()
            .filter(|(kind, _)| *kind == "strong")
            .map(|(_, f)| *f)
            .collect();
        assert!(
            weak_modes.len() >= 2 && !strong_modes.is_empty(),
            "could not see the first three bending modes in {classified:?}, expected {expected:?}"
        );
        let got = [weak_modes[0], strong_modes[0], weak_modes[1]];
        (out, got)
    }

    #[test]
    fn cantilever_bending_matches_euler_bernoulli() {
        let (_, got) = cantilever_bending(16);
        let length = 400.0;
        let width = 20.0;
        let height = 10.0;
        let density = 7800.0;
        let young = 210_000.0;
        let mu = density * KG_M3_TO_TONNE_MM3 * width * height;
        let i_weak = width * height.powi(3) / 12.0;
        let i_strong = height * width.powi(3) / 12.0;
        let betas = [1.875_104_068_4, 4.694_091_133, 7.854_757_438];
        let expected = [
            euler_bernoulli_hz(betas[0], young, i_weak, mu, length),
            euler_bernoulli_hz(betas[0], young, i_strong, mu, length),
            euler_bernoulli_hz(betas[1], young, i_weak, mu, length),
        ];
        for (i, (g, e)) in got.iter().zip(expected).enumerate() {
            let err = (g - e).abs() / e;
            assert!(err < 0.03, "bending mode {i}: got {g} expected {e} err {err}");
        }
    }

    #[test]
    fn cantilever_frequency_converges_with_the_mesh() {
        let mut errors = Vec::new();
        for cells in [8_usize, 12, 16] {
            let (_, got) = cantilever_bending(cells);
            let length = 400.0;
            let width = 20.0;
            let height = 10.0;
            let mu = 7800.0 * KG_M3_TO_TONNE_MM3 * width * height;
            let i_weak = width * height.powi(3) / 12.0;
            let exact = euler_bernoulli_hz(1.875_104_068_4, 210_000.0, i_weak, mu, length);
            errors.push((got[0] - exact).abs() / exact);
        }
        assert!(
            errors[2] < errors[0],
            "refining the beam should cut the first-frequency error: {errors:?}"
        );
        assert!(errors[2] < 0.03, "fine mesh error {}", errors[2]);
    }

    #[test]
    fn free_free_block_has_six_rigid_body_modes() {
        let mesh = brick_tet10([2, 2, 2], [0.0, 0.0, 0.0], [10.0, 12.0, 14.0]);
        let out = modal_tet10(&mesh.nodes, &mesh.elements, steel(), 7800.0, &[], 8).unwrap();
        assert!(out.shift < 0.0, "a free-free stiffness needs a shift");
        assert_eq!(out.frequencies_hz.len(), 8);
        let flexible = out.frequencies_hz[6];
        assert!(flexible > 1.0, "seventh frequency {flexible} should be a real elastic mode");
        for (i, f) in out.frequencies_hz.iter().take(6).enumerate() {
            assert!(
                *f < 1.0e-3 * flexible,
                "rigid mode {i} is {f} Hz, flexible is {flexible}"
            );
        }
        let mut sum = [0.0; 3];
        for mode in 0..6 {
            for axis in 0..3 {
                sum[axis] += out.effective_mass[mode * 3 + axis];
            }
        }
        for axis in 0..3 {
            assert!(
                (sum[axis] - 1.0).abs() < 0.05,
                "rigid modes should carry the translational mass on axis {axis}: {sum:?}"
            );
        }
    }
}
