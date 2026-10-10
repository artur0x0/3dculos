//! CalculiX deck writer and `.frd` / `.dat` reader.
//!
//! CalculiX is GPL-2.0-only. This module does not contain CalculiX source,
//! does not link it, and does not vendor it. It writes a text deck and reads
//! the text results of an external `ccx` process.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementKind {
    C3d10,
    S6,
}

impl ElementKind {
    pub fn ccx_name(self) -> &'static str {
        match self {
            Self::C3d10 => "C3D10",
            Self::S6 => "S6",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Deck {
    pub kind: ElementKind,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<Vec<u32>>,
    /// Shell thickness in millimetres. Ignored for C3D10.
    pub thickness: f64,
    pub young: f64,
    pub poisson: f64,
    /// `(node, dof)` with `node` 0-based and `dof` the CalculiX degree of
    /// freedom (1 = ux … 3 = uz, 4 = θx … 6 = θz), value 0.
    pub fixed: Vec<(u32, u32)>,
    /// Translational nodal forces in newtons, one vector per node.
    pub forces: Vec<[f64; 3]>,
    /// Element-face ties. Empty leaves the deck identical to a single body.
    /// Face numbers are CalculiX C3D10 faces S1–S4. The first surface is
    /// the slave.
    pub ties: Vec<SurfaceTie>,
    /// Node-to-surface contact. Empty leaves the deck without a contact pair.
    /// The slave list is node ids. The master list is CalculiX element faces.
    pub contacts: Vec<SurfaceContact>,
}

/// One `*CONTACT PAIR` / `*SURFACE INTERACTION`. `mu: None` is frictionless.
#[derive(Clone, Debug)]
pub struct SurfaceContact {
    pub name: String,
    /// Slave node ids, 0-based.
    pub slave_nodes: Vec<u32>,
    /// Master `(element, face)`, element 0-based, face in 1..=4.
    pub master: Vec<(u32, u8)>,
    /// Coulomb coefficient. `None` omits `*FRICTION`.
    pub mu: Option<f64>,
    /// Linear pressure-overclosure slope, MPa per mm. A soft slope is extra
    /// compliance and will not match a penalty that is stiff next to the solid.
    pub penalty: f64,
    /// Tensile pressure at large clearance, MPa. CalculiX 2.21 requires it
    /// to be strictly positive for node-to-surface contact.
    pub tension: f64,
    /// Stick slope, MPa per mm. Written as the second `*FRICTION` field.
    pub stick_slope: f64,
    /// `*CONTACT PAIR` adjust distance, millimetres.
    pub adjust: f64,
}

/// One `*TIE` between two element surfaces on this deck's elements.
#[derive(Clone, Debug)]
pub struct SurfaceTie {
    pub name: String,
    /// `(element, face)` with `element` 0-based and `face` in 1..=4.
    pub slave: Vec<(u32, u8)>,
    pub master: Vec<(u32, u8)>,
    /// `*TIE` position tolerance, millimetres.
    pub tolerance: f64,
}

#[derive(Clone, Debug)]
pub struct CcxResult {
    /// Translations at the input nodes, millimetres. Shell values are the
    /// mid-surface displacements `ccx` prints for the original shell nodes.
    pub displacement: Vec<[f64; 3]>,
    /// Nodal Cauchy stress, Voigt `[σxx, σyy, σzz, σxy, σyz, σxz]` in MPa.
    /// For C3D10 this is one tensor per input node. For S6 the map is keyed
    /// by the expanded-mesh node id; coordinates are in [`Self::expanded`].
    pub stress: HashMap<u32, [f64; 6]>,
    /// Expanded-mesh nodes from the `.frd` file (id, xyz). For C3D10 these
    /// are the input nodes. For S6 they are the wedge nodes `ccx` generates.
    pub expanded: Vec<(u32, [f64; 3])>,
}

pub fn ccx_bin() -> String {
    std::env::var("CCX").unwrap_or_else(|_| "ccx".to_string())
}

pub fn run_case(dir: &Path, name: &str, deck: &Deck) -> Result<CcxResult, String> {
    fs::create_dir_all(dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    let inp = dir.join(format!("{name}.inp"));
    fs::write(&inp, render_inp(deck)).map_err(|err| format!("write {}: {err}", inp.display()))?;

    let bin = ccx_bin();
    let output = Command::new(&bin)
        .arg("-i")
        .arg(name)
        .current_dir(dir)
        .output()
        .map_err(|err| {
            format!(
                "failed to start `{bin}` ({err}). Install it as an external binary, for example `apt install calculix-ccx`. Do not vendor CalculiX."
            )
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        let lower = line.to_ascii_lowercase();
        if lower.contains("warning") || lower.contains("error") || lower.contains("*info") {
            eprintln!("ccx {name}: {line}");
        }
    }
    if !output.status.success() || !stdout.contains("Job finished") {
        let tail = tail_lines(&stdout, 40);
        return Err(format!(
            "ccx did not finish {name} (status {:?}).\n{tail}\n{stderr}",
            output.status.code()
        ));
    }

    let dat = fs::read_to_string(dir.join(format!("{name}.dat")))
        .map_err(|err| format!("read {name}.dat: {err}"))?;
    let frd = fs::read_to_string(dir.join(format!("{name}.frd")))
        .map_err(|err| format!("read {name}.frd: {err}"))?;
    let mut displacement = parse_dat_displacements(&dat)?;
    displacement.sort_by_key(|(id, _)| *id);
    if displacement.len() != deck.nodes.len() {
        return Err(format!(
            "{name}: ccx printed {} nodal displacements, expected {}",
            displacement.len(),
            deck.nodes.len()
        ));
    }
    for (i, (id, _)) in displacement.iter().enumerate() {
        if *id as usize != i + 1 {
            return Err(format!(
                "{name}: displacement node ids are not 1..N (missing {id} at position {i})"
            ));
        }
    }
    let parsed = parse_frd(&frd)?;
    Ok(CcxResult {
        displacement: displacement.into_iter().map(|(_, u)| u).collect(),
        stress: parsed.stress,
        expanded: parsed.nodes,
    })
}

pub fn render_inp(deck: &Deck) -> String {
    let mut out = String::new();
    out.push_str("** Generated by the surfcad-fea calculix_reference example.\n");
    out.push_str("** CalculiX is GPL-2.0-only. This deck is input for an external ccx binary.\n");
    out.push_str(
        "** It is not CalculiX source, it is not linked into SurfCAD, and it is not committed.\n",
    );
    out.push_str(
        "** Distributed loads are the same consistent nodal forces the SurfCAD solver assembles.\n",
    );
    out.push_str("*NODE\n");
    for (i, node) in deck.nodes.iter().enumerate() {
        out.push_str(&format!(
            "{}, {:.12e}, {:.12e}, {:.12e}\n",
            i + 1,
            node[0],
            node[1],
            node[2]
        ));
    }
    out.push_str(&format!(
        "*ELEMENT, TYPE={}, ELSET=EALL\n",
        deck.kind.ccx_name()
    ));
    for (e, elem) in deck.elements.iter().enumerate() {
        let ids: Vec<String> = elem.iter().map(|id| (id + 1).to_string()).collect();
        out.push_str(&format!("{}, {}\n", e + 1, ids.join(", ")));
    }
    match deck.kind {
        ElementKind::C3d10 => {
            out.push_str("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT\n");
        }
        ElementKind::S6 => {
            out.push_str("*SHELL SECTION, ELSET=EALL, MATERIAL=MAT\n");
            out.push_str(&format!("{:.12e}\n", deck.thickness));
        }
    }
    out.push_str("*MATERIAL, NAME=MAT\n");
    out.push_str("*ELASTIC\n");
    out.push_str(&format!("{:.12e}, {:.12e}\n", deck.young, deck.poisson));
    out.push_str("*NSET, NSET=NALL, GENERATE\n");
    out.push_str(&format!("1, {}\n", deck.nodes.len()));
    out.push_str("*BOUNDARY\n");
    let mut fixed = deck.fixed.clone();
    fixed.sort_unstable();
    fixed.dedup();
    for (node, dof) in fixed {
        out.push_str(&format!("{}, {}, {}\n", node + 1, dof, dof));
    }
    for tie in &deck.ties {
        let slave_name = format!("{}S", tie.name);
        let master_name = format!("{}M", tie.name);
        out.push_str(&format!("*SURFACE, NAME={slave_name}, TYPE=ELEMENT\n"));
        for (element, face) in &tie.slave {
            out.push_str(&format!("{}, S{face}\n", element + 1));
        }
        out.push_str(&format!("*SURFACE, NAME={master_name}, TYPE=ELEMENT\n"));
        for (element, face) in &tie.master {
            out.push_str(&format!("{}, S{face}\n", element + 1));
        }
        out.push_str(&format!(
            "*TIE, NAME={}, POSITION TOLERANCE={:.6e}\n",
            tie.name, tie.tolerance
        ));
        out.push_str(&format!("{slave_name}, {master_name}\n"));
    }
    for contact in &deck.contacts {
        let slave_name = format!("{}S", contact.name);
        let master_name = format!("{}M", contact.name);
        let interaction = format!("{}I", contact.name);
        out.push_str(&format!("*SURFACE, NAME={slave_name}, TYPE=NODE\n"));
        for node in &contact.slave_nodes {
            // CalculiX 2.21 reads a node surface as one node number per line.
            out.push_str(&format!("{}\n", node + 1));
        }
        out.push_str(&format!("*SURFACE, NAME={master_name}, TYPE=ELEMENT\n"));
        for (element, face) in &contact.master {
            out.push_str(&format!("{}, S{face}\n", element + 1));
        }
        out.push_str(&format!("*SURFACE INTERACTION, NAME={interaction}\n"));
        out.push_str("*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR\n");
        out.push_str(&format!(
            "{:.6e}, {:.6e}\n",
            contact.penalty, contact.tension
        ));
        if let Some(mu) = contact.mu {
            out.push_str("*FRICTION\n");
            out.push_str(&format!("{:.6e}, {:.6e}\n", mu, contact.stick_slope));
        }
        out.push_str(&format!(
            "*CONTACT PAIR, INTERACTION={interaction}, TYPE=NODE TO SURFACE, SMALL SLIDING, ADJUST={:.6e}\n",
            contact.adjust
        ));
        out.push_str(&format!("{slave_name}, {master_name}\n"));
    }
    out.push_str("*STEP\n");
    out.push_str("*STATIC\n");
    let scale = deck
        .forces
        .iter()
        .flat_map(|f| f.iter().copied())
        .map(f64::abs)
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let cutoff = 1e-12 * scale;
    let mut wrote_cload = false;
    for (i, force) in deck.forces.iter().enumerate() {
        for axis in 0..3 {
            if force[axis].abs() <= cutoff {
                continue;
            }
            if !wrote_cload {
                out.push_str("*CLOAD\n");
                wrote_cload = true;
            }
            out.push_str(&format!("{}, {}, {:.12e}\n", i + 1, axis + 1, force[axis]));
        }
    }
    if !wrote_cload {
        // A comparison with no load is a zero field. Keep the deck valid.
        out.push_str("*CLOAD\n");
        out.push_str("1, 1, 0.0\n");
    }
    out.push_str("*NODE PRINT, NSET=NALL\n");
    out.push_str("U\n");
    out.push_str("*NODE FILE\n");
    out.push_str("U\n");
    out.push_str("*EL FILE\n");
    out.push_str("S\n");
    out.push_str("*END STEP\n");
    out
}

/// Lowest `modes` frequencies in hertz from an external `ccx` `*FREQUENCY` step.
///
/// `density_tonne_per_mm3` matches the mm / N / MPa system (`kg/m³ × 1e-12`).
/// The deck's static loads are not written. CalculiX stays an external binary.
pub fn run_frequency(
    dir: &Path,
    name: &str,
    deck: &Deck,
    density_tonne_per_mm3: f64,
    modes: usize,
) -> Result<Vec<f64>, String> {
    fs::create_dir_all(dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    let inp = dir.join(format!("{name}.inp"));
    fs::write(
        &inp,
        render_frequency_inp(deck, density_tonne_per_mm3, modes),
    )
    .map_err(|err| format!("write {}: {err}", inp.display()))?;
    let bin = ccx_bin();
    let output = Command::new(&bin)
        .arg("-i")
        .arg(name)
        .current_dir(dir)
        .output()
        .map_err(|err| format!("failed to start `{bin}` ({err})"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() || !stdout.contains("Job finished") {
        return Err(format!(
            "ccx did not finish {name} frequency (status {:?}).\n{}\n{stderr}",
            output.status.code(),
            tail_lines(&stdout, 40)
        ));
    }
    let dat = fs::read_to_string(dir.join(format!("{name}.dat")))
        .map_err(|err| format!("read {name}.dat: {err}"))?;
    parse_dat_frequencies(&dat, modes)
}

fn render_frequency_inp(deck: &Deck, density: f64, modes: usize) -> String {
    let mut out = String::new();
    out.push_str("** Generated by the surfcad-fea calculix_reference example.\n");
    out.push_str("** CalculiX is GPL-2.0-only. This deck is input for an external ccx binary.\n");
    out.push_str("*NODE\n");
    for (i, node) in deck.nodes.iter().enumerate() {
        out.push_str(&format!(
            "{}, {:.12e}, {:.12e}, {:.12e}\n",
            i + 1,
            node[0],
            node[1],
            node[2]
        ));
    }
    out.push_str(&format!(
        "*ELEMENT, TYPE={}, ELSET=EALL\n",
        deck.kind.ccx_name()
    ));
    for (e, elem) in deck.elements.iter().enumerate() {
        let ids: Vec<String> = elem.iter().map(|id| (id + 1).to_string()).collect();
        out.push_str(&format!("{}, {}\n", e + 1, ids.join(", ")));
    }
    match deck.kind {
        ElementKind::C3d10 => {
            out.push_str("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT\n");
        }
        ElementKind::S6 => {
            out.push_str("*SHELL SECTION, ELSET=EALL, MATERIAL=MAT\n");
            out.push_str(&format!("{:.12e}\n", deck.thickness));
        }
    }
    out.push_str("*MATERIAL, NAME=MAT\n");
    out.push_str("*ELASTIC\n");
    out.push_str(&format!("{:.12e}, {:.12e}\n", deck.young, deck.poisson));
    out.push_str("*DENSITY\n");
    out.push_str(&format!("{:.12e}\n", density));
    out.push_str("*BOUNDARY\n");
    let mut fixed = deck.fixed.clone();
    fixed.sort_unstable();
    fixed.dedup();
    for (node, dof) in fixed {
        out.push_str(&format!("{}, {}, {}\n", node + 1, dof, dof));
    }
    out.push_str("*STEP\n");
    out.push_str("*FREQUENCY\n");
    out.push_str(&format!("{modes}\n"));
    out.push_str("*NODE FILE\n");
    out.push_str("U\n");
    out.push_str("*END STEP\n");
    out
}

fn parse_dat_frequencies(text: &str, modes: usize) -> Result<Vec<f64>, String> {
    let mut in_table = false;
    let mut found = Vec::new();
    for line in text.lines() {
        let upper = line.to_ascii_uppercase();
        if upper.contains("CYCLES/TIME") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        if line.trim().is_empty() {
            if !found.is_empty() {
                break;
            }
            continue;
        }
        let nums: Vec<f64> = line
            .split_whitespace()
            .filter_map(|token| token.parse().ok())
            .collect();
        if nums.len() >= 4 {
            found.push(nums[3]);
        }
        if found.len() == modes {
            break;
        }
    }
    if found.len() < modes {
        return Err(format!(
            "ccx .dat listed {} frequencies, expected {modes}",
            found.len()
        ));
    }
    Ok(found)
}

struct ParsedFrd {
    /// Checked by the parser unit test. The example itself prints `ccx -v`.
    #[cfg_attr(not(test), allow(dead_code))]
    version: String,
    nodes: Vec<(u32, [f64; 3])>,
    stress: HashMap<u32, [f64; 6]>,
}

fn parse_frd(text: &str) -> Result<ParsedFrd, String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        None,
        Nodes,
        Stress,
    }
    let mut mode = Mode::None;
    let mut version = String::from("unknown");
    let mut nodes = Vec::new();
    let mut stress = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("1UVERSION") {
            let label = rest.trim();
            if !label.is_empty() {
                version = label.to_string();
            }
            continue;
        }
        if trimmed.starts_with("-3") {
            mode = Mode::None;
            continue;
        }
        if trimmed.starts_with("-4") {
            mode = if trimmed.contains("STRESS") {
                Mode::Stress
            } else {
                Mode::None
            };
            continue;
        }
        if trimmed.starts_with("-5") || trimmed.starts_with("-2") {
            continue;
        }
        if trimmed.starts_with("2C") {
            mode = Mode::Nodes;
            nodes.clear();
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("-1") else {
            continue;
        };
        match mode {
            Mode::Nodes => {
                let (id, tail) =
                    leading_int(rest).ok_or_else(|| format!("frd node line has no id: {line}"))?;
                let xyz = scan_floats(tail)?;
                if xyz.len() != 3 {
                    return Err(format!(
                        "frd node {id} has {} coordinates, expected 3",
                        xyz.len()
                    ));
                }
                nodes.push((id, [xyz[0], xyz[1], xyz[2]]));
            }
            Mode::Stress => {
                let (id, tail) = leading_int(rest)
                    .ok_or_else(|| format!("frd stress line has no id: {line}"))?;
                let s = scan_floats(tail)?;
                if s.len() < 6 {
                    return Err(format!(
                        "frd stress at node {id} has {} components, expected 6",
                        s.len()
                    ));
                }
                // FRD order is SXX, SYY, SZZ, SXY, SYZ, SZX.
                stress.insert(id, [s[0], s[1], s[2], s[3], s[4], s[5]]);
            }
            Mode::None => {}
        }
    }
    if nodes.is_empty() {
        return Err("frd file has no node block".into());
    }
    if stress.is_empty() {
        return Err("frd file has no STRESS block".into());
    }
    Ok(ParsedFrd {
        version,
        nodes,
        stress,
    })
}

fn parse_dat_displacements(text: &str) -> Result<Vec<(u32, [f64; 3])>, String> {
    let mut current: Option<Vec<(u32, [f64; 3])>> = None;
    let mut last = None;
    for line in text.lines() {
        if line.contains("displacements (vx,vy,vz)") {
            if let Some(block) = current.take() {
                if !block.is_empty() {
                    last = Some(block);
                }
            }
            current = Some(Vec::new());
            continue;
        }
        let Some(block) = current.as_mut() else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with(|c: char| c.is_ascii_digit()) {
            let (id, tail) = leading_int(trimmed)
                .ok_or_else(|| format!("displacement line has no node id: {line}"))?;
            let v = scan_floats(tail)?;
            if v.len() != 3 {
                return Err(format!(
                    "displacement at node {id} has {} components, expected 3",
                    v.len()
                ));
            }
            block.push((id, [v[0], v[1], v[2]]));
        } else if !block.is_empty() {
            last = Some(current.take().unwrap());
        }
    }
    if let Some(block) = current {
        if !block.is_empty() {
            last = Some(block);
        }
    }
    last.ok_or_else(|| "dat file has no nodal displacements".into())
}

fn leading_int(text: &str) -> Option<(u32, &str)> {
    let text = text.trim_start();
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let id = text[..end].parse().ok()?;
    Some((id, &text[end..]))
}

/// Scan a CalculiX fixed-width numeric tail. Signs of later fields abut the
/// previous token (`1.0E+00-2.0E-04`), so this is not a whitespace split.
fn scan_floats(text: &str) -> Result<Vec<f64>, String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let start = i;
        if bytes[i] == b'+' || bytes[i] == b'-' {
            i += 1;
        }
        let mut digits = false;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            digits = true;
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                digits = true;
                i += 1;
            }
        }
        if !digits {
            return Err(format!("expected a number in `{text}` near byte {start}"));
        }
        if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
            i += 1;
            if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                i += 1;
            }
            let exp = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i == exp {
                return Err(format!("truncated exponent in `{text}`"));
            }
        }
        let token = &text[start..i];
        out.push(
            token
                .parse::<f64>()
                .map_err(|err| format!("parse `{token}`: {err}"))?,
        );
    }
    Ok(out)
}

fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frd_parser_reads_abutting_signs_and_stress_order() {
        let frd = "\
    1UVERSION           Version 2.21
    2C                             2                                     1
 -1         1 0.00000E+00 1.00000E+00 2.00000E+00
 -1         2-1.50000E+00-2.50000E+00 3.50000E+00
 -3
 -4  DISP        4    1
 -5  D1          1    2    1    0
 -1         1 1.00000E-03 0.00000E+00 0.00000E+00
 -3
 -4  STRESS      6    1
 -5  SXX         1    4    1    1
 -5  SYY         1    4    2    2
 -5  SZZ         1    4    3    3
 -5  SXY         1    4    1    2
 -5  SYZ         1    4    2    3
 -5  SZX         1    4    3    1
 -1         1 1.00000E+01 2.00000E+01 3.00000E+01 4.00000E+00 5.00000E+00-6.00000E+00
 -1         2-1.00000E+01 2.00000E+01-3.00000E+01-4.00000E+00 5.00000E+00 6.00000E+00
 -3
";
        let parsed = parse_frd(frd).unwrap();
        assert_eq!(parsed.version, "Version 2.21");
        assert_eq!(parsed.nodes.len(), 2);
        assert!((parsed.nodes[1].1[0] + 1.5).abs() < 1e-12);
        let s = parsed.stress[&2];
        assert!((s[0] + 10.0).abs() < 1e-9);
        assert!((s[5] - 6.0).abs() < 1e-9);
        assert!((s[4] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn dat_parser_keeps_the_last_displacement_block() {
        let dat = "\
 displacements (vx,vy,vz) for set NALL and time  0.1000000E+01

         1  1.000000E+00  0.000000E+00  0.000000E+00

 stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set EALL and time  0.1000000E+01

         1   1  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00

 displacements (vx,vy,vz) for set NALL and time  0.2000000E+01

         1 -2.500000E-01  3.000000E-01 -4.000000E-01
         2  1.000000E-03 -2.000000E-03  3.000000E-03
";
        let disp = parse_dat_displacements(dat).unwrap();
        assert_eq!(disp.len(), 2);
        assert!((disp[0].1[0] + 0.25).abs() < 1e-12);
        assert!((disp[1].1[1] + 0.002).abs() < 1e-12);
    }
}
