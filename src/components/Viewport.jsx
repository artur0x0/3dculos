// components/Viewport.jsx
/* eslint-disable react-hooks/exhaustive-deps -- legacy: deps arrays below are tuned for
   three.js render-loop stability (scene/camera/controls live in refs); adding the flagged
   refs would rebind listeners/materials per render. Revisit deliberately, not via lint. */
import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
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
  DoubleSide,
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
  SphereGeometry,
  Group,
} from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import Toolbar from './Toolbar';
import CrossSectionPanel from './CrossSectionPanel';
import HelperInsertPalette from './HelperInsertPalette';
import ContourModeRail from './ContourModeRail';
import ContourModeChip from './ContourModeChip';
import { classifySelectedFace } from '../utils/faceFeaturePlacement';
import { buildCrossSectionPreview } from '../utils/crossSectionSubstrate';
import {
  buildContourPreview,
  buildExtrudeSolidPreview,
  buildRevolveSolidPreview,
  enterContourState,
  intersectRayPlane,
  isExtrudeEntry,
  isRevolveEntry,
  planeFromContourFace,
  resolveContourWorkplane,
  resolveExtrudeAxis,
  resolveRevolveAxis,
  switchContourTool,
  toolToProfileParams,
  validateContourProfile,
  validateExtrudeParams,
  validateRevolveParams,
  worldToPlaneUV,
  workplaneOverlaySize,
  workplaneQuadCorners,
} from '../utils/contourMode';
import { buildSweepPathPreview } from '../utils/edgeSweepPath';
import {
  buildFeatureEdges,
  pickNearestEdgeScreen,
  resolveEdgePickSlopPx,
  toggleEdgeSelectionPropagated,
  popLastEdgeSelection,
  edgeKey,
} from '../utils/selectEdge';
import { X } from 'lucide-react';
import { downloadModelFromMesh, get3MFBase64FromMesh } from '../utils/exportModel';
import { parseImportedModels, loadCachedModel } from '../utils/importModel';
import { calculateQuote } from '../utils/quoting';
import { selectFaceByID, selectFaceWithTolerance, selectAllConnected } from '../utils/selectFace';
import { createCuttingPlaneWidget, updateCuttingPlaneWidget } from '../utils/cuttingPlaneWidget';
import { AxesHelper } from 'three';
import { calculateMeasurements, createMeasurementLines, disposeMeasurementLines } from '../utils/measurementTool';
import { fitView, VIEW_PRESETS } from '../utils/viewCamera';

import { validateScript, formatValidationErrors } from '../utils/scriptValidator';
import manifoldContext from '../utils/ManifoldWorker';
import { formatGameTime } from '../utils/gamePuzzle';

