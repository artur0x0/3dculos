/**
 * Reload must reopen the last assembly when signed in, and must not create
 * or commit the stock demo (`Part (1)` in `Assembly`) when auth is slow,
 * the session refresh fails, or the user is signed out.
 *
 * Root deps only. No backend / mongoose imports.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  ASSEMBLY_DOC_DB,
  ASSEMBLY_DOC_KEY,
  ASSEMBLY_DOC_STORE,
  LAST_OPENED_STORAGE_KEY,
  bootWouldClobber,
  bootWriteAllowed,
  canonicalRowId,
  planReloadAssembly,
  pointerForUser,
  rememberLastOpened,
  sameOpenedAssembly,
} from '../src/utils/assemblyBoot.js';
import {
  SESSION_MAX_AGE_MS,
  SESSION_ROLLING,
  SESSION_TOUCH_AFTER_SEC,
} from '../src/utils/sessionPolicy.js';
import {
  bundleFromTokenResponse,
  planTokenRefresh,
  refreshGithubAccessToken,
} from '../src/utils/git/githubTokenRefresh.js';

const GEARBOX = {
  name: 'Gearbox',
  source: 'git',
  activeId: 'local:bracket',
  parts: [{ id: 'local:bracket', name: 'Bracket', visible: true, order: 0 }],
};

const DEMO = {
  name: 'Assembly',
  source: 'local',
  activeId: 'bare-new',
  parts: [{ id: 'bare-new', name: 'Part (1)', visible: true, order: 0 }],
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function assertNeverWrites(plan) {
  assert.equal(plan.persist, false);
  assert.equal(plan.commit, false);
  assert.equal(plan.enqueue, false);
  assert.equal(plan.createAssembly, false);
  assert.equal(bootWriteAllowed(plan), false);
}

describe('reload last assembly', () => {
  test('signed-in reload reopens the last assembly while /me and the vault are slow', () => {
    const pointer = { name: 'Gearbox', activeId: 'bracket', source: 'git' };
    const steps = [
      {
        me: 'pending',
        refresh: 'pending',
        cacheStatus: 'pending',
        vaultStatus: 'pending',
        githubConnected: true,
        userId: 'user-1',
      },
      {
        me: 'pending',
        refresh: 'pending',
        cacheStatus: 'hit',
        cachedDoc: GEARBOX,
        pointer,
        userId: 'user-1',
        vaultStatus: 'pending',
        githubConnected: true,
      },
      {
        me: 'in',
        refresh: 'idle',
        cacheStatus: 'hit',
        cachedDoc: GEARBOX,
        pointer,
        userId: 'user-1',
        vaultStatus: 'pending',
        githubConnected: true,
      },
    ];
    const plans = steps.map((step) => planReloadAssembly(step));
    assert.equal(plans[0].action, 'wait');
    assert.equal(plans[0].reason, 'auth-pending');
    assert.equal(plans[1].action, 'wait');
    assert.equal(plans[2].action, 'reopen-cache');
    assert.equal(plans[2].doc.name, 'Gearbox');
    assert.equal(plans[2].chip, 'show');
    assert.equal(canonicalRowId(plans[2].doc.activeId), canonicalRowId('local:bracket'));
    assert.equal(sameOpenedAssembly(pointer, GEARBOX), true);
    for (const plan of plans) assertNeverWrites(plan);
    assert.equal(bootWouldClobber(GEARBOX, DEMO), true);
    assert.equal(bootWouldClobber(null, DEMO), true);
  });

  test('cache timeout does not invent a demo; a ready vault reopens the pointer', () => {
    const waiting = planReloadAssembly({
      me: 'in',
      cacheStatus: 'timeout',
      cachedDoc: null,
      pointer: { name: 'Gearbox', activeId: 'local:bracket' },
      userId: 'user-1',
      vaultStatus: 'pending',
      githubConnected: true,
    });
    assert.equal(waiting.action, 'wait');
    assert.equal(waiting.reason, 'vault-pending');
    assert.equal(waiting.name, 'Gearbox');
    assertNeverWrites(waiting);

    const opened = planReloadAssembly({
      me: 'in',
      cacheStatus: 'timeout',
      pointer: { name: 'Gearbox', activeId: 'local:bracket' },
      userId: 'user-1',
      vaultStatus: 'ready',
      githubConnected: true,
    });
    assert.equal(opened.action, 'reopen-vault');
    assert.equal(opened.name, 'Gearbox');
    assert.equal(opened.doc, null);
    assertNeverWrites(opened);
  });

  test('expired session: quiet refresh keeps the assembly; a failed refresh clears the chip', () => {
    const kept = planReloadAssembly({
      me: 'out',
      refresh: 'ok',
      cacheStatus: 'hit',
      cachedDoc: GEARBOX,
      pointer: { name: 'Gearbox', activeId: 'bracket' },
      userId: 'user-1',
      vaultStatus: 'pending',
      githubConnected: true,
    });
    assert.equal(kept.action, 'reopen-cache');
    assert.equal(kept.doc.name, 'Gearbox');
    assertNeverWrites(kept);

    const dropped = planReloadAssembly({
      me: 'out',
      refresh: 'failed',
      cacheStatus: 'hit',
      cachedDoc: GEARBOX,
      pointer: { name: 'Gearbox', activeId: 'bracket' },
      userId: 'user-1',
      vaultStatus: 'ready',
      githubConnected: false,
    });
    assert.equal(dropped.action, 'clear');
    assert.equal(dropped.chip, 'clear');
    assert.equal(dropped.reason, 'session-refresh-failed');
    assert.equal(dropped.doc, null);
    assertNeverWrites(dropped);
  });

  test('signed out does not load or create a default assembly', () => {
    const plan = planReloadAssembly({
      me: 'out',
      refresh: 'idle',
      cacheStatus: 'hit',
      cachedDoc: GEARBOX,
      pointer: { name: 'Gearbox', activeId: 'local:bracket' },
      userId: 'user-1',
      vaultStatus: 'ready',
      githubConnected: false,
    });
    assert.equal(plan.action, 'clear');
    assert.equal(plan.chip, 'clear');
    assert.equal(plan.reason, 'signed-out');
    assertNeverWrites(plan);
    assert.equal(plan.doc, null);
  });

  test('a per-user pointer beats a global demo document left in IndexedDB', () => {
    const plan = planReloadAssembly({
      me: 'in',
      cacheStatus: 'hit',
      cachedDoc: DEMO,
      pointer: { name: 'Gearbox', activeId: 'local:bracket' },
      userId: 'user-1',
      vaultStatus: 'ready',
      githubConnected: true,
    });
    assert.equal(plan.action, 'reopen-vault');
    assert.equal(plan.name, 'Gearbox');
    assert.equal(plan.reason, 'pointer-over-demo');
    assertNeverWrites(plan);
  });

  test('pointer storage is per-user and keeps a legacy local: active id', () => {
    const storage = memoryStorage();
    const saved = rememberLastOpened(storage, 'user-1', GEARBOX);
    assert.equal(saved.activeId, 'local:bracket');
    assert.equal(canonicalRowId(saved.activeId), 'bracket');
    const raw = JSON.parse(storage.getItem(LAST_OPENED_STORAGE_KEY));
    assert.equal(raw['user-1'].name, 'Gearbox');
    assert.equal(pointerForUser(raw, 'user-2'), null);
    assert.equal(ASSEMBLY_DOC_DB, 'surfcad-assembly');
    assert.equal(ASSEMBLY_DOC_STORE, 'assembly');
    assert.equal(ASSEMBLY_DOC_KEY, 'current');
  });

  test('the boot effect does not persist a demo seed before auth is ready', () => {
    const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
    const start = app.indexOf('Restore editor + assembly');
    const end = app.indexOf('Mirror the live CAD buffer');
    assert.ok(start > 0 && end > start);
    const boot = app.slice(start, end);
    assert.equal(boot.includes('Persist the seed we already showed'), false);
    assert.match(boot, /planReloadAssembly/);
    assert.equal(/name: filename \|\| DEFAULT_PART_NAME/.test(boot), false);
    assert.equal(/setEditorInitialScript\(DEFAULT_SCRIPT\)/.test(app), false);
    assert.match(app, /showCadTitle=\{!!assemblyDoc\}/);
  });
});

describe('session and GitHub token refresh', () => {
  test('the server session rolls and outlives a single week', () => {
    assert.equal(SESSION_ROLLING, true);
    assert.ok(SESSION_MAX_AGE_MS >= 30 * 24 * 60 * 60 * 1000);
    assert.ok(SESSION_TOUCH_AFTER_SEC > 0);
    assert.ok(SESSION_TOUCH_AFTER_SEC <= 60 * 60);
    const session = readFileSync(new URL('../backend/auth/session.js', import.meta.url), 'utf8');
    assert.match(session, /rolling:\s*SESSION_ROLLING/);
    assert.match(session, /touchAfter:\s*SESSION_TOUCH_AFTER_SEC/);
    const oauth = readFileSync(new URL('../backend/services/githubOAuth.js', import.meta.url), 'utf8');
    assert.match(oauth, /refreshGithubOAuthToken/);
    assert.match(oauth, /grant_type:\s*'refresh_token'/);
  });

  test('an expiring GitHub user token refreshes quietly and a hard failure does not invent an assembly', async () => {
    const now = 1_700_000_000_000;
    const fresh = bundleFromTokenResponse({
      access_token: 'ghu_new',
      refresh_token: 'ghr_new',
      expires_in: 8 * 60 * 60,
      refresh_token_expires_in: 60 * 60 * 24 * 180,
    }, now);
    assert.equal(planTokenRefresh(fresh, now), 'keep');
    assert.equal(planTokenRefresh({ ...fresh, expiresAt: now + 60_000 }, now), 'refresh');
    assert.equal(planTokenRefresh({ accessToken: 'ghu_legacy' }, now), 'keep');

    const storage = memoryStorage();
    storage.setItem('surfcad.github.tokenBundle', JSON.stringify({
      accessToken: 'ghu_old',
      refreshToken: 'ghr_old',
      expiresAt: now - 1000,
      refreshExpiresAt: now + 60_000,
    }));
    const session = memoryStorage();
    let posted = null;
    const ok = await refreshGithubAccessToken({
      now,
      storage,
      session,
      fetchImpl: async (url, opts) => {
        posted = { url, body: JSON.parse(opts.body) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'ghu_new',
            refresh_token: 'ghr_new',
            expires_in: 28800,
          }),
        };
      },
    });
    assert.equal(ok.refreshed, true);
    assert.equal(ok.accessToken, 'ghu_new');
    assert.equal(posted.url, '/api/github/oauth/refresh');
    assert.equal(posted.body.refresh_token, 'ghr_old');
    assert.equal(session.getItem('surfcad.github.token'), 'ghu_new');

    const failed = await refreshGithubAccessToken({
      now,
      storage: memoryStorage({
        'surfcad.github.tokenBundle': JSON.stringify({
          accessToken: 'ghu_old',
          refreshToken: 'ghr_dead',
          expiresAt: now - 1000,
          refreshExpiresAt: 0,
        }),
      }),
      session: memoryStorage(),
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'bad refresh' }),
      }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.accessToken, '');
    const plan = planReloadAssembly({
      me: 'out',
      refresh: 'failed',
      cacheStatus: 'miss',
      githubConnected: false,
    });
    assert.equal(plan.action, 'clear');
    assertNeverWrites(plan);
  });
});
