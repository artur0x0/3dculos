#!/usr/bin/env node
/**
 * G10: Parts session identity strip (Guest | Apple | Google | GitHub).
 * Not a Local|Git data-mode toggle. IndexedDB silent autosave for all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sessionIdentity, SESSION_IDENTITIES } from '../../src/utils/sessionIdentity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  ok(name, g === w, `got ${g}, want ${w}`);
}

console.log('G10 — sessionIdentity helper');
eq('kinds', SESSION_IDENTITIES, ['guest', 'apple', 'google', 'github']);
eq('signed out → Guest', sessionIdentity({}), { kind: 'guest', label: 'Guest' });
eq('github', sessionIdentity({
  isAuthenticated: true, user: { authProvider: 'github', email: 'a@b.c' },
}), { kind: 'github', label: 'GitHub' });
eq('apple', sessionIdentity({
  isAuthenticated: true, user: { authProvider: 'apple' },
}), { kind: 'apple', label: 'Apple' });
eq('google', sessionIdentity({
  isAuthenticated: true, user: { authProvider: 'google' },
}), { kind: 'google', label: 'Google' });
eq('local email → Guest', sessionIdentity({
  isAuthenticated: true, user: { authProvider: 'local', email: 'x@y.z' },
}), { kind: 'guest', label: 'Guest' });

console.log('\nG10 — PartFeed + App wiring (profile unify)');
{
  const feed = readFileSync(join(root, 'src/components/PartFeed.jsx'), 'utf8');
  const app = readFileSync(join(root, 'src/App.jsx'), 'utf8');
  const arch = readFileSync(join(root, 'docs/architecture.md'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  const chip = readFileSync(join(root, 'src/components/ProfileChip.jsx'), 'utf8');

  ok('Parts uses same ProfileChip as CAD (not Guest strip)',
    /data-parts-profile-chip/.test(feed)
    && /ProfileChip/.test(feed)
    && /variant="inline"/.test(feed)
    && /onAccount=\{onAccount\}/.test(feed)
    && !/data-parts-session-identity/.test(feed)
    && !/SessionIdentityIcon/.test(feed));
  ok('visible GitHub button gone; Connect is sr-only',
    !/<Github[\s\S]*?data-git-connect/.test(feed)
    && /data-git-connect=""/.test(feed)
    && /className="sr-only"[\s\S]{0,200}?data-git-connect=""/.test(feed));
  ok('Local|Git toggle removed', !/data-parts-source-toggle/.test(feed)
    && !/aria-pressed=\{source === 'git'\}/.test(feed));
  ok('no Git/Local label toggle text', !/source === 'git' \? 'Git' : 'Local'/.test(feed));
  ok('dirty badge on Commit',
    /data-git-dirty-badge/.test(feed) && /data-git-commit=""/.test(feed));
  ok('Commit/Branches still gated on source===git',
    /\{source === 'git' && \(/.test(feed));
  ok('App wires onAccount into PartFeed',
    /onAccount=\{handleAccount\}/.test(app));
  ok('ProfileChip green signed-in / grey signed-out',
    /border-green-500/.test(chip) && /border-gray-500/.test(chip)
    && !/border-blue-500/.test(chip));
  ok('ProfileChip viewport + inline variants',
    /variant === 'inline'/.test(chip) || /variant = 'viewport'/.test(chip)
    || /data-profile-chip-variant/.test(chip));

  ok('App syncs source with githubConnected',
    /githubConnected/.test(app)
    && /source: 'git'/.test(app)
    && /source: 'local'/.test(app)
    && /G10: GitHub token enables vault/.test(app));
  ok('Disconnect drops to local source',
    /handleGitDisconnect/.test(app)
    && /leaving GitHub drops vault chrome/.test(app));

  ok('architecture: profile unifies Parts + CAD',
    /ProfileChip|profile chip/i.test(arch)
    && /IndexedDB stays silent autosave/.test(arch));
  ok('architecture dropped user-facing Local|Git toggle wording on strip',
    !/data-parts-source-toggle/.test(arch)
    && /removed the user-facing Local\|Git toggle/.test(arch));
  ok('package.json has golden:session-identity', /golden:session-identity/.test(pkg));
}

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
