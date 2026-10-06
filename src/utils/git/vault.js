/**
 * Find-or-create the user's vault: one private repo, default `surfcad`.
 * The name is editable when the vault is created (sanitizeVaultName).
 *
 * A repo is a vault when its default branch has `surfcad.json` with
 * `{ "kind": "surfcad-vault", "version": 1 }`. An existing empty repo with
 * the chosen name is initialized in place. An existing non-empty repo
 * without the marker is never written; findOrCreateVault reports
 * 'not-a-vault' so the UI can ask for another name.
 */
import { assertGithubAdapter, GitAdapterError } from './githubAdapter.js';
import { ASSEMBLIES_DIR, SHARED_PARTS_DIR, VAULT_MARKER_PATH, VAULT_README_PATH } from './vaultLayout.js';

export const DEFAULT_VAULT_NAME = 'surfcad';
export const VAULT_MARKER_KIND = 'surfcad-vault';
export const VAULT_MARKER_VERSION = 1;

/** GitHub repo name from a rename field: [A-Za-z0-9._-], max 100. '' when nothing is left. */
export function sanitizeVaultName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return name === '.' || name === '..' ? '' : name;
}

export function vaultMarkerContent() {
  return `${JSON.stringify({ kind: VAULT_MARKER_KIND, version: VAULT_MARKER_VERSION }, null, 2)}\n`;
}

export function isVaultMarker(content) {
  try {
    const m = JSON.parse(String(content));
    return m?.kind === VAULT_MARKER_KIND && Number.isInteger(m.version);
  } catch {
    return false;
  }
}

/** Files of the first vault commit. `.gitkeep` holds the two top-level folders. */
export function vaultSeedFiles(name) {
  return [
    { path: VAULT_MARKER_PATH, content: vaultMarkerContent() },
    {
      path: VAULT_README_PATH,
      content: `# ${name}\n\nSurfCAD vault.\n\n- \`${ASSEMBLIES_DIR}/<name>/<name>.surf.json\` assembly, with its \`parts/<part>.js\`\n- \`${SHARED_PARTS_DIR}/<part>.js\` shared parts, referenced by path\n`,
    },
    { path: `${ASSEMBLIES_DIR}/.gitkeep`, content: '' },
    { path: `${SHARED_PARTS_DIR}/.gitkeep`, content: '' },
  ];
}

/**
 * -> { status: 'found' | 'created' | 'initialized', repo: { owner, name },
 *      defaultBranch, headSha, private }
 *  | { status: 'not-a-vault', repo }      (existing repo, has files, no marker)
 *  | { status: 'invalid-name', name }
 *
 * `create: false` only looks; a missing repo gives { status: 'missing' }.
 */
export async function findOrCreateVault(adapter, { name = DEFAULT_VAULT_NAME, create = true } = {}) {
  assertGithubAdapter(adapter);
  const repoName = sanitizeVaultName(name);
  if (!repoName) return { status: 'invalid-name', name };
  const { login } = await adapter.getViewer();
  const repo = { owner: login, name: repoName };
  let info = await adapter.getRepo(repo);

  if (info && !info.empty) {
    const marker = await adapter.readFile(repo, VAULT_MARKER_PATH, info.defaultBranch);
    if (!marker || !isVaultMarker(marker.content)) return { status: 'not-a-vault', repo };
    const head = await adapter.getBranch(repo, info.defaultBranch);
    return { status: 'found', repo, defaultBranch: info.defaultBranch, headSha: head?.sha || null, private: info.private };
  }
  if (!info && !create) return { status: 'missing', repo };

  let status = 'initialized';
  if (!info) {
    try {
      info = await adapter.createRepo({ name: repoName, private: true, description: 'SurfCAD vault' });
      status = 'created';
    } catch (err) {
      if (err instanceof GitAdapterError && err.code === 'name_exists') {
        // Raced with another tab: look again instead of failing.
        return findOrCreateVault(adapter, { name: repoName, create: false });
      }
      throw err;
    }
  }
  const commit = await adapter.commitFiles(repo, {
    branch: info.defaultBranch,
    message: 'Create SurfCAD vault',
    files: vaultSeedFiles(repoName),
    baseSha: null,
  });
  return { status, repo, defaultBranch: info.defaultBranch, headSha: commit.sha, private: info.private };
}
