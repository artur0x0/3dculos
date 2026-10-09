//! Deterministic stub stress field.
//!
//! This is not a finite-element solution. For each input vertex the scalar is
//!
//! ```text
//! distance * (load_magnitude / load_area)
//! ```
//!
//! `distance` is the Euclidean distance to the nearest fixture face origin
//! (`faces[].at`). When the study has no finite fixture point, `distance` is
//! `|z - z_min|` over the finite vertex Z coordinates, which reads as a
//! bending-like ramp from the lowest point. `load_magnitude` is the sum of
//! the Euclidean lengths of `loads[].vector`. `load_area` is the sum of the
//! positive finite `loads[].faces[].area` values. Either sum that is missing
//! or not positive is treated as 1 so an empty study still varies with shape.
//!
//! Coordinates are whatever length unit the caller used (the study schema uses
//! millimetres). The number is labeled MPa only because that is the contract
//! the real solver will use. Material `E_MPa` and `nu` are validated and then
//! ignored. `yield_MPa` is used only for `safetyFactor = yield_MPa / p95`.
//!
//! `p95` is the nearest-rank 95th percentile: sort ascending, 1-based rank
//! `ceil(0.95 * n)`, index `rank - 1` (the only value when `n == 1`, and 0
//! when `n == 0`).

use serde::{Deserialize, Serialize};
use std::cell::Cell;

/// Crate version reported by `capabilities()`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Hint for a later solid model on a phone-class heap (about 512 MiB).
pub const PHONE_MAX_DOFS: u32 = 48_000;

/// Hint for a later solid model on a desktop heap.
pub const DESKTOP_MAX_DOFS: u32 = 300_000;

pub const SOURCE_STUB: &str = "stub";

pub const STUB_WARNING: &str =
    "STUB, not a real result. The von Mises field is a deterministic placeholder, not a finite-element solution.";

thread_local! {
    static CANCELLED: Cell<bool> = const { Cell::new(false) };
}

/// Request that the next `solve` fail instead of returning a field.
pub fn request_cancel() {
    CANCELLED.with(|flag| flag.set(true));
}

/// Drop a pending cancel. The wasm `dispose` export calls this.
pub fn reset() {
    CANCELLED.with(|flag| flag.set(false));
}

fn take_cancel() -> bool {
    CANCELLED.with(|flag| {
        let cancelled = flag.get();
        if cancelled {
            flag.set(false);
        }
        cancelled
    })
}

/// `true` when this compilation was built with `+simd128`.
pub fn simd_compiled() -> bool {
    cfg!(target_feature = "simd128")
}

/// One SIMD add, so the wasm module actually contains a simd128 opcode.
/// The extracted lane is 1, and the stub multiplies by it.
fn simd_unit() -> f32 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::{f32x4_add, f32x4_extract_lane, f32x4_splat};
        let sum = f32x4_add(f32x4_splat(1.0), f32x4_splat(0.0));
        f32x4_extract_lane::<0>(sum)
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        1.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Phone,
    Desktop,
}

impl std::fmt::Display for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Phone => "phone",
            Self::Desktop => "desktop",
        })
    }
}

impl Profile {
    pub fn parse(text: &str) -> Result<Self, SolveError> {
        match text {
            "phone" => Ok(Self::Phone),
            "desktop" => Ok(Self::Desktop),
            other => Err(SolveError::BadProfile(format!(
                "profile must be 'phone' or 'desktop', got {other:?}"
            ))),
        }
    }

