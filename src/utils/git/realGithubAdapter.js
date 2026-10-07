/**
 * Real GitHub adapter — same surface as mockGithubAdapter / githubAdapter.js.
 *
 * Takes a user-to-server OAuth access token (browser-only). All GitHub calls
 * go through `fetch` with `Authorization: Bearer <token>`. Inject `fetchImpl`
 * in tests to mock the network. No secrets, no server storage.
 */
import { GitAdapterError, assertGithubAdapter } from './githubAdapter.js';
import { normalizeRepoPath } from '../assembly.js';

const API = 'https://api.github.com';
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function createRealGithubAdapter({ token, fetchImpl = globalThis.fetch, apiBase = API } = {}) {
  if (!token) {
    throw new GitAdapterError('unauthorized', 'GitHub token required');
  }
  const doFetch = fetchImpl;

  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`;
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new GitAdapterError('invalid', `GitHub network error: ${err?.message || err}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitAdapterError('unauthorized', `GitHub ${res.status}`);
    }
    return res;
  }

  async function json(path, opts) {
    const res = await api(path, opts);
    if (res.status === 204) return { res, data: null };
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    return { res, data };
  }

  function repoPath(repo) {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  function infoFromRepo(r) {
    return {
      owner: r.owner?.login || r.owner,
      name: r.name,
      private: !!r.private,
      defaultBranch: r.default_branch || 'main',
      empty: r.size === 0,
    };
  }

  async function resolveSha(repo, ref) {
    if (ref == null || ref === '') return null;
    const br = await getBranchInner(repo, ref);
    if (br) return br.sha;
    if (/^[0-9a-f]{40}$/i.test(String(ref))) return String(ref);
    return null;
  }

  async function getBranchInner(repo, branch) {
    const { res, data } = await json(
      `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'getBranch failed');
    return { name: data.name, sha: data.commit?.sha };
  }

  const adapter = {
    kind: 'real',

    async getViewer() {
      const { res, data } = await json('/user');
      if (!res.ok) throw new GitAdapterError('unauthorized', data?.message || 'getViewer failed');
      return { login: data.login };
    },

    async getRepo(repo) {
      const { res, data } = await json(repoPath(repo));
      if (res.status === 404) return null;
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'getRepo failed');
      return infoFromRepo(data);
    },

    async createRepo({ name, private: isPrivate = true, description = '' } = {}) {
      if (!REPO_NAME_RE.test(String(name || '')) || name === '.' || name === '..') {
        throw new GitAdapterError('invalid', `Invalid repo name "${name}"`);
      }
      const { res, data } = await json('/user/repos', {
        method: 'POST',
        body: {
          name,
          private: isPrivate !== false,
          description: description || '',
          auto_init: false,
        },
      });
      if (res.status === 422) {
        throw new GitAdapterError('name_exists', data?.message || `Repo ${name} already exists`);
      }
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'createRepo failed');
      return {
        owner: data.owner?.login,
        name: data.name,
        private: !!data.private,
        defaultBranch: data.default_branch || 'main',
        empty: true,
      };
    },

    async listBranches(repo) {
      const { res, data } = await json(`${repoPath(repo)}/branches?per_page=100`);
      if (res.status === 404) {
        throw new GitAdapterError('not_found', `Repo ${repo.owner}/${repo.name} not found`);
      }
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'listBranches failed');
      return (data || [])
        .map((b) => ({ name: b.name, sha: b.commit?.sha }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async getBranch(repo, branch) {
      return getBranchInner(repo, branch);
    },

    async createBranch(repo, branch, fromSha) {
      if (!branch) throw new GitAdapterError('name_exists', 'Branch name required');
      const { res, data } = await json(`${repoPath(repo)}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: fromSha },
      });
      if (res.status === 422) {
        // Existing ref or invalid sha — distinguish by message when possible.
        const msg = data?.message || '';
        if (/already exists|Reference already exists/i.test(msg)) {
          throw new GitAdapterError('name_exists', `Branch ${branch} already exists`);
        }
        if (/not found|Object does not exist|is not a valid/i.test(msg)) {
          throw new GitAdapterError('not_found', `Commit ${fromSha} not found`);
        }
        throw new GitAdapterError('name_exists', msg || `Branch ${branch} already exists`);
      }
      if (res.status === 404) {
        throw new GitAdapterError('not_found', data?.message || `Commit ${fromSha} not found`);
      }
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'createBranch failed');
      return { name: branch, sha: data.object?.sha || fromSha };
    },

    async listTree(repo, ref, { prefix = '' } = {}) {
      const sha = await resolveSha(repo, ref);
      if (!sha) return [];
      let treeSha = sha;
      const commitRes = await json(`${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`);
      if (commitRes.res.ok && commitRes.data?.tree?.sha) {
        treeSha = commitRes.data.tree.sha;
      } else if (!commitRes.res.ok) {
        return [];
      }
      const { res, data } = await json(
        `${repoPath(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      );
      if (!res.ok) return [];
      return filterTree(data?.tree, prefix);
    },

    async readFile(repo, path, ref) {
      const p = normalizeRepoPath(path);
      if (!p) return null;
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const encoded = p.split('/').map(encodeURIComponent).join('/');
      const { res, data } = await json(`${repoPath(repo)}/contents/${encoded}${q}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'readFile failed');
      if (data?.type !== 'file') return null;
      let content = '';
      if (data.encoding === 'base64' && data.content) {
        content = decodeBase64Utf8(data.content.replace(/\n/g, ''));
      } else if (typeof data.content === 'string') {
        content = data.content;
      }
      return { path: p, content, sha: data.sha };
    },

    async commitFiles(repo, { branch, message, files, baseSha } = {}) {
      if (!Array.isArray(files) || files.length === 0) {
        throw new GitAdapterError('invalid', 'commitFiles needs at least one file');
      }
      const info = await this.getRepo(repo);
      if (!info) throw new GitAdapterError('not_found', `Repo ${repo.owner}/${repo.name} not found`);
      const target = branch || info.defaultBranch || 'main';

      let head = null;
      const br = await getBranchInner(repo, target);
      if (br) head = br.sha;
      else if (!info.empty) {
        const branches = await this.listBranches(repo);
        if (branches.length > 0) {
          throw new GitAdapterError('not_found', `Branch ${target} not found`);
        }
      }

      if (baseSha !== undefined && (baseSha || null) !== head) {
        throw new GitAdapterError(
          'non_fast_forward',
          `${target} moved: head ${head}, base ${baseSha}`,
        );
      }

      let baseEntries = [];
      let parentTreeSha = null;
      if (head) {
        const { res: cRes, data: cData } = await json(
          `${repoPath(repo)}/git/commits/${encodeURIComponent(head)}`,
        );
        if (!cRes.ok) throw new GitAdapterError('invalid', cData?.message || 'parent commit failed');
        parentTreeSha = cData.tree.sha;
        const { res: tRes, data: tData } = await json(
          `${repoPath(repo)}/git/trees/${encodeURIComponent(parentTreeSha)}?recursive=1`,
        );
        if (!tRes.ok) throw new GitAdapterError('invalid', tData?.message || 'parent tree failed');
        baseEntries = (tData.tree || []).filter((e) => e.type === 'blob');
      }

      const byPath = new Map(baseEntries.map((e) => [e.path, e]));
      for (const f of files) {
        const path = normalizeRepoPath(f?.path);
        if (!path) throw new GitAdapterError('invalid', `Bad path "${f?.path}"`);
        if (f.delete) {
          byPath.delete(path);
        } else {
          const { res, data } = await json(`${repoPath(repo)}/git/blobs`, {
            method: 'POST',
            body: { content: String(f.content ?? ''), encoding: 'utf-8' },
          });
          if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'blob create failed');
          byPath.set(path, { path, mode: '100644', type: 'blob', sha: data.sha });
        }
      }

      const fullTree = [...byPath.values()].map((e) => ({
        path: e.path,
        mode: e.mode || '100644',
        type: 'blob',
        sha: e.sha,
      }));

      // Deletes need a full tree (no base_tree). Adds/edits can use base_tree.
      const hasDelete = files.some((f) => f.delete);
      const treeBody = (!hasDelete && parentTreeSha)
        ? { base_tree: parentTreeSha, tree: treeDiff(baseEntries, fullTree) }
        : { tree: fullTree };

      const { res: treeRes, data: treeData } = await json(`${repoPath(repo)}/git/trees`, {
        method: 'POST',
        body: treeBody,
      });
      if (!treeRes.ok) {
        throw new GitAdapterError('invalid', treeData?.message || 'tree create failed');
      }

      const { res: commitRes, data: commitData } = await json(`${repoPath(repo)}/git/commits`, {
        method: 'POST',
        body: {
          message: String(message || 'Update'),
          tree: treeData.sha,
          parents: head ? [head] : [],
        },
      });
      if (!commitRes.ok) {
        throw new GitAdapterError('invalid', commitData?.message || 'commit create failed');
      }
      const newSha = commitData.sha;

      if (head) {
        const { res: refRes, data: refData } = await json(
          `${repoPath(repo)}/git/refs/heads/${encodeURIComponent(target)}`,
          { method: 'PATCH', body: { sha: newSha, force: false } },
        );
        if (refRes.status === 422) {
          throw new GitAdapterError('non_fast_forward', refData?.message || `${target} moved`);
        }
        if (!refRes.ok) {
          throw new GitAdapterError('invalid', refData?.message || 'ref update failed');
        }
      } else {
        const { res: refRes, data: refData } = await json(`${repoPath(repo)}/git/refs`, {
          method: 'POST',
          body: { ref: `refs/heads/${target}`, sha: newSha },
        });
        if (!refRes.ok) {
          throw new GitAdapterError('invalid', refData?.message || 'ref create failed');
        }
      }

      return { sha: newSha, parents: head ? [head] : [], branch: target };
    },

    async compare(repo, base, head) {
      const { res, data } = await json(
        `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      );
      if (res.status === 404) {
        throw new GitAdapterError('not_found', `Cannot compare ${base}...${head}`);
      }
      if (!res.ok) throw new GitAdapterError('invalid', data?.message || 'compare failed');

      let headSha = data.commits?.length
        ? data.commits[data.commits.length - 1].sha
        : null;
      let baseSha = data.base_commit?.sha || null;
      if (!headSha) headSha = await resolveSha(repo, head);
      if (!baseSha) baseSha = await resolveSha(repo, base);
      // identical → head == merge base
      if (!headSha && data.status === 'identical') {
        headSha = data.merge_base_commit?.sha || baseSha;
      }

      const files = (data.files || [])
        .map((f) => ({ path: f.filename, status: mapFileStatus(f.status) }))
        .sort((a, b) => a.path.localeCompare(b.path));

      return {
        status: data.status || 'identical',
        aheadBy: data.ahead_by || 0,
        behindBy: data.behind_by || 0,
        mergeBaseSha: data.merge_base_commit?.sha || null,
        baseSha,
        headSha,
        files,
      };
    },
  };

  return assertGithubAdapter(adapter);
}

function filterTree(tree, prefix) {
  const out = [];
  for (const e of tree || []) {
    if (e.type !== 'blob') continue;
    if (prefix && !e.path.startsWith(prefix)) continue;
    out.push({ path: e.path, type: 'blob', sha: e.sha });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function treeDiff(baseEntries, nextEntries) {
  const base = new Map(baseEntries.map((e) => [e.path, e.sha]));
  const changes = [];
  for (const e of nextEntries) {
    if (base.get(e.path) !== e.sha) {
      changes.push({ path: e.path, mode: e.mode || '100644', type: 'blob', sha: e.sha });
    }
  }
  return changes;
}

function mapFileStatus(s) {
  if (s === 'added') return 'added';
  if (s === 'removed') return 'removed';
  return 'modified';
}

function decodeBase64Utf8(b64) {
  const Buf = globalThis.Buffer;
  if (typeof Buf !== 'undefined') {
    return Buf.from(b64, 'base64').toString('utf8');
  }
  const bin = atob(b64);
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  return bin;
}
