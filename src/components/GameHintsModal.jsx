import React from 'react';
import { X, BookOpen } from 'lucide-react';

/**
 * Compact puzzle-vocabulary cheatsheet for game mode.
 * Mirrors the Slice 01 allowlist in HELPER_FUNCTIONS.md — not a full docs rewrite.
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
  { name: 'facesByNormal / workplaneFromFace / …', role: 'Selection helpers' },
  { name: 'shell, addDraft, tube, hexPrism, mirror, array3D…', role: 'Solids / layout' },
];

const DEMO_HINT = `// Demo target shape
let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;`;

const GameHintsModal = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3">
      <div
        role="dialog"
        aria-labelledby="game-hints-title"
        className="w-full max-w-lg max-h-[85dvh] overflow-hidden flex flex-col rounded-lg bg-gray-900 border border-gray-700 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 text-white">
            <BookOpen size={18} className="text-cyan-400" />
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
            Stay inside the official puzzle vocabulary. Prefer these names so
            scripts stay comparable. Loud failures on bad inputs are expected.
          </p>

          <div className="rounded border border-cyan-700/40 bg-cyan-950/30 p-3">
            <div className="text-xs font-semibold text-cyan-300 mb-2">Demo puzzle hint</div>
            <pre className="text-[11px] leading-relaxed text-cyan-100/90 whitespace-pre-wrap font-mono overflow-x-auto">
              {DEMO_HINT}
            </pre>
          </div>

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