    pub fn max_dofs(self) -> u32 {
        match self {
            Self::Phone => PHONE_MAX_DOFS,
            Self::Desktop => DESKTOP_MAX_DOFS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolveError {
    Cancelled,
    BadPositions(&'static str),
    BadIndices(&'static str),
    BadProfile(String),
    BadMaterial(String),
    BadStudy(String),
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "FEA solve cancelled"),
            Self::BadPositions(msg) | Self::BadIndices(msg) => write!(f, "{msg}"),
            Self::BadProfile(msg) | Self::BadMaterial(msg) | Self::BadStudy(msg) => {
                write!(f, "{msg}")
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct Study {
    #[serde(default)]
    pub fixtures: Vec<Fixture>,
    #[serde(default)]
    pub loads: Vec<Load>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct Fixture {
    #[serde(default)]
    pub faces: Vec<FaceRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct Load {
    #[serde(default)]
    pub faces: Vec<FaceRef>,
    #[serde(default)]
    pub vector: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct FaceRef {
    #[serde(default)]
    pub at: Option<[f64; 3]>,
    #[serde(default)]
    pub area: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Material {
    pub e_mpa: f64,
    pub nu: f64,
    pub yield_mpa: f64,
}

#[derive(Debug, Deserialize)]
struct MaterialRaw {
    #[serde(default, rename = "E_MPa")]
    e_mpa: Option<f64>,
    #[serde(default, rename = "E")]
    e: Option<f64>,
    nu: f64,
    #[serde(default, rename = "yield_MPa")]
    yield_mpa: Option<f64>,
    #[serde(default, rename = "yield")]
    yield_alias: Option<f64>,
}

impl Material {
    pub fn from_raw_parts(e_mpa: f64, nu: f64, yield_mpa: f64) -> Result<Self, SolveError> {
        if !e_mpa.is_finite() || e_mpa <= 0.0 {
            return Err(SolveError::BadMaterial(
                "material.E_MPa must be a finite number greater than 0 (megapascals)".into(),
            ));
        }
        if !nu.is_finite() || nu <= -1.0 || nu >= 0.5 {
            return Err(SolveError::BadMaterial(
                "material.nu must be finite and in the open interval (-1, 0.5)".into(),
            ));
        }
        if !yield_mpa.is_finite() || yield_mpa < 0.0 {
            return Err(SolveError::BadMaterial(
                "material.yield_MPa must be a finite number greater than or equal to 0 (megapascals)".into(),
            ));
        }
        Ok(Self {
            e_mpa,
            nu,
            yield_mpa,
        })
    }
}

impl<'de> Deserialize<'de> for Material {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = MaterialRaw::deserialize(deserializer)?;
        let e_mpa = pick_alias(raw.e_mpa, raw.e, "E_MPa", "E").map_err(serde::de::Error::custom)?;
        let yield_mpa = pick_alias(raw.yield_mpa, raw.yield_alias, "yield_MPa", "yield")
            .map_err(serde::de::Error::custom)?;
        Material::from_raw_parts(e_mpa, raw.nu, yield_mpa).map_err(serde::de::Error::custom)
    }
}

fn pick_alias(
    primary: Option<f64>,
    alias: Option<f64>,
    primary_name: &str,
    alias_name: &str,
) -> Result<f64, String> {
    match (primary, alias) {
        (Some(a), Some(b)) if a != b => Err(format!(
            "material.{primary_name} and material.{alias_name} disagree ({a} vs {b}); pass megapascals as {primary_name}"
        )),
        (Some(a), _) => Ok(a),
        (None, Some(b)) => Ok(b),
        (None, None) => Err(format!(
            "material.{primary_name} (or {alias_name}) is required, in megapascals"
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Warning {
    pub code: &'static str,
    pub msg: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolveOutput {
    pub nodal: Vec<f32>,
    pub min: f32,
    pub max: f32,
    pub p95: f32,
    pub safety_factor: Option<f64>,
    pub warnings: Vec<Warning>,
    pub dofs: u32,
    pub vertices: u32,
    pub triangles: u32,
}

/// Nearest-rank 95th percentile. See the module docs.
pub fn percentile_95(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((values.len() as f64) * 0.95).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[index]
}

pub fn solve(
    study: &Study,
    positions: &[f32],
    indices: &[u32],
    _face_ids: &[u32],
    material: Material,
    profile: Profile,
) -> Result<SolveOutput, SolveError> {
    if take_cancel() {
        return Err(SolveError::Cancelled);
    }
    if positions.len() % 3 != 0 {
        return Err(SolveError::BadPositions(
            "mesh.positions length must be a multiple of 3 (x, y, z per vertex)",
        ));
    }
    if indices.len() % 3 != 0 {
        return Err(SolveError::BadIndices(
            "mesh.indices length must be a multiple of 3 (three corners per triangle)",
        ));
    }

    let vertex_count = positions.len() / 3;
    let mut coords = Vec::with_capacity(vertex_count);
    let mut z_min = f32::INFINITY;
    let mut non_finite = false;
    for chunk in positions.chunks_exact(3) {
        let point = [chunk[0], chunk[1], chunk[2]];
        if point[2].is_finite() {
            z_min = z_min.min(point[2]);
        } else {
            non_finite = true;
        }
        if !point[0].is_finite() || !point[1].is_finite() {
            non_finite = true;
        }
        coords.push(point);
    }
    if !z_min.is_finite() {
        z_min = 0.0;
    }

    let fixtures = fixture_points(study);
    let scale = load_scale(study) as f32;
    let unit = simd_unit();
    let mut nodal = Vec::with_capacity(vertex_count);
    for point in &coords {
        let distance = if !point[0].is_finite() || !point[1].is_finite() || !point[2].is_finite() {
            0.0
        } else if fixtures.is_empty() {
            (point[2] - z_min).abs()
        } else {
            fixtures
                .iter()
                .map(|origin| dist(*point, *origin))
                .fold(f32::INFINITY, f32::min)
        };
        nodal.push(distance * scale * unit);
    }

    let min = nodal.iter().copied().fold(f32::INFINITY, f32::min);
    let max = nodal.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let (min, max) = if nodal.is_empty() {
        (0.0, 0.0)
    } else {
        (min, max)
    };
    let p95 = percentile_95(&nodal);
    let safety_factor = if p95.is_finite() && p95 > 0.0 {
        Some(material.yield_mpa / f64::from(p95))
    } else {
        None
    };

    let mut warnings = vec![Warning {
        code: "stub",
        msg: STUB_WARNING.into(),
    }];
    if vertex_count == 0 {
        warnings.push(Warning {
            code: "empty-mesh",
            msg: "mesh.positions is empty, so the stub field has no vertices".into(),
        });
    }
    if non_finite {
        warnings.push(Warning {
            code: "non-finite-vertex",
            msg: "a vertex coordinate was not finite; that vertex was given stress 0".into(),
        });
    }
    if vertex_count > 0 && p95 == 0.0 {
        warnings.push(Warning {
            code: "zero-stress",
            msg: "p95 is 0, so safetyFactor is null (yield / p95 is undefined)".into(),
        });
    }
    let dofs = (vertex_count as u32).saturating_mul(3);
    if dofs > profile.max_dofs() {
        warnings.push(Warning {
            code: "dof-hint",
            msg: format!(
                "estimated {dofs} DOFs exceeds the {profile} hint of {} DOFs; the stub still returned a field",
                profile.max_dofs()
            ),
        });
    }

    Ok(SolveOutput {
        nodal,
        min,
        max,
        p95,
        safety_factor,
        warnings,
        dofs,
        vertices: vertex_count as u32,
        triangles: (indices.len() / 3) as u32,
    })
}

fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn fixture_points(study: &Study) -> Vec<[f32; 3]> {
    let mut points = Vec::new();
    for fixture in &study.fixtures {
        for face in &fixture.faces {
            let Some(at) = face.at else { continue };
            if at.iter().all(|coord| coord.is_finite()) {
                points.push([at[0] as f32, at[1] as f32, at[2] as f32]);
            }
        }
    }
    points
}

fn load_scale(study: &Study) -> f64 {
    let mut magnitude = 0.0;
    let mut area = 0.0;
    for load in &study.loads {
        if let Some(vector) = load.vector {
            if vector.iter().all(|coord| coord.is_finite()) {
                magnitude +=
                    (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
            }
        }
        for face in &load.faces {
            if let Some(face_area) = face.area {
                if face_area.is_finite() && face_area > 0.0 {
                    area += face_area;
                }
            }
        }
    }
    let magnitude = if magnitude > 0.0 { magnitude } else { 1.0 };
    let area = if area > 0.0 { area } else { 1.0 };
    magnitude / area
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aluminum() -> Material {
        Material::from_raw_parts(68_900.0, 0.33, 276.0).unwrap()
    }

    fn empty_mesh_study() -> Study {
        Study::default()
    }

    #[test]
    fn percentile_rank_matches_the_contract() {
        assert_eq!(percentile_95(&[]), 0.0);
        assert_eq!(percentile_95(&[4.0]), 4.0);
        assert_eq!(percentile_95(&[0.0, 10.0, 20.0, 30.0]), 30.0);
        let values: Vec<f32> = (0..20).map(|n| n as f32).collect();
        assert_eq!(percentile_95(&values), 18.0);
    }

    #[test]
    fn z_ramp_is_deterministic_and_scales_with_load() {
        let positions = [
            0.0_f32, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 20.0, 0.0, 0.0, 30.0,
        ];
        let study: Study = serde_json::from_str(
            r#"{"loads":[{"kind":"force","vector":[0,0,-200],"faces":[{"at":[0,0,30],"area":100}]}],"ignored":true}"#,
        )
        .unwrap();
        let first = solve(
            &study,
            &positions,
            &[0, 1, 2],
            &[7],
            aluminum(),
            Profile::Desktop,
        )
        .unwrap();
        let second = solve(
            &study,
            &positions,
            &[0, 1, 2],
            &[7],
            aluminum(),
            Profile::Phone,
        )
        .unwrap();
        assert_eq!(first.nodal, vec![0.0, 20.0, 40.0, 60.0]);
        assert_eq!(second.nodal, first.nodal);
        assert_eq!(first.min, 0.0);
        assert_eq!(first.max, 60.0);
        assert_eq!(first.p95, 60.0);
        assert_eq!(first.safety_factor, Some(276.0 / 60.0));
        assert_eq!(first.vertices, 4);
        assert_eq!(first.triangles, 1);
        assert_eq!(first.dofs, 12);
        assert_eq!(first.warnings[0].code, "stub");
        assert!(first.warnings[0].msg.contains("STUB, not a real result"));
    }

    #[test]
    fn fixture_distance_replaces_the_z_ramp() {
        let positions = [0.0_f32, 0.0, 0.0, 3.0, 4.0, 0.0];
        let study: Study = serde_json::from_str(
            r#"{"fixtures":[{"kind":"fixed","faces":[{"at":[0,0,0],"n":[0,0,-1],"area":400}]}]}"#,
        )
        .unwrap();
        let out = solve(&study, &positions, &[], &[], aluminum(), Profile::Desktop).unwrap();
        assert_eq!(out.nodal, vec![0.0, 5.0]);
        assert_eq!(out.p95, 5.0);
        assert_eq!(out.safety_factor, Some(276.0 / 5.0));
    }

    #[test]
    fn nearest_fixture_wins() {
        let positions = [10.0_f32, 0.0, 0.0];
        let study: Study =
            serde_json::from_str(r#"{"fixtures":[{"faces":[{"at":[0,0,0]},{"at":[9,0,0]}]}]}"#)
                .unwrap();
        let out = solve(&study, &positions, &[], &[], aluminum(), Profile::Phone).unwrap();
        assert_eq!(out.nodal, vec![1.0]);
    }

    #[test]
    fn empty_mesh_has_null_safety_factor() {
        let out = solve(
            &empty_mesh_study(),
            &[],
            &[],
            &[],
            aluminum(),
            Profile::Phone,
        )
        .unwrap();
        assert!(out.nodal.is_empty());
        assert_eq!(out.p95, 0.0);
        assert_eq!(out.safety_factor, None);
        assert!(out
            .warnings
            .iter()
            .any(|warning| warning.code == "empty-mesh"));
        assert!(out.warnings.iter().any(|warning| warning.code == "stub"));
    }

    #[test]
    fn zero_field_explains_the_missing_safety_factor() {
        let out = solve(
            &Study::default(),
            &[1.0, 2.0, 3.0],
            &[],
            &[],
            aluminum(),
            Profile::Desktop,
        )
        .unwrap();
        assert_eq!(out.nodal, vec![0.0]);
        assert_eq!(out.safety_factor, None);
        assert!(out
            .warnings
            .iter()
            .any(|warning| warning.code == "zero-stress"));
    }

    #[test]
    fn material_aliases_are_megapascals() {
        let from_canonical: Material =
            serde_json::from_str(r#"{"E_MPa":68900,"nu":0.33,"yield_MPa":276}"#).unwrap();
        let from_alias: Material =
            serde_json::from_str(r#"{"E":68900,"nu":0.33,"yield":276}"#).unwrap();
        assert_eq!(from_canonical, from_alias);
        let disagreed =
            serde_json::from_str::<Material>(r#"{"E_MPa":1,"E":2,"nu":0.3,"yield_MPa":1}"#);
        assert!(disagreed.is_err());
    }

    #[test]
    fn material_rejects_non_physical_constants() {
        assert!(Material::from_raw_parts(0.0, 0.3, 1.0).is_err());
        assert!(Material::from_raw_parts(1.0, 0.5, 1.0).is_err());
        assert!(Material::from_raw_parts(1.0, 0.3, -1.0).is_err());
    }

    #[test]
    fn bad_buffers_and_profile_fail() {
        assert!(matches!(
            solve(
                &Study::default(),
                &[1.0, 2.0],
                &[],
                &[],
                aluminum(),
                Profile::Phone
            ),
            Err(SolveError::BadPositions(_))
        ));
        assert!(matches!(
            solve(
                &Study::default(),
                &[0.0, 0.0, 0.0],
                &[0, 1],
                &[],
                aluminum(),
                Profile::Phone
            ),
            Err(SolveError::BadIndices(_))
        ));
        assert!(Profile::parse("tablet").is_err());
    }

    #[test]
    fn cancel_is_consumed_once() {
        request_cancel();
        assert!(matches!(
            solve(
                &Study::default(),
                &[],
                &[],
                &[],
                aluminum(),
                Profile::Desktop
            ),
            Err(SolveError::Cancelled)
        ));
        assert!(solve(
            &Study::default(),
            &[],
            &[],
            &[],
            aluminum(),
            Profile::Desktop
        )
        .is_ok());
        request_cancel();
        reset();
        assert!(solve(
            &Study::default(),
            &[],
            &[],
            &[],
            aluminum(),
            Profile::Desktop
        )
        .is_ok());
    }

    #[test]
    fn dof_hint_warns_without_dropping_the_field() {
        let positions = vec![0.0_f32; (PHONE_MAX_DOFS as usize + 3) * 3];
        // vertex count = PHONE_MAX_DOFS + 3, dofs = 3 * vertices > phone hint.
        let vertices = positions.len() / 3;
        assert!(vertices * 3 > PHONE_MAX_DOFS as usize);
        let out = solve(
            &Study::default(),
            &positions,
            &[],
            &[],
            aluminum(),
            Profile::Phone,
        )
        .unwrap();
        assert_eq!(out.nodal.len(), vertices);
        assert!(out
            .warnings
            .iter()
            .any(|warning| warning.code == "dof-hint"));
        let desktop = solve(
            &Study::default(),
            &positions,
            &[],
            &[],
            aluminum(),
            Profile::Desktop,
        )
        .unwrap();
        assert!(desktop
            .warnings
            .iter()
            .all(|warning| warning.code != "dof-hint"));
    }

    #[test]
    fn study_json_round_trip_ignores_unknown_keys() {
        let text = r#"{"v":1,"fixtures":[{"kind":"fixed","faces":[{"at":[0,0,0],"n":[0,0,-1],"area":400}]}],"loads":[{"kind":"force","faces":[{"area":100}],"vector":[0,0,-200]}]}"#;
        let study: Study = serde_json::from_str(text).unwrap();
        let encoded = serde_json::to_string(&study).unwrap();
        let again: Study = serde_json::from_str(&encoded).unwrap();
        assert_eq!(study, again);
        assert_eq!(again.fixtures[0].faces[0].at, Some([0.0, 0.0, 0.0]));
        assert_eq!(again.loads[0].vector, Some([0.0, 0.0, -200.0]));
        assert_eq!(again.loads[0].faces[0].area, Some(100.0));
        assert!(!encoded.contains("\"kind\""));
        assert!(!encoded.contains("\"n\""));
    }
}
