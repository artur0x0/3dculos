/**
 * Rebuild packages/surfcad-fea/pkg with the pinned wasm-pack.
 *
 * The same command is what CI runs (via check-wasm-fresh.mjs) to prove the
 * committed wasm and JS glue are reproducible. RUSTFLAGS is set here, not in
 * the environment, so a developer flag cannot change the bytes.
 *
 *   node scripts/fea/build-wasm.mjs
 *   node scripts/fea/build-wasm.mjs --out-dir pkg-rebuild
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_WASM_PACK = '0.15.0';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const crateDir = resolve(repoRoot, 'packages/surfcad-fea');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

const outDirName = argValue('--out-dir') || 'pkg';
if (outDirName.includes('/') || outDirName.includes('\\') || outDirName === '.' || outDirName === '..') {
  throw new Error('--out-dir must be a single directory name inside the crate');
}

const version = spawnSync('wasm-pack', ['--version'], { encoding: 'utf8' });
const reported = `${version.stdout || ''} ${version.stderr || ''}`.trim();
if (version.status !== 0 || !reported.includes(REQUIRED_WASM_PACK)) {
  console.error(`wasm-pack ${REQUIRED_WASM_PACK} is required on PATH${reported ? `, found: ${reported}` : ''}.`);
  console.error('Install notes are in packages/surfcad-fea/README.md.');
  process.exit(1);
}

const cargoHome = process.env.CARGO_HOME || resolve(homedir(), '.cargo');
const rustflags = [
  '-C', 'target-feature=+simd128',
  '--remap-path-prefix', `${crateDir}/=surfcad-fea/`,
  '--remap-path-prefix', `${cargoHome}/=cargo/`,
].join(' ');

const env = {
  ...process.env,
  SOURCE_DATE_EPOCH: '0',
  CARGO_INCREMENTAL: '0',
  RUSTFLAGS: rustflags,
};
delete env.CARGO_ENCODED_RUSTFLAGS;

const build = spawnSync('wasm-pack', [
  'build',
  '--release',
  '--target', 'web',
  '--out-dir', outDirName,
  '--mode', 'normal',
  '--',
  '--locked',
], { cwd: crateDir, env, stdio: 'inherit' });

if (build.status !== 0) {
  process.exit(build.status === null ? 1 : build.status);
}

const outDir = resolve(crateDir, outDirName);
for (const name of ['.gitignore', 'README.md']) {
  rmSync(resolve(outDir, name), { force: true });
}

const pkgPath = resolve(outDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.type = 'module';
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`surfcad-fea wasm package: ${outDir}`);
for (const name of readdirSync(outDir).sort()) {
  console.log(`  ${name}`);
}
