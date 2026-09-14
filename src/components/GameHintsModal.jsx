import React from 'react';
import { X, BookOpen } from 'lucide-react';
import { listPuzzles } from '../utils/gamePuzzle';

/**
 * Compact puzzle-vocabulary cheatsheet for game mode.
 * Mirrors the Slice 01 allowlist in HELPER_FUNCTIONS.md — not a full docs rewrite.
 * Slice 05: lists every pack puzzle title + blurb so playtest works without editor spoilers.
 */
const ROWS = [
  { name: 'filletEdges(part, edges, r, opts?)', role: 'Circular fillet on convex edges' },
  { name: 'chamferEdges(part, edges, c)', role: 'Equal-leg chamfer' },
  { name: 'convexEdges(part)', role: 'Select convex edges (for fillet/chamfer)' },
  { name: 'roundedBox(size, radius, segments?)', role: 'Box with rounded edges' },
  { name: 'clearanceHole(part, frame, u, v, size, …)', role: 'Clearance hole by fastener size' },
  { name: 'tapDrillHole(part, frame, u, v, size, …)', role: 'Tap-drill hole by fastener size' },
  { name: 'cboreHole / cskHole', role: 'Counterbore / countersink' },
  { name: 'hole / holeSpan / holePattern', role: 'Generic through-holes' },
  { name: 'tube / hexPrism / roundedBox', role: 'Primitive solids' },
  { name: 'facesByNormal / workplaneFromFace / …', role: 'Selection helpers' },
  { name: 'shell, addDraft, mirror, array3D…', role: 'Solids / layout' },
];

const GameHintsModal = ({ onClose, puzzle = null }) => {
  const pack = listPuzzles();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3">
      <div
        role="dialog"
        aria-labelledby="game-hints-title"
        className="w-full max-w-lg max-h-[85dvh] overflow-hidden flex flex-col rounded-lg bg-gray-900 border border-gray-700 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 text-white">
            <BookOpen size={18} className="text-gray-300" />
            <h2 id="game-hints-title" className="font-semibold text-sm">
              Puzzle helpers
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4 text-sm text-gray-200">
          <p className="text-xs text-gray-400">
            Match the grey ghost. Stay inside the official puzzle vocabulary.
            Prefer these names so scripts stay comparable. Loud failures on bad
            inputs are expected. Editor stays blank on enter — use the blurbs
            below for what to build.
          </p>

          <div>
            <div className="text-xs font-semibold text-gray-300 mb-2">Puzzle pack</div>
            <ul className="space-y-2">
              {pack.map((p) => {
                const active = puzzle?.id === p.id;
                return (
                  <li
                    key={p.id}
                    className={`rounded border px-3 py-2 ${
                      active
                        ? 'border-gray-400 bg-gray-800/80'
                        : 'border-gray-800 bg-gray-900/40'
                    }`}
                  >
                    <div className="text-xs font-semibold text-gray-100">
                      {p.title}
                      {p.difficulty ? (
                        <span className="ml-2 font-normal text-gray-500 normal-case">
                          · {p.difficulty}
                        </span>
                      ) : null}
                      {active ? (
                        <span className="ml-2 font-normal text-emerald-400/90">· current</span>
                      ) : null}
                    </div>
                    {p.blurb && (
                      <p className="text-[11px] text-gray-400 mt-0.5">{p.blurb}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {puzzle?.hint && (
            <div className="rounded border border-gray-600/50 bg-gray-800/50 p-3">
              <div className="text-xs font-semibold text-gray-300 mb-1">
                Hint · {puzzle.title}
              </div>
              <pre className="text-[11px] leading-relaxed text-gray-200 whitespace-pre-wrap font-mono overflow-x-auto">
                {puzzle.hint}
              </pre>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-gray-300 mb-2">Allowlist</div>
            <ul className="space-y-2">
              {ROWS.map((row) => (
                <li key={row.name} className="border-b border-gray-800 pb-2 last:border-0">
                  <code className="text-[11px] text-emerald-300 font-mono break-all">{row.name}</code>
                  <div className="text-xs text-gray-400 mt-0.5">{row.role}</div>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[11px] text-gray-500">
            Full reference: HELPER_FUNCTIONS.md (repo root). Unsupported: curved
            singleton fillets, open curved runs, concave “fillets”, arbitrary
            fastener sizes outside the table.
          </p>
        </div>
      </div>
    </div>
  );
};

export default GameHintsModal;
