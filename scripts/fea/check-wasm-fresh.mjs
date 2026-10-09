/**
 * Rebuild the FEA wasm into a scratch directory and require a byte match
 * with the committed packages/surfcad-fea/pkg. README.md and .gitignore are
 * not part of the artifact (the build script deletes them).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const committed = resolve(repoRoot, 'packages/surfcad-fea/pkg');
const rebuiltName = 'pkg-rebuild';
const rebuilt = resolve(repoRoot, 'packages/surfcad-fea', rebuiltName);

rmSync(rebuilt, { recursive: true, force: true });

const build = spawnSync(process.execPath, [resolve(here, 'build-wasm.mjs'), '--out-dir', rebuiltName], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (build.status !== 0) {
  process.exit(build.status === null ? 1 : build.status);
}

const ignore = new Set(['README.md', '.gitignore']);
const list = (dir) => readdirSync(dir).filter((name) => !ignore.has(name)).sort();

try {
  const committedFiles = list(committed);
  const rebuiltFiles = list(rebuilt);
  if (committedFiles.join('\n') !== rebuiltFiles.join('\n')) {
    console.error(`committed pkg files:\n  ${committedFiles.join('\n  ')}`);
    console.error(`rebuilt pkg files:\n  ${rebuiltFiles.join('\n  ')}`);
    process.exit(1);
  }
  let failed = false;
  for (const name of committedFiles) {
    const left = readFileSync(resolve(committed, name));
    const right = readFileSync(resolve(rebuilt, name));
    if (left.equals(right)) continue;
    failed = true;
    const n = Math.min(left.length, right.length);
    let at = n;
    for (let i = 0; i < n; i++) {
      if (left[i] !== right[i]) {
        at = i;
        break;
      }
    }
    console.error(`${name} differs at byte ${at} (committed ${left.length} bytes, rebuilt ${right.length} bytes)`);
  }
  if (failed) {
    console.error('Committed FEA wasm does not match a rebuild. Run npm run fea:build and commit packages/surfcad-fea/pkg.');
    process.exit(1);
  }
  console.log(`wasm freshness ok (${committedFiles.length} files)`);
} finally {
  rmSync(rebuilt, { recursive: true, force: true });
}
