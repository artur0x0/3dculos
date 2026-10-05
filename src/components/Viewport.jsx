// components/Viewport.jsx
/* eslint-disable react-hooks/exhaustive-deps -- legacy: deps arrays below are tuned for
   three.js render-loop stability (scene/camera/controls live in refs); adding the flagged
   refs would rebind listeners/materials per render. Revisit deliberately, not via lint. */
import React, { useEffect, useMemo, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  PointLight,
  Mesh as ThreeMesh,
  MeshLambertMaterial,
  MeshNormalMaterial,
  MeshBasicMaterial,
  PlaneGeometry,
  ExtrudeGeometry,
  Shape,
  Quaternion,
  BufferGeometry,
  BufferAttribute,
  Raycaster,
  Vector2,
  Vector3,
  Vector4,
  Matrix4,
  Triangle,
  LineSegments,
  LineLoop,
  Line,
  LineBasicMaterial,
  ShaderMaterial,
  FrontSide,
  SphereGeometry,
  Group,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Color,
} from 'three';
import {
  makePreviewSkinMaterial,
  makePreviewOutlineMaterial,
  PREVIEW_COLORS,
  PREVIEW_OPACITY,
  PREVIEW_RENDER_ORDER,
} from '../utils/previewStyle';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import Toolbar from './Toolbar';
import CrossSectionPanel from './CrossSectionPanel';
import HelperInsertPalette from './HelperInsertPalette';
import ErrorPopup from './ErrorPopup';
import ContourModeRail from './ContourModeRail';
import ContourModeChip from './ContourModeChip';
import FilletModeChip from './FilletModeChip';
import ShellModeChip from './ShellModeChip';
import DraftModeChip from './DraftModeChip';
import CutModeChip from './CutModeChip';
import MoveModeChip from './MoveModeChip';
import MoveFaceModeChip from './MoveFaceModeChip';
import DeleteFaceModeChip from './DeleteFaceModeChip';
import { buildCrossSectionPreview, defaultTopPlaneFrame } from '../utils/crossSectionSubstrate';
import {
  applySavedContour,
  listConstructionPlanes,
  listSavedContours,
  pickContourByRay,
  savedContourRings,
  withAutoPickedContour,
} from '../utils/savedContours';
import { shouldClearViewportScript } from '../utils/helperPaletteSnippets';
import {
  addLoftProfile,
  buildContourPreview,
  buildExtrudeSolidPreview,
  buildLoftSolidPreview,
  buildRevolveSolidPreview,
  buildSweepSolidPreview,
  activeContourFace,
  contourWorkplaneFace,
  contourWorkplane,
  applyContourPlaneEdit,
  axisPresetFrame,
  contourHostCenter,
  enterContourState,
  intersectRayPlane,
  isExtrudeEntry,
  isLoftEntry,
  isRevolveEntry,
  isSweepEntry,
  isWorkplaneEntry,
  planeFromContourFace,
  removeLoftProfile,
  resolveContourWorkplane,
  resolveExtrudeAxis,
  resolveRevolveAxis,
  selectLoftProfile,
  setLoftProfileOffset,
  switchContourTool,
  toolToProfileParams,
  validateContourProfile,
  validateExtrudeParams,
  validateLoftProfiles,
  validateRevolveParams,
  validateSweepPath,
  worldToPlaneUV,
  workplaneOverlaySize,
  workplaneQuadCorners,
  writeLoftSelected,
} from '../utils/contourMode';
import { buildSweepPathPreview } from '../utils/edgeSweepPath';
import {
  buildFilletBlendPreview,
  enterFilletState,
  enterChamferState,
  validateFilletAccept,
  validateChamferAccept,
  defaultFilletParams,
  normalizeFilletParams,
  hasFilletModeBlock,
  hasChamferModeBlock,
} from '../utils/filletMode';
import {
  enterShellState,
  validateShellAccept,
  normalizeShellParams,
  toggleShellFaceSelection,
  popLastShellFace,
} from '../utils/shellMode';
import {
  emptyDraftState,
  applyDraftFaceTap,
  popLastDraftFace,
  clearDraftFaces,
  setDraftAngle,
  setDraftFlip,
  validateDraftAccept,
} from '../utils/draftMode';
import {
  emptyCutState,
  applyCutTap,
  popLastCutPick,
  clearCutPicks,
  setCutPlaneSource,
  setCutOriginOffset,
  setCutPickTarget,
  cutPlaneFromState,
  validateCutAccept,
  meshBodyComponents,
  bodyContainingTriangle,
  classifyCutBody,
  trianglePieceSide,
  cutBodyKey,
  cutPointsMatch,
  CUT_PIECE_COLORS,
  CUT_PIECE_OPACITY,
} from '../utils/cutMode';
import {
  emptyMoveState,
  clearMoveTarget,
  validateMoveAccept,
  movePreviewOffset,
  resolveMoveBodyAt,
  cutNormalFromScript,
  MOVE_MODE_NEED_BODY,
} from '../utils/moveMode';
import {
  emptyMoveFaceState,
  toggleMoveFaceSelection,
  popLastMoveFace,
  clearMoveFaces,
  setMoveFaceDistance,
  setMoveFaceFlip,
  validateMoveFaceAccept,
} from '../utils/moveFaceMode';
import {
  emptyDeleteFaceState,
  toggleDeleteFaceSelection,
  popLastDeleteFace,
  clearDeleteFaces,
  validateDeleteFaceAccept,
} from '../utils/deleteFaceMode';
import { contactSeamSegments } from '../utils/contactSeam';
import { dropPlanarFins, highlightBoundaryPositions } from '../utils/planarSeam';
import { classifySelectedFace } from '../utils/faceFeaturePlacement';
import { classifyFilletEdges, countDegenerateTriangles } from '../utils/filletEdgeClass';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  pickNearestEdgeScreen,
  resolveEdgePickSlopPx,
  toggleEdgeSelectionPropagated,
  popLastEdgeSelection,
  edgeKey,
  pathLengthFromEdges,
  sweepBlendHardMax,
  projectWorldToCanvas,
  edgeTrackPoint,
  edgePolyline,
} from '../utils/selectEdge';
import {
  annotateFeatureEdges,
  indexBoundaryEdgesFromGeometry,
  stampBoundaryOnSelection,
  filletOverlayTargets,
} from '../utils/boundaryEdgeIds';
import { downloadModelFromMesh, get3MFBase64FromMesh } from '../utils/exportModel';
import { parseImportedModels, loadCachedModel } from '../utils/importModel';
import { calculateQuote } from '../utils/quoting';
import { resolveViewportFaceClick, warmFaceGraph } from '../utils/selectFace';
import { formatViewerTitle } from '../utils/assembly.js';
import { buildPartGraphPatches, buildPatchOverlayArrays, PARTGRAPH_MAX_TRIANGLES } from '../utils/partGraphPatches';
import { createCuttingPlaneWidget, updateCuttingPlaneWidget } from '../utils/cuttingPlaneWidget';
import { AxesHelper } from 'three';
import { calculateMeasurements, createMeasurementLines, disposeMeasurementLines } from '../utils/measurementTool';
import { fitView, VIEW_PRESETS, VIEW_SNAP_MARGIN, panViewByNdcY, easeInOutCubic } from '../utils/viewCamera';

import { validateScript, formatValidationErrors } from '../utils/scriptValidator';
import manifoldContext from '../utils/ManifoldWorker';
import { formatGameTime } from '../utils/gamePuzzle';

/**
 * Screen-space fat-line widths (WebGL ignores LineBasicMaterial.linewidth > 1).
 * Thinned from the playtest orange (core 4 / halo 14, halo opacity cap 0.38)
 * so a selected silhouette stays readable on the solid. Hit slop is unchanged.
 */
const EDGE_CORE_PX = 2.5;
const EDGE_HALO_PX = 8;
const EDGE_HOVER_CORE_PX = 2;
const EDGE_HOVER_HALO_PX = 6;
/** Selection core opacity. Was 1 (fully opaque orange). */
const EDGE_SELECT_OPACITY = 0.72;

/** Polyline draft handles: idle cyan, amber under the cursor, orange in hand. */
const POLYLINE_POINT_COLOR = 0x22d3ee;
const POLYLINE_POINT_HOVER_COLOR = 0xfbbf24;
const POLYLINE_POINT_DRAG_COLOR = 0xf97316;
/** Handle scale targets; the render loop eases toward these (never snaps). */
const POLYLINE_POINT_SCALE = 1;
const POLYLINE_POINT_HOVER_SCALE = 1.5;
const POLYLINE_POINT_DRAG_SCALE = 1.9;

/** Screen-facing f{id} / e{id} chip. depthTest off so it stays readable on the part. */
function makeFilletIdSprite(text, worldH) {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 192, 96);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(8, 12, 176, 72);
  ctx.fillStyle = text.startsWith('e') ? '#bbf7d0' : '#7dd3fc';
  ctx.font = 'bold 52px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 96, 50);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new SpriteMaterial({
    map: tex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new Sprite(mat);
  sprite.scale.set(worldH * 2, worldH, 1);
  sprite.renderOrder = 30;
  sprite.frustumCulled = false;
  sprite.raycast = () => {};
  return sprite;
}

/** Dispose LineSegments2 Group (halo+core) or legacy LineSegments. */
function disposeEdgeOverlayObject(scene, obj) {
  if (!obj) return;
  scene?.remove(obj);
  const disposeOne = (node) => {
    node.geometry?.dispose?.();
    const mat = node.material;
    if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
    else mat?.dispose?.();
  };
  if (typeof obj.traverse === 'function') {
    obj.traverse((child) => {
      if (child !== obj) disposeOne(child);
    });
  }
  disposeOne(obj);
}

/** Assembly position is on the mesh, not in the script. Overlays and picks add it. */
function partWorldOffset(mesh) {
  const p = mesh?.position;
  if (!p || (p.x === 0 && p.y === 0 && p.z === 0)) return null;
  return p;
}

function shiftEdgeForWorld(edge, p) {
  if (!p || !edge) return edge;
  const s = (v) => (v ? [v[0] + p.x, v[1] + p.y, v[2] + p.z] : v);
  return { ...edge, va: s(edge.va), vb: s(edge.vb), mid: s(edge.mid) };
}

