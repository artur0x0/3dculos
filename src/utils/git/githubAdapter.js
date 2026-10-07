/**
 * GitHub adapter interface for the git vault.
 *
 * Everything in git mode talks to GitHub through one object with the
 * methods below. G1 ships an in-memory mock (mockGithubAdapter.js). The
 * real GitHub App adapter drops in later with the same surface; nothing
 * outside an adapter may call the GitHub API. No adapter holds a secret:
 * the real one will receive a user token that lives only in the browser.
 *
 * All methods are async. `repo` is `{ owner, name }`. Paths are
 * repo-relative (see vaultLayout.js). File content is a UTF-8 string.
 *
 *   getViewer()                                  -> { login }
 *   getRepo(repo)                                -> RepoInfo | null
 *   createRepo({ name, private, description })   -> RepoInfo   (viewer-owned)
 *   listBranches(repo)                           -> [{ name, sha }]
 *   getBranch(repo, branch)                      -> { name, sha } | null
 *   createBranch(repo, branch, fromSha)          -> { name, sha }
 *   listTree(repo, ref, { prefix }?)             -> [{ path, type: 'blob', sha }]
 *   readFile(repo, path, ref?)                   -> { path, content, sha } | null
 *   commitFiles(repo, { branch, message, files, baseSha? })
 *                                                -> { sha, parents: [sha], branch }
 *       files: [{ path, content }] or [{ path, delete: true }], applied as
 *       ONE commit. With baseSha, the write is refused (GitAdapterError
 *       code 'non_fast_forward') when the branch head is not baseSha.
 *   compare(repo, base, head)                    -> CompareResult
 *       base/head are branch names or commit shas.
 *       { status: 'identical'|'ahead'|'behind'|'diverged',
 *         aheadBy, behindBy, mergeBaseSha, baseSha, headSha,
 *         files: [{ path, status: 'added'|'modified'|'removed' }] }
 *       `files` is the diff from mergeBase to head (what head changed).
 *
 * RepoInfo = { owner, name, private, defaultBranch, empty }
 */

export const GITHUB_ADAPTER_METHODS = Object.freeze([
  'getViewer',
  'getRepo',
  'createRepo',
  'listBranches',
  'getBranch',
  'createBranch',
  'listTree',
  'readFile',
  'commitFiles',
  'compare',
]);

export const GIT_ADAPTER_ERROR_CODES = Object.freeze([
  'not_found',
  'name_exists',
  'non_fast_forward',
  'invalid',
  'unauthorized',
]);

export class GitAdapterError extends Error {
  /**
   * @param {string} code one of GIT_ADAPTER_ERROR_CODES
   * @param {string} [message]
   * @param {{ status?: number, acceptedPermissions?: string|null, githubMessage?: string|null }} [details]
   */
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'GitAdapterError';
    this.code = code;
    if (details.status != null) this.status = details.status;
    if (details.acceptedPermissions !== undefined) {
      this.acceptedPermissions = details.acceptedPermissions;
    }
    if (details.githubMessage !== undefined) {
      this.githubMessage = details.githubMessage;
    }
  }
}

/** Missing method names, [] when `adapter` implements the whole interface. */
export function missingAdapterMethods(adapter) {
  if (!adapter || typeof adapter !== 'object') return [...GITHUB_ADAPTER_METHODS];
  return GITHUB_ADAPTER_METHODS.filter((m) => typeof adapter[m] !== 'function');
}

/** Throws when `adapter` does not implement the interface; returns it otherwise. */
export function assertGithubAdapter(adapter) {
  const missing = missingAdapterMethods(adapter);
  if (missing.length) {
    throw new GitAdapterError('invalid', `GitHub adapter is missing: ${missing.join(', ')}`);
  }
  return adapter;
}

/** One file change for commitFiles. */
export function fileWrite(path, content) {
  return { path, content: String(content ?? '') };
}

export function fileDelete(path) {
  return { path, delete: true };
}
