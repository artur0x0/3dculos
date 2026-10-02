#!/usr/bin/env node
/**
 * Error toasts carry an Undo button, and the fillet scrap message says what
 * to do about it.
 *
 * Before: the scrap notice read "Fillet left zero-area faces. Undo restores
 * the solid." — it *told* the user to undo and then left them to go find the
 * button. Now it reads "Unable to generate clean fillet, please try smaller
 * size." and the toast itself carries the Undo.
 *
 * Toast payloads are `{ text, undo }`. `undo` defaults ON because almost every
 * toast in the viewport is a refusal; purely informational hints opt out with
 * `{ undo: false }`. The button additionally renders only when `canUndo` says
 * there is history to pop, so it never offers a no-op.
 *
 * Static source assertions — these are render-path/JSX concerns that the mesh
 * goldens cannot reach.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const VP = join(here, '..', '..', 'src', 'components', 'Viewport.jsx');
const src = readFileSync(VP, 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('error toasts — Undo button + fillet scrap copy');

// ---- the copy ----
check(
  'fillet scrap notice uses the new wording',
  src.includes('Unable to generate clean fillet, please try smaller size.'),
  'new string not found',
);
check(
  'old zero-area wording is gone',
  !src.includes('Fillet left zero-area faces'),
  'old string still present',
);

// ---- the payload shape ----
check('toastPayload helper exists', /const toastPayload = \(msg, opts\)/.test(src));
check(
  'undo defaults ON (errors are the common case)',
  /undo:\s*opts\?\.undo !== false/.test(src),
  'default is not opt-out',
);

// ---- the button ----
check('ToastUndo component exists', /const ToastUndo = \(\{ show \}\)/.test(src));
check(
  'Undo button is gated on canUndo so it is never a no-op',
  /show && canUndo \?/.test(src),
  'canUndo gate missing',
);
check(
  'Undo button calls onUndo',
  /onUndo\?\.\(\)/.test(src),
  'onUndo not wired',
);
check(
  'button re-enables pointer events (bubbles are pointer-events-none)',
  /data-toast-undo="1"/.test(src) && /pointer-events-auto/.test(src),
  'button would not be clickable inside the toast bubble',
);
check(
  'button stops propagation so the tap does not reach the viewport',
  /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(src),
  'tap would fall through to edge/face picking',
);

// ---- every toast renders it ----
for (const t of ['edgeModeToast', 'contourToast', 'filletToast', 'shellToast']) {
  check(
    `${t} renders text + Undo`,
    new RegExp(`\\{${t}\\.text\\}`).test(src) && new RegExp(`show=\\{${t}\\.undo\\}`).test(src),
    'not wired',
  );
  check(
    `${t} no longer renders a bare string`,
    !new RegExp(`\\{${t}\\}\\s*\\n`).test(src),
    'still rendered as a raw string — would print [object Object]',
  );
}
check(
  'fillet scrap notice always offers Undo',
  /<ToastUndo show \/>/.test(src),
  'scrap notice has no Undo',
);

// ---- informational toasts opt out ----
check(
  'the edge-pick hint opts out of Undo',
  /Edge pick on — tap near an edge \(tangent loops on\)', \{ undo: false \}/.test(src),
  'informational hint would offer a confusing Undo',
);
check(
  'the point-drag hint opts out of Undo',
  /Right-drag this point to move it[^)]*\{ undo: false \}/.test(src),
  'informational hint would offer a confusing Undo',
);

// ---- no setter left passing a raw string ----
const rawSetters = [...src.matchAll(/set(?:EdgeMode|Contour|Fillet|Shell)Toast\(([^)]*)\)/g)]
  .map((m) => m[1].trim())
  .filter((a) => a !== 'null' && !a.startsWith('toastPayload'));
check(
  'every toast setter goes through toastPayload (or clears with null)',
  rawSetters.length === 0,
  rawSetters.join(' | '),
);

if (failed) {
  console.error(`\n${failed} error-toast check(s) failed.`);
  process.exit(1);
}
console.log('\nAll error-toast Undo checks passed.');