/** Screen-space fat-line widths (WebGL ignores LineBasicMaterial.linewidth > 1). */
const EDGE_CORE_PX = 4;
const EDGE_HALO_PX = 14;
const EDGE_HOVER_CORE_PX = 3;
const EDGE_HOVER_HALO_PX = 10;

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
  isUploading,
  mode = 'cad',
  ghostMeshData = null,
  onStartGame,
  onExitGame,
  onRun,
  onHint,
  onPickPuzzle,
  gameElapsedMs = 0,
  gameSuccess = false,
  gamePuzzleTitle = null,
  gameBestTimeMs = null,
  isMobile = false,
  onInsertHelper = null,
  onCommitContourProfile = null,
  getHelperBuffer = null,
}, ref) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const resultRef = useRef(null);
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
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const measurementLinesRef = useRef(null); 

  // Configuration for click detection
  const MULTI_CLICK_DELAY = 300; // ms to wait for additional clicks
  const ANGLE_TOLERANCE_DEGREES = 3; // Angular tolerance for double-click selection
  const DRAG_THRESHOLD = 3; // pixels - movement beyond this is considered a drag
  
  const [selectedFace, setSelectedFace] = useState(null);
  /** Slice 12: 'face' | 'edge' — mutually exclusive pick modes. */
  const [pickMode, setPickMode] = useState('face');
  const [selectedEdges, setSelectedEdges] = useState([]);
  const featureEdgesRef = useRef([]);
  /** Geometry identity that featureEdgesRef was built from — invalidate on replace. */
  const featureEdgesSourceRef = useRef(null);
  const edgeHighlightRef = useRef(null);
  const edgeHoverRef = useRef(null);
  /** Slice 21: plane+profile preview overlay while HelperParamModal is open. */
  const xsPreviewRef = useRef(null);
  const pathPreviewRef = useRef(null);
  const edgePickScratchA = useRef(new Vector3());
  const edgePickScratchB = useRef(new Vector3());
  const pickModeRef = useRef('face');
  const edgeModeToastShownRef = useRef(false);
  const edgeModeToastTimerRef = useRef(null);
  const [edgeModeToast, setEdgeModeToast] = useState(null);
  /** Slice 24/25/26: contour-mode shell (Profile-in-mode; Extrude / Revolve commit a solid). */
  const [contourMode, setContourMode] = useState(null);
  const contourModeRef = useRef(null);
  const workplaneOverlayRef = useRef(null);
  const polylineDraftRef = useRef(null);
  const extrudePreviewRef = useRef(null);
  const revolvePreviewRef = useRef(null);
  const contourGhostMatsRef = useRef(null);
  const [contourToast, setContourToast] = useState(null);
  const contourToastTimerRef = useRef(null);
  /** G1 tangent chain propagation for Edge pick — ON by default (circular / fillet loops). */
  const [tangentProp, setTangentProp] = useState(true);
  const tangentPropRef = useRef(true);

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
  const showContourToast = (msg) => {
    setContourToast(msg);
    armContourToastClear();
  };
  const [materials, setMaterials] = useState([]);
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
  tangentPropRef.current = tangentProp;
  cachedMeshDataRef.current = cachedMeshData;
  contourModeRef.current = contourMode;

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
      setContourMode(null);
      contourModeRef.current = null;
      setContourToast(null);
      setSelectedFace(null);
      setSelectedEdges([]);
      onFaceSelected?.(null);
      setCachedMeshData(null);
      setExecutionError(null);
      setModelBounds(null);
      if (resultRef.current) {
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
      }
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
      setEdgeModeToast(msg || 'Re-pick edges after geometry changes');
      armEdgeModeToastClear();
    },
    setPickMode: (mode) => setPickMode(mode === 'edge' ? 'edge' : 'face'),
    /** Slice 24: loud-fail toast while contour mode is open. */
    softFailContour: (msg) => {
      showContourToast(msg || 'Contour mode refused — check the workplane / profile.');
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
    getCurrentMeshData: () => cachedMeshData
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
  }, []);

  const clearEdgeHighlight = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, edgeHighlightRef.current);
    edgeHighlightRef.current = null;
  }, []);

  const clearEdgeHover = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, edgeHoverRef.current);
    edgeHoverRef.current = null;
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
      if (!e.va || !e.vb) continue;
      positions.push(e.va[0], e.va[1], e.va[2], e.vb[0], e.vb[1], e.vb[2]);
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
    group.add(makeSeg(haloPx, Math.min(0.38, opacity * 0.45), 10));
    group.add(makeSeg(corePx, opacity, 11));
    sceneRef.current.add(group);
    return group;
  }, [edgeLineResolution]);

  const clearXsPreview = useCallback(() => {
    if (!xsPreviewRef.current) return;
    disposeEdgeOverlayObject(sceneRef.current, xsPreviewRef.current);
    xsPreviewRef.current = null;
  }, []);

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

  const clearPolylineDraft = useCallback(() => {
    disposeEdgeOverlayObject(sceneRef.current, polylineDraftRef.current);
    polylineDraftRef.current = null;
  }, []);

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
    const mat = new MeshLambertMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      flatShading: true,
      side: DoubleSide,
      emissive: 0x164e63,
      emissiveIntensity: 0.2,
    });
    const mesh = new ThreeMesh(geom, mat);
    mesh.name = 'contourExtrudePreview';
    mesh.renderOrder = 8;
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
    const mat = new MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: DoubleSide,
    });
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
    const mat = new MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: DoubleSide,
    });
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

  const paintPolylineDraft = useCallback((plane, points) => {
    clearPolylineDraft();
    if (!plane || !points?.length || !sceneRef.current) return;
    const group = new Group();
    group.name = 'contourPolylineDraft';
    const world = points.map(([u, v]) => [
      plane.center[0] + u * plane.x[0] + v * plane.y[0],
      plane.center[1] + u * plane.x[1] + v * plane.y[1],
      plane.center[2] + u * plane.x[2] + v * plane.y[2],
    ]);
    const ptMat = new MeshBasicMaterial({
      color: 0x22d3ee,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    for (const p of world) {
      const s = new ThreeMesh(new SphereGeometry(0.45, 8, 8), ptMat);
      s.position.set(p[0], p[1], p[2]);
      s.renderOrder = 16;
      s.frustumCulled = false;
      group.add(s);
    }
    if (world.length >= 2) {
      const pos = new Float32Array(world.length * 3);
      for (let i = 0; i < world.length; i++) {
        pos[i * 3] = world[i][0];
        pos[i * 3 + 1] = world[i][1];
        pos[i * 3 + 2] = world[i][2];
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const line = new Line(g, new LineBasicMaterial({
        color: 0x22d3ee,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }));
      line.renderOrder = 15;
      line.frustumCulled = false;
      group.add(line);
    }
    sceneRef.current.add(group);
    polylineDraftRef.current = group;
  }, [clearPolylineDraft]);

  const exitContourMode = useCallback(() => {
    setContourMode(null);
    contourModeRef.current = null;
    clearXsPreview();
    clearWorkplaneOverlay();
    clearPolylineDraft();
    clearExtrudePreview();
    clearRevolvePreview();
    applyContourPartGhost(false);
    if (contourToastTimerRef.current) {
      clearTimeout(contourToastTimerRef.current);
      contourToastTimerRef.current = null;
    }
    setContourToast(null);
  }, [clearXsPreview, clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, applyContourPartGhost]);

  const enterContourMode = useCallback(({ entry } = {}) => {
    setPickMode('face');
    disposeEdgeOverlayObject(sceneRef.current, pathPreviewRef.current);
    pathPreviewRef.current = null;
    const next = enterContourState(entry, selectedFace);
    setContourMode(next);
    if (next.enterRefuse) showContourToast(next.enterRefuse);
    applyContourPartGhost(true);
  }, [selectedFace, applyContourPartGhost]);

  const confirmContourProfile = useCallback(() => {
    const state = contourModeRef.current;
    if (!state) return;
    const gate = validateContourProfile(state.tool, state.params);
    if (!gate.ok) {
      showContourToast(gate.message);
      return;
    }
    if (isExtrudeEntry(state.entry)) {
      const extGate = validateExtrudeParams(state.extrude);
      if (!extGate.ok) {
        showContourToast(extGate.message);
        return;
      }
      const axis = resolveExtrudeAxis(
        planeFromContourFace(state.planeFace),
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
        planeFromContourFace(state.planeFace),
        revGate.normalized.axis,
      );
      if (!axis.ok) {
        showContourToast(axis.message);
        return;
      }
    }
    const ok = onCommitContourProfile?.({
      face: state.planeFace,
      tool: state.tool,
      params: state.params,
      entry: state.entry,
      extrude: state.extrude,
      revolve: state.revolve,
    });
    if (ok) {
      showContourToast(
        isRevolveEntry(state.entry)
          ? 'Revolve saved — still in contour mode. Confirm again to update.'
          : isExtrudeEntry(state.entry)
            ? 'Extrude saved — still in contour mode. Confirm again to update.'
            : 'Profile saved — still in contour mode (Profile only).',
      );
    }
  }, [onCommitContourProfile]);

  // Live workplane + makeCrossSection profile (+ Extrude / Revolve solid) preview.
  useEffect(() => {
    if (!contourMode) {
      clearWorkplaneOverlay();
      clearPolylineDraft();
      clearExtrudePreview();
      clearRevolvePreview();
      applyContourPartGhost(false);
      return;
    }
    // No face pick: snap the default +Z plane to the part top so the live
    // solid sits on the workplane (same intent as facesByNormal on Confirm).
    let planeFace = contourMode.planeFace;
    if (!planeFace && modelBounds?.max && Number.isFinite(Number(modelBounds.max[2]))) {
      planeFace = {
        type: 'planar',
        center: [
          Number(modelBounds.center?.[0]) || 0,
          Number(modelBounds.center?.[1]) || 0,
          Number(modelBounds.max[2]),
        ],
        normal: [0, 0, 1],
        area: Math.max(1, (Number(modelBounds.size?.[0]) || 20) * (Number(modelBounds.size?.[1]) || 20)),
        triangleCount: 2,
        selectionMode: 'coplanar',
      };
    }
    const plane = planeFromContourFace(planeFace);
    paintWorkplaneOverlay(plane, planeFace);
    applyContourPartGhost(true);
    const pts = contourMode.params?.points;
    if (contourMode.tool === 'polyline' && (!Array.isArray(pts) || pts.length < 3)) {
      clearXsPreview();
      clearExtrudePreview();
      clearRevolvePreview();
      paintPolylineDraft(plane, pts || []);
      return;
    }
    clearPolylineDraft();
    if (buildContourPreview(planeFace, contourMode.tool, contourMode.params)) {
      setXsPreview({
        face: planeFace,
        params: toolToProfileParams(contourMode.tool, contourMode.params),
      });
    } else {
      clearXsPreview();
    }
    if (isExtrudeEntry(contourMode.entry)) {
      clearRevolvePreview();
      const solid = buildExtrudeSolidPreview(
        planeFace,
        contourMode.tool,
        contourMode.params,
        contourMode.extrude,
      );
      if (solid) paintExtrudePreview(solid);
      else clearExtrudePreview();
    } else if (isRevolveEntry(contourMode.entry)) {
      clearExtrudePreview();
      const solid = buildRevolveSolidPreview(
        planeFace,
        contourMode.tool,
        contourMode.params,
        contourMode.revolve,
      );
      if (solid) paintRevolvePreview(solid);
      else clearRevolvePreview();
    } else {
      clearExtrudePreview();
      clearRevolvePreview();
    }
  }, [contourMode, modelBounds, paintWorkplaneOverlay, paintPolylineDraft, paintExtrudePreview, paintRevolvePreview, applyContourPartGhost, clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, clearXsPreview, setXsPreview]);

  useEffect(() => () => {
    clearWorkplaneOverlay();
    clearPolylineDraft();
    clearExtrudePreview();
    clearRevolvePreview();
    applyContourPartGhost(false);
    if (contourToastTimerRef.current) clearTimeout(contourToastTimerRef.current);
  }, [clearWorkplaneOverlay, clearPolylineDraft, clearExtrudePreview, clearRevolvePreview, applyContourPartGhost]);

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
      return { ...prev, planeFace: resolved.face };
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

  useEffect(() => () => clearPathPreview(), [clearPathPreview]);

  const highlightSelectedEdges = useCallback((edges) => {
    clearEdgeHighlight();
    edgeHighlightRef.current = paintEdgeLines(edges, {
      color: 0xff9900,
      name: 'edgeSelection',
      opacity: 1,
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
  }, [selectedEdges, highlightSelectedEdges]);

  /** Rebuild feature-edge cache when the source BufferGeometry identity changes. */
  const syncFeatureEdges = useCallback((geom) => {
    if (featureEdgesSourceRef.current !== geom) {
      featureEdgesRef.current = geom ? buildFeatureEdges(geom) : [];
      featureEdgesSourceRef.current = geom ?? null;
    }
  }, []);

  const rebuildFeatureEdges = useCallback(() => {
    syncFeatureEdges(resultRef.current?.geometry ?? null);
  }, [syncFeatureEdges]);


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

  // Helper function to highlight a face - with boundary edges only
  const highlightFace = useCallback((faceIndices, geometry, positions, index, color = 0xffff00, name = 'highlight') => {
    const highlightPositions = [];
    const edgeCount = new Map(); // Track how many times each edge appears
    
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
      
      // Track edges (use sorted vertex indices as key)
      const edges = [
        [Math.min(i0, i1), Math.max(i0, i1)],
        [Math.min(i1, i2), Math.max(i1, i2)],
        [Math.min(i2, i0), Math.max(i2, i0)]
      ];
      
      edges.forEach(([a, b]) => {
        const key = `${a}-${b}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      });
    });
    
    // Build boundary edges (edges that appear only once)
    const boundaryEdgePositions = [];
    edgeCount.forEach((count, key) => {
      if (count === 1) {
        const [a, b] = key.split('-').map(Number);
        const v1 = new Vector3().fromBufferAttribute(positions, a);
        const v2 = new Vector3().fromBufferAttribute(positions, b);
        boundaryEdgePositions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    });
    
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
    return pickNearestEdgeScreen(
      featureEdgesRef.current,
      cameraRef.current,
      rect.width,
      rect.height,
      px,
      py,
      slop,
      opts,
    );
  }, [syncFeatureEdges]);

  /**
   * Handle mouse down - record position for drag detection
   */
  const handleMouseDown = useCallback((event) => {
    mouseDownPosRef.current = { x: event.clientX, y: event.clientY };
    isDraggingRef.current = false;
  }, []);

  /**
   * Handle mouse move - detect if dragging
   */
  const handleMouseMove = useCallback((event) => {
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
  }, [selectedEdges, highlightHoverEdge, clearEdgeHover, pickEdgeAtClient]);

  /**
   * Handle mouse up - process click only if not dragging
   */
  const handleMouseUp = useCallback((event) => {
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
    if (contourModeRef.current?.tool === 'polyline') {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickCountRef.current = 0;
      pendingClickDataRef.current = null;
      const plane = planeFromContourFace(contourModeRef.current.planeFace);
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
        return { ...prev, params: { ...prev.params, points } };
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
    const intersects = raycasterRef.current.intersectObject(resultRef.current);
    
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
      faceNormal: [clickedFace.normal.x, clickedFace.normal.y, clickedFace.normal.z]
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
    
  }, [onFaceSelected, measurementEnabled, clearHighlight, clearEdgeHover, pickEdgeAtClient]);


  /**
   * Process the pending click based on click count
   * This is called after the multi-click delay has passed
   */
  const processClick = useCallback(() => {
    const clickData = pendingClickDataRef.current;
    if (!clickData) return;
    
    const { clickedFace, seedFaceIndex, geometry, positions, index, faceNormal } = clickData;
    const clickCount = clickCountRef.current;
    
    // Reset click tracking
    clickCountRef.current = 0;
    clickTimerRef.current = null;
    pendingClickDataRef.current = null;
    
    // Determine which selection function to use based on click count
    let faceIndices;
    let selectionMode;
    
    if (clickCount >= 3) {
      // Triple click: select all connected triangles
      faceIndices = selectAllConnected(geometry, seedFaceIndex);
      selectionMode = 'all-connected';
      console.log(`[Face Selection] Triple-click: selecting all ${faceIndices.length} connected triangles`);
    } else if (clickCount === 2) {
      // Double click: select faces within angular tolerance
      faceIndices = selectFaceWithTolerance(geometry, seedFaceIndex, { normal: faceNormal }, ANGLE_TOLERANCE_DEGREES);
      selectionMode = 'angular-tolerance';
      console.log(`[Face Selection] Double-click: selecting ${faceIndices.length} triangles within ${ANGLE_TOLERANCE_DEGREES}° tolerance`);
    } else {
      // Single click: select exact coplanar faces
      faceIndices = selectFaceByID(geometry, seedFaceIndex, { normal: faceNormal });
      selectionMode = 'coplanar';
      console.log(`[Face Selection] Single-click: selecting ${faceIndices.length} coplanar triangles`);
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
      setSelectedFace(faceData);
      onFaceSelected?.(faceData);
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0xffff00);
    }
    
  }, [measurementEnabled, measurementFaces, onFaceSelected, clearHighlight, clearEdgeHighlight, highlightFace]);

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

  // --- Event listener setup ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp]);

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
      const camera = new PerspectiveCamera(45, width / height, 0.1, 2000);
      camera.position.set(300, 300, 300);
      camera.lookAt(0, 0, 0);
      const light = new PointLight(0xffffff, 1);
      camera.add(light);
      scene.add(camera);

      sceneRef.current = scene;
      cameraRef.current = camera;

      const renderer = new WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true
      });

      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
          stageSnap: (key, margin = 1.15) => {
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
  const handleViewSnap = useCallback((key, margin = 1.15) => {
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

    const geometry = new BufferGeometry();
    
    // Convert arrays to typed arrays
    const vertProperties = new Float32Array(meshData.vertProperties);
    const triVerts = new Uint32Array(meshData.triVerts);
    
    geometry.setAttribute('position', new BufferAttribute(vertProperties, 3));
    geometry.setIndex(new BufferAttribute(triVerts, 1));

    if (meshData.faceID && meshData.faceID.length > 0) {
      geometry.setAttribute('faceID', new BufferAttribute(new Float32Array(meshData.faceID), 1));
    }

    // Set up material groups
    if (meshData.runIndex) {
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
    
    resultRef.current.geometry?.dispose();
    resultRef.current.geometry = geometry;

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
  const executeScript = useCallback(async (scriptOverride) => {
    const script = scriptOverride ?? currentScript;
    
    if (!script || !sceneRef.current) return false;
    
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
      
      const { mesh: meshData, memoryUsedMB } = result;
      
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

      // Geometry replaced → previous face/edge picks are stale. Clear intentionally
      // and nudge the user when they were in edge pick mode.
      const hadEdges = Array.isArray(selectedEdges) && selectedEdges.length > 0;
      const wasEdgeMode = pickModeRef.current === 'edge';
      clearHighlight();
      clearEdgeHighlight();
      clearEdgeHover();
      setSelectedFace(null);
      setSelectedEdges([]);
      onFaceSelected?.(null);
      featureEdgesRef.current = [];
      featureEdgesSourceRef.current = null;
      syncFeatureEdges(resultRef.current?.geometry ?? null);
      if (wasEdgeMode && hadEdges) {
        setEdgeModeToast('Geometry updated — re-pick edges');
        armEdgeModeToastClear();
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
      // Truthy object: callers that only check success keep working; game compare needs nonce.
      return { ok: true, nonce };

    } catch (error) {
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
        setEdgeModeToast('Selected edges not found — re-pick after geometry changes');
        armEdgeModeToastClear();
      }

      // Failed Auto-Run: restore the last good mesh and keep edge/face selection
      // so the chip does not falsely show "0 selected" (unless soft-cleared above).
      const prev = cachedMeshDataRef.current;
      if (prev?.vertProperties && resultRef.current) {
        renderMeshData(prev);
        featureEdgesSourceRef.current = null;
        syncFeatureEdges(resultRef.current?.geometry ?? null);
        // Re-paint edge highlight from current selection (effect also runs).
        if (pickModeRef.current === 'edge') {
          // highlightSelectedEdges is invoked via selectedEdges effect
        }
      } else if (resultRef.current) {
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
        // No prior mesh — selection would be meaningless on empty geom.
        clearHighlight();
        clearEdgeHighlight();
        clearEdgeHover();
        setSelectedFace(null);
        setSelectedEdges([]);
        onFaceSelected?.(null);
        featureEdgesRef.current = [];
        featureEdgesSourceRef.current = null;
        setEdgeModeToast('Run failed — selection cleared (no prior solid)');
        armEdgeModeToastClear();
      }
      return false;
    } finally {
      setIsExecuting(false);
      if (executionAbortRef.current === abortController) {
        executionAbortRef.current = null;
      }
    }
  }, [currentScript, materials, onFaceSelected, renderMeshData, clearHighlight, clearEdgeHighlight, clearEdgeHover, autoFitEnabled, handleZoomToFit, selectedEdges, syncFeatureEdges]);

  /**
   * Download the current model as 3mf
   * Uses cached mesh data when available to avoid re-execution
   */
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

  return (
    <div ref={containerRef} className="relative w-full h-full bg-gray-900 overflow-hidden">
      {/* CAD floating chrome. Game actions moved to CodeEditor mid-strip (slice 08). */}
      {mode !== 'game' && (
        <Toolbar
          mode={mode}
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
          onHint={onHint}
          onPickPuzzle={onPickPuzzle}
          gameElapsedMs={gameElapsedMs}
          gameSuccess={gameSuccess}
          gameBestTimeMs={gameBestTimeMs}
        />
      )}

      {/* Slice 08: part name only, centered top-middle (where floating bar sat). */}
      {mode === 'game' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none max-w-[min(20rem,calc(100%-2rem))]">
          <div className="text-xs font-medium text-center truncate px-3 py-1.5 rounded-lg shadow bg-gray-900/85 border border-gray-500/50 text-gray-100">
            {gamePuzzleTitle || 'Puzzle'}
          </div>
        </div>
      )}

      {mode === 'game' && gameSuccess && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-emerald-900/90 border border-emerald-400/60 text-white px-5 py-3 rounded-xl shadow-xl text-center">
            <div className="text-sm font-semibold">Match!</div>
            <div className="text-2xl font-mono tabular-nums mt-1">{formatGameTime(gameElapsedMs)}</div>
            <div className="text-[11px] text-emerald-200/80 mt-1">lower is better</div>
          </div>
        </div>
      )}
      
      {/* Slice 09: left helper insert palette (game mode only). */}
      {mode === 'game' && onInsertHelper && !contourMode && (
        <HelperInsertPalette
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
            setEdgeModeToast(msg || 'Re-pick edges after geometry changes');
            armEdgeModeToastClear();
          }}
          onProfilePreview={setXsPreview}
          onPathPreview={setPathPreview}
          onEnterContourMode={enterContourMode}
          compact={isMobile}
        />
      )}

      {/* Slice 24: contour-mode rail (tools + Back). */}
      {mode === 'game' && contourMode && (
        <ContourModeRail
          tool={contourMode.tool}
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
                setEdgeModeToast('Edge pick on — tap near an edge (tangent loops on)');
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
          verticalRail={mode === 'game' && isMobile}
        />
      
      {executionError && (
        <div className="absolute top-16 right-4 bg-red-900/90 text-white p-3 rounded text-xs max-w-md z-10">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-bold mb-1">Execution Error</div>
              <div>{executionError}</div>
            </div>
            <button
              onClick={() => setExecutionError(null)}
              className="text-red-200 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      
      {/* Face Info Display — Slice 11: show classified type; dodge palette in game mode */}
      {selectedFace && !measurementEnabled && !contourMode && (
        <div
          className={`absolute bg-black/50 text-white p-2 rounded-lg text-xs font-mono z-10 ${
            mode === 'game'
              ? 'bottom-4 right-2 lg:right-4 max-w-[14rem]'
              : 'bottom-4 left-2 lg:left-4'
          }`}
        >
          <div className="font-bold mb-1">
            Selected Face
            {(() => {
              const c = classifySelectedFace(selectedFace);
              return c ? (
                <span className="ml-1 font-normal text-cyan-300">({c.type})</span>
              ) : null;
            })()}
          </div>
          <div>Center: [{selectedFace.center.map(v => v.toFixed(1)).join(', ')}]</div>
          <div>Normal: [{selectedFace.normal.map(v => v.toFixed(2)).join(', ')}]</div>
          <div>Area: {selectedFace.area.toFixed(1)} mm²</div>
          {mode === 'game' && (
            <div className="mt-1 text-[10px] text-gray-300 normal-case font-sans">
              Tap Hole / Clearance / … on the left to place on this face
            </div>
          )}
        </div>
      )}

      {/* Slice 24: contour chip — plane + profile params (Edge-pick pattern). */}
      {contourMode && (
        <ContourModeChip
          tool={contourMode.tool}
          entry={contourMode.entry}
          params={contourMode.params}
          extrude={contourMode.extrude || {}}
          revolve={contourMode.revolve || {}}
          compact={isMobile}
          planeLabel={
            contourMode.planeFace
              ? `planar n=[${contourMode.planeFace.normal.map((v) => Number(v).toFixed(2)).join(', ')}]`
              : 'default +Z top'
          }
          onParamChange={(next) => setContourMode((prev) => (prev ? { ...prev, params: next } : prev))}
          onExtrudeChange={(next) => setContourMode((prev) => (prev ? { ...prev, extrude: next } : prev))}
          onRevolveChange={(next) => setContourMode((prev) => (prev ? { ...prev, revolve: next } : prev))}
          onConfirm={confirmContourProfile}
          onUndoPoint={() => setContourMode((prev) => {
            if (!prev || prev.tool !== 'polyline') return prev;
            const points = (prev.params?.points || []).slice(0, -1);
            return { ...prev, params: { ...prev.params, points } };
          })}
          onClearPoints={() => setContourMode((prev) => {
            if (!prev || prev.tool !== 'polyline') return prev;
            return { ...prev, params: { ...prev.params, points: [] } };
          })}
        />
      )}

      {/* Slice 12 hotfix: Edge pick chip — visible whenever Edge mode is on */}
      {pickMode === 'edge' && !contourMode && (
        <div
          className={`absolute bg-amber-950/85 border border-amber-500/70 text-white px-3 py-2 rounded-lg text-xs z-20 shadow-lg ${
            mode === 'game'
              ? 'bottom-4 right-2 lg:right-4 max-w-[16rem]'
              : 'bottom-4 left-2 lg:left-4'
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

      {edgeModeToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="bg-amber-600 text-white text-xs font-sans font-medium px-3 py-2 rounded-full shadow-lg">
            {edgeModeToast}
          </div>
        </div>
      )}

      {contourToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 pointer-events-none max-w-[min(22rem,calc(100%-2rem))]">
          <div className="bg-cyan-700 text-white text-xs font-sans font-medium px-3 py-2 rounded-full shadow-lg text-center">
            {contourToast}
          </div>
        </div>
      )}

      {/* Measurement Info Display */}
      {measurementEnabled && measurementFaces.first && (
        <div className="absolute bottom-4 left-2 lg:left-4 bg-black/50 backdrop-blur-sm text-white p-3 rounded-lg text-xs font-mono z-10 space-y-1">
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