function geometryFromMeshData(meshData) {
  const geometry = new BufferGeometry();
  const np = meshData.numProp || 3;
  const src = meshData.vertProperties;
  const nVert = Math.floor(src.length / np);
  const positions = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const fin = dropPlanarFins(positions, new Uint32Array(meshData.triVerts));
  geometry.setIndex(new BufferAttribute(fin.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function removeContactSeam(mesh) {
  const prev = mesh?.getObjectByName?.('contactSeam');
  if (!prev) return;
  mesh.remove(prev);
  prev.geometry?.dispose?.();
  prev.material?.dispose?.();
}

/**
 * The flush cut is each body's own contour, drawn as a 1px black line on
 * that contour. Not lifted onto the side face, and not a second edge.
 * A small view-space bias keeps the line from losing the depth test against
 * the face it lies on (far plane is 2000). Only contactSeamSegments qualify,
 * so an uncut body and a one-sided cut grow nothing.
 */
function attachContactSeam(mesh, meshData) {
  removeContactSeam(mesh);
  if (!mesh || !meshData?.vertProperties || !meshData?.triVerts) return;
  const segs = contactSeamSegments(
    meshData.vertProperties,
    meshData.triVerts,
    meshData.numProp || 3,
  );
  if (!segs.length) return;
  const pos = new Float32Array(segs.length * 6);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const o = i * 6;
    pos[o] = s.a[0];
    pos[o + 1] = s.a[1];
    pos[o + 2] = s.a[2];
    pos[o + 3] = s.b[0];
    pos[o + 4] = s.b[1];
    pos[o + 5] = s.b[2];
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  const material = new ShaderMaterial({
    vertexShader: `
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        mvPosition.z += 0.5;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      void main() {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      }
    `,
    depthTest: true,
    depthWrite: false,
  });
  const line = new LineSegments(geom, material);
  line.name = 'contactSeam';
  line.raycast = () => {};
  line.frustumCulled = false;
  line.renderOrder = 3;
  mesh.add(line);
}

/** Plane + picked bodies. Drop list is not part of the key: hiding does not re-cut. */
function cutPreviewKey(state) {
  const plane = cutPlaneFromState(state);
  const bodies = state?.bodies || [];
  if (!plane || !bodies.length) return '';
  const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
  const bodyKey = bodies.map((b) => (b.at || []).map(r3).join(',')).join(';');
  if (plane.source === 'face') {
    return ['face', plane.center.map(r3).join(','), plane.normal.map(r3).join(','), r3(plane.faceOffset), bodyKey].join('|');
  }
  return [plane.source, r3(plane.originOffset), bodyKey].join('|');
}

/** Same object cut() would receive. Offset is omitted when it is 0. */
function cutPreviewPlanePayload(state) {
  const plane = cutPlaneFromState(state);
  if (!plane) return null;
  if (plane.source === 'face') {
    const payload = { center: plane.center.slice(), normal: plane.normal.slice() };
    const off = Number(plane.faceOffset);
    if (Number.isFinite(off) && off !== 0) payload.offset = off;
    return payload;
  }
  return { normal: plane.normal.slice(), originOffset: Number(plane.originOffset) || 0 };
}

function cutPreviewPieceHidden(state, piece) {
  if (!piece?.selected) return false;
  return (state?.drop || []).some((d) => {
    if (d.side !== piece.side || !Array.isArray(d.at) || !Array.isArray(piece.at)) return false;
    if (cutPointsMatch(d.at, piece.at)) return true;
    const dx = d.at[0] - piece.at[0];
    const dy = d.at[1] - piece.at[1];
    const dz = d.at[2] - piece.at[2];
    return dx * dx + dy * dy + dz * dz <= 1e-4;
  });
}

function geometryFromPreviewMesh(mesh) {
  const np = mesh?.numProp || 3;
  const src = mesh?.vertProperties;
  const tris = mesh?.triVerts;
  if (!src?.length || !tris?.length) return null;
  const n = Math.floor(src.length / np);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.setIndex(new BufferAttribute(Uint32Array.from(tris), 1));
  geom.computeVertexNormals();
  return geom;
}

/** Shared top title. Puzzle name in game; filename on mobile CAD. */
/** Filenames land in `${name}.js` downloads, so keep them path-safe and short. */
function sanitizePartName(raw) {
  return String(raw ?? '')
    .replace(/[/\\:*?"<>|]/g, '')   // path + Windows-illegal characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const TITLE_CHIP = 'text-xs font-medium text-center truncate px-3 py-1.5 rounded-lg shadow'
  + ' bg-gray-900/80 surface-glass-chip border border-gray-500/50 text-gray-100';

/**
 * Title chip. With `onRename` it is also the rename control: click (or Enter /
 * Space on the focused chip) swaps in an input. Enter or blur commits, Escape
 * reverts. An empty or all-junk name commits nothing, so the part falls back to
 * "Untitled" rather than becoming nameless.
 *
 * `inline` sits in the CAD title row (part, then "in", then the assembly).
 * The floating form is the game puzzle name, alone at the top.
 * `noun` is "Part" or "Assembly" — same commit rules, different label.
 */
function ViewportTitleChip({ children, value = null, onRename = null, inline = false, noun = 'Part' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    if (!onRename) return;
    setDraft(value || '');
    setEditing(true);
  };

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    const next = sanitizePartName(draft);
    if (next && next !== (value || '')) onRename(next);
  };

  const shell = TITLE_CHIP;
  const role = noun === 'Assembly' ? 'assembly' : 'part';
  const renameTitle = noun === 'Assembly' ? 'Click to rename this assembly' : 'Click to rename this part';
  const shown = value || (noun === 'Assembly' ? '' : 'Untitled');
  const frame = inline
    ? `relative z-10 min-w-0 max-w-[min(14rem,42vw)] ${onRename ? 'pointer-events-auto' : 'pointer-events-none'}`
    : `absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-[min(20rem,calc(100%-2rem))] ${
      onRename ? '' : 'pointer-events-none'
    }`;

  return (
    <div className={frame}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            e.stopPropagation(); // viewport hotkeys must not eat the typing
          }}
          className={`${shell} w-48 outline-none border-blue-400/80 bg-gray-900`}
          aria-label={noun === 'Assembly' ? 'Assembly name' : 'Part name'}
          data-title-chip="input"
          data-title-role={role}
          {...(role === 'assembly' ? { 'data-assembly-name': '' } : {})}
        />
      ) : onRename ? (
        <button
          type="button"
          onClick={start}
          className={`${shell} hover:border-blue-400/70 hover:text-white cursor-text`}
          title={renameTitle}
          aria-label={`${noun} name: ${shown}. Click to rename.`}
          data-title-chip="button"
          data-title-role={role}
          {...(role === 'assembly' ? { 'data-assembly-name': '' } : {})}
        >
          {children}
        </button>
      ) : (
        <div
          className={shell}
          data-title-chip="static"
          data-title-role={role}
          {...(role === 'assembly' ? { 'data-assembly-name': '' } : {})}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Execution limits
const EXECUTION_LIMITS = {
  timeoutMs: 30000,      // 30 seconds max execution time
  memoryLimitMB: 512,    // 512 MB memory limit
};

const Viewport = forwardRef(({ 
  onAccount,
  currentScript, 
  onFaceSelected, 
  onOpen,
  onSave,
  onQuote,
  onUpload,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  currentFilename,
  /** Assembly document name. Blank documents resolve to Assembly before this. */
  assemblyName = '',
  onRenameFile = null,
  /** Same click-to-edit as the part chip. Writes the document name. */
  onRenameAssembly = null,
  isUploading,
  mode = 'cad',
  ghostMeshData = null,
  onStartGame,
  onExitGame,
  onRun,
  /** CAD strip Select all — App owns the editor ref, so it passes the action. */
  onSelectAll = null,
  onHint,
  onPickPuzzle,
  gameElapsedMs = 0,
  gameSuccess = false,
  gamePuzzleTitle = null,
  gameBestTimeMs = null,
  isMobile = false,
  onInsertHelper = null,
  onCommitContourProfile = null,
  onCommitFillet = null,
  onCommitShell = null,
  onCommitDraft = null,
  onCommitCut = null,
  onCommitMove = null,
  onCommitMoveFace = null,
  onCommitDeleteFace = null,
  getHelperBuffer = null,
  /** Mobile CAD mid-strip host (CodeEditor). Null on desktop and in game. */
  cadToolbarHost = null,
  /** CAD Run. When set, the strip runs the assembly instead of one script. */
  onRunAssembly = null,
  /** Slice Mobile C: long-press on body opens feature sheet (mobile CAD only). */
  featureSheetEnabled = false,
  onFeatureLongPress = null,
}, ref) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const resultRef = useRef(null);
  const assemblyGroupRef = useRef(null);
  const assemblyExtrasRef = useRef(new Map());
  const clearAssemblyExtrasRef = useRef(() => {});
  const placeAssemblyRef = useRef(() => false);
  const ghostMeshRef = useRef(null);
  const raycasterRef = useRef(new Raycaster());
  const mouseRef = useRef(new Vector2());
  const highlightMeshRef = useRef(null);
  const cuttingPlaneWidgetRef = useRef(null);
  const axisHelperRef = useRef(null);
  const executionAbortRef = useRef(null);
  // Mirrors the last execution error for the dev-only __VIEWPORT__ hook (the real handler
  // stores it in state, which a headless caller cannot read synchronously).
  const stageExecErrorRef = useRef(null);

  const clickCountRef = useRef(0);
  const clickTimerRef = useRef(null);
  const lastClickTimeRef = useRef(0);
  const pendingClickDataRef = useRef(null);
  // Multi-face pick. Each entry is { center, normal, indices }.
  // Shell (in mode) accumulates every tap — no shift — and toggles a face
  // that is already selected, same as the edge picker. Draft still shift-adds.
  // Shell and Draft read the list off selectedFace.group; every other feature
  // keeps using the LAST pick.
  const facePickGroupRef = useRef(null);
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  /** Slice Mobile C: pointer-hold opens feature sheet without conflicting with orbit. */
  const featureLongPressTimerRef = useRef(null);
  const featureLongPressOriginRef = useRef(null);
  const featureLongPressFiredRef = useRef(false);
  const featureSheetEnabledRef = useRef(featureSheetEnabled);
  featureSheetEnabledRef.current = featureSheetEnabled;
  const onFeatureLongPressRef = useRef(onFeatureLongPress);
  onFeatureLongPressRef.current = onFeatureLongPress;
  const measurementLinesRef = useRef(null); 

  // Configuration for click detection
  const MULTI_CLICK_DELAY = 300; // ms to wait for additional clicks
  const ANGLE_TOLERANCE_DEGREES = 3; // Angular tolerance for double-click selection
  const DRAG_THRESHOLD = 3; // pixels - movement beyond this is considered a drag
  
  const [selectedFace, setSelectedFace] = useState(null);
  /** Slice 12: 'face' | 'edge' — mutually exclusive pick modes. */
  const [pickMode, setPickMode] = useState('face');
  /**
   * Plane / contour overlay visibility. Independent of Face/Edge.
   * Session state only (same as pick mode) — both default on.
   */
  const [showPlanes, setShowPlanes] = useState(true);
  const [showContours, setShowContours] = useState(true);
  /** Edges PR2: patch-colour debug overlay (PartGraph). Default off. Lazy-built. */
  const [showPatchOverlay, setShowPatchOverlay] = useState(false);
  const [selectedEdges, setSelectedEdges] = useState([]);
  /** Slice B+C: latest selection for orbit-synced HTML edge chips (animate loop). */
  const selectedEdgesRef = useRef([]);
  selectedEdgesRef.current = selectedEdges;
  const edgeChipElsRef = useRef(new Map());
  const edgeChipProjectTmpRef = useRef(new Vector3());
  const featureEdgesRef = useRef([]);
  const graphTimingRef = useRef(null);
  const runTimingStartRef = useRef(0);
  /** Geometry identity that featureEdgesRef was built from — invalidate on replace. */
  const featureEdgesSourceRef = useRef(null);
  /** Mesh object the face/edge/contour graphs were last built for. */
  const graphsBoundMeshRef = useRef(null);
  const adoptActiveSolidRef = useRef(() => false);
  /** Per-triangle Manifold faceID from the last worker mesh (not a per-vertex attribute). */
  const faceIDsRef = useRef(null);
  /**
   * Edges PR2: PartGraph built lazily on the main thread when the patch overlay
   * is toggled on (never shipped from worker serializeResult — #88/#89).
   */
  const partGraphRef = useRef(null);
  const partGraphSourceRef = useRef(null);
  const patchOverlayMatRef = useRef(null);
  const preOverlayMaterialRef = useRef(null);
  /** True only while the patch overlay has replaced base geometry/material. */
  const patchOverlayActiveRef = useRef(false);
  const boundaryTopoRef = useRef(null);
  const idLabelGroupRef = useRef(null);
  const edgeHighlightRef = useRef(null);
  const edgeHoverRef = useRef(null);
  /** Slice 21: plane+profile preview overlay while HelperParamModal is open. */
  const xsPreviewRef = useRef(null);
  /** Saved makeCrossSection wires while contour mode is open. */
  const savedContourGhostRef = useRef(null);
  const pathPreviewRef = useRef(null);
  const edgePickScratchA = useRef(new Vector3());
  const edgePickScratchB = useRef(new Vector3());
  const pickModeRef = useRef('face');
  const showPlanesRef = useRef(true);
  const showContoursRef = useRef(true);
  const edgeModeToastShownRef = useRef(false);
  const edgeModeToastTimerRef = useRef(null);
  const [edgeModeToast, setEdgeModeToast] = useState(null);
  /** Slice 24/25/26/28/30: contour-mode shell (Profile-in-mode; Extrude / Revolve / Loft / Sweep commit a solid). */
  const [contourMode, setContourMode] = useState(null);
  const [selectedPlaneId, setSelectedPlaneId] = useState(null);
  const [armedContourId, setArmedContourId] = useState(null);
  const [sceneReady, setSceneReady] = useState(false);
  const contourModeRef = useRef(null);
  const workplaneOverlayRef = useRef(null);
  const constructionPlaneRef = useRef(null);
  const savedContoursRef = useRef([]);
  const savedContourHostPlaneRef = useRef(null);
  const polylineDraftRef = useRef(null);
  /** Scratch for projecting handles to screen space (no per-frame alloc). */
  const polylineProjectScratch = useRef(new Vector3());
  /** Index of the draft point under the cursor (-1 = none). */
  const polylinePointHoverRef = useRef(-1);
  /** Live right-drag: { index, plane, moved } while a point is being moved. */
  const polylinePointDragRef = useRef(null);
  /** TrackballControls noRotate/noPan saved while a point handle is grabbed. */
  const polylineControlsLockRef = useRef(null);
  const extrudePreviewRef = useRef(null);
  const revolvePreviewRef = useRef(null);
  const loftPreviewRef = useRef(null);
  const sweepPreviewRef = useRef(null);
  const contourGhostMatsRef = useRef(null);
  const [contourToast, setContourToast] = useState(null);
  const contourToastTimerRef = useRef(null);
  /** Slice 27: Fillet-in-mode (enter without edges; Accept commits sweep fillet). */
  const [filletMode, setFilletMode] = useState(null);
  const filletModeRef = useRef(null);
  const [shellMode, setShellMode] = useState(null);
  const shellModeRef = useRef(null);
  const [draftMode, setDraftMode] = useState(null);
  const draftModeRef = useRef(null);
  const [cutMode, setCutMode] = useState(null);
  const cutModeRef = useRef(null);
  const [moveMode, setMoveMode] = useState(null);
  const moveModeRef = useRef(null);
  const [moveFaceMode, setMoveFaceMode] = useState(null);
  const moveFaceModeRef = useRef(null);
  const [deleteFaceMode, setDeleteFaceMode] = useState(null);
  const deleteFaceModeRef = useRef(null);
  /** Kernel centroids from the last execute. move() matches these, not the viewport average. */
  const bodyCentroidsRef = useRef([]);
  const movePreviewRef = useRef(null);
  const moveFacePreviewRef = useRef(null);
  const moveFaceBaseMaterialRef = useRef(null);
  const moveFaceHiddenMatRef = useRef(null);
  const moveFaceLiveKeyRef = useRef('');
  const moveFacePreviewGenRef = useRef(0);
  const moveFacePreviewTimerRef = useRef(null);
  const clearMoveFacePreviewRef = useRef(() => {});
  const clearDeleteFacePreviewRef = useRef(() => {});
  const cutPlaneWidgetRef = useRef(null);
  const cutPiecesPreviewRef = useRef(null);
  const cutBaseMaterialRef = useRef(null);
  const cutBaseHiddenMatRef = useRef(null);
  const cutLiveKeyRef = useRef('');
  const cutLivePiecesRef = useRef(null);
  const cutPreviewGenRef = useRef(0);
  const cutPreviewTimerRef = useRef(null);
  const clearCutPiecePreviewRef = useRef(() => {});
  const [shellToast, setShellToast] = useState(null);
  const shellToastTimerRef = useRef(null);
  /** Slice C: restore Face/Edge after Fillet Accept / exit (do not snap to default). */
  const filletPriorPickModeRef = useRef('face');
  const filletBlendPreviewRef = useRef(null);
  const [filletToast, setFilletToast] = useState(null);
  const filletToastTimerRef = useRef(null);
  /** Bumps when the solid mesh is replaced so fillet easy/hard recomputes. */
  const [meshEpoch, setMeshEpoch] = useState(0);
  /** Set on Fillet Accept with preDeg; next successful run reports NEW scrap only. */
  const filletQualityWatchRef = useRef(null);
  const [filletScrapNotice, setFilletScrapNotice] = useState(null);
  /** Successful Fillet Accept already left the mode; don't toast a false re-pick. */
  const edgeRematchToastSuppressRef = useRef(false);
  /** G1 tangent chain propagation for Edge pick — ON by default (circular / fillet loops). */
  const [tangentProp, setTangentProp] = useState(true);
  const tangentPropRef = useRef(true);
  /** Mobile C.2 — current feature-sheet camera lift in NDC-Y (0 = none). */
  const sheetLiftNdcRef = useRef(0);
  const sheetLiftTweenRef = useRef(null);

  /**
   * Toast payload. Errors carry an Undo affordance so a bad Accept is one tap
   * from reverted — the scrap notice used to just *say* "Undo restores the
   * solid" and leave the user to find the button.
   *
   * Most toasts are refusals, so `undo` defaults ON; purely informational
   * hints opt out with `{ undo: false }`. The button still only renders when
   * `canUndo` says there is history to pop.
   */
  const toastPayload = (msg, opts) => (
    msg == null ? null : { text: String(msg), undo: opts?.undo !== false }
  );

  const armEdgeModeToastClear = () => {
    if (edgeModeToastTimerRef.current) clearTimeout(edgeModeToastTimerRef.current);
    edgeModeToastTimerRef.current = setTimeout(() => {
      edgeModeToastTimerRef.current = null;
      setEdgeModeToast(null);
    }, 2800);
  };
  const armContourToastClear = () => {
    if (contourToastTimerRef.current) clearTimeout(contourToastTimerRef.current);
    contourToastTimerRef.current = setTimeout(() => {
      contourToastTimerRef.current = null;
      setContourToast(null);
    }, 3200);
  };
  const showContourToast = (msg, opts) => {
    setContourToast(toastPayload(msg, opts));
    armContourToastClear();
  };
  const armFilletToastClear = () => {
    if (filletToastTimerRef.current) clearTimeout(filletToastTimerRef.current);
    filletToastTimerRef.current = setTimeout(() => {
      filletToastTimerRef.current = null;
      setFilletToast(null);
    }, 3200);
  };
  const showFilletToast = (msg, opts) => {
    setFilletToast(toastPayload(msg, opts));
    armFilletToastClear();
  };
  const armShellToastClear = () => {
    if (shellToastTimerRef.current) clearTimeout(shellToastTimerRef.current);
    shellToastTimerRef.current = setTimeout(() => {
      shellToastTimerRef.current = null;
      setShellToast(null);
    }, 3200);
  };
  const showShellToast = (msg, opts) => {
    setShellToast(toastPayload(msg, opts));
    armShellToastClear();
  };
  const [materials, setMaterials] = useState([]);
  const materialsRef = useRef(materials);
  materialsRef.current = materials;
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Cross-section state
  const [crossSectionEnabled, setCrossSectionEnabled] = useState(false);
  const [crossSectionPlane, setCrossSectionPlane] = useState({
    normal: [0, 0, 1],
    originOffset: 0,
    showPlane: true
  });
  const [modelBounds, setModelBounds] = useState(null);
  // Mouse handlers must resolve the workplane against live bounds without
  // rebinding listeners on every recompute.
  const modelBoundsRef = useRef(null);
  modelBoundsRef.current = modelBounds;
  const [cachedMeshData, setCachedMeshData] = useState(null);
  /** Always-current mesh for failed Auto-Run restore (state alone is stale in closures). */
  const cachedMeshDataRef = useRef(null);
  
  // Measurement tool and axis helper state
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurementFaces, setMeasurementFaces] = useState({ first: null, second: null });
  const [axisHelperEnabled, setAxisHelperEnabled] = useState(false);
  // Re-frame the part after each successful run, preserving the current orbit direction.
  const [autoFitEnabled, setAutoFitEnabled] = useState(true);

  pickModeRef.current = pickMode;
  showPlanesRef.current = showPlanes;
  showContoursRef.current = showContours;
  tangentPropRef.current = tangentProp;
  cachedMeshDataRef.current = cachedMeshData;
  contourModeRef.current = contourMode;
  filletModeRef.current = filletMode;
  shellModeRef.current = shellMode;
  draftModeRef.current = draftMode;
  cutModeRef.current = cutMode;
  moveModeRef.current = moveMode;
  moveFaceModeRef.current = moveFaceMode;
  deleteFaceModeRef.current = deleteFaceMode;

  useImperativeHandle(ref, () => ({
    executeScript,
    /** Clear player attempt mesh (game mode enter: ghost-only until Run). */
    clearAttempt: () => {
      clearHighlight();
      disposeEdgeOverlayObject(sceneRef.current, edgeHighlightRef.current);
      edgeHighlightRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, edgeHoverRef.current);
      edgeHoverRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, xsPreviewRef.current);
      xsPreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
      pathPreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, workplaneOverlayRef.current);
      workplaneOverlayRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, polylineDraftRef.current);
      polylineDraftRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, extrudePreviewRef.current);
      extrudePreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, revolvePreviewRef.current);
      revolvePreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, loftPreviewRef.current);
      loftPreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, sweepPreviewRef.current);
      sweepPreviewRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, filletBlendPreviewRef.current);
      filletBlendPreviewRef.current = null;
      setContourMode(null);
      contourModeRef.current = null;
      setFilletMode(null);
      filletModeRef.current = null;
      setShellMode(null);
      shellModeRef.current = null;
      setDraftMode(null);
      draftModeRef.current = null;
      setCutMode(null);
      cutModeRef.current = null;
      setMoveMode(null);
      moveModeRef.current = null;
      clearMoveFacePreviewRef.current();
      setMoveFaceMode(null);
      moveFaceModeRef.current = null;
      clearDeleteFacePreviewRef.current();
      setDeleteFaceMode(null);
      deleteFaceModeRef.current = null;
      setContourToast(null);
      setFilletToast(null);
      setShellToast(null);
      setSelectedFace(null);
      setSelectedEdges([]);
      onFaceSelected?.(null);
      setCachedMeshData(null);
      setExecutionError(null);
      setModelBounds(null);
      if (resultRef.current) {
        removeContactSeam(resultRef.current);
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
        resultRef.current.position.set(0, 0, 0);
      }
      clearAssemblyExtrasRef.current();
      featureEdgesRef.current = [];
      featureEdgesSourceRef.current = null;
    },
    /** Frame ghost with phone-friendly margin (puzzle enter / switch). */
    frameGhost: () => {
      const geom = ghostMeshRef.current?.geometry;
      // Skip empty BufferGeometry ghosts (cleared state) before fitView bbox work.
      if (!geom?.attributes?.position || !cameraRef.current) return false;
      return fitView({
        camera: cameraRef.current,
        controls: controlsRef.current,
        geometry: geom,
        margin: 1.55,
      });
    },
    clearFaceSelection: () => {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
    },
    clearEdgeSelection: () => {
      disposeEdgeOverlayObject(sceneRef.current, edgeHighlightRef.current);
      edgeHighlightRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, edgeHoverRef.current);
      edgeHoverRef.current = null;
      setSelectedEdges([]);
    },
    /** Soft-fail: clear stale edges + toast — never paired with emitting broken JS. */
    softFailStaleEdges: (msg) => {
      disposeEdgeOverlayObject(sceneRef.current, edgeHighlightRef.current);
      edgeHighlightRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, edgeHoverRef.current);
      edgeHoverRef.current = null;
      disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
      pathPreviewRef.current = null;
      setSelectedEdges([]);
      setEdgeModeToast(toastPayload(msg || 'Re-pick edges after geometry changes'));
      armEdgeModeToastClear();
    },
    setPickMode: (mode) => setPickMode(mode === 'edge' ? 'edge' : 'face'),
    /** Slice 24: loud-fail toast while contour mode is open. */
    softFailContour: (msg) => {
      showContourToast(msg || 'Contour mode refused — check the workplane / profile.');
    },
    /** Slice 27: loud-fail toast — keep the path visible (do not clear edges). */
    softFailFillet: (msg) => {
      showFilletToast(msg || (filletModeRef.current?.entry === 'chamferEdges'
        ? 'Chamfer refused — pick edges (disjoint sets chamfer independently), then Accept.'
        : 'Fillet refused — pick edges (disjoint sets fillet independently), then Accept.'));
    },
    softFailShell: (msg) => {
      showShellToast(msg || 'Shell refused — tap a face or choose Closed, then Confirm.');
    },
    softFailDraft: (msg) => {
      showShellToast(msg || 'Draft refused — tap the neutral face, then the faces to draft.');
    },
    softFailCut: (msg) => {
      showShellToast(msg || 'Cut refused — pick a plane and the bodies to cut.');
    },
    softFailMove: (msg) => {
      showShellToast(msg || 'Move refused — double-click a body, then Confirm.');
    },
    softFailMoveFace: (msg) => {
      showShellToast(msg || 'Move Face refused — tap a face, then Confirm.');
    },
    softFailDeleteFace: (msg) => {
      showShellToast(msg || 'Delete Face refused — tap a face, then Confirm.');
    },
    // Updated to use cached mesh when available
    export3MF: async () => {
      if (cachedMeshData?.vertProperties) {
        return get3MFBase64FromMesh(cachedMeshData);
      }
      throw new Error('No model available to export');
    },
    calculateQuote: async (options) => {
      return await calculateQuote(currentScript, options);
    },
    zoomToFit: handleZoomToFit,
    getCurrentMeshData: () => cachedMeshData,
    /**
     * Place visible assembly solids that are not the active part, and move
     * the active solid when the row stores a position. Graphs rebind to the
     * active mesh only. The extra parts are not the pick mesh.
     */
    placeAssembly: (payload) => placeAssemblyRef.current(payload),
    /** Install one part's solid and rebuild face, edge, and contour graphs. */
    adoptActiveSolid: (payload) => adoptActiveSolidRef.current(payload),
    /**
     * Mobile C.2 — tween the part away from an open under-title feature sheet.
     * `ndcY` is the target lift in NDC-Y units (positive → part moves DOWN on
     * screen, clear of a top sheet). Pass 0 to return. Edge-pick chips must
     * NOT call this. Desktop no-ops when camera/controls missing.
     */
    setFeatureSheetLift: (ndcY, opts = {}) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls?.target) return false;
      const target = Number(ndcY) || 0;
      const from = sheetLiftNdcRef.current;
      const delta = target - from;
      if (Math.abs(delta) < 1e-6) {
        sheetLiftNdcRef.current = target;
        return true;
      }
      if (sheetLiftTweenRef.current) {
        cancelAnimationFrame(sheetLiftTweenRef.current);
        sheetLiftTweenRef.current = null;
      }
      const ms = Math.max(120, Number(opts.ms) || 280);
      const t0 = performance.now();
      let applied = 0;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const eased = easeInOutCubic(t);
        const want = delta * eased;
        const slice = want - applied;
        if (Math.abs(slice) > 1e-8) {
          panViewByNdcY({ camera, controls, ndcY: slice });
          applied = want;
        }
        if (t < 1) {
          sheetLiftTweenRef.current = requestAnimationFrame(step);
        } else {
          sheetLiftTweenRef.current = null;
          sheetLiftNdcRef.current = target;
        }
      };
      sheetLiftTweenRef.current = requestAnimationFrame(step);
      return true;
    },
  }));

  // Clear face highlight
  const clearHighlight = useCallback(() => {
    if (highlightMeshRef.current) {
      if (Array.isArray(highlightMeshRef.current)) {
        highlightMeshRef.current.forEach(mesh => {
          sceneRef.current.remove(mesh);
          mesh.geometry?.dispose();
          mesh.material?.dispose();
        });
        highlightMeshRef.current = [];
      } else {
        sceneRef.current.remove(highlightMeshRef.current);
        highlightMeshRef.current.geometry?.dispose();
        highlightMeshRef.current.material?.dispose();
        highlightMeshRef.current = null;
      }
    }
    // Losing the highlight IS losing the face selection — drop the accumulated
    // multi-pick with it (processClick reads the group before calling this, so
    // an additive click still sees the previous picks).
    facePickGroupRef.current = null;
  }, []);

  const clearEdgeHighlight = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, edgeHighlightRef.current);
    edgeHighlightRef.current = null;
  }, []);

  const clearEdgeHover = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, edgeHoverRef.current);
    edgeHoverRef.current = null;
  }, []);

  /**
   * Slice B+C: project on-geometry track points to canvas so numbered edge
   * chips stick to the selected edge under orbit (not world-floating).
   */
  const updateEdgeChips = useCallback(() => {
    const cam = cameraRef.current;
    const container = containerRef.current;
    const map = edgeChipElsRef.current;
    if (!cam || !container || !map.size) return;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const tmp = edgeChipProjectTmpRef.current;
    const edges = selectedEdgesRef.current || [];
    const live = new Set();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const key = edgeKey(e);
      live.add(key);
      const el = map.get(key);
      if (!el) continue;
      const track = edgeTrackPoint(e);
      if (!track) {
        el.style.visibility = 'hidden';
        continue;
      }
      const shift = partWorldOffset(resultRef.current);
      const worldTrack = shift && track
        ? [track[0] + shift.x, track[1] + shift.y, track[2] + shift.z]
        : track;
      const scr = projectWorldToCanvas(cam, worldTrack, w, h, tmp);
      if (!scr) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.left = `${scr.x}px`;
      el.style.top = `${scr.y}px`;
    }
    for (const [key, el] of map) {
      if (!live.has(key) && el) el.style.visibility = 'hidden';
    }
  }, []);

  const edgeLineResolution = useCallback(() => {
    const r = rendererRef.current;
    if (r) {
      const sz = r.getSize(new Vector2());
      return sz;
    }
    const el = containerRef.current;
    return new Vector2(el?.clientWidth || 1, el?.clientHeight || 1);
  }, []);

  /**
   * Fat screen-space edge overlay: translucent halo + opaque core via LineSegments2.
   * WebGL ignores LineBasicMaterial.linewidth>1 on most GPUs (esp. mobile); dual-pass
   * LineMaterial stays cheap (2 draw calls, shared segment list, no CPU tube tessellation).
   */
  const paintEdgeLines = useCallback((edges, {
    color, name, opacity = 1, corePx = EDGE_CORE_PX, haloPx = EDGE_HALO_PX,
  }) => {
    if (!edges?.length || !sceneRef.current) return null;
    const positions = [];
    for (const e of edges) {
      // Slice B+C: draw the dense pre-RDP polyline so the halo sticks to the
      // real edge instead of floating on chord shortcuts through air.
      const poly = edgePolyline(e);
      if (!poly || poly.length < 2) {
        if (!e.va || !e.vb) continue;
        positions.push(e.va[0], e.va[1], e.va[2], e.vb[0], e.vb[1], e.vb[2]);
        continue;
      }
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1];
        const b = poly[i];
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    if (!positions.length) return null;
    const res = edgeLineResolution();
    const posArr = positions; // flat xyz pairs for LineSegmentsGeometry.setPositions

    const makeSeg = (linewidth, op, renderOrder) => {
      const geom = new LineSegmentsGeometry();
      geom.setPositions(posArr);
      const mat = new LineMaterial({
        color,
        linewidth,
        transparent: true,
        opacity: op,
        depthTest: false,
        depthWrite: false,
        worldUnits: false,
      });
      mat.resolution.set(res.x, res.y);
      const line = new LineSegments2(geom, mat);
      line.renderOrder = renderOrder;
      line.frustumCulled = false;
      return line;
    };

    const group = new Group();
    group.name = name;
    // Soft transparent halo first (under), then brighter core on top.
    group.add(makeSeg(haloPx, Math.min(0.2, opacity * 0.28), 10));
    group.add(makeSeg(corePx, opacity, 11));
    const shift = partWorldOffset(resultRef.current);
    if (shift) group.position.set(shift.x, shift.y, shift.z);
    sceneRef.current.add(group);
    return group;
  }, [edgeLineResolution]);

  const clearXsPreview = useCallback(() => {
    if (!xsPreviewRef.current) return;
    disposeEdgeOverlayObject(sceneRef.current, xsPreviewRef.current);
    xsPreviewRef.current = null;
  }, []);

  const clearSavedContourGhosts = useCallback(() => {
    if (!savedContourGhostRef.current) return;
    disposeEdgeOverlayObject(sceneRef.current, savedContourGhostRef.current);
    savedContourGhostRef.current = null;
  }, []);

  /**
   * Wire ghosts for every saved contour. Selected pick is amber; the rest
   * stay readable but dim so an empty menu is not the only signal.
   */
  const paintSavedContourGhosts = useCallback((contours, pickedId, hostPlane) => {
    clearSavedContourGhosts();
    if (!contours?.length || !sceneRef.current) return;
    const selected = [];
    const rest = [];
    for (const contour of contours) {
      const rings = savedContourRings(contour, hostPlane);
      const bucket = contour.id === pickedId ? selected : rest;
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        for (let i = 0; i < ring.length; i++) {
          bucket.push({ va: ring[i], vb: ring[(i + 1) % ring.length] });
        }
      }
    }
    const group = new Group();
    group.name = 'savedContourGhosts';
    const sel = paintEdgeLines(selected, {
      color: 0xff9900,
      name: 'contourSelected',
      opacity: 0.75,
      corePx: EDGE_CORE_PX,
      haloPx: EDGE_HALO_PX,
    });
    const idle = paintEdgeLines(rest, {
      color: 0xe2e8f0,
      name: 'contourIdle',
      opacity: 0.55,
      corePx: 1.5,
      haloPx: 5,
    });
    if (sel) group.add(sel);
    if (idle) group.add(idle);
    if (!group.children.length) return;
    sceneRef.current.add(group);
    savedContourGhostRef.current = group;
  }, [clearSavedContourGhosts, paintEdgeLines]);

  /**
   * Slice 21: draw profile outline(s) on the cross-section plane while editing params.
   * @param {{ face: object|null, params: object }|null} payload
   */
  const setXsPreview = useCallback((payload) => {
    clearXsPreview();
    if (!payload || !sceneRef.current) return;
    const preview = buildCrossSectionPreview(payload.face || null, payload.params || {});
    if (!preview?.rings?.length) return;
    const group = new Group();
    group.name = 'crossSectionPreview';
    const mat = new LineBasicMaterial({
      color: 0x22d3ee,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    for (const ring of preview.rings) {
      if (!ring?.length) continue;
      const positions = new Float32Array(ring.length * 3);
      for (let i = 0; i < ring.length; i++) {
        positions[i * 3] = ring[i][0];
        positions[i * 3 + 1] = ring[i][1];
        positions[i * 3 + 2] = ring[i][2];
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      const loop = new LineLoop(geom, mat);
      loop.renderOrder = 12;
      loop.frustumCulled = false;
      group.add(loop);
    }
    // Plane axes hint (short u/v ticks at origin)
    const { plane } = preview;
    if (plane) {
      const axisLen = 4;
      const axisMat = new LineBasicMaterial({
        color: 0xa5f3fc,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.55,
      });
      const makeAxis = (dir) => {
        const a = plane.center;
        const b = [
          a[0] + axisLen * dir[0],
          a[1] + axisLen * dir[1],
          a[2] + axisLen * dir[2],
        ];
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array([
          a[0], a[1], a[2], b[0], b[1], b[2],
        ]), 3));
        const line = new LineSegments(g, axisMat);
        line.renderOrder = 12;
        line.frustumCulled = false;
        return line;
      };
      group.add(makeAxis(plane.x));
      group.add(makeAxis(plane.y));
    }
    sceneRef.current.add(group);
    xsPreviewRef.current = group;
  }, [clearXsPreview]);

  // Dispose cross-section preview on unmount (route change / modal still open).
  useEffect(() => () => clearXsPreview(), [clearXsPreview]);

  const clearWorkplaneOverlay = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, workplaneOverlayRef.current);
    workplaneOverlayRef.current = null;
  }, []);

  /** Restore orbit/pan after a point grab (hover or drag) releases. */
  const unlockOrbitForPointDrag = useCallback(() => {
    const saved = polylineControlsLockRef.current;
    const controls = controlsRef.current;
    if (saved && controls) {
      controls.noRotate = saved.noRotate;
      controls.noPan = saved.noPan;
    }
    polylineControlsLockRef.current = null;
  }, []);

  const clearPolylineDraft = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, polylineDraftRef.current);
    polylineDraftRef.current = null;
    polylinePointHoverRef.current = -1;
    polylinePointDragRef.current = null;
    unlockOrbitForPointDrag();
  }, [unlockOrbitForPointDrag]);

  const clearExtrudePreview = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, extrudePreviewRef.current);
    extrudePreviewRef.current = null;
  }, []);

  /**
   * Slice 25: live Extrude solid (Three.js ExtrudeGeometry on the workplane).
   * Local Z = plane normal; w0 applies sense (out / in / both).
   */
  const paintExtrudePreview = useCallback((payload) => {
    clearExtrudePreview();
    if (!payload?.plane || !payload?.contours?.length || !sceneRef.current) return;
    const loop = payload.contours[0];
    if (!loop || loop.length < 3) return;
    const shape = new Shape();
    shape.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i++) {
      const u = Number(loop[i][0]);
      const v = Number(loop[i][1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) return;
      shape.lineTo(u, v);
    }
    shape.closePath();
    const geom = new ExtrudeGeometry(shape, {
      depth: payload.distance,
      bevelEnabled: false,
      curveSegments: 1,
    });
    // Unlit, like every other preview: a lit material turned the faces angled
    // away from the lights dark and muddy (see utils/previewStyle.js).
    const mat = makePreviewSkinMaterial();
    const mesh = new ThreeMesh(geom, mat);
    mesh.name = 'contourExtrudePreview';
    mesh.renderOrder = PREVIEW_RENDER_ORDER.skin;
    mesh.frustumCulled = false;
    const { plane, w0 } = payload;
    const n = plane.normal;
    const x = plane.x;
    const y = plane.y;
    const c = plane.center;
    mesh.matrix.set(
      x[0], y[0], n[0], c[0] + w0 * n[0],
      x[1], y[1], n[1], c[1] + w0 * n[1],
      x[2], y[2], n[2], c[2] + w0 * n[2],
      0, 0, 0, 1,
    );
    mesh.matrixAutoUpdate = false;
    const group = new Group();
    group.name = 'contourExtrudePreviewGroup';
    group.add(mesh);
    // Start and end loops, exactly like Loft's station rings — the skin alone
    // reads as a smear without them.
    const outlineMat = makePreviewOutlineMaterial();
    for (const w of [w0, w0 + Number(payload.distance)]) {
      if (!Number.isFinite(w)) continue;
      const pos = new Float32Array((loop.length + 1) * 3);
      for (let i = 0; i <= loop.length; i++) {
        const [u, v] = loop[i % loop.length];
        for (let k = 0; k < 3; k++) {
          pos[i * 3 + k] = c[k] + u * x[k] + v * y[k] + w * n[k];
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const line = new Line(g, outlineMat);
      line.renderOrder = PREVIEW_RENDER_ORDER.outline;
      line.frustumCulled = false;
      group.add(line);
    }
    sceneRef.current.add(group);
    extrudePreviewRef.current = group;
  }, [clearExtrudePreview]);

  const clearRevolvePreview = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, revolvePreviewRef.current);
    revolvePreviewRef.current = null;
  }, []);

  /**
   * Slice 26: live Revolve solid (surface of revolution on an in-plane axis).
   * Local X=radial, Y=axis, Z=plane normal; sense offsets the start angle.
   * Identity remap: axis through the workplane origin; clamp r<0 to match
   * makeRevolve / Manifold's positive-X clip (centered circle → sphere).
   */
  const paintRevolvePreview = useCallback((payload) => {
    clearRevolvePreview();
    if (!payload?.contours?.length || !payload?.center || !sceneRef.current) return;
    const radial = payload.radial;
    const axis = payload.axis;
    const out = payload.plane?.normal;
    const c = payload.center;
    if (!radial || !axis || !out || !c) return;
    const loop = payload.contours[0];
    if (!loop || loop.length < 3) return;
    const pts = [];
    for (const p of loop) {
      const r = Number(p[0]);
      const h = Number(p[1]);
      if (!Number.isFinite(r) || !Number.isFinite(h)) return;
      pts.push([Math.max(0, r), h]);
    }
    if (pts.length < 3) return;
    const f0 = pts[0];
    const f1 = pts[pts.length - 1];
    if (Math.hypot(f0[0] - f1[0], f0[1] - f1[1]) > 1e-6) pts.push([f0[0], f0[1]]);
    const angle = Number(payload.angle);
    if (!(angle > 0) || !Number.isFinite(angle)) return;
    const start = (Number(payload.startDeg) || 0) * (Math.PI / 180);
    const span = angle * (Math.PI / 180);
    const segs = Math.max(16, Math.round(48 * Math.max(0.2, angle / 360)));
    const n = pts.length;
    const positions = new Float32Array((segs + 1) * n * 3);
    let w = 0;
    for (let j = 0; j <= segs; j++) {
      const th = start + (j / segs) * span;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      for (let i = 0; i < n; i++) {
        positions[w++] = pts[i][0] * ct;
        positions[w++] = pts[i][1];
        positions[w++] = pts[i][0] * st;
      }
    }
    const indices = [];
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + n;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const mat = makePreviewSkinMaterial();
    const mesh = new ThreeMesh(geom, mat);
    mesh.name = 'contourRevolvePreview';
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    // Local: X=radial, Y=axis, Z=plane normal.
    mesh.matrix.set(
      radial[0], axis[0], out[0], c[0],
      radial[1], axis[1], out[1], c[1],
      radial[2], axis[2], out[2], c[2],
      0, 0, 0, 1,
    );
    mesh.matrixAutoUpdate = false;
    const group = new Group();
    group.name = 'contourRevolvePreviewGroup';
    group.add(mesh);
    sceneRef.current.add(group);
    revolvePreviewRef.current = group;
  }, [clearRevolvePreview]);

  const clearLoftPreview = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, loftPreviewRef.current);
    loftPreviewRef.current = null;
  }, []);

  /**
   * Slice 28: live Loft solid (linear skin between offset stations) + profile rings.
   * Stations live on copies of the workplane offset along the normal.
   */
  const paintLoftPreview = useCallback((payload) => {
    clearLoftPreview();
    if (!payload?.stations?.length || !sceneRef.current) return;
    const group = new Group();
    group.name = 'contourLoftPreviewGroup';
    const ringMat = makePreviewOutlineMaterial();
    const skinMat = makePreviewSkinMaterial();
    const worldRing = (station) => {
      const plane = station.plane;
      return (station.ring || []).map((uv) => [
        plane.center[0] + uv[0] * plane.x[0] + uv[1] * plane.y[0],
        plane.center[1] + uv[0] * plane.x[1] + uv[1] * plane.y[1],
        plane.center[2] + uv[0] * plane.x[2] + uv[1] * plane.y[2],
      ]);
    };
    for (const station of payload.stations) {
      const ring = worldRing(station);
      if (ring.length < 3) continue;
      const pos = new Float32Array((ring.length + 1) * 3);
      for (let i = 0; i < ring.length; i++) {
        pos[i * 3] = ring[i][0];
        pos[i * 3 + 1] = ring[i][1];
        pos[i * 3 + 2] = ring[i][2];
      }
      pos[ring.length * 3] = ring[0][0];
      pos[ring.length * 3 + 1] = ring[0][1];
      pos[ring.length * 3 + 2] = ring[0][2];
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const line = new Line(g, ringMat);
      line.renderOrder = 11;
      line.frustumCulled = false;
      group.add(line);
    }
    for (let s = 0; s < payload.stations.length - 1; s++) {
      const a = worldRing(payload.stations[s]);
      const b = worldRing(payload.stations[s + 1]);
      const n = Math.min(a.length, b.length);
      if (n < 3) continue;
      const positions = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        positions[i * 3] = a[i][0];
        positions[i * 3 + 1] = a[i][1];
        positions[i * 3 + 2] = a[i][2];
        positions[(n + i) * 3] = b[i][0];
        positions[(n + i) * 3 + 1] = b[i][1];
        positions[(n + i) * 3 + 2] = b[i][2];
      }
      const indices = [];
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        indices.push(i, n + i, i1, n + i, n + i1, i1);
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      geom.setIndex(indices);
      geom.computeVertexNormals();
      const mesh = new ThreeMesh(geom, skinMat);
      mesh.name = 'contourLoftPreview';
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    if (group.children.length) {
      sceneRef.current.add(group);
      loftPreviewRef.current = group;
    }
  }, [clearLoftPreview]);

  const clearSweepPreview = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, sweepPreviewRef.current);
    sweepPreviewRef.current = null;
  }, []);

  /**
   * Slice 30: live Sweep skin along the path (profile stations, not a manifold).
   * Rings are already in world space. Invalid path → caller passes null.
   */
  const paintSweepPreview = useCallback((payload) => {
    clearSweepPreview();
    if (!payload?.stations?.length || !sceneRef.current) return;
    const group = new Group();
    group.name = 'contourSweepPreviewGroup';
    const ringMat = makePreviewOutlineMaterial();
    const skinMat = makePreviewSkinMaterial();
    const addSkin = (a, b) => {
      const n = Math.min(a?.length || 0, b?.length || 0);
      if (n < 3) return;
      const positions = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        if (!a[i] || !b[i]) return;
        positions[i * 3] = a[i][0];
        positions[i * 3 + 1] = a[i][1];
        positions[i * 3 + 2] = a[i][2];
        positions[(n + i) * 3] = b[i][0];
        positions[(n + i) * 3 + 1] = b[i][1];
        positions[(n + i) * 3 + 2] = b[i][2];
      }
      const indices = [];
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        indices.push(i, n + i, i1, n + i, n + i1, i1);
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      geom.setIndex(indices);
      geom.computeVertexNormals();
      const mesh = new ThreeMesh(geom, skinMat);
      mesh.name = 'contourSweepPreview';
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      group.add(mesh);
    };
    const rings = [];
    for (const station of payload.stations) {
      const ring = station.ring;
      if (!ring || ring.length < 3) continue;
      rings.push(ring);
      const pos = new Float32Array((ring.length + 1) * 3);
      for (let i = 0; i < ring.length; i++) {
        pos[i * 3] = ring[i][0];
        pos[i * 3 + 1] = ring[i][1];
        pos[i * 3 + 2] = ring[i][2];
      }
      pos[ring.length * 3] = ring[0][0];
      pos[ring.length * 3 + 1] = ring[0][1];
      pos[ring.length * 3 + 2] = ring[0][2];
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const line = new Line(g, ringMat);
      line.renderOrder = 11;
      line.frustumCulled = false;
      group.add(line);
    }
    for (let s = 0; s < rings.length - 1; s++) addSkin(rings[s], rings[s + 1]);
    if (payload.closed && rings.length > 2) addSkin(rings[rings.length - 1], rings[0]);
    if (group.children.length) {
      sceneRef.current.add(group);
      sweepPreviewRef.current = group;
    }
  }, [clearSweepPreview]);

  const applyContourPartGhost = useCallback((on) => {
    const mesh = resultRef.current;
    if (!mesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (on) {
      contourGhostMatsRef.current = true;
      for (const m of mats) {
        if (!m) continue;
        if (m.userData._contourPrev == null) {
          m.userData._contourPrev = {
            transparent: m.transparent,
            opacity: m.opacity,
            depthWrite: m.depthWrite,
          };
        }
        // Dim in place so the part stays recognizable (not a grey void).
        m.transparent = true;
        m.opacity = 0.4;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    } else if (contourGhostMatsRef.current) {
      for (const m of mats) {
        const prev = m?.userData?._contourPrev;
        if (!prev) continue;
        m.transparent = prev.transparent;
        m.opacity = prev.opacity;
        m.depthWrite = prev.depthWrite;
        m.needsUpdate = true;
        delete m.userData._contourPrev;
      }
      contourGhostMatsRef.current = null;
    }
  }, []);

  const paintWorkplaneOverlay = useCallback((plane, face) => {
    clearWorkplaneOverlay();
    if (!plane || !sceneRef.current) return;
    const size = workplaneOverlaySize(face);
    const group = new Group();
    group.name = 'contourWorkplane';
    const geom = new PlaneGeometry(size, size);
    const mat = makePreviewSkinMaterial({ opacity: PREVIEW_OPACITY.ghost });
    const quad = new ThreeMesh(geom, mat);
    quad.position.set(plane.center[0], plane.center[1], plane.center[2]);
    const q = new Quaternion();
    q.setFromRotationMatrix(new Matrix4().makeBasis(
      new Vector3(plane.x[0], plane.x[1], plane.x[2]),
      new Vector3(plane.y[0], plane.y[1], plane.y[2]),
      new Vector3(plane.normal[0], plane.normal[1], plane.normal[2]),
    ));
    quad.quaternion.copy(q);
    quad.renderOrder = 8;
    quad.frustumCulled = false;
    group.add(quad);
    // Outline
    try {
      const corners = workplaneQuadCorners(plane, size);
      const ring = [...corners, corners[0]];
      const pos = new Float32Array(ring.length * 3);
      for (let i = 0; i < ring.length; i++) {
        pos[i * 3] = ring[i][0];
        pos[i * 3 + 1] = ring[i][1];
        pos[i * 3 + 2] = ring[i][2];
      }
      const lineGeom = new BufferGeometry();
      lineGeom.setAttribute('position', new BufferAttribute(pos, 3));
      const lineMat = new LineBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        depthWrite: false,
      });
      const loop = new Line(lineGeom, lineMat);
      loop.renderOrder = 9;
      loop.frustumCulled = false;
      group.add(loop);
    } catch { /* overlay outline is best-effort */ }
    sceneRef.current.add(group);
    workplaneOverlayRef.current = group;
  }, [clearWorkplaneOverlay]);

  const clearConstructionPlanes = useCallback(() => {
    if (!constructionPlaneRef.current) return;
    disposeEdgeOverlayObject(sceneRef.current, constructionPlaneRef.current);
    constructionPlaneRef.current = null;
  }, []);

  const paintConstructionPlanes = useCallback((planes, activeId) => {
    clearConstructionPlanes();
    if (!planes?.length || !sceneRef.current) return;
    const group = new Group();
    group.name = 'constructionPlanes';
    for (const p of planes) {
      const plane = p.plane;
      if (!plane?.center || !plane?.x || !plane?.y || !plane?.normal) continue;
      const size = 48;
      const geom = new PlaneGeometry(size, size);
      const selected = p.id === activeId;
      // Same translucent recipe as the tool previews, amber when active.
      const mat = makePreviewSkinMaterial(selected
        ? { color: PREVIEW_COLORS.selected, opacity: PREVIEW_OPACITY.selected }
        : { color: PREVIEW_COLORS.outline, opacity: PREVIEW_OPACITY.ghost });
      const quad = new ThreeMesh(geom, mat);
      quad.position.set(plane.center[0], plane.center[1], plane.center[2]);
      const q = new Quaternion();
      q.setFromRotationMatrix(new Matrix4().makeBasis(
        new Vector3(plane.x[0], plane.x[1], plane.x[2]),
        new Vector3(plane.y[0], plane.y[1], plane.y[2]),
        new Vector3(plane.normal[0], plane.normal[1], plane.normal[2]),
      ));
      quad.quaternion.copy(q);
      quad.renderOrder = 7;
      quad.frustumCulled = false;
      quad.userData = { planeId: p.id, plane, kind: 'constructionPlane' };
      group.add(quad);
    }
    if (!group.children.length) return;
    sceneRef.current.add(group);
    constructionPlaneRef.current = group;
  }, [clearConstructionPlanes]);

  /**
   * Per-frame handle animation: ease every handle toward its state's scale, and
   * breathe the one under the cursor so it reads as grabbable rather than drawn.
   * Scale (not colour) is animated here — colour is a state change, not motion.
   */
  const animatePolylineHandles = useCallback(() => {
    const handles = polylineDraftRef.current?.userData?.handles;
    if (!handles?.length) return;
    const dragIndex = polylinePointDragRef.current?.index ?? -1;
    const hoverIndex = polylinePointHoverRef.current;
    const pulse = 1 + Math.sin(performance.now() / 160) * 0.08;
    for (let i = 0; i < handles.length; i++) {
      let target = POLYLINE_POINT_SCALE;
      if (i === dragIndex) target = POLYLINE_POINT_DRAG_SCALE;
      else if (i === hoverIndex) target = POLYLINE_POINT_HOVER_SCALE * pulse;
      const cur = handles[i].scale.x;
      const next = Math.abs(target - cur) < 0.002 ? target : cur + (target - cur) * 0.25;
      handles[i].scale.setScalar(next);
    }
  }, []);

  /** Recolor handles for the current hover / drag state (scale is animated). */
  const paintPolylineHandleStates = useCallback(() => {
    const handles = polylineDraftRef.current?.userData?.handles;
    if (!handles) return;
    const dragIndex = polylinePointDragRef.current?.index ?? -1;
    const hoverIndex = polylinePointHoverRef.current;
    for (let i = 0; i < handles.length; i++) {
      const mat = handles[i].material;
      if (!mat) continue;
      if (i === dragIndex) mat.color.setHex(POLYLINE_POINT_DRAG_COLOR);
      else if (i === hoverIndex) mat.color.setHex(POLYLINE_POINT_HOVER_COLOR);
      else mat.color.setHex(POLYLINE_POINT_COLOR);
    }
  }, []);

  /**
   * Draft polyline: one grab handle per tapped point + the connecting wire.
   *
   * Points are kept as individual meshes with their own material and a
   * `pointIndex`, because they are interactive: hover grows them, right-drag
   * moves them (see beginPolylinePointDrag). Handle geometry is rebuilt only
   * when the point list changes — a live drag mutates positions in place so
   * the wire follows the cursor at frame rate instead of through React.
   */
  const paintPolylineDraft = useCallback((plane, points, { wire = true } = {}) => {
    // A repaint (point added, undone, plane re-picked) rebuilds the handles;
    // carry the hover across it so the grab target does not flicker back to
    // idle under a stationary cursor.
    const keepHover = polylinePointHoverRef.current;
    clearPolylineDraft();
    if (!plane || !points?.length || !sceneRef.current) return;
    const group = new Group();
    group.name = 'contourPolylineDraft';
    const world = points.map(([u, v]) => [
      plane.center[0] + u * plane.x[0] + v * plane.y[0],
      plane.center[1] + u * plane.x[1] + v * plane.y[1],
      plane.center[2] + u * plane.x[2] + v * plane.y[2],
    ]);
    const handles = [];
    for (let i = 0; i < world.length; i++) {
      const p = world[i];
      // Per-point material: hover / drag tint one handle, not the whole draft.
      const mat = new MeshBasicMaterial({
        color: POLYLINE_POINT_COLOR,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const s = new ThreeMesh(new SphereGeometry(0.45, 12, 12), mat);
      s.position.set(p[0], p[1], p[2]);
      s.renderOrder = 16;
      s.frustumCulled = false;
      s.userData.pointIndex = i;
      handles.push(s);
      group.add(s);
    }
    let line = null;
    if (wire && world.length >= 2) {
      const pos = new Float32Array(world.length * 3);
      for (let i = 0; i < world.length; i++) {
        pos[i * 3] = world[i][0];
        pos[i * 3 + 1] = world[i][1];
        pos[i * 3 + 2] = world[i][2];
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      line = new Line(g, new LineBasicMaterial({
        color: POLYLINE_POINT_COLOR,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }));
      line.renderOrder = 15;
      line.frustumCulled = false;
      group.add(line);
    }
    group.userData.handles = handles;
    group.userData.line = line;
    group.userData.plane = plane;
    sceneRef.current.add(group);
    polylineDraftRef.current = group;
    polylinePointHoverRef.current = keepHover < handles.length ? keepHover : -1;
    paintPolylineHandleStates();
  }, [clearPolylineDraft, paintPolylineHandleStates]);

  /** Move one handle (and its wire vertex) without rebuilding the draft. */
  const movePolylineHandle = useCallback((index, worldPoint) => {
    const group = polylineDraftRef.current;
    const handle = group?.userData?.handles?.[index];
    if (!handle) return;
    handle.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
    const line = group.userData.line;
    const attr = line?.geometry?.getAttribute('position');
    if (attr) {
      attr.setXYZ(index, worldPoint[0], worldPoint[1], worldPoint[2]);
      attr.needsUpdate = true;
      line.geometry.computeBoundingSphere?.();
    }
  }, []);

  /**
   * Nearest draft point within the edge-pick slop, in screen space so the
   * grab target stays finger-sized however far the camera is.
   * @returns {number} point index, or -1
   */
  const pickPolylinePointAtClient = useCallback((clientX, clientY) => {
    const group = polylineDraftRef.current;
    const handles = group?.userData?.handles;
    const camera = cameraRef.current;
    const canvas = canvasRef.current;
    if (!handles?.length || !camera || !canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const slop = resolveEdgePickSlopPx();
    let best = -1;
    let bestD = slop * slop;
    for (let i = 0; i < handles.length; i++) {
      const v = polylineProjectScratch.current.copy(handles[i].position).project(camera);
      if (v.z > 1) continue; // behind the camera
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }, []);

  /**
   * Hovering a handle hands the right button to the point, not the camera:
   * TrackballControls pans on right-drag, which would fight the move.
   */
  const setPolylinePointHover = useCallback((index) => {
    if (polylinePointHoverRef.current === index) return;
    polylinePointHoverRef.current = index;
    const controls = controlsRef.current;
    if (index >= 0 && controls && !polylineControlsLockRef.current) {
      polylineControlsLockRef.current = { noRotate: controls.noRotate, noPan: controls.noPan };
      controls.noRotate = true;
      controls.noPan = true;
    } else if (index < 0 && !polylinePointDragRef.current) {
      unlockOrbitForPointDrag();
    }
    if (canvasRef.current) {
      canvasRef.current.style.cursor = index >= 0 ? 'grab' : '';
    }
    paintPolylineHandleStates();
  }, [paintPolylineHandleStates, unlockOrbitForPointDrag]);

  const clearFilletBlendPreview = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, filletBlendPreviewRef.current);
    filletBlendPreviewRef.current = null;
  }, []);

  /**
   * Slice 27: live sweep-fillet blend (path + swept wedge). Branched
   * selections keep their polylines visible. Disjoint simple components each
   * get their own wedge rings (independent fillets).
   */
  const paintFilletBlendPreview = useCallback((payload) => {
    clearFilletBlendPreview();
    if (!payload || !sceneRef.current) return;
    const group = new Group();
    group.name = 'filletBlendPreview';

    const addPolyline = (pts, color, opacity = 0.95) => {
      if (!pts || pts.length < 2) return;
      const pos = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        pos[i * 3] = pts[i][0];
        pos[i * 3 + 1] = pts[i][1];
        pos[i * 3 + 2] = pts[i][2];
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(pos, 3));
      const line = new Line(geom, new LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity,
      }));
      line.renderOrder = 16;
      line.frustumCulled = false;
      group.add(line);
    };

    const addWedgeMesh = (rings, closed) => {
      if (!rings || rings.length < 2) return;
      const n = rings[0].length;
      if (n < 3) return;
      const positions = new Float32Array(rings.length * n * 3);
      let w = 0;
      for (const ring of rings) {
        for (let i = 0; i < n; i++) {
          const p = ring[i] || ring[0];
          positions[w++] = p[0];
          positions[w++] = p[1];
          positions[w++] = p[2];
        }
      }
      const indices = [];
      for (let j = 0; j < rings.length - 1; j++) {
        for (let i = 0; i < n; i++) {
          const i1 = (i + 1) % n;
          const a = j * n + i;
          const b = a + n;
          indices.push(a, b, j * n + i1, b, b + i1 - i, j * n + i1);
        }
      }
      if (closed && rings.length > 2) {
        const last = rings.length - 1;
        for (let i = 0; i < n; i++) {
          const i1 = (i + 1) % n;
          const a = last * n + i;
          const b = i;
          indices.push(a, b, last * n + i1, b, i1, last * n + i1);
        }
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      geom.setIndex(indices);
      geom.computeVertexNormals();
      const mat = makePreviewSkinMaterial({ color: PREVIEW_COLORS.blendSkin });
      const mesh = new ThreeMesh(geom, mat);
      mesh.name = 'filletBlendWedge';
      mesh.renderOrder = 10;
      mesh.frustumCulled = false;
      group.add(mesh);
    };

    const multi = Array.isArray(payload.components) && payload.components.length > 1;
    if (multi) {
      for (const part of payload.components) {
        if (part?.preview?.points?.length) {
          addPolyline(part.preview.points, part.ok ? 0x22c55e : 0xf97316, 0.98);
        } else {
          for (const poly of part?.polylines || []) {
            addPolyline(poly, part?.ok ? 0x22c55e : 0xf97316, 0.9);
          }
        }
        if (payload.ok && part?.ok) addWedgeMesh(part.rings, part.closed);
      }
    } else {
      if (payload.preview?.points?.length) {
        addPolyline(payload.preview.points, payload.ok ? 0x22c55e : 0xf97316, 0.98);
      } else {
        for (const poly of payload.polylines || []) addPolyline(poly, 0xf97316, 0.9);
      }
      if (payload.ok) addWedgeMesh(payload.rings, payload.closed);
    }

    if (group.children.length) {
      sceneRef.current.add(group);
      filletBlendPreviewRef.current = group;
    }
  }, [clearFilletBlendPreview]);

  const exitContourMode = useCallback(() => {
    setContourMode(null);
    contourModeRef.current = null;
    setPickMode('face');
    clearXsPreview();
    clearWorkplaneOverlay();
    clearPolylineDraft();
    clearExtrudePreview();
    clearRevolvePreview();
    clearLoftPreview();
    clearSweepPreview();
    disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
    pathPreviewRef.current = null;
    applyContourPartGhost(false);
    clearSavedContourGhosts();
    if (contourToastTimerRef.current) {
      clearTimeout(contourToastTimerRef.current);
      contourToastTimerRef.current = null;
    }
    setContourToast(null);
  }, [clearXsPreview, clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, clearLoftPreview, clearSweepPreview, applyContourPartGhost, clearSavedContourGhosts]);

  const enterContourMode = useCallback(({ entry } = {}) => {
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    setCutMode(null);
    cutModeRef.current = null;
    setMoveMode(null);
    moveModeRef.current = null;
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
    pathPreviewRef.current = null;
    const buf = (typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || currentScript || '';
    const saved = listSavedContours(buf);
    const planes = listConstructionPlanes(buf);
    const armedPlane = planes.find((p) => p.id === selectedPlaneId);
    const faceArg = selectedFace || (armedPlane ? {
      type: 'planar',
      center: armedPlane.plane.center.slice(),
      normal: armedPlane.plane.normal.slice(),
      area: 400,
      triangleCount: 2,
      selectionMode: 'coplanar',
      planeFrame: {
        center: armedPlane.plane.center.slice(),
        normal: armedPlane.plane.normal.slice(),
        x: armedPlane.plane.x.slice(),
        y: armedPlane.plane.y.slice(),
      },
    } : null);
    let next = enterContourState(entry, faceArg);
    const armed = saved.find((c) => c.id === armedContourId);
    next = armed ? applySavedContour(next, armed) : withAutoPickedContour(next, saved);
    setContourMode(next);
    // Soft-fail / refuse only — no informational toast on successful feature UI open.
    if (next.enterRefuse) showContourToast(next.enterRefuse);
    applyContourPartGhost(true);
  }, [selectedFace, selectedPlaneId, armedContourId, applyContourPartGhost, clearFilletBlendPreview, getHelperBuffer, currentScript]);

  const confirmContourProfile = useCallback(() => {
    const state = contourModeRef.current;
    if (!state) return;
    if (!isWorkplaneEntry(state.entry)) {
      const gate = validateContourProfile(state.tool, state.params);
      if (!gate.ok) {
        showContourToast(gate.message);
        return;
      }
    }
    const commitFace = activeContourFace(state, modelBounds);
    if (isExtrudeEntry(state.entry)) {
      const extGate = validateExtrudeParams(state.extrude);
      if (!extGate.ok) {
        showContourToast(extGate.message);
        return;
      }
      const axis = resolveExtrudeAxis(
        planeFromContourFace(commitFace),
        extGate.normalized.direction,
      );
      if (!axis.ok) {
        showContourToast(axis.message);
        return;
      }
    }
    if (isRevolveEntry(state.entry)) {
      const revGate = validateRevolveParams(state.revolve);
      if (!revGate.ok) {
        showContourToast(revGate.message);
        return;
      }
      const axis = resolveRevolveAxis(
        planeFromContourFace(commitFace),
        revGate.normalized.axis,
      );
      if (!axis.ok) {
        showContourToast(axis.message);
        return;
      }
    }
    if (isLoftEntry(state.entry)) {
      const loftGate = validateLoftProfiles(state.loft?.profiles);
      if (!loftGate.ok) {
        showContourToast(loftGate.message);
        return;
      }
    }
    if (isSweepEntry(state.entry)) {
      const pathGate = validateSweepPath(selectedEdges, state.sweep);
      if (!pathGate.ok) {
        showContourToast(pathGate.message);
        return;
      }
    }
    const loftState = isLoftEntry(state.entry)
      ? writeLoftSelected(state, {
        tool: state.tool,
        params: { ...(state.params || {}) },
      })
      : state;
    const ok = onCommitContourProfile?.({
      face: loftState.planeFace || commitFace,
      tool: loftState.tool,
      params: loftState.params,
      entry: loftState.entry,
      extrude: loftState.extrude,
      revolve: loftState.revolve,
      loft: loftState.loft,
      sweep: loftState.sweep,
      edges: selectedEdges,
    });
    if (ok) {
      exitContourMode();
    }
  }, [onCommitContourProfile, selectedEdges, modelBounds, exitContourMode]);

  const exitFilletMode = useCallback(() => {
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    if (filletToastTimerRef.current) {
      clearTimeout(filletToastTimerRef.current);
      filletToastTimerRef.current = null;
    }
    setFilletToast(null);
    // Restore pre-Fillet Face/Edge (Plane/Contour toggles were never cleared).
    const restore = filletPriorPickModeRef.current === 'edge' ? 'edge' : 'face';
    pickModeRef.current = restore;
    setPickMode(restore);
  }, [clearFilletBlendPreview]);

  const enterFilletMode = useCallback((opts = {}) => {
    const entry = opts?.entry === 'chamferEdges' ? 'chamferEdges' : 'filletEdges';
    // Snapshot before exitContourMode, which forces face pick.
    filletPriorPickModeRef.current = pickModeRef.current === 'edge' ? 'edge' : 'face';
    exitContourMode();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    setCutMode(null);
    cutModeRef.current = null;
    setMoveMode(null);
    moveModeRef.current = null;
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('edge');
    clearHighlight();
    setSelectedFace(null);
    onFaceSelected?.(null);
    const next = entry === 'chamferEdges'
      ? enterChamferState(selectedEdges)
      : enterFilletState(selectedEdges);
    setFilletMode(next);
    filletModeRef.current = next;
    setTangentProp(true);
    // No informational toast on successful Fillet/Chamfer UI open — soft-fail/accept gates still toast.
  }, [exitContourMode, onFaceSelected, selectedEdges, clearHighlight]);

  const acceptFillet = useCallback(() => {
    const state = filletModeRef.current;
    if (!state) return;
    const edges = (selectedEdges && selectedEdges.length)
      ? selectedEdges
      : (state.lastEdges || []);
    if (state.entry === 'chamferEdges') {
      const gate = validateChamferAccept(edges, state.params);
      if (!gate.ok) {
        showFilletToast(gate.message);
        return;
      }
      const buf = (typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || '';
      const ok = onCommitFillet?.({
        entry: 'chamferEdges',
        edges,
        params: gate.normalized,
        commitMode: hasChamferModeBlock(buf) ? 'append' : 'replace',
      });
      if (ok) {
        edgeRematchToastSuppressRef.current = true;
        clearEdgeHover();
        clearEdgeHighlight();
        setSelectedEdges([]);
        exitFilletMode();
      }
      return;
    }
    const gate = validateFilletAccept(edges, state.params);
    if (!gate.ok) {
      showFilletToast(gate.message);
      return;
    }
    const buf = (typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || '';
    const edgeClass = classifyFilletEdges(edges, {
      radius: gate.normalized.radius,
      geometry: resultRef.current?.geometry,
    });
    filletQualityWatchRef.current = {
      preDeg: countDegenerateTriangles(resultRef.current?.geometry),
    };
    const ok = onCommitFillet?.({
      edges,
      params: gate.normalized,
      filletClass: edgeClass.klass,
      geometry: resultRef.current?.geometry,
      commitMode: hasFilletModeBlock(buf) ? 'append' : 'replace',
    });
    if (!ok) filletQualityWatchRef.current = null;
    if (ok) {
      edgeRematchToastSuppressRef.current = true;
      // Keep Face/Edge (and Plane/Contour) — exitFilletMode restores pre-Fillet pick.
      clearEdgeHover();
      clearEdgeHighlight();
      setSelectedEdges([]);
      exitFilletMode();
    }
  }, [onCommitFillet, selectedEdges, getHelperBuffer, exitFilletMode, clearEdgeHover, clearEdgeHighlight]);

  const exitShellMode = useCallback(() => {
    setShellMode(null);
    shellModeRef.current = null;
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, []);

  const enterShellMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setDraftMode(null);
    draftModeRef.current = null;
    if (cutModeRef.current || moveModeRef.current || moveFaceModeRef.current || deleteFaceModeRef.current) clearHighlight();
    setCutMode(null);
    cutModeRef.current = null;
    setMoveMode(null);
    moveModeRef.current = null;
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const next = enterShellState(selectedFace);
    setShellMode(next);
    shellModeRef.current = next;
  }, [exitContourMode, selectedFace, clearFilletBlendPreview, clearEdgeHover, clearEdgeHighlight, clearHighlight]);

  const acceptShell = useCallback(() => {
    const state = shellModeRef.current;
    if (!state) return;
    const liveFace = selectedFace
      ? (selectedFace.type ? selectedFace : classifySelectedFace(selectedFace))
      : null;
    const face = liveFace || state.lastFace || null;
    const gate = validateShellAccept(face, state.params);
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitShell?.({
      face: gate.face,
      params: gate.normalized,
      // One Shell feature. Replacing the marked block keeps a single hollow()
      // even when the script already has one — appending would shell the
      // already thin body. Extra openings are further taps on this picker.
      commitMode: 'replace',
    });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitShellMode();
    }
  }, [onCommitShell, selectedFace, exitShellMode, onFaceSelected, clearHighlight]);

  // Keep lastFace in sync while the user picks opening faces in Shell mode.
  useEffect(() => {
    if (!shellMode) return;
    if (!selectedFace) return;
    const classified = selectedFace.type
      ? selectedFace
      : classifySelectedFace(selectedFace);
    if (!classified) return;
    setShellMode((prev) => {
      if (!prev) return prev;
      const next = { ...prev, lastFace: classified };
      shellModeRef.current = next;
      return next;
    });
  }, [shellMode, selectedFace]);

  // Live sweep-fillet blend as edges accumulate. The payload is memoized so the
  // chip's pathOk flag and the painter share ONE build per input (Slice 27 nit:
  // the chip used to re-run buildFilletBlendPreview on every render just for .ok).
  const filletEdgeClass = useMemo(() => {
    if (!filletMode || !selectedEdges?.length) return null;
    const params = normalizeFilletParams(filletMode.params || {}, selectedEdges);
    return classifyFilletEdges(selectedEdges, {
      radius: params.radius,
      geometry: resultRef.current?.geometry,
    });
  }, [filletMode, selectedEdges, meshEpoch]);

  const filletBlendPayload = useMemo(() => {
    if (!filletMode) return null;
    if (filletMode.entry === 'chamferEdges') {
      return buildFilletBlendPreview(selectedEdges, {
        ...(filletMode.params || {}),
        strategy: 'sweep',
        profile: 'chamfer',
        radius: filletMode.params?.chamfer,
      });
    }
    return buildFilletBlendPreview(selectedEdges, filletMode.params);
  }, [filletMode, selectedEdges]);
  useEffect(() => {
    if (!filletMode) {
      clearFilletBlendPreview();
      return;
    }
    if (filletMode.entry === 'chamferEdges') {
      paintFilletBlendPreview(filletBlendPayload);
      return;
    }
    if (!filletMode.radiusTouched) {
      const seeded = defaultFilletParams(selectedEdges);
      if (Number(filletMode.params?.radius) !== seeded.radius) {
        setFilletMode((prev) => (
          prev && !prev.radiusTouched
            ? { ...prev, params: { ...prev.params, radius: seeded.radius } }
            : prev
        ));
        return;
      }
    }
    paintFilletBlendPreview(filletBlendPayload);
  }, [filletMode, selectedEdges, filletBlendPayload, paintFilletBlendPreview, clearFilletBlendPreview]);

  const clearIdLabels = useCallback(() => {
    const group = idLabelGroupRef.current;
    if (group && sceneRef.current) sceneRef.current.remove(group);
    if (group) {
      group.traverse((obj) => {
        if (obj.material) {
          obj.material.map?.dispose();
          obj.material.dispose();
        }
      });
    }
    idLabelGroupRef.current = null;
  }, []);

  useEffect(() => () => {
    clearFilletBlendPreview();
    if (filletToastTimerRef.current) clearTimeout(filletToastTimerRef.current);
  }, [clearFilletBlendPreview]);

  const savedContours = useMemo(
    () => listSavedContours(currentScript || ''),
    [currentScript],
  );

  const constructionPlanes = useMemo(
    () => listConstructionPlanes(currentScript || ''),
    [currentScript],
  );

  const savedContourHostPlane = useMemo(() => {
    if (modelBounds?.max && Number.isFinite(Number(modelBounds.max[2]))) {
      return defaultTopPlaneFrame([
        Number(modelBounds.center?.[0]) || 0,
        Number(modelBounds.center?.[1]) || 0,
        Number(modelBounds.max[2]),
      ]);
    }
    return defaultTopPlaneFrame([0, 0, 0]);
  }, [modelBounds]);

  useEffect(() => {
    savedContoursRef.current = savedContours;
    savedContourHostPlaneRef.current = savedContourHostPlane;
    if (!showContours) {
      clearSavedContourGhosts();
      return;
    }
    paintSavedContourGhosts(
      savedContours,
      contourMode?.pickedContourId || armedContourId,
      savedContourHostPlane,
    );
  }, [
    contourMode,
    armedContourId,
    savedContours,
    savedContourHostPlane,
    showContours,
    paintSavedContourGhosts,
    clearSavedContourGhosts,
    sceneReady,
  ]);

  useEffect(() => {
    if (!showPlanes) {
      clearConstructionPlanes();
      return;
    }
    paintConstructionPlanes(constructionPlanes, selectedPlaneId);
  }, [constructionPlanes, selectedPlaneId, showPlanes, paintConstructionPlanes, clearConstructionPlanes, sceneReady]);

  useEffect(() => () => {
    clearConstructionPlanes();
  }, [clearConstructionPlanes]);

  // Live workplane + makeCrossSection profile (+ Extrude / Revolve / Loft solid) preview.
  useEffect(() => {
    if (!contourMode) {
      clearWorkplaneOverlay();
      clearPolylineDraft();
      clearExtrudePreview();
      clearRevolvePreview();
      clearLoftPreview();
      clearSweepPreview();
      applyContourPartGhost(false);
      return;
    }
    // No face pick: snap the default +Z plane to the part top so the live
    // solid sits on the workplane (same intent as facesByNormal on Confirm).
    // Same resolver the polyline hit-test uses — see contourWorkplaneFace.
    const planeFace = contourWorkplaneFace(contourMode, modelBounds);
    const plane = planeFromContourFace(planeFace);
    // Workplane mode always shows a live plane preview; other entries follow
    // the Plane overlay toggle.
    if (showPlanes || isWorkplaneEntry(contourMode.entry)) paintWorkplaneOverlay(plane, planeFace);
    else clearWorkplaneOverlay();
    applyContourPartGhost(true);
    if (isWorkplaneEntry(contourMode.entry)) {
      clearXsPreview();
      clearPolylineDraft();
      clearExtrudePreview();
      clearRevolvePreview();
      clearLoftPreview();
      clearSweepPreview();
      return;
    }
    const pts = contourMode.params?.points;
    if (contourMode.tool === 'polyline' && (!Array.isArray(pts) || pts.length < 3)) {
      clearXsPreview();
      clearExtrudePreview();
      clearRevolvePreview();
      paintPolylineDraft(plane, pts || []);
      clearSweepPreview();
      if (isLoftEntry(contourMode.entry)) {
        const solid = buildLoftSolidPreview(planeFace, contourMode.loft?.profiles);
        if (solid) paintLoftPreview(solid);
        else clearLoftPreview();
      } else {
        clearLoftPreview();
      }
      return;
    }
    // A closed polyline draws its own outline, but the grab handles must stay
    // on the points — that is the whole window in which the user wants to nudge
    // them. Handles only, no duplicate wire.
    if (contourMode.tool === 'polyline' && Array.isArray(pts) && pts.length) {
      paintPolylineDraft(plane, pts, { wire: false });
    } else {
      clearPolylineDraft();
    }
    if (isLoftEntry(contourMode.entry)) {
      clearXsPreview();
      clearExtrudePreview();
      clearRevolvePreview();
      const solid = buildLoftSolidPreview(planeFace, contourMode.loft?.profiles);
      if (solid) paintLoftPreview(solid);
      else clearLoftPreview();
      clearSweepPreview();
    } else if (buildContourPreview(planeFace, contourMode.tool, contourMode.params)) {
      setXsPreview({
        face: planeFace,
        params: toolToProfileParams(contourMode.tool, contourMode.params),
      });
      if (isExtrudeEntry(contourMode.entry)) {
        clearRevolvePreview();
        clearLoftPreview();
        const solid = buildExtrudeSolidPreview(
          planeFace,
          contourMode.tool,
          contourMode.params,
          contourMode.extrude,
        );
        if (solid) paintExtrudePreview(solid);
        else clearExtrudePreview();
        clearSweepPreview();
      } else if (isRevolveEntry(contourMode.entry)) {
        clearExtrudePreview();
        clearLoftPreview();
        clearSweepPreview();
        const solid = buildRevolveSolidPreview(
          planeFace,
          contourMode.tool,
          contourMode.params,
          contourMode.revolve,
        );
        if (solid) paintRevolvePreview(solid);
        else clearRevolvePreview();
      } else if (isSweepEntry(contourMode.entry)) {
        clearExtrudePreview();
        clearRevolvePreview();
        clearLoftPreview();
        const solid = buildSweepSolidPreview(
          planeFace,
          contourMode.tool,
          contourMode.params,
          selectedEdges,
          contourMode.sweep,
        );
        if (solid) paintSweepPreview(solid);
        else clearSweepPreview();
      } else {
        clearExtrudePreview();
        clearRevolvePreview();
        clearLoftPreview();
        clearSweepPreview();
      }
    } else {
      clearXsPreview();
      clearExtrudePreview();
      clearRevolvePreview();
      clearLoftPreview();
      clearSweepPreview();
    }
  }, [contourMode, modelBounds, selectedEdges, showPlanes, paintWorkplaneOverlay, paintPolylineDraft, paintExtrudePreview, paintRevolvePreview, paintLoftPreview, paintSweepPreview, applyContourPartGhost, clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, clearLoftPreview, clearSweepPreview, clearXsPreview, setXsPreview]);

  useEffect(() => () => {
    clearWorkplaneOverlay();
    clearPolylineDraft();
    clearExtrudePreview();
    clearRevolvePreview();
    clearLoftPreview();
    clearSweepPreview();
    applyContourPartGhost(false);
    clearSavedContourGhosts();
    if (contourToastTimerRef.current) clearTimeout(contourToastTimerRef.current);
  }, [clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, clearLoftPreview, clearSweepPreview, applyContourPartGhost, clearSavedContourGhosts]);

  // Contour mode: planar face tap updates the workplane; non-planar is a loud refuse.
  useEffect(() => {
    if (!contourModeRef.current || !selectedFace) return;
    const resolved = resolveContourWorkplane(selectedFace);
    if (!resolved.ok) {
      showContourToast(resolved.message);
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      return;
    }
    setContourMode((prev) => {
      if (!prev) return prev;
      return applyContourPlaneEdit(prev, {
        preset: 'face',
        base: planeFromContourFace(resolved.face),
        angles: { x: 0, y: 0, z: 0 },
      });
    });
  }, [selectedFace, onFaceSelected, clearHighlight]);

  const clearPathPreview = useCallback(() => {
    if (!pathPreviewRef.current) return;
    disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
    pathPreviewRef.current = null;
  }, []);

  /**
   * Slice 22: ordered path preview (gradient + direction arrows), distinct from orange selection halo.
   * @param {{ edges: object[], params?: object }|null} payload
   */
  const setPathPreview = useCallback((payload) => {
    clearPathPreview();
    if (!payload?.edges?.length || !sceneRef.current) return;
    const preview = buildSweepPathPreview(payload.edges, {
      reverse: !!payload.params?.reverse,
    });
    if (!preview?.points?.length) return;

    const group = new Group();
    group.name = 'sweepPathPreview';

    // Gradient polyline (green → magenta) showing order/direction.
    const pts = preview.points;
    const colors = preview.colors || [];
    const positions = new Float32Array(pts.length * 3);
    const colorArr = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      positions[i * 3] = pts[i][0];
      positions[i * 3 + 1] = pts[i][1];
      positions[i * 3 + 2] = pts[i][2];
      const c = colors[i] || [0.66, 0.33, 0.97];
      colorArr[i * 3] = c[0];
      colorArr[i * 3 + 1] = c[1];
      colorArr[i * 3 + 2] = c[2];
    }
    const lineGeom = new BufferGeometry();
    lineGeom.setAttribute('position', new BufferAttribute(positions, 3));
    lineGeom.setAttribute('color', new BufferAttribute(colorArr, 3));
    const lineMat = new LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.98,
    });
    const line = new Line(lineGeom, lineMat);
    line.renderOrder = 13;
    line.frustumCulled = false;
    group.add(line);

    // Direction chevrons (arrows) along the path.
    const arrowMat = new LineBasicMaterial({
      color: 0xe879f9,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    for (const ar of preview.arrows || []) {
      const arrPos = new Float32Array([
        ar.left[0], ar.left[1], ar.left[2],
        ar.tip[0], ar.tip[1], ar.tip[2],
        ar.right[0], ar.right[1], ar.right[2],
        ar.tip[0], ar.tip[1], ar.tip[2],
      ]);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(arrPos, 3));
      const seg = new LineSegments(g, arrowMat);
      seg.renderOrder = 14;
      seg.frustumCulled = false;
      group.add(seg);
    }

    // Start / end markers (numbered cue via size: start larger).
    const startMat = new MeshBasicMaterial({
      color: 0x22c55e,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const endMat = new MeshBasicMaterial({
      color: 0xa855f7,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const markers = preview.markers || [];
    if (markers.length) {
      const s = markers[0];
      const startMesh = new ThreeMesh(new SphereGeometry(0.55, 10, 10), startMat);
      startMesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      startMesh.renderOrder = 15;
      startMesh.frustumCulled = false;
      group.add(startMesh);
    }
    if (markers.length > 1 && !preview.closed) {
      const e = markers[markers.length - 1];
      const endMesh = new ThreeMesh(new SphereGeometry(0.45, 10, 10), endMat);
      endMesh.position.set(e.pos[0], e.pos[1], e.pos[2]);
      endMesh.renderOrder = 15;
      endMesh.frustumCulled = false;
      group.add(endMesh);
    }

    sceneRef.current.add(group);
    pathPreviewRef.current = group;
  }, [clearPathPreview]);

  // Sweep contour: path order preview (green → magenta) while edges accumulate.
  // Other contour entries clear it. A null contour mode leaves the Path modal preview alone.
  useEffect(() => {
    if (!contourMode || !isSweepEntry(contourMode.entry)) {
      if (contourMode) clearPathPreview();
      return;
    }
    setPathPreview({
      edges: selectedEdges,
      params: { reverse: !!contourMode.sweep?.reverse },
    });
  }, [contourMode, selectedEdges, setPathPreview, clearPathPreview]);

  useEffect(() => () => clearPathPreview(), [clearPathPreview]);

  const highlightSelectedEdges = useCallback((edges) => {
    clearEdgeHighlight();
    edgeHighlightRef.current = paintEdgeLines(edges, {
      color: 0xff9900,
      name: 'edgeSelection',
      opacity: EDGE_SELECT_OPACITY,
      corePx: EDGE_CORE_PX,
      haloPx: EDGE_HALO_PX,
    });
  }, [clearEdgeHighlight, paintEdgeLines]);

  const highlightHoverEdge = useCallback((edge, selectedKeys) => {
    clearEdgeHover();
    if (!edge) return;
    // Do not pre-highlight an already-selected edge (selection orange wins).
    if (selectedKeys?.has(edgeKey(edge))) return;
    edgeHoverRef.current = paintEdgeLines([edge], {
      color: 0xffcc66,
      name: 'edgeHover',
      opacity: 0.9,
      corePx: EDGE_HOVER_CORE_PX,
      haloPx: EDGE_HOVER_HALO_PX,
    });
  }, [clearEdgeHover, paintEdgeLines]);

  // Paint edge selection highlight when selectedEdges changes (idempotent: clear then draw).
  useEffect(() => {
    highlightSelectedEdges(selectedEdges);
    // Chips re-bind via refs on render; project once so they appear before the next frame.
    requestAnimationFrame(() => updateEdgeChips());
  }, [selectedEdges, highlightSelectedEdges, updateEdgeChips]);

  /**
   * Pick graph for Edge, Fillet, and Sweep path.
   * Sharp creases only, collapsed to silhouette chains (#46 dihedral gate).
   * Shallow loft-wall seams stay out so tangent-on cannot flood the mesh.
   */
  const syncFeatureEdges = useCallback((geom) => {
    if (featureEdgesSourceRef.current === geom && featureEdgesRef.current) return;
    const faceIDs = faceIDsRef.current;
    const tFeat = performance.now();
    const raw = geom ? buildFeatureEdges(geom) : [];
    const featureMs = performance.now() - tFeat;
    let topoMs = 0;
    let annotateMs = 0;
    let coherentMs = 0;
    if (geom && faceIDs && faceIDs.length) {
      const tTopo = performance.now();
      const topo = indexBoundaryEdgesFromGeometry(geom, faceIDs);
      topoMs = performance.now() - tTopo;
      const tAnn = performance.now();
      const annotated = annotateFeatureEdges(raw, topo);
      annotateMs = performance.now() - tAnn;
      boundaryTopoRef.current = topo;
      const tCoh = performance.now();
      featureEdgesRef.current = buildCoherentEdges(annotated);
      coherentMs = performance.now() - tCoh;
    } else {
      boundaryTopoRef.current = null;
      const tCoh = performance.now();
      featureEdgesRef.current = buildCoherentEdges(raw);
      coherentMs = performance.now() - tCoh;
    }
    featureEdgesSourceRef.current = geom ?? null;
    const prev = graphTimingRef.current || {};
    graphTimingRef.current = { ...prev, featureMs, topoMs, annotateMs, coherentMs };
  }, []);

  // Fillet mode: face ids (fN) and boundary-edge ids (eN) for the Accept helpers.
  const filletActive = !!filletMode;
  useEffect(() => {
    clearIdLabels();
    if (!filletActive || !sceneRef.current) return undefined;
    featureEdgesSourceRef.current = null;
    const geom = resultRef.current?.geometry;
    const note = (msg) => {
      setFilletToast(toastPayload(msg));
      if (filletToastTimerRef.current) clearTimeout(filletToastTimerRef.current);
      filletToastTimerRef.current = setTimeout(() => {
        filletToastTimerRef.current = null;
        setFilletToast(null);
      }, 3200);
    };
    try {
      if (geom) syncFeatureEdges(geom);
      setSelectedEdges((prev) => stampBoundaryOnSelection(prev, featureEdgesRef.current));
    } catch (err) {
      note(err?.message || 'Fillet could not read edges on this solid.');
      return undefined;
    }
    const topo = boundaryTopoRef.current;
    if (!topo) {
      if (geom) note('This solid has no face ids — Fillet cannot pick edges.');
      return undefined;
    }
    const targets = filletOverlayTargets(topo);
    if (!targets.edges.length) {
      note('No pickable edges on this solid. Shallow blend tessellation stays out of the pick graph.');
    }
    const dims = modelBounds?.size;
    const span = dims ? Math.max(dims[0], dims[1], dims[2]) : 40;
    const worldH = Math.max(1.6, span * 0.055);
    const group = new Group();
    group.name = 'filletIdLabels';
    try {
      for (const face of targets.faces) {
        if (!face?.center) continue;
        const sprite = makeFilletIdSprite(`f${face.id}`, worldH);
        if (!sprite) continue;
        const n = face.normal || [0, 0, 1];
        sprite.position.set(
          face.center[0] + n[0] * worldH * 0.35,
          face.center[1] + n[1] * worldH * 0.35,
          face.center[2] + n[2] * worldH * 0.35,
        );
        group.add(sprite);
      }
      for (const edge of targets.edges) {
        if (!edge?.mid) continue;
        const sprite = makeFilletIdSprite(`e${edge.id}`, worldH * 0.85);
        if (!sprite) continue;
        sprite.position.set(edge.mid[0], edge.mid[1], edge.mid[2]);
        group.add(sprite);
      }
    } catch (err) {
      clearIdLabels();
      note(err?.message || 'Could not label edges — pick still uses the sharp set.');
      return undefined;
    }
    sceneRef.current.add(group);
    idLabelGroupRef.current = group;
    return () => clearIdLabels();
  }, [filletActive, cachedMeshData, modelBounds, syncFeatureEdges, clearIdLabels]);

  const rebuildFeatureEdges = useCallback(() => {
    syncFeatureEdges(resultRef.current?.geometry ?? null);
  }, [syncFeatureEdges]);

  const wasFilletActiveRef = useRef(false);
  useEffect(() => {
    const leftFillet = wasFilletActiveRef.current && !filletActive;
    wasFilletActiveRef.current = filletActive;
    if (pickMode !== 'edge') return;
    if (filletActive) return;
    if (contourMode && isSweepEntry(contourMode.entry)) {
      rebuildFeatureEdges();
      return;
    }
    // Leaving Fillet restores prior Face/Edge; when still in Edge, drop sharp-only cache.
    if (leftFillet) {
      featureEdgesSourceRef.current = null;
      rebuildFeatureEdges();
    }
  }, [filletActive, contourMode, pickMode, rebuildFeatureEdges]);

  const pickSweepPath = useCallback(() => {
    setPickMode('edge');
    clearHighlight();
    setSelectedFace(null);
    onFaceSelected?.(null);
    rebuildFeatureEdges();
    setTangentProp(true);
    // Path-pick is visible via Edge mode + rail; skip instructional toast.
  }, [onFaceSelected, rebuildFeatureEdges, clearHighlight]);

  const pickSweepPlane = useCallback(() => {
    setPickMode('face');
    clearEdgeHover();
  }, [clearEdgeHover]);

  // Clear cutting plane widget
  const clearCuttingPlane = () => {
    if (cuttingPlaneWidgetRef.current && sceneRef.current) {
      sceneRef.current.remove(cuttingPlaneWidgetRef.current);
      cuttingPlaneWidgetRef.current.children.forEach(child => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      cuttingPlaneWidgetRef.current = null;
    }
  };

  // Handle cross-section toggle
  const handleCrossSectionToggle = async (enabled) => {
    if (enabled) {
      try {
        if (!manifoldContext.isReady || !currentScript) return;
        setCrossSectionEnabled(true);
      } catch (error) {
        console.error('[CrossSection] Failed to enable:', error);
      }
    } else {
      // Disable and restore original
      setCrossSectionEnabled(false);
      clearCuttingPlane();
    }
  };

  // Handle plane changes for cross-section preview
  const handlePlaneChange = async (plane) => {
    setCrossSectionPlane(plane);
    
    if (!crossSectionEnabled || !cachedMeshData) return;
    
    try {
      const normal = new Vector3(...plane.normal).normalize();
      const normalArray = [normal.x, normal.y, normal.z];
      
      // Call worker to trim the cached manifold
      const { mesh: trimmedMesh } = await manifoldContext.trimByPlane(
        normalArray, 
        plane.originOffset
      );
      
      // Render the trimmed result
      renderMeshData(trimmedMesh);
      
      // Update cutting plane widget visibility
      if (plane.showPlane) {
        if (cuttingPlaneWidgetRef.current) {
          updateCuttingPlaneWidget(cuttingPlaneWidgetRef.current, plane);
        } else {
          const widget = createCuttingPlaneWidget({
            normal: plane.normal,
            originOffset: plane.originOffset,
            size: Math.max(...(modelBounds?.size || [200, 200, 200]))
          });
          sceneRef.current.add(widget);
          cuttingPlaneWidgetRef.current = widget;
        }
      } else {
        clearCuttingPlane();
      }
      
    } catch (error) {
      console.error('[CrossSection] Error applying plane:', error);
      setExecutionError(error.message);
    }
  };

  useEffect(() => {
    if (crossSectionEnabled && cachedMeshData) {
      handlePlaneChange(crossSectionPlane);
    } else if (!crossSectionEnabled && cachedMeshData) {
      // Restore original mesh when cross-section is disabled
      renderMeshData(cachedMeshData);
      clearCuttingPlane();
    }
  }, [crossSectionEnabled]);

  // Picked triangles plus their outline. A duplicate-vertex seam is not an outline edge.
  const highlightFace = useCallback((faceIndices, geometry, positions, index, color = 0xffff00, name = 'highlight') => {
    const highlightPositions = [];

    faceIndices.forEach(faceIdx => {
      const i0 = index[faceIdx * 3];
      const i1 = index[faceIdx * 3 + 1];
      const i2 = index[faceIdx * 3 + 2];
      const v1 = new Vector3().fromBufferAttribute(positions, i0);
      const v2 = new Vector3().fromBufferAttribute(positions, i1);
      const v3 = new Vector3().fromBufferAttribute(positions, i2);
      highlightPositions.push(
        v1.x, v1.y, v1.z,
        v2.x, v2.y, v2.z,
        v3.x, v3.y, v3.z
      );
    });

    // Index-shared edges cancel. A seam whose copies do not share an index
    // cancels too, when its midpoint already lies on this face.
    const boundaryEdgePositions = highlightBoundaryPositions(positions, index, faceIndices);
    
    // Create highlight mesh
    const highlightGeometry = new BufferGeometry();
    highlightGeometry.setAttribute('position', new BufferAttribute(new Float32Array(highlightPositions), 3));
    const indices = [];
    for (let i = 0; i < faceIndices.length * 3; i++) {
      indices.push(i);
    }
    highlightGeometry.setIndex(indices);
    
    const highlightMesh = new ThreeMesh(highlightGeometry, new MeshBasicMaterial({
      color, transparent: true, opacity: 0.3, depthTest: true, side: 2
    }));
    highlightMesh.name = name;
    const shift = partWorldOffset(resultRef.current);
    if (shift) highlightMesh.position.set(shift.x, shift.y, shift.z);
    
    // Create boundary edge lines only
    if (boundaryEdgePositions.length > 0) {
      const edgeGeometry = new BufferGeometry();
      edgeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(boundaryEdgePositions), 3));
      const edgesLine = new LineSegments(edgeGeometry, new LineBasicMaterial({ 
        color, linewidth: 3, depthTest: true
      }));
      highlightMesh.add(edgesLine);
    }
    
    sceneRef.current.add(highlightMesh);
    
    if (!highlightMeshRef.current) {
      highlightMeshRef.current = [];
    }
    highlightMeshRef.current.push(highlightMesh);
  }, []);

  // Below highlightFace on purpose. These dep arrays run during render; listing
  // highlightFace above its const throws and the viewport never mounts.
  const paintDraftPicks = useCallback((state) => {
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    clearHighlight();
    if (!state) return;
    if (geom && positions && index && state.neutral?.indices?.length) {
      highlightFace(state.neutral.indices, geom, positions, index, 0x22d3ee, 'draft-neutral');
    }
    const drafted = (state.drafts || []).flatMap((f) => f.indices || []);
    if (geom && positions && index && drafted.length) {
      highlightFace(drafted, geom, positions, index, 0xfbbf24, 'draft-faces');
    }
  }, [clearHighlight, highlightFace]);

  const exitDraftMode = useCallback(() => {
    const was = draftModeRef.current;
    setDraftMode(null);
    draftModeRef.current = null;
    if (was) clearHighlight();
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, [clearHighlight]);

  const enterDraftMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    if (cutModeRef.current || moveModeRef.current || moveFaceModeRef.current || deleteFaceModeRef.current) clearHighlight();
    setCutMode(null);
    cutModeRef.current = null;
    setMoveMode(null);
    moveModeRef.current = null;
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const picks = facePickGroupRef.current?.picks || [];
    let seed = null;
    if (picks.length === 1) seed = picks[0];
    else if (selectedFace && Array.isArray(selectedFace.center) && Array.isArray(selectedFace.normal)) {
      seed = {
        center: selectedFace.center,
        normal: selectedFace.normal,
        indices: undefined,
      };
    }
    const next = emptyDraftState(seed);
    setDraftMode(next);
    draftModeRef.current = next;
    paintDraftPicks(next);
  }, [exitContourMode, selectedFace, clearFilletBlendPreview, clearEdgeHover, clearEdgeHighlight, clearHighlight, paintDraftPicks]);

  const commitDraftState = useCallback((next) => {
    draftModeRef.current = next;
    setDraftMode(next);
    paintDraftPicks(next);
  }, [paintDraftPicks]);

  const acceptDraft = useCallback(() => {
    const state = draftModeRef.current;
    if (!state) return;
    const gate = validateDraftAccept(state);
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitDraft?.({ state });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitDraftMode();
    }
  }, [onCommitDraft, exitDraftMode, onFaceSelected, clearHighlight]);

  const clearCutPlaneWidget = useCallback(() => {
    const widget = cutPlaneWidgetRef.current;
    if (!widget || !sceneRef.current) return;
    sceneRef.current.remove(widget);
    widget.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    cutPlaneWidgetRef.current = null;
  }, []);

  useEffect(() => {
    if (!cutMode) clearCutPlaneWidget();
  }, [cutMode, clearCutPlaneWidget]);

  const syncCutPlaneWidget = useCallback((state) => {
    const plane = cutPlaneFromState(state);
    if (!plane || !sceneRef.current) {
      clearCutPlaneWidget();
      return;
    }
    const size = Math.max(40, ...(modelBoundsRef.current?.size || [40]));
    if (cutPlaneWidgetRef.current) {
      updateCuttingPlaneWidget(cutPlaneWidgetRef.current, {
        normal: plane.normal,
        originOffset: plane.originOffset,
      });
      return;
    }
    const widget = createCuttingPlaneWidget({
      normal: plane.normal,
      originOffset: plane.originOffset,
      size: size * 1.4,
      color: 0x22d3ee,
      opacity: 0.22,
    });
    sceneRef.current.add(widget);
    cutPlaneWidgetRef.current = widget;
  }, [clearCutPlaneWidget]);

  const removeCutPreviewGroup = useCallback(() => {
    const group = cutPiecesPreviewRef.current;
    if (!group) return;
    sceneRef.current?.remove(group);
    group.traverse((obj) => {
      if (obj === group) return;
      obj.geometry?.dispose?.();
      obj.material?.dispose?.();
    });
    cutPiecesPreviewRef.current = null;
  }, []);

  const restoreCutBaseMesh = useCallback(() => {
    const mesh = resultRef.current;
    if (mesh && cutBaseMaterialRef.current) {
      mesh.material = cutBaseMaterialRef.current;
      cutBaseMaterialRef.current = null;
    }
  }, []);

  const clearCutPiecePreview = useCallback(() => {
    cutPreviewGenRef.current += 1;
    cutLiveKeyRef.current = '';
    cutLivePiecesRef.current = null;
    if (cutPreviewTimerRef.current) {
      clearTimeout(cutPreviewTimerRef.current);
      cutPreviewTimerRef.current = null;
    }
    removeCutPreviewGroup();
    restoreCutBaseMesh();
  }, [removeCutPreviewGroup, restoreCutBaseMesh]);
  clearCutPiecePreviewRef.current = clearCutPiecePreview;

  // Leaving Pieces, Dismiss, or another mode that drops cut mode: the clone
  // never touched the script, and the viewport goes back to the whole model.
  useEffect(() => {
    if (cutMode?.pick === 'pieces') return;
    clearCutPiecePreview();
  }, [cutMode, clearCutPiecePreview]);

  const hideCutBaseMesh = useCallback(() => {
    const mesh = resultRef.current;
    if (!mesh) return;
    if (!cutBaseHiddenMatRef.current) {
      cutBaseHiddenMatRef.current = new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
    }
    if (!cutBaseMaterialRef.current) cutBaseMaterialRef.current = mesh.material;
    mesh.material = cutBaseHiddenMatRef.current;
  }, []);

  const paintLiveCutPieces = useCallback((state, pieces) => {
    const scene = sceneRef.current;
    if (!scene) return;
    removeCutPreviewGroup();
    hideCutBaseMesh();
    const group = new Group();
    group.name = 'cutPiecesPreview';
    const addMesh = (geom, material) => {
      const pieceMesh = new ThreeMesh(geom, material);
      pieceMesh.raycast = () => {};
      group.add(pieceMesh);
      return pieceMesh;
    };
    let colorI = 0;
    for (const piece of pieces || []) {
      const geom = geometryFromPreviewMesh(piece.mesh);
      if (!geom) continue;
      if (!piece.selected) {
        addMesh(geom, new MeshNormalMaterial({ flatShading: true }));
        continue;
      }
      const color = CUT_PIECE_COLORS[colorI % CUT_PIECE_COLORS.length];
      colorI += 1;
      const hidden = cutPreviewPieceHidden(state, piece);
      if (hidden) {
        geom.dispose();
        continue;
      }
      // Opaque depth, then a front-face tint. The tint blends with the
      // background; the other piece is already in the depth buffer.
      const depthGeom = geom.clone();
      addMesh(depthGeom, new MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        side: FrontSide,
      }));
      addMesh(geom, new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: CUT_PIECE_OPACITY,
        depthWrite: false,
        depthTest: true,
        side: FrontSide,
      }));
    }
    scene.add(group);
    cutPiecesPreviewRef.current = group;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) renderer.render(scene, camera);
  }, [hideCutBaseMesh, removeCutPreviewGroup]);

  const ensureLiveCutPreview = useCallback((state) => {
    const key = cutPreviewKey(state);
    if (!key) {
      clearCutPiecePreview();
      return;
    }
    if (cutLiveKeyRef.current === key && cutLivePiecesRef.current) {
      paintLiveCutPieces(state, cutLivePiecesRef.current);
      return;
    }
    const gen = ++cutPreviewGenRef.current;
    cutLiveKeyRef.current = '';
    cutLivePiecesRef.current = null;
    removeCutPreviewGroup();
    restoreCutBaseMesh();
    if (cutPreviewTimerRef.current) clearTimeout(cutPreviewTimerRef.current);
    const plane = cutPreviewPlanePayload(state);
    const bodies = (state.bodies || []).map((b) => ({ at: b.at }));
    cutPreviewTimerRef.current = setTimeout(() => {
      cutPreviewTimerRef.current = null;
      if (gen !== cutPreviewGenRef.current) return;
      manifoldContext.previewCut({ plane, bodies }).then((payload) => {
        if (gen !== cutPreviewGenRef.current) return;
        const live = cutModeRef.current;
        if (!live || live.pick !== 'pieces' || cutPreviewKey(live) !== key) return;
        cutLiveKeyRef.current = key;
        cutLivePiecesRef.current = payload?.pieces || [];
        paintLiveCutPieces(live, cutLivePiecesRef.current);
      }).catch((err) => {
        if (gen !== cutPreviewGenRef.current) return;
        clearCutPiecePreview();
        showShellToast(err?.message || 'Cut preview failed');
      });
    }, 60);
  }, [clearCutPiecePreview, paintLiveCutPieces, removeCutPreviewGroup, restoreCutBaseMesh]);

  const paintCutPicks = useCallback((state) => {
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    clearHighlight();
    if (!state || !geom || !positions || !index) {
      clearCutPiecePreview();
      return;
    }
    const plane = cutPlaneFromState(state);
    if (state.pick === 'pieces' && plane && (state.bodies || []).length) {
      ensureLiveCutPreview(state);
      return;
    }
    clearCutPiecePreview();
    const keepTris = [];
    const dropTris = [];
    for (const body of state.bodies || []) {
      const info = classifyCutBody(body, plane, positions, index);
      for (const tri of body.triangles || []) {
        const side = trianglePieceSide(tri, body, info, plane, positions, index);
        const dropped = (state.drop || []).some((d) => d.key === cutBodyKey(body) && d.side === side);
        (dropped ? dropTris : keepTris).push(tri);
      }
    }
    if (keepTris.length) highlightFace(keepTris, geom, positions, index, 0x22d3ee, 'cut-bodies');
    if (dropTris.length) highlightFace(dropTris, geom, positions, index, 0xf97316, 'cut-drop');
  }, [clearHighlight, highlightFace, clearCutPiecePreview, ensureLiveCutPreview]);

  const exitCutMode = useCallback(() => {
    const was = cutModeRef.current;
    setCutMode(null);
    cutModeRef.current = null;
    clearCutPlaneWidget();
    clearCutPiecePreview();
    if (was) clearHighlight();
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, [clearHighlight, clearCutPlaneWidget, clearCutPiecePreview]);

  const commitCutState = useCallback((next) => {
    cutModeRef.current = next;
    setCutMode(next);
    paintCutPicks(next);
    syncCutPlaneWidget(next);
  }, [paintCutPicks, syncCutPlaneWidget]);

  const enterCutMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    if (moveModeRef.current || moveFaceModeRef.current || deleteFaceModeRef.current) clearHighlight();
    setMoveMode(null);
    moveModeRef.current = null;
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const next = emptyCutState();
    const face = selectedFace && Array.isArray(selectedFace.center) && Array.isArray(selectedFace.normal)
      ? selectedFace
      : null;
    const classified = face ? (face.type ? face : classifySelectedFace(face)) : null;
    if (classified && classified.type === 'planar') {
      next.planeFace = {
        center: classified.center.map(Number),
        normal: classified.normal.map(Number),
      };
      next.pick = 'bodies';
    }
    commitCutState(next);
  }, [
    exitContourMode,
    selectedFace,
    clearFilletBlendPreview,
    clearEdgeHover,
    clearEdgeHighlight,
    commitCutState,
  ]);

  const acceptCut = useCallback(() => {
    const state = cutModeRef.current;
    if (!state) return;
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    const bodyCount = meshBodyComponents(positions, index).length;
    const gate = validateCutAccept(state, { positions, index, bodyCount });
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitCut?.({ state, mesh: { positions, index, bodyCount } });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitCutMode();
    }
  }, [onCommitCut, exitCutMode, onFaceSelected, clearHighlight]);

  const clearMovePreview = useCallback(() => {
    const mesh = movePreviewRef.current;
    movePreviewRef.current = null;
    if (!mesh) return;
    if (sceneRef.current) sceneRef.current.remove(mesh);
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  }, []);

  const paintMovePreview = useCallback((state) => {
    clearMovePreview();
    const tris = state?.target?.triangles;
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    const scene = sceneRef.current;
    if (!tris?.length || !positions || !index || !scene) return;
    const buf = (typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || '';
    const offset = movePreviewOffset(state, buf);
    if (!offset) return;
    const [dx, dy, dz] = offset;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const pos = [];
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k];
        pos.push(positions.getX(v) + dx, positions.getY(v) + dy, positions.getZ(v) + dz);
      }
    }
    if (pos.length < 9) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geometry.computeVertexNormals();
    const mesh = new ThreeMesh(geometry, new MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.45,
      depthTest: true,
      side: FrontSide,
    }));
    mesh.name = 'move-preview';
    mesh.raycast = () => {};
    scene.add(mesh);
    movePreviewRef.current = mesh;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) renderer.render(scene, camera);
  }, [clearMovePreview, getHelperBuffer]);

  const exitMoveMode = useCallback(() => {
    const was = moveModeRef.current;
    clearMovePreview();
    setMoveMode(null);
    moveModeRef.current = null;
    if (was) clearHighlight();
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, [clearHighlight, clearMovePreview]);

  const enterMoveMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    if (cutModeRef.current) {
      clearHighlight();
      clearCutPlaneWidget();
      clearCutPiecePreview();
    }
    setCutMode(null);
    cutModeRef.current = null;
    if (moveFaceModeRef.current || deleteFaceModeRef.current) clearHighlight();
    clearMoveFacePreviewRef.current();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const next = emptyMoveState();
    moveModeRef.current = next;
    setMoveMode(next);
    clearHighlight();
  }, [
    exitContourMode,
    clearFilletBlendPreview,
    clearCutPlaneWidget,
    clearCutPiecePreview,
    clearEdgeHover,
    clearEdgeHighlight,
    clearHighlight,
  ]);

  const acceptMove = useCallback(() => {
    const state = moveModeRef.current;
    if (!state) return;
    const gate = validateMoveAccept(state);
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitMove?.({ state });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitMoveMode();
    }
  }, [onCommitMove, exitMoveMode, onFaceSelected, clearHighlight]);

  const removeMoveFacePreview = useCallback(() => {
    if (moveFacePreviewTimerRef.current) {
      clearTimeout(moveFacePreviewTimerRef.current);
      moveFacePreviewTimerRef.current = null;
    }
    const preview = moveFacePreviewRef.current;
    moveFacePreviewRef.current = null;
    if (preview) {
      sceneRef.current?.remove(preview);
      preview.geometry?.dispose?.();
      preview.material?.dispose?.();
    }
    const mesh = resultRef.current;
    if (mesh && moveFaceBaseMaterialRef.current) {
      mesh.material = moveFaceBaseMaterialRef.current;
      moveFaceBaseMaterialRef.current = null;
    }
  }, []);

  const clearMoveFacePreview = useCallback(() => {
    moveFacePreviewGenRef.current += 1;
    moveFaceLiveKeyRef.current = '';
    removeMoveFacePreview();
  }, [removeMoveFacePreview]);
  clearMoveFacePreviewRef.current = clearMoveFacePreview;

  const hideMoveFaceBase = useCallback(() => {
    const mesh = resultRef.current;
    if (!mesh) return;
    if (!moveFaceHiddenMatRef.current) {
      moveFaceHiddenMatRef.current = new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
    }
    if (!moveFaceBaseMaterialRef.current) moveFaceBaseMaterialRef.current = mesh.material;
    mesh.material = moveFaceHiddenMatRef.current;
  }, []);

  const paintMoveFacePreview = useCallback((meshData) => {
    const scene = sceneRef.current;
    removeMoveFacePreview();
    if (!scene || !meshData) return;
    const geom = geometryFromPreviewMesh(meshData);
    if (!geom) return;
    hideMoveFaceBase();
    const mesh = new ThreeMesh(geom, makePreviewSkinMaterial());
    mesh.name = 'move-face-preview';
    mesh.raycast = () => {};
    scene.add(mesh);
    moveFacePreviewRef.current = mesh;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) renderer.render(scene, camera);
  }, [hideMoveFaceBase, removeMoveFacePreview]);

  const ensureMoveFacePreview = useCallback((state) => {
    const dist = Number(state?.distance);
    const faces = state?.faces || [];
    if (!faces.length || !Number.isFinite(dist) || dist === 0) {
      clearMoveFacePreview();
      return;
    }
    const payloadFaces = faces.map((f) => ({ center: f.center, normal: f.normal }));
    const key = JSON.stringify({ payloadFaces, dist, flip: !!state.flip });
    if (moveFaceLiveKeyRef.current === key && moveFacePreviewRef.current) return;
    const gen = ++moveFacePreviewGenRef.current;
    moveFaceLiveKeyRef.current = '';
    removeMoveFacePreview();
    moveFacePreviewTimerRef.current = setTimeout(() => {
      moveFacePreviewTimerRef.current = null;
      if (gen !== moveFacePreviewGenRef.current) return;
      manifoldContext.previewMoveFace({
        faces: payloadFaces,
        distance: dist,
        flip: !!state.flip,
      }).then((payload) => {
        if (gen !== moveFacePreviewGenRef.current) return;
        const live = moveFaceModeRef.current;
        if (!live) return;
        moveFaceLiveKeyRef.current = key;
        paintMoveFacePreview(payload?.mesh);
      }).catch((err) => {
        if (gen !== moveFacePreviewGenRef.current) return;
        removeMoveFacePreview();
        showShellToast(err?.message || 'Move Face preview failed');
      });
    }, 60);
  }, [clearMoveFacePreview, paintMoveFacePreview, removeMoveFacePreview]);

  const paintMoveFacePicks = useCallback((state) => {
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    clearHighlight();
    const shown = [...new Set((state?.faces || []).flatMap((f) => f.indices || []))];
    if (geom && positions && index && shown.length) {
      highlightFace(shown, geom, positions, index, 0xffff00, 'move-face');
    }
  }, [clearHighlight, highlightFace]);

  const exitMoveFaceMode = useCallback(() => {
    const was = moveFaceModeRef.current;
    clearMoveFacePreview();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    if (was) clearHighlight();
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, [clearHighlight, clearMoveFacePreview]);

  const commitMoveFaceState = useCallback((next) => {
    moveFaceModeRef.current = next;
    setMoveFaceMode(next);
    paintMoveFacePicks(next);
  }, [paintMoveFacePicks]);

  const enterMoveFaceMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    if (cutModeRef.current) {
      clearHighlight();
      clearCutPlaneWidget();
      clearCutPiecePreview();
    }
    setCutMode(null);
    cutModeRef.current = null;
    if (moveModeRef.current) {
      clearHighlight();
      clearMovePreview();
    }
    setMoveMode(null);
    moveModeRef.current = null;
    if (deleteFaceModeRef.current) clearHighlight();
    clearDeleteFacePreviewRef.current();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const picks = facePickGroupRef.current?.picks;
    let seed = [];
    if (Array.isArray(picks) && picks.length) seed = picks;
    else if (selectedFace && Array.isArray(selectedFace.center) && Array.isArray(selectedFace.normal)) {
      seed = [selectedFace];
    }
    commitMoveFaceState(emptyMoveFaceState(seed));
  }, [
    exitContourMode,
    selectedFace,
    clearFilletBlendPreview,
    clearCutPlaneWidget,
    clearCutPiecePreview,
    clearMovePreview,
    clearEdgeHover,
    clearEdgeHighlight,
    commitMoveFaceState,
  ]);

  const acceptMoveFace = useCallback(() => {
    const state = moveFaceModeRef.current;
    if (!state) return;
    const gate = validateMoveFaceAccept(state);
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitMoveFace?.({ state });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitMoveFaceMode();
    }
  }, [onCommitMoveFace, exitMoveFaceMode, onFaceSelected, clearHighlight]);

  useEffect(() => {
    if (!moveFaceMode) {
      clearMoveFacePreview();
      return;
    }
    ensureMoveFacePreview(moveFaceMode);
  }, [moveFaceMode, clearMoveFacePreview, ensureMoveFacePreview]);

  // A tap only adds or removes a face. deleteFace runs on Confirm, not here,
  // so a heal that cannot stay closed does not throw on the click.
  const clearDeleteFacePreview = useCallback(() => {}, []);
  clearDeleteFacePreviewRef.current = clearDeleteFacePreview;

  const paintDeleteFacePicks = useCallback((state) => {
    const geom = resultRef.current?.geometry;
    const positions = geom?.attributes?.position;
    const index = geom?.index?.array;
    clearHighlight();
    const shown = [...new Set((state?.faces || []).flatMap((f) => f.indices || []))];
    if (geom && positions && index && shown.length) {
      highlightFace(shown, geom, positions, index, 0xffff00, 'delete-face');
    }
  }, [clearHighlight, highlightFace]);

  const exitDeleteFaceMode = useCallback(() => {
    const was = deleteFaceModeRef.current;
    clearDeleteFacePreview();
    setDeleteFaceMode(null);
    deleteFaceModeRef.current = null;
    if (was) clearHighlight();
    if (shellToastTimerRef.current) {
      clearTimeout(shellToastTimerRef.current);
      shellToastTimerRef.current = null;
    }
    setShellToast(null);
  }, [clearHighlight, clearDeleteFacePreview]);

  const commitDeleteFaceState = useCallback((next) => {
    deleteFaceModeRef.current = next;
    setDeleteFaceMode(next);
    paintDeleteFacePicks(next);
  }, [paintDeleteFacePicks]);

  const enterDeleteFaceMode = useCallback(() => {
    exitContourMode();
    setFilletMode(null);
    filletModeRef.current = null;
    clearFilletBlendPreview();
    setShellMode(null);
    shellModeRef.current = null;
    setDraftMode(null);
    draftModeRef.current = null;
    if (cutModeRef.current) {
      clearHighlight();
      clearCutPlaneWidget();
      clearCutPiecePreview();
    }
    setCutMode(null);
    cutModeRef.current = null;
    if (moveModeRef.current) {
      clearHighlight();
      clearMovePreview();
    }
    setMoveMode(null);
    moveModeRef.current = null;
    if (moveFaceModeRef.current) clearHighlight();
    clearMoveFacePreview();
    setMoveFaceMode(null);
    moveFaceModeRef.current = null;
    setPickMode('face');
    clearEdgeHover();
    clearEdgeHighlight();
    setSelectedEdges([]);
    const picks = facePickGroupRef.current?.picks;
    let seed = [];
    if (Array.isArray(picks) && picks.length) seed = picks;
    else if (selectedFace && Array.isArray(selectedFace.center) && Array.isArray(selectedFace.normal)) {
      seed = [selectedFace];
    }
    commitDeleteFaceState(emptyDeleteFaceState(seed));
  }, [
    exitContourMode,
    selectedFace,
    clearFilletBlendPreview,
    clearCutPlaneWidget,
    clearCutPiecePreview,
    clearMovePreview,
    clearMoveFacePreview,
    clearEdgeHover,
    clearEdgeHighlight,
    commitDeleteFaceState,
  ]);

  const acceptDeleteFace = useCallback(() => {
    const state = deleteFaceModeRef.current;
    if (!state) return;
    const gate = validateDeleteFaceAccept(state);
    if (!gate.ok) {
      showShellToast(gate.message);
      return;
    }
    const ok = onCommitDeleteFace?.({ state });
    if (ok) {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      exitDeleteFaceMode();
    }
  }, [onCommitDeleteFace, exitDeleteFaceMode, onFaceSelected, clearHighlight]);

  const clearMeasurementLines = useCallback(() => {
    if (measurementLinesRef.current && sceneRef.current) {
      sceneRef.current.remove(measurementLinesRef.current);
      disposeMeasurementLines(measurementLinesRef.current);
      measurementLinesRef.current = null;
    }
  }, []);

  const updateMeasurementVisualization = useCallback((face1, face2) => {
    // Clear existing measurement lines
    clearMeasurementLines();
    
    if (face1 && face2 && sceneRef.current) {
      // Create new measurement lines
      const lines = createMeasurementLines(face1, face2);
      sceneRef.current.add(lines);
      measurementLinesRef.current = lines;
    }
  }, [clearMeasurementLines]);


  /** Shared screen-space edge pick. Occlusion raycast is opt-in (click path);
   *  hover skips it to avoid full mesh intersect on every mousemove (iPhone jank). */
  const pickEdgeAtClient = useCallback((clientX, clientY, { occlude = true } = {}) => {
    if (!canvasRef.current || !cameraRef.current || !resultRef.current) return null;
    syncFeatureEdges(resultRef.current.geometry);
    const shift = partWorldOffset(resultRef.current);
    const localEdges = featureEdgesRef.current;
    const pickEdges = shift ? localEdges.map((edge) => shiftEdgeForWorld(edge, shift)) : localEdges;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const slop = resolveEdgePickSlopPx();
    const cam = cameraRef.current.position;
    const opts = {
      projectScratchA: edgePickScratchA.current,
      projectScratchB: edgePickScratchB.current,
      cameraPosition: [cam.x, cam.y, cam.z],
    };
    if (occlude) {
      // Raycast mesh for occlusion — reject back-face edges behind the hit.
      mouseRef.current.x = (px / rect.width) * 2 - 1;
      mouseRef.current.y = -(py / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
      const hits = raycasterRef.current.intersectObject(resultRef.current);
      if (hits.length > 0) {
        const p = hits[0].point;
        opts.meshHitPoint = [p.x, p.y, p.z];
      }
    }
    const picked = pickNearestEdgeScreen(
      pickEdges,
      cameraRef.current,
      rect.width,
      rect.height,
      px,
      py,
      slop,
      opts,
    );
    if (!picked || pickEdges === localEdges) return picked;
    return localEdges.find((edge) => edge.key === picked.key) || null;
  }, [syncFeatureEdges]);

  /**
   * Handle mouse down - record position for drag detection
   */
  const handleMouseDown = useCallback((event) => {
    mouseDownPosRef.current = { x: event.clientX, y: event.clientY };
    isDraggingRef.current = false;

    // Right button on a placed point picks it up (left button keeps adding).
    if (event.button !== 2 || contourModeRef.current?.tool !== 'polyline') return;
    if (pickModeRef.current === 'edge') return;
    const index = pickPolylinePointAtClient(event.clientX, event.clientY);
    if (index < 0) return;
    event.preventDefault();
    polylinePointDragRef.current = {
      index,
      plane: contourWorkplane(contourModeRef.current, modelBoundsRef.current),
      moved: false,
    };
    setPolylinePointHover(index);
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    paintPolylineHandleStates();
  }, [pickPolylinePointAtClient, setPolylinePointHover, paintPolylineHandleStates]);

  /**
   * Project the cursor onto the draft's workplane.
   * @returns {{ uv: number[], world: number[] }|null}
   */
  const polylinePlanePointAtClient = useCallback((clientX, clientY, plane) => {
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    if (!canvas || !camera || !plane) return null;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const o = raycasterRef.current.ray.origin;
    const d = raycasterRef.current.ray.direction;
    const world = intersectRayPlane([o.x, o.y, o.z], [d.x, d.y, d.z], plane);
    if (!world) return null;
    let uv;
    try {
      uv = worldToPlaneUV(world, plane);
    } catch {
      return null;
    }
    if (!uv.every(Number.isFinite)) return null;
    return { uv, world };
  }, []);

  /** Write the dragged point back into mode state (once, on release). */
  const commitPolylinePointDrag = useCallback((uv, index) => {
    setContourMode((prev) => {
      if (!prev || prev.tool !== 'polyline') return prev;
      const points = (prev.params?.points || []).map(
        (pt, i) => (i === index ? [uv[0], uv[1]] : pt),
      );
      const next = { ...prev, params: { ...prev.params, points } };
      return isLoftEntry(prev.entry) ? writeLoftSelected(next, { params: next.params }) : next;
    });
  }, []);

  const endPolylinePointDrag = useCallback((event) => {
    const drag = polylinePointDragRef.current;
    if (!drag) return;
    polylinePointDragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = '';
    if (drag.moved && drag.lastUv) commitPolylinePointDrag(drag.lastUv, drag.index);
    // A release outside the canvas has no meaningful hover.
    const stillOver = event
      && pickPolylinePointAtClient(event.clientX, event.clientY) === drag.index;
    setPolylinePointHover(stillOver ? drag.index : -1);
    paintPolylineHandleStates();
  }, [commitPolylinePointDrag, pickPolylinePointAtClient, setPolylinePointHover,
    paintPolylineHandleStates]);

  /**
   * Handle mouse move - detect if dragging
   */
  const handleMouseMove = useCallback((event) => {
    // Live point drag owns the pointer: move the handle, skip camera/pick work.
    const drag = polylinePointDragRef.current;
    if (drag) {
      const hit = polylinePlanePointAtClient(event.clientX, event.clientY, drag.plane);
      if (hit) {
        drag.moved = true;
        drag.lastUv = hit.uv;
        movePolylineHandle(drag.index, hit.world);
      }
      return;
    }

    if (mouseDownPosRef.current) {
      const dx = event.clientX - mouseDownPosRef.current.x;
      const dy = event.clientY - mouseDownPosRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > DRAG_THRESHOLD) {
        isDraggingRef.current = true;
      }
    }

    // Optional Edge-mode pre-highlight: teach the fat hit target (nearest edge).
    if (
      pickModeRef.current === 'edge'
      && !isDraggingRef.current
      && canvasRef.current
      && cameraRef.current
      && resultRef.current
    ) {
      const edge = pickEdgeAtClient(event.clientX, event.clientY, { occlude: false });
      const selectedKeys = new Set(
        (Array.isArray(selectedEdges) ? selectedEdges : []).map((e) => edgeKey(e)),
      );
      highlightHoverEdge(edge, selectedKeys);
    } else if (pickModeRef.current !== 'edge') {
      clearEdgeHover();
    }

    // Teach the grab: handles grow and warm as the cursor reaches them.
    if (contourModeRef.current?.tool === 'polyline' && pickModeRef.current !== 'edge') {
      setPolylinePointHover(pickPolylinePointAtClient(event.clientX, event.clientY));
    } else if (polylinePointHoverRef.current !== -1) {
      setPolylinePointHover(-1);
    }
  }, [selectedEdges, highlightHoverEdge, clearEdgeHover, pickEdgeAtClient,
    polylinePlanePointAtClient, movePolylineHandle, pickPolylinePointAtClient,
    setPolylinePointHover]);

  /**
   * Handle mouse up - process click only if not dragging
   */
  const handleMouseUp = useCallback((event) => {
    if (polylinePointDragRef.current) {
      endPolylinePointDrag(event);
      return;
    }
    // Only the left button places points / picks faces; the right button is
    // the point-move gesture and must never drop a stray point on release.
    if (event.button !== 0) return;
    // Slice Mobile C: long-press already opened the sheet — suppress the click.
    if (featureLongPressFiredRef.current) {
      featureLongPressFiredRef.current = false;
      isDraggingRef.current = false;
      return;
    }
    // If user was dragging, don't process as a click
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      return;
    }
    
    if (!canvasRef.current || !cameraRef.current) return;
    // Face/edge pick still needs a part mesh; polyline workplane taps do not.
    if (!resultRef.current && contourModeRef.current?.tool !== 'polyline') return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    mouseRef.current.x = (px / rect.width) * 2 - 1;
    mouseRef.current.y = -(py / rect.height) * 2 + 1;

    // Slice 24: polyline tool — tap the workplane to add UV points (cheap draw).
    if (contourModeRef.current?.tool === 'polyline' && pickModeRef.current !== 'edge') {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickCountRef.current = 0;
      pendingClickDataRef.current = null;
      // MUST match the painted overlay (contourWorkplaneFace): resolving a
      // different fallback here is what put tapped points off-cursor.
      // Tapping a handle almost always means "grab this", not "stack a second
      // point on top of it" — say so instead of silently doing the wrong thing.
      if (pickPolylinePointAtClient(event.clientX, event.clientY) >= 0) {
        showContourToast('Right-drag this point to move it — tap elsewhere to add one.', { undo: false });
        return;
      }
      const plane = contourWorkplane(contourModeRef.current, modelBoundsRef.current);
      raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
      const origin = raycasterRef.current.ray.origin;
      const dir = raycasterRef.current.ray.direction;
      const hit = intersectRayPlane(
        [origin.x, origin.y, origin.z],
        [dir.x, dir.y, dir.z],
        plane,
      );
      if (!hit) {
        showContourToast('Could not hit the workplane — orbit so the plane faces the camera.');
        return;
      }
      let uv;
      try {
        uv = worldToPlaneUV(hit, plane);
      } catch (e) {
        showContourToast(e.message || 'Could not project onto the workplane.');
        return;
      }
      if (!uv.every(Number.isFinite)) {
        showContourToast('Workplane tap produced a non-finite UV — refusing the point.');
        return;
      }
      setContourMode((prev) => {
        if (!prev || prev.tool !== 'polyline') return prev;
        const points = [...(prev.params?.points || []), [uv[0], uv[1]]];
        const next = { ...prev, params: { ...prev.params, points } };
        return isLoftEntry(prev.entry) ? writeLoftSelected(next, { params: next.params }) : next;
      });
      return;
    }

    if (!resultRef.current) return;

    // Slice 12 hotfix: Edge mode short-circuits face selection entirely.
    // Screen-space pick with finger slop — no mesh-face hit required.
    if (pickModeRef.current === 'edge') {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickCountRef.current = 0;
      pendingClickDataRef.current = null;

      const slop = resolveEdgePickSlopPx();
      const edge = pickEdgeAtClient(event.clientX, event.clientY);
      if (!edge) {
        // Preserve multi-selection on miss (same as #14) — stray taps must not wipe the set.
        console.log('[Edge Selection] No feature edge within', slop, 'px');
        clearEdgeHover();
        return;
      }
      clearEdgeHover();
      setSelectedEdges((prev) => toggleEdgeSelectionPropagated(prev, edge, {
        propagate: tangentPropRef.current,
        featureEdges: featureEdgesRef.current,
      }));
      // Clear face selection so modes do not fight
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      return;
    }

    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const ray = raycasterRef.current.ray;
    const origin = [ray.origin.x, ray.origin.y, ray.origin.z];
    const dir = [ray.direction.x, ray.direction.y, ray.direction.z];
    const camDist = Math.hypot(ray.origin.x, ray.origin.y, ray.origin.z) || 80;
    // Cut owns the canvas: a saved contour under the cursor must not eat the
    // piece tap (same as a construction plane sitting on the cut).
    if (!moveFaceModeRef.current && !deleteFaceModeRef.current && !cutModeRef.current && showContoursRef.current && !moveModeRef.current && contourModeRef.current?.tool !== 'polyline') {
      const hitC = pickContourByRay(
        origin,
        dir,
        savedContoursRef.current,
        savedContourHostPlaneRef.current,
        Math.max(1.5, camDist * 0.02),
      );
      if (hitC) {
        setArmedContourId(hitC.id);
        setContourMode((prev) => (prev ? applySavedContour(prev, hitC) : prev));
        return;
      }
    }
    const planeHits = (showPlanesRef.current && constructionPlaneRef.current)
      ? raycasterRef.current.intersectObject(constructionPlaneRef.current, true)
      : [];
    const solidHits = resultRef.current?.geometry?.attributes?.position
      ? raycasterRef.current.intersectObject(resultRef.current)
      : [];
    const planeD = planeHits[0]?.distance ?? Infinity;
    const solidD = solidHits[0]?.distance ?? Infinity;
    // Cut taps a body or a piece. A construction plane that sits on the cut
    // (the XY plane through a centered part) must not swallow that click.
    if (!cutModeRef.current && planeHits.length && !moveModeRef.current && !moveFaceModeRef.current && !deleteFaceModeRef.current && planeD <= solidD + 0.5) {
      const ud = planeHits[0].object.userData?.plane
        ? planeHits[0].object.userData
        : planeHits[0].object.parent?.userData;
      if (ud?.plane) {
        setSelectedPlaneId(ud.planeId || null);
        setContourMode((prev) => (prev
          ? applyContourPlaneEdit(prev, {
            preset: 'workplane',
            base: ud.plane,
            angles: { x: 0, y: 0, z: 0 },
          })
          : prev));
        return;
      }
    }
    const intersects = solidHits;

    // Handle click on empty space (only if not dragging)
    if (intersects.length === 0) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickCountRef.current = 0;
      pendingClickDataRef.current = null;
      
      if (measurementEnabled) {
        console.log("[Measurement] Keeping face selected for measurement");
      } else if (contourModeRef.current) {
        // Keep the contour workplane — empty taps must not drop the plane.
      } else if (draftModeRef.current) {
        // Preserve draft face selection — stray taps must not wipe the set.
      } else if (shellModeRef.current) {
        // Preserve shell face selection — stray taps must not wipe the set.
      } else if (cutModeRef.current) {
        // Preserve cut body selection — stray taps must not wipe the set.
      } else if (moveModeRef.current) {
        // Preserve the picked body — stray taps must not wipe the target.
      } else if (moveFaceModeRef.current) {
        // Preserve the picked faces — stray taps must not wipe the set.
      } else if (deleteFaceModeRef.current) {
        // Preserve the picked faces — stray taps must not wipe the set.
      } else {
        clearHighlight();
        setSelectedFace(null);
        onFaceSelected?.(null);
      }
      return;
    }
    
    // Capture intersection data
    const intersection = intersects[0];
    const geometry = resultRef.current.geometry;

    const clickedFace = intersection.face;
    const seedFaceIndex = intersection.faceIndex;
    const positions = geometry.attributes.position;
    const index = geometry.index.array;
    
    const clickData = {
      clickedFace,
      seedFaceIndex,
      geometry,
      positions,
      index,
      faceNormal: [clickedFace.normal.x, clickedFace.normal.y, clickedFace.normal.z],
      hitPoint: [intersection.point.x, intersection.point.y, intersection.point.z],
      // Shift (or ⌘/Ctrl) adds this face to the pick instead of replacing it.
      additive: !!(event.shiftKey || event.metaKey || event.ctrlKey),
    };
    
    // Multi-click detection
    const now = Date.now();
    if (now - lastClickTimeRef.current > MULTI_CLICK_DELAY) {
      clickCountRef.current = 0;
    }
    
    clickCountRef.current++;
    lastClickTimeRef.current = now;
    pendingClickDataRef.current = clickData;
    
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
    }
    
    // Process click after delay
    clickTimerRef.current = setTimeout(() => {
      processClick();
    }, MULTI_CLICK_DELAY);
    
  }, [onFaceSelected, measurementEnabled, clearHighlight, clearEdgeHover, pickEdgeAtClient,
    endPolylinePointDrag, pickPolylinePointAtClient]);


  /**
   * Commit a shell/draft face list: highlight every selected face and expose
   * the group on selectedFace. clearHighlight() drops the ref, so restore it
   * after. An empty list clears the highlight — used by Undo-to-zero and Clear.
   */
  const publishFacePicks = useCallback((picks, geometry, positions, index, faceData = null) => {
    const list = Array.isArray(picks) ? picks : [];
    const lite = list.map((f) => ({ center: f.center, normal: f.normal }));
    const shown = [...new Set(list.flatMap((f) => f.indices || []))];
    clearHighlight();
    facePickGroupRef.current = list.length ? { picks: list } : null;
    if (!list.length) {
      setSelectedFace(null);
      onFaceSelected?.(null);
      setShellMode((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, lastFace: null };
        shellModeRef.current = updated;
        return updated;
      });
      return;
    }
    const last = list[list.length - 1];
    const sameTap = faceData
      && Array.isArray(faceData.center)
      && faceData.center.length === 3
      && faceData.center.every((v, i) => Math.abs(v - last.center[i]) < 1e-6);
    const base = sameTap
      ? faceData
      : {
        center: last.center,
        normal: last.normal,
        area: 0,
        triangleCount: (last.indices || []).length,
        selectionMode: 'coplanar',
      };
    const payload = list.length > 1 ? { ...base, group: lite } : { ...base };
    const classified = classifySelectedFace(payload) || payload;
    setSelectedFace(classified);
    onFaceSelected?.(classified);
    setShellMode((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, lastFace: classified };
      shellModeRef.current = updated;
      return updated;
    });
    if (geometry && positions && index && shown.length) {
      highlightFace(shown, geometry, positions, index, 0xffff00);
    }
  }, [clearHighlight, highlightFace, onFaceSelected]);

  /**
   * Process the pending click based on click count
   * This is called after the multi-click delay has passed
   */
  const processClick = useCallback(() => {
    const clickData = pendingClickDataRef.current;
    if (!clickData) return;
    
    const { clickedFace, seedFaceIndex, geometry, positions, index, faceNormal, additive } = clickData;
    const clickCount = clickCountRef.current;
    
    // Reset click tracking
    clickCountRef.current = 0;
    clickTimerRef.current = null;
    pendingClickDataRef.current = null;
    
    // Shell, Draft, and Cut keep tap-to-add / tap-to-remove. A double click
    // there must stay the old tolerance walk — not the owning body — so
    // confirm still writes the face that was tapped.
    const legacyTap = !!(shellModeRef.current || draftModeRef.current || cutModeRef.current);
    const resolved = resolveViewportFaceClick({
      geometry,
      seedFaceIndex,
      faceNormal,
      clickCount,
      faceIDs: faceIDsRef.current,
      angleTolerance: ANGLE_TOLERANCE_DEGREES,
      legacy: legacyTap || !!moveFaceModeRef.current || !!deleteFaceModeRef.current,
    });
    const faceIndices = resolved.indices;
    const selectionMode = resolved.selectionMode;
    if (legacyTap) {
      console.log(`[Face Selection] ${clickCount}-click picker tap: ${faceIndices.length} triangles (${selectionMode})`);
    } else if (clickCount >= 2) {
      console.log(`[Face Selection] Double-click: body, ${faceIndices.length} triangles`);
    } else {
      console.log(`[Face Selection] Single-click: face (${resolved.kind}), ${faceIndices.length} triangles`);
    }
    
    // Calculate face data (center, area, vertices) from selected triangles
    let centerSum = new Vector3();
    let totalArea = 0;
    const allVertices = [];
    
    faceIndices.forEach(faceIdx => {
      const i0 = index[faceIdx * 3];
      const i1 = index[faceIdx * 3 + 1];
      const i2 = index[faceIdx * 3 + 2];
      const v1 = new Vector3().fromBufferAttribute(positions, i0);
      const v2 = new Vector3().fromBufferAttribute(positions, i1);
      const v3 = new Vector3().fromBufferAttribute(positions, i2);
      const triangle = new Triangle(v1, v2, v3);
      const area = triangle.getArea();
      const triCenter = new Vector3().add(v1).add(v2).add(v3).divideScalar(3);
      centerSum.add(triCenter.multiplyScalar(area));
      totalArea += area;
      allVertices.push([v1.x, v1.y, v1.z], [v2.x, v2.y, v2.z], [v3.x, v3.y, v3.z]);
    });
    
    const center = centerSum.divideScalar(totalArea);
    const normal = clickedFace.normal.clone();
    const faceData = {
      center: [center.x, center.y, center.z],
      normal: [normal.x, normal.y, normal.z],
      area: totalArea,
      vertices: allVertices,
      triangleCount: faceIndices.length,
      selectionMode // Include selection mode in face data for UI display
    };
    
    // Handle measurement mode
    if (measurementEnabled) {
      handleMeasurementClick(faceData, faceIndices, geometry, positions, index);
    } else {
      // Normal face selection mode — clear edges so modes do not fight
      clearEdgeHighlight();
      setSelectedEdges([]);
      // Read the accumulated multi-pick BEFORE clearHighlight() drops it.
      const entry = {
        center: faceData.center,
        normal: faceData.normal,
        indices: faceIndices.slice(),
      };
      let picks;
      if (moveModeRef.current) {
        // Same resolver as the rest of the viewport: one click is the full
        // face and does not change the body. Two clicks set that body as
        // the move target. Not a legacy picker, and no viewport arrows.
        if (clickCount >= 2) {
          const bodies = meshBodyComponents(positions, index);
          const hit = bodyContainingTriangle(bodies, seedFaceIndex);
          if (!hit) {
            showShellToast(MOVE_MODE_NEED_BODY);
            return;
          }
          const prev = moveModeRef.current.target;
          const same = prev && cutBodyKey(prev) === cutBodyKey(hit);
          const buf = (typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || '';
          const target = same ? null : {
            at: resolveMoveBodyAt(hit.at, bodyCentroidsRef.current, buf),
            minTri: hit.minTri,
            triangles: hit.triangles.slice(),
          };
          const next = { ...moveModeRef.current, target };
          moveModeRef.current = next;
          setMoveMode(next);
          clearHighlight();
          if (target) {
            highlightFace(target.triangles, geometry, positions, index, 0x22d3ee, 'move-body');
          }
          paintMovePreview(next);
          return;
        }
        publishFacePicks([entry], geometry, positions, index, faceData);
        {
          let nx = 0;
          let ny = 0;
          let nz = 0;
          for (const faceIdx of faceIndices) {
            const i0 = index[faceIdx * 3];
            const i1 = index[faceIdx * 3 + 1];
            const i2 = index[faceIdx * 3 + 2];
            const ax = positions.getX(i1) - positions.getX(i0);
            const ay = positions.getY(i1) - positions.getY(i0);
            const az = positions.getZ(i1) - positions.getZ(i0);
            const bx = positions.getX(i2) - positions.getX(i0);
            const by = positions.getY(i2) - positions.getY(i0);
            const bz = positions.getZ(i2) - positions.getZ(i0);
            nx += ay * bz - az * by;
            ny += az * bx - ax * bz;
            nz += ax * by - ay * bx;
          }
          const len = Math.hypot(nx, ny, nz);
          if (len > 1e-12) {
            const next = {
              ...moveModeRef.current,
              faceNormal: [nx / len, ny / len, nz / len],
            };
            moveModeRef.current = next;
            setMoveMode(next);
            paintMovePreview(next);
          }
        }
        return;
      }
      if (moveFaceModeRef.current) {
        // Same sticky tap as Shell. A double click stays the legacy face walk,
        // not the owning body, so Confirm still writes the tapped face.
        const next = toggleMoveFaceSelection(moveFaceModeRef.current, entry);
        commitMoveFaceState(next);
        return;
      }
      if (deleteFaceModeRef.current) {
        // Sticky tap: add the face, or remove it if it is already picked.
        // This does not run deleteFace. Confirm writes the call.
        const next = toggleDeleteFaceSelection(deleteFaceModeRef.current, entry);
        commitDeleteFaceState(next);
        return;
      }
      if (cutModeRef.current) {
        // Cut: plane, bodies, and pieces are sticky taps. No shift-click.
        const geom = geometry;
        const tap = applyCutTap(cutModeRef.current, {
          triangle: seedFaceIndex,
          point: clickData.hitPoint,
          face: entry,
          positions: geom?.attributes?.position,
          index: geom?.index?.array,
        });
        if (tap.toast) showShellToast(tap.toast);
        commitCutState(tap.state);
        return;
      }
      if (draftModeRef.current) {
        // Draft: first tap is the neutral face. Later taps toggle drafted faces.
        // Tap the neutral face again to replace it, not to draft it. No modifier.
        const next = applyDraftFaceTap(draftModeRef.current, entry);
        draftModeRef.current = next;
        setDraftMode(next);
        paintDraftPicks(next);
        return;
      }
      if (shellModeRef.current) {
        // Shell: every tap adds. Tap an already-selected face to remove it.
        // No shift / ctrl. Same model as toggleEdgeSelection.
        picks = toggleShellFaceSelection(facePickGroupRef.current?.picks, entry);
      } else {
        const prev = additive ? (facePickGroupRef.current?.picks || []) : [];
        picks = [...prev, entry];
      }
      publishFacePicks(picks, geometry, positions, index, faceData);
      if (picks.length > 1 && !shellModeRef.current) {
        console.log(`[Face Selection] ${picks.length} faces picked (shift-click to add more)`);
      }
    }
    
  }, [measurementEnabled, measurementFaces, onFaceSelected, clearHighlight, clearEdgeHighlight, highlightFace, publishFacePicks, paintDraftPicks, commitCutState, paintMovePreview, commitMoveFaceState, commitDeleteFaceState, getHelperBuffer]);

  /**
   * Handle face selection in measurement mode
   */
  const handleMeasurementClick = useCallback((faceData, faceIndices, geometry, positions, index) => {
    if (!measurementFaces.first) {
      // First face selected - clear any existing measurement lines
      clearMeasurementLines();
      setMeasurementFaces({ first: faceData, second: null });
      
      // Highlight first face in green
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0x00ff00, 'first');
      
      console.log('[Measurement] First face selected');
    } else if (!measurementFaces.second) {
      // Second face selected - highlight and create measurement visualization
      setMeasurementFaces(prev => {
        // Create measurement lines with both faces
        updateMeasurementVisualization(prev.first, faceData);
        return { ...prev, second: faceData };
      });
      highlightFace(faceIndices, geometry, positions, index, 0xffff00, 'second');
      
      console.log('[Measurement] Second face selected');
    } else {
      // Third click - restart with this as first face
      clearMeasurementLines();
      setMeasurementFaces({ first: faceData, second: null });
      
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0x00ff00, 'first');
      
      console.log('[Measurement] Restarted with new first face');
    }
  }, [measurementFaces, clearHighlight, highlightFace, clearMeasurementLines, updateMeasurementVisualization]);

  // Slice Mobile C: long-press (~450ms, no drag) on the part opens a feature sheet.
  // Pointer events cover touch + mouse; cancelled on move past drag threshold or when
  // Contour/Fillet/measure modes own the canvas. Desktop leaves featureSheetEnabled false.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const CLEAR_LP = () => {
      if (featureLongPressTimerRef.current) {
        clearTimeout(featureLongPressTimerRef.current);
        featureLongPressTimerRef.current = null;
      }
      featureLongPressOriginRef.current = null;
    };

    const onPointerDown = (event) => {
      if (!featureSheetEnabledRef.current) return;
      if (event.button != null && event.button !== 0) return;
      if (contourModeRef.current || filletModeRef.current || shellModeRef.current || draftModeRef.current || moveModeRef.current || moveFaceModeRef.current || deleteFaceModeRef.current) return;
      if (measurementEnabled) return;
      CLEAR_LP();
      featureLongPressFiredRef.current = false;
      featureLongPressOriginRef.current = { x: event.clientX, y: event.clientY };
      featureLongPressTimerRef.current = setTimeout(() => {
        featureLongPressTimerRef.current = null;
        const origin = featureLongPressOriginRef.current;
        featureLongPressOriginRef.current = null;
        if (!origin || !featureSheetEnabledRef.current) return;
        if (contourModeRef.current || filletModeRef.current || shellModeRef.current || draftModeRef.current || moveModeRef.current || moveFaceModeRef.current || deleteFaceModeRef.current) return;
        featureLongPressFiredRef.current = true;
        onFeatureLongPressRef.current?.({ clientX: origin.x, clientY: origin.y });
      }, 450);
    };

    const onPointerMove = (event) => {
      const origin = featureLongPressOriginRef.current;
      if (!origin) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (Math.hypot(dx, dy) > 10) CLEAR_LP();
    };

    const onPointerEnd = () => {
      CLEAR_LP();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);
    canvas.addEventListener('pointerleave', onPointerEnd);

    return () => {
      CLEAR_LP();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      canvas.removeEventListener('pointerleave', onPointerEnd);
    };
  }, [measurementEnabled]);

  // --- Event listener setup ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Right-drag must not raise the browser menu over the sketch, and a drag
    // that ends off-canvas still has to release (window-level mouseup).
    const onContextMenu = (event) => {
      if (contourModeRef.current?.tool === 'polyline') event.preventDefault();
    };
    const onWindowMouseUp = (event) => {
      if (polylinePointDragRef.current) endPolylinePointDrag(event);
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mouseup', onWindowMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp, endPolylinePointDrag]);

  // Click / toast timer cleanup effect
  useEffect(() => {
    return () => {
      // Cleanup click timer on unmount
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
      if (edgeModeToastTimerRef.current) {
        clearTimeout(edgeModeToastTimerRef.current);
        edgeModeToastTimerRef.current = null;
      }
      // Cleanup measurement lines on unmount
      clearMeasurementLines();
    };
  }, [clearMeasurementLines]);

  useEffect(() => {
    if (!measurementEnabled) {
      clearMeasurementLines();
    }
  }, [measurementEnabled, clearMeasurementLines]);

  // Initialize Three.js scene
  useEffect(() => {
    console.log('[Viewport] Initializing Three.js scene');
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    let initialized = false;
    
    const getContainerSize = () => {
      const size = {
        width: container.clientWidth,
        height: container.clientHeight
      };
      return size;
    };

    const initScene = () => {
      if (initialized) return;
      
      let { width, height } = getContainerSize();
      
      if (width === 0 || height === 0) {
        return;
      }
      
      initialized = true;

      const scene = new Scene();
      // Match Monaco / body (#1e1e1e) — not Tailwind gray-900 (#111827).
      scene.background = new Color(0x1e1e1e);
      const camera = new PerspectiveCamera(45, width / height, 0.1, 2000);
      camera.position.set(300, 300, 300);
      camera.lookAt(0, 0, 0);
      const light = new PointLight(0xffffff, 1);
      camera.add(light);
      scene.add(camera);

      sceneRef.current = scene;
      cameraRef.current = camera;
      setSceneReady(true);

      const renderer = new WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true
      });

      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x1e1e1e, 1);
      rendererRef.current = renderer;

      // Dev/automation hook used by headless review tooling (harness/stage_shot.mjs).
      // Drives the exact same execute -> render path the Run button uses, and lets a
      // script position the camera deterministically for reproducible screenshots.
      const __tris = () => {
        const g = resultRef.current?.geometry;
        if (!g) return 0;
        return g.index ? Math.ceil(g.index.count / 3)
          : (g.attributes?.position ? Math.ceil(g.attributes.position.count / 3) : 0);
      };
      if (import.meta.env?.DEV) {
        window.__VIEWPORT__ = {
          ready: () => !!(sceneRef.current && rendererRef.current && resultRef.current),
          // Set this from automation to be notified the instant a mesh lands in the scene.
          // Fires from renderMeshData with the exact meshData object that was painted.
          onRendered: null,
          _lastRenderedMesh: null,
          _renderCount: 0,
          lastRenderedIs: (mesh) => window.__VIEWPORT__?._lastRenderedMesh === mesh,
          // Run a script exactly as the Run button does -- validate, execute in the worker,
          // render into the live scene, auto-fit. Resolves { error, mesh } so a headless
          // caller can tell a fresh build from a failure without reading React state.
          executeScript: async (s) => {
            stageExecErrorRef.current = null;
            try {
              await executeScript(s);
            } catch (e) {
              stageExecErrorRef.current = String(e?.message || e);
            }
            const err = stageExecErrorRef.current;
            const mesh = err ? null : (window.__MANIFOLD_CONTEXT__?.lastResult?.mesh ?? null);
            // Identity check against the render choke point: the object we painted is the
            // object the worker just returned, or this run did not reach the screen at all.
            return {
              error: err,
              mesh,
              onScreen: !!mesh && window.__VIEWPORT__?._lastRenderedMesh === mesh,
              sceneTris: __tris(),
            };
          },
          // az/el in degrees, z-up world (the app models parts with +Z up). Delegates to
          // the same fitView the UI buttons use, so an automated capture frames the part
          // exactly as a manual snap would.
          stageFit: ({ az = 35, el = 20, margin = 1.15 } = {}) => {
            const cam = cameraRef.current, ctl = controlsRef.current, res = resultRef.current;
            if (!cam || !res || !res.geometry) return false;
            const azr = (az * Math.PI) / 180, elr = (el * Math.PI) / 180;
            const ok = fitView({
              camera: cam, controls: ctl, geometry: res.geometry,
              dir: [Math.cos(elr) * Math.cos(azr), Math.cos(elr) * Math.sin(azr), Math.sin(elr)],
              up: [0, 0, 1], margin,
            });
            renderer.render(sceneRef.current, cam);
            return ok;
          },
          stageSnap: (key, margin = VIEW_SNAP_MARGIN) => {
            const known = Object.prototype.hasOwnProperty.call(VIEW_PRESETS, key) ? key : 'iso';
            const ok = handleViewSnap(known, margin);
            renderer.render(sceneRef.current, cameraRef.current);
            return ok;
          },
          stageAutoFit: (on) => { setAutoFitEnabled(!!on); return true; },
          // Framing assertion for automated review: projects the part's 8 bounding-box
          // corners through the live camera and reports whether they land inside the
          // viewport and how much of it the part covers. A snap that silently no-ops, a
          // part rendered off-screen tiny, or geometry clipped by near/far all fail here
          // with a readable reason -- which pixels alone would not reliably tell us.
          stageVerifyFraming: () => {
            const cam = cameraRef.current, res = resultRef.current;
            if (!cam || !res?.geometry?.attributes?.position) return { ok: false, problems: ['no camera or geometry'] };
            const g = res.geometry;
            g.computeBoundingBox();
            const b = g.boundingBox;
            if (!b || b.isEmpty()) return { ok: false, problems: ['empty bounding box'] };

            cam.updateMatrixWorld();      // this fork refreshes matrixWorldInverse inside updateMatrixWorld()
            const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            const p = new Vector4();
            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            let behindNear = 0, beyondFar = 0, invalid = 0;
            const nearZ = -(cam.far + cam.near) / (cam.far - cam.near);
            const farZ = 1;
            for (let i = 0; i < 8; i++) {
              p.set(
                i & 1 ? b.max.x : b.min.x,
                i & 2 ? b.max.y : b.min.y,
                i & 4 ? b.max.z : b.min.z,
                1
              ).applyMatrix4(mvp);
              if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z) || Math.abs(p.w) < 1e-12) { invalid++; continue; }
              const u = p.x / p.w, vv = p.y / p.w, z = p.z / p.w;
              minU = Math.min(minU, u); maxU = Math.max(maxU, u);
              minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
              if (z < nearZ - 1e-3) behindNear++;
              if (z > farZ + 1e-3) beyondFar++;
            }
            if (invalid === 8) return { ok: false, problems: ['projection produced no finite corners'] };

            const problems = [];
            if (behindNear === 8) problems.push('part is entirely in front of the near plane');
            if (beyondFar === 8) problems.push('part is entirely beyond the far plane');
            // The part's largest projected extent, as a fraction of the half-frame. A correct
            // fit sits in [~0.5, ~1.0]: the biggest dimension fills the frame (minus the margin
            // factor) and nothing spills outside it. This is the right test, not total frame
            // coverage -- a long thin part viewed down its long axis legitimately covers a small
            // fraction of the frame while being framed perfectly.
            const extent = Math.max(Math.abs(minU), Math.abs(maxU), Math.abs(minV), Math.abs(maxV));
            if (!Number.isFinite(extent)) problems.push('non-finite projection');
            else if (extent > 1.05) problems.push(`part projects outside the frame (largest extent ${extent.toFixed(2)} of half-frame)`);
            else if (extent < 0.40) problems.push(`part fills only ${(extent * 100).toFixed(0)}% of the frame (not fitted)`);
            const covU = Math.max(0, Math.min(1, maxU) - Math.max(-1, minU));
            const covV = Math.max(0, Math.min(1, maxV) - Math.max(-1, minV));
            // Normalised to [0..1]: the visible NDC box is [-1,1]^2, an area of 4. Reported
            // for context only -- it is expected to be small for slender parts.
            const coverage = (covU * covV) / 4;

            return {
              ok: problems.length === 0,
              problems,
              extent: Number.isFinite(extent) ? +extent.toFixed(3) : null,
              u: [minU, maxU].map((x) => +x.toFixed(3)),
              v: [minV, maxV].map((x) => +x.toFixed(3)),
              coverage: +coverage.toFixed(3),
              tris: Math.ceil((g.index ? g.index.count : g.attributes.position.count) / 3),
            };
          },
          // Framing state for automated assertions (headless callers cannot read refs).
          stageCamera: () => {
            const cam = cameraRef.current, ctl = controlsRef.current, res = resultRef.current;
            if (!cam) return null;
            const g = res?.geometry;
            g?.computeBoundingBox();
            const b = g?.boundingBox;
            // zoom/view/projection-matrix readouts for headless forensics. For this fork the
            // verified identities are te[5] = zoom / tan(fov_deg * PI/180 / 2) and te[0] =
            // te[5] / aspect (near cancels out — makePerspective scales width with near).
            // Measured once: te = {1.293, 2.414} <=> exactly fov 45, aspect 1.867 — so a
            // mismatch here means someone mutated fov/aspect/zoom, not that the fit is bad.
            const pe = cam.projectionMatrix?.elements || null;
            return {
              position: cam.position.toArray(),
              up: cam.up.toArray(),
              target: ctl ? ctl.target.toArray() : null,
              near: cam.near, far: cam.far, fov: cam.fov, aspect: cam.aspect,
              zoom: cam.zoom, view: cam.view ? { ...cam.view } : null,
              te: pe ? { te0: pe[0], te5: pe[5], te8: pe[8], te9: pe[9] } : null,
              bbox: b && !b.isEmpty() ? { min: b.min.toArray(), max: b.max.toArray() } : null,
            };
          },
          // Fullscreen the viewport and hide every non-canvas element (toolbars, panels,
          // editor, modals) so captures show only the part on a clean background.
          stageIsolate: ({ bg = '#0d1116' } = {}) => {
            const container = containerRef.current, canvas = canvasRef.current;
            if (!container || !canvas) return false;
            const keep = new Set();
            for (let el = canvas; el; el = el.parentElement) keep.add(el);
            for (const el of document.querySelectorAll('body *')) {
              if (keep.has(el)) continue;
              el.style.setProperty('display', 'none', 'important');
            }
            for (const ch of Array.from(container.children)) {
              if (ch !== canvas) ch.style.setProperty('display', 'none', 'important');
            }
            container.style.setProperty('position', 'fixed', 'important');
            container.style.setProperty('inset', '0', 'important');
            container.style.setProperty('width', '100vw', 'important');
            container.style.setProperty('height', '100vh', 'important');
            container.style.setProperty('margin', '0', 'important');
            container.style.setProperty('border', 'none', 'important');
            container.style.setProperty('z-index', '2147483647', 'important');
            container.style.setProperty('background', bg, 'important');
            canvas.style.setProperty('display', 'block', 'important');
            canvas.style.setProperty('width', '100vw', 'important');
            canvas.style.setProperty('height', '100vh', 'important');
            return true;
          },
          stageSize: (w, h) => {
            const r = rendererRef.current, c = cameraRef.current;
            if (!r || !c) return false;
            r.setSize(w, h);
            r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            c.aspect = w / h;
            c.updateProjectionMatrix();
            renderer.render(sceneRef.current, c);
            return true;
          },
          setAxes: (on) => { setAxisHelperEnabled(!!on); return true; },
          /** Mobile C.2 — same tween as the imperative handle (playtest). */
          setFeatureSheetLift: (ndcY, opts = {}) => {
            const camera = cameraRef.current;
            const controls = controlsRef.current;
            if (!camera || !controls?.target) return false;
            const target = Number(ndcY) || 0;
            const from = sheetLiftNdcRef.current;
            const delta = target - from;
            if (Math.abs(delta) < 1e-6) {
              sheetLiftNdcRef.current = target;
              return true;
            }
            if (sheetLiftTweenRef.current) {
              cancelAnimationFrame(sheetLiftTweenRef.current);
              sheetLiftTweenRef.current = null;
            }
            const ms = Math.max(120, Number(opts.ms) || 280);
            const t0 = performance.now();
            let applied = 0;
            const step = (now) => {
              const t = Math.min(1, (now - t0) / ms);
              const eased = easeInOutCubic(t);
              const want = delta * eased;
              const slice = want - applied;
              if (Math.abs(slice) > 1e-8) {
                panViewByNdcY({ camera, controls, ndcY: slice });
                applied = want;
              }
              if (t < 1) {
                sheetLiftTweenRef.current = requestAnimationFrame(step);
              } else {
                sheetLiftTweenRef.current = null;
                sheetLiftNdcRef.current = target;
              }
            };
            sheetLiftTweenRef.current = requestAnimationFrame(step);
            return true;
          },
          sheetLiftNdc: () => sheetLiftNdcRef.current,
        };
      }

      const controls = new TrackballControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enableRotate = true;
      controlsRef.current = controls;

      // Add axis helper
      const axisHelper = new AxesHelper(50);
      sceneRef.current.add(axisHelper);
      axisHelperRef.current = axisHelper;
      axisHelperRef.current.visible = axisHelperEnabled;

      const animate = () => {
        requestAnimationFrame(animate);
        
        if (controlsRef.current) {
          controlsRef.current.update();
        }

        animatePolylineHandles();
        updateEdgeChips();
        
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          try {
            rendererRef.current.render(sceneRef.current, cameraRef.current);
          } catch (error) {
            // Log debug info only on error
            const meshCount = sceneRef.current.children.filter(c => c.type === 'Mesh').length;
            const hasMaterials = resultRef.current?.material && Array.isArray(resultRef.current.material);
            const hasGeometry = resultRef.current?.geometry?.attributes?.position;
            
            console.error('[Animate] Render error:', error.message);
            console.error('[Animate] Scene state:', {
              meshCount,
              hasMaterials,
              hasGeometry,
              resultMaterial: resultRef.current?.material?.length || 'none',
              sceneChildren: sceneRef.current.children.length,
              highlightMeshes: Array.isArray(highlightMeshRef.current) ? highlightMeshRef.current.length : (highlightMeshRef.current ? 1 : 0)
            });
          }
        }
      };
      animate();
    };

    const handleResize = () => {
      if (!initialized) return;
      
      const { width, height } = getContainerSize();
      
      if (cameraRef.current) {
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
      }
      
      if (rendererRef.current) {
        rendererRef.current.setSize(width, height);

        // Keep LineMaterial screen-space widths correct after canvas resize.
        for (const root of [edgeHighlightRef.current, edgeHoverRef.current]) {
          if (!root || typeof root.traverse !== 'function') continue;
          root.traverse((child) => {
            if (child.material?.resolution) {
              child.material.resolution.set(width, height);
            }
          });
        }
        
        if (controlsRef.current) {
          controlsRef.current.update();
        }
        
        if (sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (!initialized) {
        initScene();
      } else {
        handleResize();
      }
    });

    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);

    initScene();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (resultRef.current?.geometry) {
        resultRef.current.geometry.dispose();
      }
      clearAssemblyExtrasRef.current();
      if (ghostMeshRef.current) {
        sceneRef.current?.remove(ghostMeshRef.current);
        ghostMeshRef.current.geometry?.dispose();
        ghostMeshRef.current.material?.dispose();
        ghostMeshRef.current = null;
      }
      clearHighlight();
      clearCuttingPlane();
    };
  }, []);

  // Initialize materials
  useEffect(() => {
    const defineMaterials = () => {
      const matls = [
        new MeshNormalMaterial({ flatShading: true }),
        new MeshLambertMaterial({ color: 'red', flatShading: true }),
        new MeshLambertMaterial({ color: 'blue', flatShading: true })
      ];
      setMaterials(matls);

      const result = new ThreeMesh(undefined, matls);
      
      const scene = sceneRef.current;
      if (!scene) return;

      scene.add(result);
      resultRef.current = result;
    };
    defineMaterials();
  }, []);

  // Ghost target overlay for game mode (translucent; distinct from player attempt)
  useEffect(() => {
    let cancelled = false;

    const clearGhost = () => {
      if (ghostMeshRef.current && sceneRef.current) {
        sceneRef.current.remove(ghostMeshRef.current);
        ghostMeshRef.current.geometry?.dispose();
        ghostMeshRef.current.material?.dispose();
        ghostMeshRef.current = null;
      }
    };

    if (!ghostMeshData?.vertProperties || !ghostMeshData?.triVerts) {
      clearGhost();
      return () => { cancelled = true; };
    }

    const tryAdd = () => {
      if (cancelled) return;
      if (!sceneRef.current) {
        requestAnimationFrame(tryAdd);
        return;
      }

      clearGhost();

      const geometry = new BufferGeometry();
      const vertProperties = new Float32Array(ghostMeshData.vertProperties);
      const triVerts = new Uint32Array(ghostMeshData.triVerts);
      geometry.setAttribute('position', new BufferAttribute(vertProperties, 3));
      geometry.setIndex(new BufferAttribute(triVerts, 1));
      geometry.computeVertexNormals();

      // Grey translucent ghost (slice 05) — tip copy must say grey, not cyan.
      const material = new MeshLambertMaterial({
        color: 0x9ca3af,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        flatShading: true,
        side: 2,
        wireframe: false,
        emissive: 0x4b5563,
        emissiveIntensity: 0.12,
      });

      const mesh = new ThreeMesh(geometry, material);
      mesh.name = 'ghostTarget';
      mesh.renderOrder = 1;
      sceneRef.current.add(mesh);
      ghostMeshRef.current = mesh;

      // Frame the ghost when there is no attempt solid yet
      const attemptEmpty = !resultRef.current?.geometry?.attributes?.position?.count;
      if (attemptEmpty && cameraRef.current && fitView) {
        fitView({
          camera: cameraRef.current,
          controls: controlsRef.current,
          geometry,
          // Phone viewports need more margin so the ghost isn't edge-clipped.
          margin: 1.55,
        });
      }
    };

    tryAdd();

    return () => {
      cancelled = true;
      clearGhost();
    };
  }, [ghostMeshData]);

  // Zoom camera to fit the model (keeps the current orbit direction)
  const handleZoomToFit = useCallback(() => {
    if (!resultRef.current?.geometry || !cameraRef.current) return;
    if (fitView({ camera: cameraRef.current, controls: controlsRef.current, geometry: resultRef.current.geometry })) {
      console.log('[Viewport] Zoomed to fit');
    }
  }, []);

  // Snap to a canonical view (iso / front / right / top) and re-fit in the same gesture.
  // Mobile B.1: default view presets (top/right/front/iso/…) frame with more margin
  // than Zoom-to-Fit. Game puzzle enter keeps its own 1.55 framing.
  const handleViewSnap = useCallback((key, margin = VIEW_SNAP_MARGIN) => {
    const preset = VIEW_PRESETS[key] || VIEW_PRESETS.iso;
    if (!resultRef.current?.geometry || !cameraRef.current) return false;
    const ok = fitView({
      camera: cameraRef.current,
      controls: controlsRef.current,
      geometry: resultRef.current.geometry,
      dir: preset.dir,
      up: preset.up,
      margin,
    });
    if (ok) console.log(`[Viewport] Snapped to ${preset.label}`);
    return ok;
  }, []);

  const handleAutoFitToggle = useCallback(() => {
    setAutoFitEnabled((on) => {
      const next = !on;
      if (next) handleZoomToFit();
      return next;
    });
  }, [handleZoomToFit]);

  const handleMeasurementToggle = () => {
    if (!measurementEnabled && selectedFace) {
      // Turning on measurement mode with a face already selected
      setMeasurementFaces({ first: selectedFace, second: null });
      // Keep the existing face highlighted - don't clear
    } else {
      // Turning off measurement mode or no face selected when turning on
      setMeasurementFaces({ first: null, second: null });
      if (measurementEnabled) {
        // Clear highlights when turning off measurement mode
        clearHighlight();
      }
    }
    
    setMeasurementEnabled(!measurementEnabled);
  };

  const handleAxisHelperToggle = () => {
    setAxisHelperEnabled(prev => {
      const newValue = !prev;
      if (axisHelperRef.current) {
        axisHelperRef.current.visible = newValue;
      }
      return newValue;
    });
  };

  // Helper to render mesh data from the worker
  const renderMeshData = useCallback((meshData) => {
    if (!meshData || !resultRef.current) return;
    // A new script result replaces the solid. Drop any Pieces clone so the
    // viewport shows that result in the normal body color.
    clearCutPiecePreviewRef.current();

    const geometry = new BufferGeometry();
    
    // Convert arrays to typed arrays. The needle between two copies of a
    // cap vertex is not part of the face: drop it so the seam is not drawn
    // and is not an edge of the face graph built from this geometry.
    const vertProperties = new Float32Array(meshData.vertProperties);
    const srcIndex = new Uint32Array(meshData.triVerts);
    const srcFaceID = meshData.faceID && meshData.faceID.length > 0 ? meshData.faceID : null;
    const fin = dropPlanarFins(vertProperties, srcIndex, srcFaceID);
    const triVerts = fin.indices;
    
    geometry.setAttribute('position', new BufferAttribute(vertProperties, 3));
    geometry.setIndex(new BufferAttribute(triVerts, 1));

    faceIDsRef.current = fin.faceIDs && fin.faceIDs.length > 0 ? fin.faceIDs : null;
    if (faceIDsRef.current) {
      geometry.setAttribute('faceID', new BufferAttribute(new Float32Array(faceIDsRef.current), 1));
    }

    // Set up material groups. A dropped needle makes the old run ranges
    // point at removed triangles; matIndex is always 0, so one group covers
    // the kept mesh.
    if (fin.dropped > 0) {
      geometry.addGroup(0, triVerts.length, 0);
    } else if (meshData.runIndex) {
      const runIndex = meshData.runIndex;
      
      let start = runIndex[0];
      for (let run = 0; run < meshData.numRun; ++run) {
        const end = runIndex[run + 1];
        // Map original ID to material index (simplified - use 0 for unknown)
        const matIndex = 0;
        geometry.addGroup(start, end - start, matIndex);
        start = end;
      }
    }

    geometry.computeVertexNormals();

    // Drop any patch-overlay material before swapping geometry — vertexColors
    // without a color attribute paints black (esp. iOS). Overlay effect will
    // re-paint lazily if still toggled on (cachedMeshData dependency).
    if (patchOverlayMatRef.current) {
      patchOverlayMatRef.current.dispose();
      patchOverlayMatRef.current = null;
    }
    if (preOverlayMaterialRef.current) {
      resultRef.current.material = preOverlayMaterialRef.current;
      preOverlayMaterialRef.current = null;
    }
    // Prefer the canonical lit base materials from defineMaterials.
    if (materialsRef.current?.length) {
      resultRef.current.material = materialsRef.current;
    }
    partGraphRef.current = null;
    partGraphSourceRef.current = null;
    patchOverlayActiveRef.current = false;

    resultRef.current.geometry?.dispose();
    resultRef.current.geometry = geometry;
    // New mesh, including after fillet. Coplanar caps join here; the blend
    // stays its own patch.
    const tFace = performance.now();
    warmFaceGraph(geometry, faceIDsRef.current);
    const faceMs = performance.now() - tFace;
    const tSeam = performance.now();
    attachContactSeam(resultRef.current, meshData);
    const seamMs = performance.now() - tSeam;
    const prevTiming = graphTimingRef.current || {};
    graphTimingRef.current = { ...prevTiming, faceMs, seamMs };
    setMeshEpoch((n) => n + 1);

    // Dev-only: the single choke point where geometry reaches the scene. Report the exact
    // meshData object we just painted so automation can prove, by identity, that what is on
    // screen is the part it submitted -- no polling, no timers, no retry logic.
    if (import.meta.env?.DEV && window.__VIEWPORT__) {
      const hook = window.__VIEWPORT__;
      hook._lastRenderedMesh = meshData;
      hook._renderCount = (hook._renderCount || 0) + 1;
      try { hook.onRendered?.(meshData); } catch (e) { console.warn('[stage] onRendered failed:', e?.message); }
    }

    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }, []);

  // Edges PR2 — PartGraph patch colours (debug). Built lazily here from the
  // already-delivered mesh (faceID + verts); worker serialize stays lean so
  // iOS Safari does not OOM/hang before the mesh lands (#88/#89).
  //
  // Hotfix (#104+#105 black viewport): overlay-off must NOT half-rebuild
  // geometry (that dropped runIndex groups and could leave MeshBasicMaterial
  // + vertexColors on colour-less geometry → black on iOS). Fail-safe:
  //   • overlay never applied + toggle off → no-op (leave renderMeshData alone)
  //   • toggle on→off / failure → force lit base materials + full renderMeshData
  useEffect(() => {
    const mesh = resultRef.current;
    if (!mesh) return undefined;

    const paint = () => {
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (renderer && scene && camera) renderer.render(scene, camera);
    };

    const forceBaseRestore = () => {
      if (patchOverlayMatRef.current) {
        patchOverlayMatRef.current.dispose();
        patchOverlayMatRef.current = null;
      }
      preOverlayMaterialRef.current = null;
      partGraphRef.current = null;
      partGraphSourceRef.current = null;
      patchOverlayActiveRef.current = false;
      const base = materialsRef.current;
      if (base?.length) {
        mesh.material = base;
      }
      const cached = cachedMeshDataRef.current;
      if (cached?.vertProperties && cached?.triVerts) {
        // Full rebuild matching the normal paint path (groups + normals).
        renderMeshData(cached);
      } else {
        paint();
      }
    };

    if (!showPatchOverlay) {
      // Default / already-off path: never touch the mesh unless overlay was live.
      if (patchOverlayActiveRef.current) {
        forceBaseRestore();
      }
      return undefined;
    }

    const cached = cachedMeshDataRef.current;
    if (!cached?.vertProperties || !cached?.triVerts) {
      if (patchOverlayActiveRef.current) forceBaseRestore();
      return undefined;
    }

    const np = cached.numProp || 3;
    const src = cached.vertProperties;
    const nVert = Math.floor(src.length / np);
    const numTri = Math.floor(cached.triVerts.length / 3);

    if (numTri > PARTGRAPH_MAX_TRIANGLES) {
      console.warn(
        `[partGraph] skip overlay — ${numTri} tris > cap ${PARTGRAPH_MAX_TRIANGLES}`,
      );
      forceBaseRestore();
      setShowPatchOverlay(false);
      return undefined;
    }

    if (partGraphSourceRef.current !== cached || !partGraphRef.current?.triPatch) {
      const positions = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) {
        positions[i * 3] = src[i * np];
        positions[i * 3 + 1] = src[i * np + 1];
        positions[i * 3 + 2] = src[i * np + 2];
      }
      try {
        const built = buildPartGraphPatches({
          positions,
          indices: cached.triVerts,
          faceIDs: cached.faceID || null,
        });
        partGraphRef.current = {
          version: built.version,
          atomCount: built.atomCount,
          triPatch: built.triPatch,
          patches: built.patches,
        };
        partGraphSourceRef.current = cached;
      } catch (e) {
        console.warn('[partGraph] segmentation failed:', e?.message || e);
        forceBaseRestore();
        setShowPatchOverlay(false);
        return undefined;
      }
    }

    const pg = partGraphRef.current;
    if (!pg?.triPatch) {
      forceBaseRestore();
      setShowPatchOverlay(false);
      return undefined;
    }

    try {
      const positions = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) {
        positions[i * 3] = src[i * np];
        positions[i * 3 + 1] = src[i * np + 1];
        positions[i * 3 + 2] = src[i * np + 2];
      }
      const { positions: oPos, colors } = buildPatchOverlayArrays(
        { positions, indices: cached.triVerts },
        pg.triPatch,
      );
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(oPos, 3));
      geom.setAttribute('color', new BufferAttribute(colors, 3));
      // Unlit — MeshLambert + vertexColors paints black under poor iOS lighting.
      if (!preOverlayMaterialRef.current) {
        preOverlayMaterialRef.current = mesh.material;
      }
      mesh.geometry?.dispose();
      mesh.geometry = geom;
      if (patchOverlayMatRef.current) patchOverlayMatRef.current.dispose();
      patchOverlayMatRef.current = new MeshBasicMaterial({
        vertexColors: true,
        side: 2,
      });
      mesh.material = patchOverlayMatRef.current;
      patchOverlayActiveRef.current = true;
      paint();
    } catch (e) {
      console.warn('[partGraph] overlay apply failed:', e?.message || e);
      forceBaseRestore();
      setShowPatchOverlay(false);
    }
    return undefined;
  }, [showPatchOverlay, cachedMeshData, renderMeshData]);


  // Calculate model bounds from mesh data
  const calculateBoundsFromMesh = (meshData) => {
    const vertProperties = meshData.vertProperties;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    
    for (let i = 0; i < vertProperties.length; i += 3) {
      min[0] = Math.min(min[0], vertProperties[i]);
      min[1] = Math.min(min[1], vertProperties[i + 1]);
      min[2] = Math.min(min[2], vertProperties[i + 2]);
      max[0] = Math.max(max[0], vertProperties[i]);
      max[1] = Math.max(max[1], vertProperties[i + 1]);
      max[2] = Math.max(max[2], vertProperties[i + 2]);
    }
    
    return {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    };
  };

  /**
   * Execute script using the sandbox worker
   */
  const executeScript = useCallback(async (scriptOverride, opts = {}) => {
    const script = scriptOverride ?? currentScript ?? '';
    const noShadow = opts.noShadow === true;

    if (!sceneRef.current) return false;

    // A blank / comment-only / construction-plane-only run empties the viewport.
    // The clear has to be total: anything still holding the previous solid — the
    // worker's cached manifold, the context's lastResult, the pick topology, the
    // solid-derived overlays — would hand the last object back through
    // cross-section, model info, quoting, game compare or the stage hooks.
    if (shouldClearViewportScript(script)) {
      setExecutionError(null);
      setCachedMeshData(null);
      cachedMeshDataRef.current = null;
      setModelBounds(null);
      clearHighlight();
      clearEdgeHighlight();
      clearEdgeHover();
      setSelectedFace(null);
      setSelectedEdges([]);
      onFaceSelected?.(null);
      // Pick topology belongs to the gone solid — drop it with the mesh.
      featureEdgesRef.current = [];
      featureEdgesSourceRef.current = null;
      faceIDsRef.current = null;
      partGraphRef.current = null;
      partGraphSourceRef.current = null;
      patchOverlayActiveRef.current = false;
      if (patchOverlayMatRef.current) {
        patchOverlayMatRef.current.dispose();
        patchOverlayMatRef.current = null;
      }
      preOverlayMaterialRef.current = null;
      if (resultRef.current && materialsRef.current?.length) {
        resultRef.current.material = materialsRef.current;
      }
      boundaryTopoRef.current = null;
      // Overlays drawn from that solid (cut plane, section/path previews, the
      // fillet blend ghost, f#/e# labels) must not outlive it on screen.
      clearIdLabels();
      clearCuttingPlane();
      clearXsPreview();
      clearPathPreview();
      clearFilletBlendPreview();
      if (resultRef.current) {
        removeContactSeam(resultRef.current);
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
      }
      setMeshEpoch((n) => n + 1);
      // Nothing executed, so no run will overwrite these — forget them here.
      manifoldContext.clearResult().catch((e) => {
        console.warn('[Viewport] clearResult failed:', e?.message || e);
      });
      if (window.__VIEWPORT__) window.__VIEWPORT__._lastRenderedMesh = null;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (renderer && scene && camera) renderer.render(scene, camera);
      return { ok: true, cleared: true };
    }

    if (!script) return false;
    runTimingStartRef.current = performance.now();
    graphTimingRef.current = {};
    
    // Cancel any pending execution
    if (executionAbortRef.current) {
      executionAbortRef.current.aborted = true;
    }
    const abortController = { aborted: false };
    executionAbortRef.current = abortController;
    
    setIsExecuting(true);
    setExecutionError(null);

    // Do NOT clear face/edge selection here — a failed Auto-Run must keep the
    // chip in sync (false "0 selected" was caused by wiping selection up-front).
    // Clear only after a successful rebuild (geometry changed → stale edges).

    try {
      if (!manifoldContext.isReady) {
        throw new Error('Manifold Sandbox not initialized');
      }
      
      // Step 1: Validate script for dangerous patterns (client-side pre-check)
      console.log('[Viewport] Validating script...');
      const validation = validateScript(script);
      if (!validation.valid) {
        throw new Error(formatValidationErrors(validation.errors));
      }
      
      if (abortController.aborted) {
        console.log('[Viewport] Execution aborted during validation');
        return false;
      }

      // Step 2: Load cached models into ManifoldContext
      const importedModels = parseImportedModels(script);
      for (let i = 0; i < importedModels.length; i++) {
        const modelData = await loadCachedModel(importedModels[i]);
        if (modelData) {
          manifoldContext.cacheImportedModel(importedModels[i], modelData);
        }
      }
      
      // Step 3: Execute script in sandbox worker (nonce ties compare to this solid)
      console.log('[Viewport] Executing script in sandbox worker...');
      const nonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `exec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await manifoldContext.executeScript(script, {
        timeoutMs: EXECUTION_LIMITS.timeoutMs,
        memoryLimitMB: EXECUTION_LIMITS.memoryLimitMB,
        nonce,
      });
      
      if (abortController.aborted) {
        console.log('[Viewport] Execution aborted after worker returned');
        return false;
      }
      
      const { mesh: meshData, memoryUsedMB, bodyCentroids } = result;
      bodyCentroidsRef.current = Array.isArray(bodyCentroids) ? bodyCentroids : [];
      
      if (!meshData || !meshData.vertProperties) {
        throw new Error('Script must return a Manifold object');
      }

      // Calculate bounds from mesh
      const bounds = calculateBoundsFromMesh(meshData);
      setModelBounds(bounds);

      // Cache mesh data for cross-section operations
      setCachedMeshData(meshData);
      cachedMeshDataRef.current = meshData;

      // Render the result
      renderMeshData(meshData);

      if (filletQualityWatchRef.current) {
        const preDeg = Number(filletQualityWatchRef.current.preDeg) || 0;
        filletQualityWatchRef.current = null;
        // C3: loft meshes already carry thousands of skinny tris — only banner
        // when Accept *introduces* a meaningful scrap delta (not the baseline).
        const degenerates = countDegenerateTriangles(resultRef.current?.geometry);
        const introduced = degenerates - preDeg;
        // Loft baselines already carry thousands of skinny tris; only banner a
        // large NEW scrap delta (not a modest re-tessellation bump).
        const scrapy = introduced > Math.max(300, 0.1 * Math.max(preDeg, 1));
        setFilletScrapNotice(scrapy
          ? 'Unable to generate clean fillet, please try smaller size.'
          : null);
      } else {
        setFilletScrapNotice(null);
      }

      // Geometry replaced → previous face/edge picks are stale. Clear intentionally
      // and nudge the user when they were in edge pick mode.
      // Slice 27: in Fillet mode keep the picked wire — Accept uses literals, so
      // second Accept can replace the same marked block without a re-pick.
      // Slice 30: Sweep Confirm does the same (edge literals + makeSweepPath).
      // Clearing the path on Auto-Run made a second Confirm a loud empty-path fail.
      const inFilletMode = !!filletModeRef.current;
      const keepSweepPath = isSweepEntry(contourModeRef.current?.entry);
      const hadEdges = Array.isArray(selectedEdges) && selectedEdges.length > 0;
      const wasEdgeMode = pickModeRef.current === 'edge';
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
      featureEdgesRef.current = [];
      featureEdgesSourceRef.current = null;
      syncFeatureEdges(resultRef.current?.geometry ?? null);
      graphsBoundMeshRef.current = meshData;
      if (inFilletMode || keepSweepPath) {
        clearEdgeHover();
        // Re-paint the kept selection on the new mesh (world va/vb still draw).
        // The selectedEdges effect only fires on reference change, which a kept
        // wire does not produce across an Auto-Run — repaint explicitly so the
        // orange halo cannot go stale against the replaced geometry.
        if (hadEdges) highlightSelectedEdges(selectedEdges);
        if (inFilletMode) {
          setSelectedEdges((prev) => stampBoundaryOnSelection(prev, featureEdgesRef.current));
        }
      } else {
        clearEdgeHighlight();
        clearEdgeHover();
        setSelectedEdges([]);
        if (edgeRematchToastSuppressRef.current) {
          edgeRematchToastSuppressRef.current = false;
        } else if (wasEdgeMode && hadEdges) {
          setEdgeModeToast(toastPayload('Geometry updated — re-pick edges'));
          armEdgeModeToastClear();
        }
      }

      // Auto scale: re-frame the part after every successful run so the new geometry is
      // never left off-screen or tiny. Keeps the user's current orbit direction.
      if (autoFitEnabled) {
        const bounds = calculateBoundsFromMesh(meshData);
        if (bounds) handleZoomToFit();
      }
      
      if (memoryUsedMB) {
        console.log(`[Viewport] Memory after execution: ${memoryUsedMB.toFixed(1)}MB`);
      }
      
      console.log('[Viewport] Script executed successfully');
      const g = graphTimingRef.current || {};
      const workerTiming = result.timing || {};
      const totalMs = performance.now() - runTimingStartRef.current;
      const report = {
        seq: (typeof window !== 'undefined' ? (window.__SURFCAD_RUN_TIMING?.seq || 0) : 0) + 1,
        totalMs,
        workerExecMs: workerTiming.execMs ?? null,
        serializeMs: workerTiming.serializeMs ?? null,
        transferMs: workerTiming.transferMs ?? null,
        roundTripMs: workerTiming.roundTripMs ?? null,
        faceGraphMs: g.faceMs ?? null,
        edgeGraphMs: (g.featureMs || 0) + (g.topoMs || 0) + (g.annotateMs || 0),
        contourGraphMs: (g.coherentMs || 0) + (g.seamMs || 0),
        featureMs: g.featureMs ?? null,
        topoMs: g.topoMs ?? null,
        annotateMs: g.annotateMs ?? null,
        coherentMs: g.coherentMs ?? null,
        seamMs: g.seamMs ?? null,
      };
      if (typeof window !== 'undefined') window.__SURFCAD_RUN_TIMING = report;
      // Truthy object: callers that only check success keep working; game compare needs nonce.
      return { ok: true, nonce, mesh: meshData };

    } catch (error) {
      filletQualityWatchRef.current = null;
      console.error('Error executing script:', error);
      const msg = error.message || 'Script execution failed';
      stageExecErrorRef.current = msg;
      setExecutionError(msg);

      // Soft-fail stale edge IDs: clear selection + prompt re-pick (never leave armed chip).
      const staleEdges = /Selected edges not found|stale selection|re-pick after geometry/i.test(msg);
      if (staleEdges) {
        clearEdgeHighlight();
        clearEdgeHover();
        setSelectedEdges([]);
        setEdgeModeToast(toastPayload('Selected edges not found — re-pick after geometry changes'));
        armEdgeModeToastClear();
      }

      // A single-script failure still restores the last good mesh.
      // An assembly part must not: noShadow drops the solid and does not
      // rebuild graphs from that previous mesh.
      const prev = noShadow ? null : cachedMeshDataRef.current;
      if (prev?.vertProperties && resultRef.current) {
        renderMeshData(prev);
        featureEdgesSourceRef.current = null;
        syncFeatureEdges(resultRef.current?.geometry ?? null);
        // Re-paint edge highlight from current selection (effect also runs).
        if (pickModeRef.current === 'edge') {
          // highlightSelectedEdges is invoked via selectedEdges effect
        }
      } else if (resultRef.current) {
        // assembly-fail: omit this part, drop the cached solid, do not rebuild graphs
        setCachedMeshData(null);
        cachedMeshDataRef.current = null;
        removeContactSeam(resultRef.current);
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
        resultRef.current.position.set(0, 0, 0);
        clearHighlight();
        clearEdgeHighlight();
        clearEdgeHover();
        setSelectedFace(null);
        setSelectedEdges([]);
        onFaceSelected?.(null);
        featureEdgesRef.current = [];
        featureEdgesSourceRef.current = null;
        graphsBoundMeshRef.current = null;
        partGraphRef.current = null;
        partGraphSourceRef.current = null;
        faceIDsRef.current = null;
        if (!noShadow) {
          setEdgeModeToast(toastPayload('Run failed — selection cleared (no prior solid)'));
          armEdgeModeToastClear();
        }
      }
      return noShadow ? { ok: false, error: msg } : false;
    } finally {
      setIsExecuting(false);
      if (executionAbortRef.current === abortController) {
        executionAbortRef.current = null;
      }
    }
  }, [currentScript, materials, onFaceSelected, renderMeshData, clearHighlight, clearEdgeHighlight, clearEdgeHover, autoFitEnabled, handleZoomToFit, selectedEdges, syncFeatureEdges]);

  clearAssemblyExtrasRef.current = () => {
    const group = assemblyGroupRef.current;
    for (const mesh of assemblyExtrasRef.current.values()) {
      group?.remove(mesh);
      mesh.geometry?.dispose();
      if (mesh.material?.dispose) mesh.material.dispose();
    }
    assemblyExtrasRef.current.clear();
  };

  /**
   * Show this part's solid as the pick mesh and rebuild face, edge, and
   * contour graphs on it before a pick. Contours are buildCoherentEdges
   * inside syncFeatureEdges. Other assembly meshes are not the pick mesh.
   */
  adoptActiveSolidRef.current = ({ mesh, position }) => {
    if (!resultRef.current || !mesh?.vertProperties) return false;
    clearHighlight();
    clearEdgeHighlight();
    clearEdgeHover();
    setSelectedFace(null);
    setSelectedEdges([]);
    onFaceSelected?.(null);
    const same = cachedMeshDataRef.current === mesh
      && resultRef.current.geometry?.attributes?.position;
    if (!same) {
      renderMeshData(mesh);
      setCachedMeshData(mesh);
      cachedMeshDataRef.current = mesh;
    } else {
      warmFaceGraph(resultRef.current.geometry, faceIDsRef.current);
    }
    const p = Array.isArray(position) ? position : [0, 0, 0];
    resultRef.current.position.set(p[0] || 0, p[1] || 0, p[2] || 0);
    featureEdgesSourceRef.current = null;
    syncFeatureEdges(resultRef.current.geometry ?? null);
    graphsBoundMeshRef.current = mesh;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera) renderer.render(scene, camera);
    return true;
  };

  placeAssemblyRef.current = (payload) => {
    const scene = sceneRef.current;
    if (!scene || !resultRef.current) return false;
    const solids = Array.isArray(payload?.solids) ? payload.solids : [];
    const activeId = payload?.activeId ?? null;
    const blankActive = payload?.blankActive === true;
    if (!assemblyGroupRef.current) {
      const group = new Group();
      group.name = 'assembly-parts';
      scene.add(group);
      assemblyGroupRef.current = group;
    }
    const group = assemblyGroupRef.current;
    const keep = new Set();
    for (const solid of solids) {
      if (!solid || solid.id === activeId) continue;
      if (!solid.mesh?.vertProperties || !solid.mesh?.triVerts) continue;
      keep.add(solid.id);
      let mesh = assemblyExtrasRef.current.get(solid.id);
      if (!mesh) {
        mesh = new ThreeMesh(undefined, new MeshNormalMaterial({ flatShading: true }));
        mesh.name = 'assembly-part';
        mesh.userData.assemblyPartId = solid.id;
        group.add(mesh);
        assemblyExtrasRef.current.set(solid.id, mesh);
      }
      const geom = geometryFromMeshData(solid.mesh);
      mesh.geometry?.dispose();
      mesh.geometry = geom;
      const p = solid.position || [0, 0, 0];
      mesh.position.set(p[0], p[1], p[2]);
    }
    for (const [id, mesh] of assemblyExtrasRef.current) {
      if (keep.has(id)) continue;
      group.remove(mesh);
      mesh.geometry?.dispose();
      if (mesh.material?.dispose) mesh.material.dispose();
      assemblyExtrasRef.current.delete(id);
    }
    if (blankActive) {
      // assembly-fail: the active part is hidden or failed. No previous solid.
      setCachedMeshData(null);
      cachedMeshDataRef.current = null;
      removeContactSeam(resultRef.current);
      resultRef.current.geometry?.dispose();
      resultRef.current.geometry = new BufferGeometry();
      resultRef.current.position.set(0, 0, 0);
      featureEdgesRef.current = [];
      featureEdgesSourceRef.current = null;
      graphsBoundMeshRef.current = null;
      partGraphRef.current = null;
      partGraphSourceRef.current = null;
      faceIDsRef.current = null;
    } else {
      const active = solids.find((solid) => solid.id === activeId);
      const p = active?.position || [0, 0, 0];
      resultRef.current.position.set(p[0], p[1], p[2]);
      if (active?.mesh?.vertProperties && graphsBoundMeshRef.current !== active.mesh) {
        adoptActiveSolidRef.current({ mesh: active.mesh, position: p });
      }
    }
    if (autoFitEnabled && solids.length && cameraRef.current) {
      const geom = new BufferGeometry();
      const chunks = [];
      for (const solid of solids) {
        const src = solid.mesh?.vertProperties;
        if (!src) continue;
        const np = solid.mesh.numProp || 3;
        const p = solid.position || [0, 0, 0];
        const n = Math.floor(src.length / np);
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = src[i * np] + p[0];
          arr[i * 3 + 1] = src[i * np + 1] + p[1];
          arr[i * 3 + 2] = src[i * np + 2] + p[2];
        }
        chunks.push(arr);
      }
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      if (total > 0) {
        const all = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        geom.setAttribute('position', new BufferAttribute(all, 3));
        fitView({
          camera: cameraRef.current,
          controls: controlsRef.current,
          geometry: geom,
        });
        geom.dispose();
      }
    }
    if (containerRef.current) {
      containerRef.current.setAttribute('data-assembly-solids', String(solids.length));
      containerRef.current.setAttribute('data-assembly-active', blankActive ? 'omitted' : 'shown');
    }
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) renderer.render(scene, camera);
    return true;
  };

  /**
   * Download the current model as 3mf
   * Uses cached mesh data when available to avoid re-execution
   */
  /**
   * CAD strip Run. `executeScript()` with no argument already falls back to the
   * live `currentScript`, which App refreshes on every keystroke, so this runs
   * exactly what is in the editor right now.
   */
  const runCadScript = useCallback(async () => {
    if (onRunAssembly) {
      setIsExecuting(true);
      try {
        await onRunAssembly();
      } finally {
        setIsExecuting(false);
      }
      return;
    }
    executeScript();
  }, [executeScript, onRunAssembly]);

  const handleDownloadModel = useCallback(async () => {
    if (!cachedMeshData?.vertProperties) {
      setExecutionError('No model to export');
      return;
    }

    setIsDownloading(true);

    try {
      const filename = currentFilename || 'model';
      await downloadModelFromMesh(cachedMeshData, filename);
    } catch (error) {
      console.error('[Viewport] Export error:', error);
      setExecutionError(`Export failed: ${error.message}`);
    } finally {
      setIsDownloading(false);
    }
  }, [cachedMeshData, currentFilename]);

  const titleParts = formatViewerTitle(
    currentFilename,
    typeof assemblyName === 'string' ? assemblyName : '',
  );

  return (
    <div ref={containerRef} className="viewport-shell relative w-full h-full bg-[#1e1e1e] overflow-hidden">
      {/* CAD chrome lives in the editor mid-strip in BOTH shells (desktop matches
          phone now): rendered here so download/export busy state stays local —
          and so Run can execute the live buffer without a round trip via App. */}
      {mode !== 'game' && cadToolbarHost && createPortal(
        <Toolbar
          mode="cad"
          variant="strip"
          onOpen={onOpen}
          onSave={onSave}
          onAccount={onAccount}
          onDownload={handleDownloadModel}
          onQuote={onQuote}
          onUpload={onUpload}
          onUndo={onUndo}
          onRedo={onRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          isExecuting={isExecuting}
          isDownloading={isDownloading}
          isUploading={isUploading}
          currentFilename={currentFilename}
          onStartGame={onStartGame}
          onExitGame={onExitGame}
          onRun={onRun}
          onRunScript={runCadScript}
          onSelectAll={onSelectAll}
          onHint={onHint}
          onPickPuzzle={onPickPuzzle}
          gameElapsedMs={gameElapsedMs}
          gameSuccess={gameSuccess}
          gameBestTimeMs={gameBestTimeMs}
        />,
        cadToolbarHost,
      )}

      {/* Title row. Game: puzzle name. CAD: part, then "in", then assembly. */}
      {mode === 'game' && (
        <ViewportTitleChip>{gamePuzzleTitle || 'Puzzle'}</ViewportTitleChip>
      )}
      {mode !== 'game' && (
        <div
          className="pointer-events-none absolute top-4 left-1/2 z-10 flex max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-2"
          data-viewer-title=""
          data-viewer-title-text={titleParts.text}
        >
          <ViewportTitleChip inline value={currentFilename} onRename={onRenameFile}>
            {titleParts.part}
          </ViewportTitleChip>
          {titleParts.connector ? (
            <span
              className="shrink-0 text-xs font-medium text-gray-300"
              data-title-in=""
            >
              {titleParts.connector}
            </span>
          ) : null}
          {titleParts.assembly ? (
            <ViewportTitleChip
              inline
              noun="Assembly"
              value={titleParts.assembly}
              onRename={onRenameAssembly}
            >
              {titleParts.assembly}
            </ViewportTitleChip>
          ) : null}
        </div>
      )}

      {mode === 'game' && gameSuccess && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-emerald-900/85 surface-glass-chip border border-emerald-400/60 text-white px-5 py-3 rounded-xl shadow-xl text-center">
            <div className="text-sm font-semibold">Match!</div>
            <div className="text-2xl font-mono tabular-nums mt-1">{formatGameTime(gameElapsedMs)}</div>
            <div className="text-[11px] text-emerald-200/80 mt-1">lower is better</div>
          </div>
        </div>
      )}
      
      {/* Left helper rail. Block, Build, Shape, Polish, Move. */}
      {onInsertHelper && !contourMode && !filletMode && !shellMode && !draftMode && !cutMode && !moveMode && !moveFaceMode && !deleteFaceMode && (
        <HelperInsertPalette
          layout={mode === 'game' ? 'game' : 'cad'}
          onInsert={onInsertHelper}
          getBuffer={getHelperBuffer}
          selectedFace={selectedFace}
          selectedEdges={selectedEdges}
          onRequestEdgeMode={() => setPickMode('edge')}
          onStaleEdgesClear={(msg) => {
            clearEdgeHighlight();
            clearEdgeHover();
            clearPathPreview();
            setSelectedEdges([]);
            setEdgeModeToast(toastPayload(msg || 'Re-pick edges after geometry changes'));
            armEdgeModeToastClear();
          }}
          onProfilePreview={setXsPreview}
          onPathPreview={setPathPreview}
          onEnterContourMode={enterContourMode}
          onEnterFilletMode={enterFilletMode}
          onEnterShellMode={enterShellMode}
          onEnterDraftMode={enterDraftMode}
          onEnterCutMode={enterCutMode}
          onEnterMoveMode={enterMoveMode}
          onEnterMoveFaceMode={enterMoveFaceMode}
          onEnterDeleteFaceMode={enterDeleteFaceMode}
          compact={isMobile}
        />
      )}

      {/* Slice 24: contour-mode rail (tools + Back). Same shell in CAD and game. */}
      {contourMode && (
        <ContourModeRail
          tool={contourMode.tool}
          entry={contourMode.entry}
          compact={isMobile}
          onSelectTool={(id) => setContourMode((prev) => (prev ? switchContourTool(prev, id) : prev))}
          onBack={exitContourMode}
        />
      )}

      {/* Cross-Section Panel */}
        <CrossSectionPanel
          enabled={crossSectionEnabled}
          onToggle={handleCrossSectionToggle}
          onPlaneChange={handlePlaneChange}
          onZoomToFit={handleZoomToFit}
          onAutoFitToggle={handleAutoFitToggle}
          autoFitEnabled={autoFitEnabled}
          onSnapView={handleViewSnap}
          bounds={modelBounds}
          measurementEnabled={measurementEnabled}
          onMeasurementToggle={handleMeasurementToggle}
          axisHelperEnabled={axisHelperEnabled}
          onAxisHelperToggle={handleAxisHelperToggle}
          pickMode={pickMode}
          showPlanes={showPlanes}
          showContours={showContours}
          onShowPlanesChange={setShowPlanes}
          onShowContoursChange={setShowContours}
          showPatchOverlay={showPatchOverlay}
          onShowPatchOverlayChange={setShowPatchOverlay}
          onPickModeChange={(mode) => {
            const next = mode === 'edge' ? 'edge' : 'face';
            setPickMode(next);
            if (next === 'edge') {
              clearHighlight();
              setSelectedFace(null);
              onFaceSelected?.(null);
              rebuildFeatureEdges();
              if (!edgeModeToastShownRef.current) {
                edgeModeToastShownRef.current = true;
                setEdgeModeToast(toastPayload('Edge pick on — tap near an edge (tangent loops on)', { undo: false }));
                armEdgeModeToastClear();
              }
            } else {
              clearEdgeHover();
              clearEdgeHighlight();
              if (edgeModeToastTimerRef.current) {
                clearTimeout(edgeModeToastTimerRef.current);
                edgeModeToastTimerRef.current = null;
              }
              setEdgeModeToast(null);
              // keep selectedEdges until user clears / face-picks
            }
          }}
          verticalRail
        />
      
      {executionError && createPortal(
        <div
          className="fixed top-16 inset-x-3 z-50 pointer-events-auto"
          data-execution-error=""
        >
          <ErrorPopup
            tone="error"
            layout="stacked"
            title="Error"
            onDismiss={() => setExecutionError(null)}
            onUndo={onUndo}
            canUndo={canUndo}
            className="p-3"
          >
            {executionError}
          </ErrorPopup>
        </div>,
        document.body,
      )}
      
      {/* Slice Mobile C.1: face-selected info popup removed (was under-title B.1).
          Selection still drives the left palette / PromptInput; no empty reserved band. */}

      {/* Slice 24: contour chip — plane + profile params (Edge-pick pattern). */}
      {contourMode && (
        <ContourModeChip
          tool={contourMode.tool}
          entry={contourMode.entry}
          params={contourMode.params}
          extrude={contourMode.extrude || {}}
          revolve={contourMode.revolve || {}}
          loft={contourMode.loft || {}}
          sweep={contourMode.sweep || {}}
          sweepPath={isSweepEntry(contourMode.entry)
            ? validateSweepPath(selectedEdges, contourMode.sweep)
            : null}
          pickMode={pickMode}
          compact={isMobile}
          planeLabel={
            contourMode.planeFace
              ? `planar n=[${contourMode.planeFace.normal.map((v) => Number(v).toFixed(2)).join(', ')}]`
              : 'default +Z top'
          }
          planePreset={contourMode.planePreset || 'z'}
          planeAngles={contourMode.planeAngles || { x: 0, y: 0, z: 0 }}
          constructionPlanes={constructionPlanes}
          pickedPlaneId={selectedPlaneId || ''}
          onPlanePreset={(axis) => setContourMode((prev) => {
            if (!prev) return prev;
            const center = prev.planeBase?.center
              || prev.planeFace?.center
              || contourHostCenter(modelBounds);
            return applyContourPlaneEdit(prev, {
              preset: axis,
              base: axisPresetFrame(axis, center),
              angles: { x: 0, y: 0, z: 0 },
            });
          })}
          onPlaneAngles={(angles) => setContourMode((prev) => {
            if (!prev) return prev;
            const center = prev.planeBase?.center
              || prev.planeFace?.center
              || contourHostCenter(modelBounds);
            const base = prev.planeBase || axisPresetFrame(prev.planePreset || 'z', center);
            return applyContourPlaneEdit(prev, { angles, base });
          })}
          onPickWorkplane={(plane, id) => {
            setSelectedPlaneId(id || null);
            setContourMode((prev) => (prev
              ? applyContourPlaneEdit(prev, {
                preset: 'workplane',
                base: plane,
                angles: { x: 0, y: 0, z: 0 },
              })
              : prev));
          }}
          onPickFace={() => {
            setPickMode('face');
            setContourMode((prev) => (prev ? { ...prev, planePreset: 'face' } : prev));
          }}
          planeOffset={contourMode.planeOffset ?? 0}
          onPlaneOffset={(offset) => setContourMode((prev) => {
            if (!prev) return prev;
            const center = prev.planeBase?.center
              || prev.planeFace?.center
              || contourHostCenter(modelBounds);
            const base = prev.planeBase || axisPresetFrame(prev.planePreset || 'z', center);
            return applyContourPlaneEdit(prev, {
              offset,
              base,
              angles: prev.planeAngles || { x: 0, y: 0, z: 0 },
              preset: prev.planePreset,
              keepAngles: true,
            });
          })}
          tangentOn={tangentProp}
          edgeCount={selectedEdges.length}
          onToggleTangent={() => setTangentProp((v) => !v)}
          onPopEdge={() => setSelectedEdges((prev) => popLastEdgeSelection(prev))}
          onClearEdges={() => {
            clearEdgeHover();
            clearEdgeHighlight();
            setSelectedEdges([]);
          }}
          onParamChange={(next) => setContourMode((prev) => {
            if (!prev) return prev;
            const updated = { ...prev, params: next };
            return isLoftEntry(prev.entry) ? writeLoftSelected(updated, { params: next }) : updated;
          })}
          onExtrudeChange={(next) => setContourMode((prev) => (prev ? { ...prev, extrude: next } : prev))}
          onRevolveChange={(next) => setContourMode((prev) => (prev ? { ...prev, revolve: next } : prev))}
          onSweepChange={(next) => setContourMode((prev) => (prev ? { ...prev, sweep: next } : prev))}
          onPickPath={pickSweepPath}
          onPickPlane={pickSweepPlane}
          onSelectLoftProfile={(i) => setContourMode((prev) => (prev ? selectLoftProfile(prev, i) : prev))}
          onAddLoftProfile={() => setContourMode((prev) => (prev ? addLoftProfile(prev) : prev))}
          onRemoveLoftProfile={(i) => setContourMode((prev) => (prev ? removeLoftProfile(prev, i) : prev))}
          onLoftOffsetChange={(offset) => setContourMode((prev) => (prev ? setLoftProfileOffset(prev, offset) : prev))}
          savedContours={savedContours}
          pickedContourId={contourMode.pickedContourId || null}
          onPickSaved={(id) => {
            const hit = savedContours.find((c) => c.id === id);
            if (!hit) return;
            setContourMode((prev) => (prev ? applySavedContour(prev, hit) : prev));
          }}
          onConfirm={confirmContourProfile}
          onUndoPoint={() => setContourMode((prev) => {
            if (!prev || prev.tool !== 'polyline') return prev;
            const points = (prev.params?.points || []).slice(0, -1);
            const next = { ...prev, params: { ...prev.params, points } };
            return isLoftEntry(prev.entry) ? writeLoftSelected(next, { params: next.params }) : next;
          })}
          onClearPoints={() => setContourMode((prev) => {
            if (!prev || prev.tool !== 'polyline') return prev;
            const next = { ...prev, params: { ...prev.params, points: [] } };
            return isLoftEntry(prev.entry) ? writeLoftSelected(next, { params: next.params }) : next;
          })}
        />
      )}

      {/* Slice 27: Fillet-in-mode chip — Tangent / Clear / Accept / Back */}
      {filletMode && (
        <FilletModeChip
          kind={filletMode.entry === 'chamferEdges' ? 'chamfer' : 'fillet'}
          edgeCount={selectedEdges.length}
          tangentOn={tangentProp}
          params={{
            ...filletMode.params,
            _sweepMax: (filletBlendPayload?.sweepMax > 0
              ? filletBlendPayload.sweepMax
              : sweepBlendHardMax(pathLengthFromEdges(selectedEdges))),
          }}
          pathOk={filletBlendPayload?.ok === true}
          componentCount={filletBlendPayload?.componentCount || 0}
          edgeClass={filletEdgeClass}
          compact={isMobile}
          onToggleTangent={() => setTangentProp((v) => !v)}
          onClear={() => {
            clearEdgeHover();
            clearEdgeHighlight();
            setSelectedEdges([]);
          }}
          onAccept={acceptFillet}
          onBack={exitFilletMode}
          onDismiss={exitFilletMode}
          onParamChange={(next, extra) => setFilletMode((prev) => (
            prev
              ? {
                ...prev,
                params: { ...prev.params, ...next },
                radiusTouched: extra?.radiusTouched ? true : prev.radiusTouched,
                sizeTouched: extra?.sizeTouched ? true : prev.sizeTouched,
              }
              : prev
          ))}
        />
      )}

      
      {/* Shell face-pick chip — opening face + wall; Confirm writes hollow(). */}
      {shellMode && (
        <ShellModeChip
          face={selectedFace
            ? (selectedFace.type ? selectedFace : classifySelectedFace(selectedFace))
            : (shellMode.lastFace || null)}
          params={normalizeShellParams(shellMode.params || {})}
          compact={isMobile}
          onParamChange={(next) => setShellMode((prev) => {
            if (!prev) return prev;
            const updated = { ...prev, params: { ...prev.params, ...next } };
            shellModeRef.current = updated;
            return updated;
          })}
          onUndoFace={() => {
            const geom = resultRef.current?.geometry;
            publishFacePicks(
              popLastShellFace(facePickGroupRef.current?.picks),
              geom,
              geom?.attributes?.position,
              geom?.index?.array,
            );
          }}
          onClearFace={() => {
            publishFacePicks([], resultRef.current?.geometry, null, null);
          }}
          onConfirm={acceptShell}
          onDismiss={exitShellMode}
        />
      )}

      {/* Draft face-pick chip — neutral plane + faces; Confirm writes draftFaces(). */}
      {draftMode && (
        <DraftModeChip
          neutral={draftMode.neutral}
          drafts={draftMode.drafts}
          replaceNeutral={draftMode.replaceNeutral}
          angle={draftMode.angle}
          flip={draftMode.flip}
          compact={isMobile}
          onAngle={(angle) => commitDraftState(setDraftAngle(draftModeRef.current, angle))}
          onFlip={(flip) => commitDraftState(setDraftFlip(draftModeRef.current, flip))}
          onUndo={() => commitDraftState(popLastDraftFace(draftModeRef.current))}
          onClear={() => commitDraftState(clearDraftFaces(draftModeRef.current))}
          onConfirm={acceptDraft}
          onDismiss={exitDraftMode}
        />
      )}

      {/* Cut plane + bodies. Confirm writes one cut(); pieces stay separate. */}
      {cutMode && (
        <CutModeChip
          state={cutMode}
          compact={isMobile}
          onPlaneSource={(source) => commitCutState(setCutPlaneSource(cutModeRef.current, source))}
          onOffset={(originOffset) => commitCutState(setCutOriginOffset(cutModeRef.current, originOffset))}
          onPickTarget={(pick) => commitCutState(setCutPickTarget(cutModeRef.current, pick))}
          onUndo={() => commitCutState(popLastCutPick(cutModeRef.current))}
          onClear={() => commitCutState(clearCutPicks(cutModeRef.current))}
          onConfirm={acceptCut}
          onDismiss={exitCutMode}
        />
      )}

      {/* Move body chip — deltas or one distance. Confirm writes one move(). No viewport arrows. */}
      {moveMode && (
        <MoveModeChip
          target={moveMode.target}
          dx={moveMode.dx}
          dy={moveMode.dy}
          dz={moveMode.dz}
          direction={moveMode.direction}
          distance={moveMode.distance}
          cutNormal={cutNormalFromScript((typeof getHelperBuffer === 'function' ? getHelperBuffer() : '') || '')}
          faceNormal={moveMode.faceNormal}
          compact={isMobile}
          onDelta={(axis, value) => {
            const prev = moveModeRef.current;
            if (!prev) return;
            const updated = { ...prev, [axis]: value };
            moveModeRef.current = updated;
            setMoveMode(updated);
            paintMovePreview(updated);
          }}
          onDirection={(direction, cutNormal) => {
            const prev = moveModeRef.current;
            if (!prev) return;
            const updated = { ...prev, direction, cutNormal: cutNormal || prev.cutNormal };
            moveModeRef.current = updated;
            setMoveMode(updated);
            paintMovePreview(updated);
          }}
          onClear={() => {
            const next = clearMoveTarget(moveModeRef.current);
            moveModeRef.current = next;
            setMoveMode(next);
            clearMovePreview();
            clearHighlight();
          }}
          onConfirm={acceptMove}
          onDismiss={exitMoveMode}
        />
      )}

      {/* Move Face — offset along each face normal. Confirm writes one moveFace(). */}
      {moveFaceMode && (
        <MoveFaceModeChip
          faces={moveFaceMode.faces}
          distance={moveFaceMode.distance}
          flip={moveFaceMode.flip}
          compact={isMobile}
          onDistance={(distance) => commitMoveFaceState(setMoveFaceDistance(moveFaceModeRef.current, distance))}
          onFlip={(flip) => commitMoveFaceState(setMoveFaceFlip(moveFaceModeRef.current, flip))}
          onUndo={() => commitMoveFaceState(popLastMoveFace(moveFaceModeRef.current))}
          onClear={() => commitMoveFaceState(clearMoveFaces(moveFaceModeRef.current))}
          onConfirm={acceptMoveFace}
          onDismiss={exitMoveFaceMode}
        />
      )}

      {/* Delete Face — heal by extending neighbors. Confirm writes one deleteFace(). */}
      {deleteFaceMode && (
        <DeleteFaceModeChip
          faces={deleteFaceMode.faces}
          compact={isMobile}
          onUndo={() => commitDeleteFaceState(popLastDeleteFace(deleteFaceModeRef.current))}
          onClear={() => commitDeleteFaceState(clearDeleteFaces(deleteFaceModeRef.current))}
          onConfirm={acceptDeleteFace}
          onDismiss={exitDeleteFaceMode}
        />
      )}

      {/* Slice B+C: numbered edge-selector chips anchored to on-geometry track
          points; left/top updated every frame via updateEdgeChips (orbit-safe). */}
      {(pickMode === 'edge' || !!filletMode || !!contourMode) && selectedEdges.length > 0 && (
        <div
          className="absolute inset-0 z-[15] pointer-events-none overflow-hidden"
          data-edge-chip-layer=""
          aria-hidden="true"
        >
          {selectedEdges.map((e, i) => {
            const key = edgeKey(e);
            return (
              <div
                key={key}
                ref={(el) => {
                  const map = edgeChipElsRef.current;
                  if (el) map.set(key, el);
                  else map.delete(key);
                }}
                data-edge-chip={i + 1}
                data-edge-chip-key={key}
                className="absolute -translate-x-1/2 -translate-y-1/2
                  min-w-[1.25rem] h-5 px-1.5 rounded-md
                  bg-amber-950/90 border border-amber-400/80
                  text-amber-100 text-[10px] font-bold font-sans
                  flex items-center justify-center shadow-lg
                  surface-glass-chip"
                style={{ left: 0, top: 0, visibility: 'hidden' }}
                title={`Selected edge ${i + 1}`}
              >
                {i + 1}
              </div>
            );
          })}
        </div>
      )}

      {/* Edge pick chip — Edge mode alone is not enough: it stays out of the way
          until at least one edge is actually selected. */}
      {/* Slice Mobile C.1: center + raise — clear of right rail and home-indicator / CAD|Script dots. */}
      {pickMode === 'edge' && !contourMode && !filletMode && selectedEdges.length > 0 && (
        <div
          data-edge-selector="standalone"
          className={`absolute bg-amber-950/80 surface-glass-chip border border-amber-500/70 text-white px-3 py-2 rounded-lg text-xs z-20 shadow-lg max-w-[min(16rem,calc(100%-3rem))] left-1/2 -translate-x-1/2 ${
            mode === 'game' || isMobile
              ? 'bottom-20'
              : 'bottom-14'
          }`}
        >
          <div className="font-bold font-sans text-amber-200">
            Edge pick · {selectedEdges.length} selected
          </div>
          <div className="text-[10px] text-amber-100/90 normal-case font-sans mt-0.5">
            Tap near an edge to toggle · Fillet / Chamfer uses this set
          </div>
          <div className="mt-1.5 flex items-center gap-3 font-sans flex-wrap">
            <button
              type="button"
              className={`text-[10px] underline ${tangentProp ? 'text-cyan-300' : 'text-amber-200/70'}`}
              onClick={() => setTangentProp((v) => !v)}
              title="When on, picking one edge adds G1-connected (tangent) edges in the loop"
              aria-pressed={tangentProp}
            >
              Tangent {tangentProp ? 'on' : 'off'}
            </button>
            {selectedEdges.length > 0 && (
              <>
                <button
                  type="button"
                  className="text-[10px] text-amber-200 underline"
                  onClick={() => {
                    clearEdgeHover();
                    setSelectedEdges((prev) => popLastEdgeSelection(prev));
                  }}
                  title="Remove last selected edge"
                >
                  Back
                </button>
                <button
                  type="button"
                  className="text-[10px] text-amber-200 underline"
                  onClick={() => {
                    clearEdgeHover();
                    clearEdgeHighlight();
                    setSelectedEdges([]);
                  }}
                  title="Clear all selected edges"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {edgeModeToast && createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none max-w-[min(22rem,calc(100%-2rem))]">
          <ErrorPopup
            tone="amber"
            onDismiss={() => setEdgeModeToast(null)}
            onUndo={edgeModeToast.undo ? onUndo : undefined}
            canUndo={canUndo}
            className="px-3 py-2 pointer-events-auto"
          >
            {edgeModeToast.text}
          </ErrorPopup>
        </div>,
        document.body,
      )}

      {contourToast && createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none max-w-[min(22rem,calc(100%-2rem))]">
          <ErrorPopup
            tone="cyan"
            onDismiss={() => setContourToast(null)}
            onUndo={contourToast.undo ? onUndo : undefined}
            canUndo={canUndo}
            className="px-3 py-2 pointer-events-auto"
          >
            {contourToast.text}
          </ErrorPopup>
        </div>,
        document.body,
      )}

      {filletScrapNotice && createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none max-w-[min(18rem,calc(100%-2rem))]">
          <ErrorPopup
            tone="scrap"
            role="status"
            data-fillet-scrap="1"
            onDismiss={() => setFilletScrapNotice(null)}
            onUndo={onUndo}
            canUndo={canUndo}
            className="px-3 py-2 pointer-events-auto"
          >
            {filletScrapNotice}
          </ErrorPopup>
        </div>,
        document.body,
      )}

      {filletToast && createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none max-w-[min(22rem,calc(100%-2rem))]">
          <ErrorPopup
            tone="warn"
            onDismiss={() => setFilletToast(null)}
            onUndo={filletToast.undo ? onUndo : undefined}
            canUndo={canUndo}
            className="px-3 py-2 pointer-events-auto"
          >
            {filletToast.text}
          </ErrorPopup>
        </div>,
        document.body,
      )}

      {shellToast && createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none max-w-[min(22rem,calc(100%-2rem))]">
          <ErrorPopup
            tone="cyan"
            onDismiss={() => setShellToast(null)}
            onUndo={shellToast.undo ? onUndo : undefined}
            canUndo={canUndo}
            className="px-3 py-2 pointer-events-auto"
          >
            {shellToast.text}
          </ErrorPopup>
        </div>,
        document.body,
      )}

      {/* Measurement Info Display */}
      {measurementEnabled && measurementFaces.first && (
        <div className={`absolute bottom-2.5 bg-black/45 surface-glass-chip text-white p-3 rounded-lg text-xs font-mono z-10 space-y-1 ${
          mode === 'game' ? 'left-2 lg:left-4' : 'left-[4.5rem] lg:left-[5.25rem]'
        }`}>
          {measurementFaces.second ? (
            <>
                {(() => {
                  const measurements = calculateMeasurements(measurementFaces.first, measurementFaces.second);
                  return (
                    <>
                      <div className="text-gray-300">Normal: {measurements.normal.toFixed(2)} mm</div>
                      <div className="text-red-300">X: {measurements.x.toFixed(2)} mm</div>
                      <div className="text-green-300">Y: {measurements.y.toFixed(2)} mm</div>
                      <div className="text-blue-300">Z: {measurements.z.toFixed(2)} mm</div>
                    </>
                  );
                })()}
            </>
          ) : (
            <div className="text-gray-400">Select second face...</div>
          )}
        </div>
      )}
      
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Viewport;
