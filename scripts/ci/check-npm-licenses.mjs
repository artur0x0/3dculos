#!/usr/bin/env node
/**
 * Fail the build when the shipped npm production tree is copyleft.
 *
 * Scope is `npm ls --omit=dev`: the root package's production dependencies
 * (what `vite build` can ship). Dev dependencies are out of scope. GPL, AGPL,
 * and LGPL fail, including the -only / -or-later / deprecated `+` forms and
 * the long "GNU * General Public License" names.
 *
 * SPDX `OR` is a choice. `(MIT OR GPL-3.0-or-later)` is allowed because the
 * MIT term can be elected; jszip (via three-3mf-exporter) is that case.
 * `AND` is not a choice: `(MIT AND LGPL-2.1-only)` fails. An expression fails
 * when every alternative is copyleft. A missing license field fails closed.
 * This is not a general OSI allow-list.
 *
 * The Rust half of the gate (cargo-deny for packages/surfcad-fea) lives in
 * CI and runs only once that crate's Cargo.toml exists. This script is npm.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const COPYLEFT_ID = /^(?:AGPL|LGPL|GPL)(?:-[\d.]+)?(?:-only|-or-later|\+)?$/i;
const COPYLEFT_WORD = /\b(?:AGPL|LGPL|GPL)v?\d*\b/i;
const COPYLEFT_NAME = /gnu\s+(?:affero\s+|lesser\s+|library\s+)?general\s+public\s+license/i;

export function shipmentAllowed(expression) {
  const expr = String(expression ?? '').trim();
  if (!expr) return { ok: false, reason: 'no license field' };
  try {
    const ok = acceptable(expr);
    return ok
      ? { ok: true, reason: '' }
      : { ok: false, reason: `copyleft license ${expr}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** True when at least one SPDX alternative is free of GPL / AGPL / LGPL. */
function acceptable(expr) {
  const trimmed = unwrap(expr.trim());
  const orParts = splitTop(trimmed, 'OR');
  if (orParts.length > 1) return orParts.some((part) => acceptable(part));
  const andParts = splitTop(trimmed, 'AND');
  if (andParts.length > 1) return andParts.every((part) => acceptable(part));
  return !isCopyleftAtom(unwrap(trimmed));
}

function unwrap(expr) {
  const s = expr.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  if (depth !== 0) return s;
  return s.slice(1, -1).trim();
}

function splitTop(expr, keyword) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const kw = keyword.toUpperCase();
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && expr.slice(i, i + kw.length).toUpperCase() === kw) {
      const before = i === 0 ? ' ' : expr[i - 1];
      const afterIdx = i + kw.length;
      const after = afterIdx >= expr.length ? ' ' : expr[afterIdx];
      if (/\s/.test(before) && /\s/.test(after)) {
        parts.push(expr.slice(start, i).trim());
        start = afterIdx;
        i = afterIdx - 1;
      }
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter(Boolean);
}

function isCopyleftAtom(atom) {
  const base = atom.replace(/\s+WITH\s+[\w.-]+$/i, '').trim();
  if (/\s(?:OR|AND)\s/i.test(base)) {
    throw new Error(`license parser left a compound expression: ${base}`);
  }
  if (COPYLEFT_ID.test(base)) return true;
  if (COPYLEFT_WORD.test(base)) return true;
  if (COPYLEFT_NAME.test(base)) return true;
  return false;
}

export function licenseExpression(pkg) {
  const { license, licenses } = pkg;
  if (typeof license === 'string' && license.trim()) return license.trim();
  if (license && typeof license === 'object' && !Array.isArray(license) && typeof license.type === 'string') {
    return license.type.trim();
  }
  const list = Array.isArray(license) ? license : licenses;
  if (Array.isArray(list) && list.length) {
    const types = list
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((entry) => typeof entry === 'string' && entry.trim());
    if (types.length) return types.map((entry) => entry.trim()).join(' OR ');
  }
  return '';
}

function productionPackagePaths() {
  const result = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const stdout = result.stdout || '';
  if (!stdout.trim()) {
    const detail = (result.stderr || '').trim();
    throw new Error(`npm ls --omit=dev produced no tree.${detail ? ` ${detail}` : ''}`);
  }
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(`${join('node_modules')}`));
}

function checkTree() {
  const failures = [];
  const dualNotes = [];
  const paths = productionPackagePaths();
  for (const pkgPath of paths) {
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
    const expression = licenseExpression(pkg);
    const decision = shipmentAllowed(expression);
    const label = `${pkg.name}@${pkg.version}`;
    if (!decision.ok) {
      failures.push(`  ${label}  ${decision.reason}`);
      continue;
    }
    if (/\b(?:AGPL|LGPL|GPL)\b/i.test(expression)) {
      dualNotes.push(`  ${label}  ${expression}`);
    }
  }
  console.log(`npm production license gate: ${paths.length} packages, ${failures.length} copyleft`);
  if (dualNotes.length) {
    console.log('allowed because a non-copyleft alternative can be elected:');
    for (const note of dualNotes) console.log(note);
  }
  if (failures.length) {
    console.error('copyleft in the shipped production dependency tree:');
    for (const line of failures) console.error(line);
    console.error('GPL, AGPL, and LGPL are rejected. An OR-expression fails only when every alternative is copyleft.');
    process.exitCode = 1;
    return;
  }
  console.log('no GPL, AGPL, or LGPL production dependency');
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
}

if (isDirectRun()) checkTree();
