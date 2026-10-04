import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';
import PromptInput from './components/PromptInput';
import SplitDivider from './components/SplitDivider';
import MobileStageToggle from './components/MobileStageToggle';
import FeatureStrip from './components/FeatureStrip';
import ErrorPopup from './components/ErrorPopup';
import FeatureSheet from './components/FeatureSheet';
import {
  writeFeatureSheetParams,
  deleteFeatureBlock,
  listFeatureSheetTargets,
  pickDefaultFeatureSheetTarget,
  isFeatureSheetEditable,
} from './utils/featureSheetWriteback';
import { saveAs } from 'file-saver';
import QuoteModal from './components/QuoteModal';
import OrderModal from './components/OrderModal';
import LoginModal from './components/LoginModal';
import AccountModal from './components/AccountModal';
import { useAuth } from './hooks/useAuth';
import { 
  importFile,
} from './utils/importModel';
import { 
  hasCheckoutReturnFlag, 
  hasPendingCheckout,
  restoreCheckoutState, 
  clearCheckoutState,
  clearCheckoutReturnFlag 
} from './utils/checkoutStorage';
import { 
  hasPendingEditorState,
  restoreEditorState, 
  clearEditorState 
} from './utils/editorStorage';
import { saveEditorDraft, loadEditorDraft } from './utils/editorDraft';
import manifoldContext from './utils/ManifoldWorker';
import DEFAULT_SCRIPT from './utils/defaultScript';
import {
  DEMO_PUZZLE,
  DEFAULT_PUZZLE_ID,
  GAME_PUZZLES,
  getPuzzle,
  getNextPuzzle,
  MATCH_REL_EPS,
  MATCH_VOL_FLOOR_MM3,
  SUCCESS_CLEAR_MS,
} from './utils/gamePuzzle';
import { getBestTimeMs, recordWin } from './utils/gameWins';
import GameHintsModal from './components/GameHintsModal';
import PuzzlePickerModal from './components/PuzzlePickerModal';
import GameConfetti from './components/GameConfetti';
import { composeContourCommit } from './utils/contourMode';
import { composeFilletCommit, composeChamferCommit } from './utils/filletMode';
import { composeShellCommit } from './utils/shellMode';
import { composeDraftCommit } from './utils/draftMode';
import { composeCutCommit } from './utils/cutMode';
import { composeMoveCommit } from './utils/moveMode';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const [currentFilename, setCurrentFilename] = useState(null);
  /** Editor column width % (desktop) and editor height px (mobile, null = auto). */
  const [splitPct, setSplitPct] = useState(50);
  const [mobileEditorPxOverride, setMobileEditorPx] = useState(null);
  /** Mobile CAD only: 'cad' (viewport+rails) vs 'script' (fullscreen editor). Session-sticky. */
  const [mobileStage, setMobileStage] = useState(() => {
    try {
      const s = sessionStorage.getItem('3dculos.mobileStage');
      return s === 'script' ? 'script' : 'cad';
    } catch {
      return 'cad';
    }
  });
  const setMobileStageSticky = (stage) => {
    const next = stage === 'script' ? 'script' : 'cad';
    setMobileStage(next);
    try { sessionStorage.setItem('3dculos.mobileStage', next); } catch { /* private mode */ }
  };
  /** Script-stage feature strip: which chip is selected (null = none). */
  const [featureStripActiveId, setFeatureStripActiveId] = useState(null);
  /**
   * Height of the editor ribbon, MEASURED. Mobile Script-stage strip overlays
   * with `top: ribbonPx`; desktop seam strip uses a matching spacer so chips
   * start flush under the ribbon (not overlapping). ResizeObserver keeps it
   * exact as the ribbon's contents change.
   */
  const [ribbonPx, setRibbonPx] = useState(44);
  /** Script-stage strip: caret jump only (no FeatureSheet — CAD strip / long-press keep the sheet). */
  const handleFeatureStripJump = (feature) => {
    if (!feature) return;
    setFeatureStripActiveId(feature.id);
    codeEditorRef.current?.revealRange?.(feature.startOffset, feature.endOffset);
    // Jump-only: clear highlight so the chip does not stay stuck cyan.
    setTimeout(() => {
      setFeatureStripActiveId((cur) => (cur === feature.id ? null : cur));
    }, 400);
  };
  /**
   * Desktop seam strip: jump the caret AND open the feature sheet in the
   * viewer. Both panes are on screen here, so editing the feature and seeing
   * the code it owns are not a trade-off the way they are on a phone.
   */
  const handleDesktopFeatureStripJump = (feature) => {
    if (!feature) return;
    setFeatureStripActiveId(feature.id);
    codeEditorRef.current?.revealRange?.(feature.startOffset, feature.endOffset);
    setFeatureSheet({ mode: 'edit', feature });
  };
  /** Desktop "Edit script": the editor is already visible — just reveal it. */
  const handleDesktopFeatureSheetEditScript = (feature) => {
    if (!feature) return;
    setFeatureSheet(null);
    // revealRange already selects, scrolls and focuses the editor.
    codeEditorRef.current?.revealRange?.(feature.startOffset, feature.endOffset);
  };
  /**
   * Slice Mobile C.1 — feature sheet (CAD + Script stages, under-title horizontal).
   * null | { mode: 'picker' } | { mode: 'edit', feature }
   * Desktop / game never open this.
   */
  const [featureSheet, setFeatureSheet] = useState(null);
  const closeFeatureSheet = () => {
    setFeatureSheet(null);
    setFeatureStripActiveId(null);
  };
  const openFeatureSheetFor = (feature) => {
    if (!feature) return;
    setFeatureStripActiveId(feature.id);
    setFeatureSheet({ mode: 'edit', feature });
  };
  const openFeatureSheetFromCad = () => {
    const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
    const features = listFeatureSheetTargets(buf);
    if (!features.length) {
      viewportRef.current?.softFailContour?.(
        'No marked features yet — Extrude / Fillet / Revolve first, then long-press to edit.',
      );
      return;
    }
    if (features.length === 1) {
      openFeatureSheetFor(features[0]);
      return;
    }
    // Prefer a default editable target; still allow picker via strip.
    const preferred = pickDefaultFeatureSheetTarget(buf);
    if (preferred && isFeatureSheetEditable(preferred.kind)) {
      openFeatureSheetFor(preferred);
      return;
    }
    setFeatureSheet({ mode: 'picker' });
  };
  const handleFeatureSheetAccept = (feature, params) => {
    if (!feature) return;
    const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
    // Re-parse markers against live buffer so offsets stay valid after prior edits.
    const live = listFeatureSheetTargets(buf).find((f) => f.id === feature.id)
      || listFeatureSheetTargets(buf).find(
        (f) => f.kind === feature.kind && f.index === feature.index,
      )
      || feature;
    const result = writeFeatureSheetParams(buf, live, params || {});
    if (!result.ok) {
      viewportRef.current?.softFailContour?.(result.message);
      return;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(
      result.buffer,
      `${feature.label || 'Feature'} sheet`,
    );
    if (!wrote) {
      viewportRef.current?.softFailContour?.(
        'Could not write feature params into the editor — try again.',
      );
      return;
    }
    setFeatureSheet(null);
    setFeatureStripActiveId(null);
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
  };
  const handleFeatureSheetDelete = (feature) => {
    if (!feature) return;
    const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
    const live = listFeatureSheetTargets(buf).find((f) => f.id === feature.id)
      || listFeatureSheetTargets(buf).find(
        (f) => f.kind === feature.kind && f.index === feature.index,
      )
      || feature;
    const result = deleteFeatureBlock(buf, live);
    if (!result.ok) {
      viewportRef.current?.softFailContour?.(result.message);
      return;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(
      result.buffer,
      `Delete ${feature.label || 'feature'}`,
    );
    if (!wrote) {
      viewportRef.current?.softFailContour?.(
        'Could not delete feature from the editor — try again.',
      );
      return;
    }
    setFeatureStripActiveId(null);
    setFeatureSheet(null);
    // Stay on the current stage (CAD stays CAD; Script stays Script).
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
  };
  const handleFeatureSheetEditScript = (feature) => {
    if (!feature) return;
    setFeatureSheet(null);
    setFeatureStripActiveId(feature.id);
    setMobileStageSticky('script');
    // Defer reveal until Script pane is interactive; then clear highlight.
    setTimeout(() => {
      const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
      const live = listFeatureSheetTargets(buf).find((f) => f.id === feature.id)
        || listFeatureSheetTargets(buf).find(
          (f) => f.kind === feature.kind && f.index === feature.index,
        )
        || feature;
      codeEditorRef.current?.revealRange?.(live.startOffset, live.endOffset);
      setFeatureStripActiveId((cur) => (cur === feature.id ? null : cur));
    }, 50);
  };

  // Dev/playtest bridge for Slice Mobile C feature sheets.

  useEffect(() => {
    if (!import.meta.env?.DEV || typeof window === 'undefined') return undefined;
    window.__FEATURE_SHEET__ = {
      open: (idOrKind) => {
        const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
        const features = listFeatureSheetTargets(buf);
        if (!features.length) return false;
        if (!idOrKind) {
          openFeatureSheetFromCad();
          return true;
        }
        const hit = features.find((f) => f.id === idOrKind)
          || features.find((f) => f.kind === idOrKind);
        if (!hit) return false;
        openFeatureSheetFor(hit);
        return true;
      },
      openPicker: () => {
        const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
        if (!listFeatureSheetTargets(buf).length) return false;
        setFeatureSheet({ mode: 'picker' });
        return true;
      },
      close: () => {
        setFeatureSheet(null);
        return true;
      },
      delete: () => {
        const st = featureSheet;
        if (!st || st.mode !== 'edit' || !st.feature) return false;
        handleFeatureSheetDelete(st.feature);
        return true;
      },
      state: () => featureSheet,
    };
    return () => {
      try { delete window.__FEATURE_SHEET__; } catch { /* ignore */ }
    };
    // Playtest bridge; open helpers close over latest render via refs-in-effect body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureSheet, currentScript]);

  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderData, setOrderData] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [manifoldReady, setManifoldReady] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalTab, setAccountModalTab] = useState('info');
  const [editorInitialScript, setEditorInitialScript] = useState(null);
  const [initError, setInitError] = useState(null);
  const [appMode, setAppMode] = useState('cad'); // 'cad' | 'game'
  const [ghostMeshData, setGhostMeshData] = useState(null);
  const [showHints, setShowHints] = useState(false);
  const [cadScriptBackup, setCadScriptBackup] = useState(null);
  const [gameLoading, setGameLoading] = useState(false);
  const [gameError, setGameError] = useState(null);
  const [gameElapsedMs, setGameElapsedMs] = useState(0);
  const [gameTimerRunning, setGameTimerRunning] = useState(false);
  const [gameSuccess, setGameSuccess] = useState(false);
  const [currentPuzzle, setCurrentPuzzle] = useState(DEMO_PUZZLE);
  const [showPuzzlePicker, setShowPuzzlePicker] = useState(false);
  const [gameBestTimeMs, setGameBestTimeMs] = useState(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [gameRunBusy, setGameRunBusy] = useState(false);
  // Mobile CAD mid-strip portal target (CodeEditor header).
  const [cadToolbarHost, setCadToolbarHost] = useState(null);

  // MUST stay below `cadToolbarHost`: a dependency array is evaluated during
  // render, so reading that binding from above its `const` throws a TDZ
  // ReferenceError and React renders nothing at all (blank screen).
  useEffect(() => {
    const ribbon = cadToolbarHost?.closest?.('[data-editor-ribbon]');
    if (!ribbon) return undefined;
    const sync = () => setRibbonPx(Math.round(ribbon.getBoundingClientRect().height));
    sync();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(sync);
    ro.observe(ribbon);
    return () => ro.disconnect();
  }, [cadToolbarHost]);


  const { user, isAuthenticated, checkAuth } = useAuth();

  const viewportRef = useRef(null);

  // Mobile C.2 — when a large under-title feature sheet opens, tween the part
  // clear of the sheet (DOWN on screen for top chrome). Reverse on close.
  // Edge-pick chips (FilletModeChip / standalone edge selector) do NOT lift.
  useEffect(() => {
    if (!isMobile || appMode === 'game') {
      viewportRef.current?.setFeatureSheetLift?.(0, { ms: 160 });
      return undefined;
    }
    const open = featureSheet?.mode === 'edit' || featureSheet?.mode === 'picker';
    if (!open) {
      viewportRef.current?.setFeatureSheetLift?.(0);
      return undefined;
    }
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      const sheet = document.querySelector('[data-feature-sheet]');
      const pane = document.querySelector('[data-stage-pane="cad"]')
        || document.querySelector('[data-stage-pane="script"]');
      let ndcY = 0.28; // fallback ~14% of viewport height (NDC half-span = 1)
      if (sheet && pane) {
        const sh = sheet.getBoundingClientRect().height;
        const ph = pane.getBoundingClientRect().height || 1;
        // Sheet covers the top — shift part down by ~half the sheet fraction.
        // NDC full height = 2, so frac of viewport → ndc = 2 * frac * 0.55.
        const frac = Math.min(0.45, Math.max(0.08, sh / ph));
        ndcY = 2 * frac * 0.55;
      }
      viewportRef.current?.setFeatureSheetLift?.(ndcY);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [featureSheet, isMobile, appMode]);

  const codeEditorRef = useRef(null);
  const gameTimerStartRef = useRef(0);
  const successClearTimerRef = useRef(null);
  const gameRunInFlightRef = useRef(false);
  // Latest puzzle id — handleGameRun closes over render-time state; ref lets
  // verdict-time validate that the puzzle did not switch mid-run.
  const currentPuzzleRef = useRef(currentPuzzle);
  currentPuzzleRef.current = currentPuzzle;
  /** False until the editor reports its first buffer (see handleExecute). */
  const editorLiveRef = useRef(false);
  const appModeRef = useRef(appMode);
  appModeRef.current = appMode;

  // iOS Safari keyboard: visualViewport height/offsetTop so the game editor
  // sits above the keyboard without eating the 3D viewport.
  const [vv, setVv] = useState(() => ({
    height: typeof window !== 'undefined'
      ? (window.visualViewport?.height ?? window.innerHeight)
      : 800,
    offsetTop: typeof window !== 'undefined'
      ? (window.visualViewport?.offsetTop ?? 0)
      : 0,
    layoutHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  
  const [history, setHistory] = useState({
    branches: {
      main: {
        commits: [],
        head: -1
      }
    },
    currentBranch: 'main'
  });

  // Headless review bridge for harness/stage_shot.mjs (dev-only).
  // Lets automation inject a script and run it through the exact same
  // execute -> render path the Run button uses, then report back over CDP.
  useEffect(() => {
    if (!import.meta.env?.DEV || typeof window === 'undefined') return;
    window.__STAGE__ = {
      ready: false,
      requested: false,
      done: false,
      _execSeq: 0,          // monotonic; ++_execSeq must not start from undefined (NaN rejects all callbacks)
      _lastScript: null,
      editorMirror: null,   // 'noop' | 'updated' | 'unavailable' from the last run
      status: null,
      error: null,
      volume: null,
      bbox: null,
      meshData: null,
      request(script) {
        this.requested = true;
        this._script = script;
        return 'queued';
      },
      // Execute `script` through the Run path and PROVE the paint via the render choke
      // point: renderMeshData fires onRendered with the exact meshData object it painted,
      // so the callback for THIS call must deliver the worker's result. If the run is
      // superseded (the editor's one-time mount render of the default script can abort it,
      // or finish LATER and clobber the scene), renderMeshData never runs for us, this
      // promise rejects, and the harness re-asserts instead of screenshotting a stranger's
      // geometry. Resolves with the painted mesh.
      _executeProven(script) {
        const vp = window.__VIEWPORT__;
        const execId = ++window.__STAGE__._execSeq;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            vp.onRendered = null;
            reject(new Error('no render within 25s of submitting the script (execution superseded)'));
          }, 25000);
          vp.onRendered = (painted) => {
            if (window.__STAGE__._execSeq !== execId) return;   // a stale run's paint
            vp.onRendered = null;
            clearTimeout(timer);
            const result = window.__MANIFOLD_CONTEXT__?.lastResult?.mesh ?? null;
            if (!result?.vertProperties?.length || !result?.triVerts?.length) {
              reject(new Error('worker returned no mesh'));
            } else if (painted !== result) {
              reject(new Error('rendered mesh is not the submitted part (painted '
                + `${painted?.triVerts?.length ?? 0} tris vs result ${result.triVerts.length})`));
            } else {
              resolve(result);
            }
          };
          vp.executeScript(script).catch((e) => {
            if (window.__STAGE__._execSeq !== execId) return;
            vp.onRendered = null;
            clearTimeout(timer);
            reject(new Error(String(e?.message || e)));
          });
        });
      },
      // Re-claim the screen after a late clobberer (the mount-time default render finishing
      // after our own paint) by executing the still-stored script again and demanding the
      // on-render proof once more. The default fires only once, so a re-execute always wins.
      async reassert() {
        try {
          const mesh = await this._executeProven(this._script);
          this.meshData = mesh;   // lastRenderedIs must compare against THIS object
          return true;
        }
        catch (e) { this.error = String(e?.message || e); return false; }
      },
      async run() {
        const vp = window.__VIEWPORT__;
        const ctx = window.__MANIFOLD_CONTEXT__;
        this.status = null; this.error = null; this.stack = null;
        this.volume = null; this.bbox = null; this.meshData = null;
        if (!ctx || !ctx.isReady) { this.status = 'error'; this.error = 'manifold context not ready'; this.done = true; return false; }
        if (!vp || !vp.ready()) { this.status = 'error'; this.error = 'viewport not ready'; this.done = true; return false; }

        try {
          const mesh = await this._executeProven(this._script);

          this.meshData = mesh;
          this.status = 'ok';
          try {
            const info = await ctx.getModelInfo(); // worker-side truth, provably ours now
            if (info) { this.volume = info.volume ?? null; this.bbox = info.boundingBox || null; }
          } catch { /* best-effort mirror; worker info optional here */ }
          // Mirror the code we ran into Monaco so the human sees the exact source that
          // produced this picture. No-ops when the buffer already holds it (see setTextOnly).
          this.editorMirror = this.mirrorToEditor();
        } catch (err) {
          this.status = 'error';
          this.error = String(err?.message || err);
          this.stack = err?.stack || null;
        }
        this.done = true;
        return false;
      },
      async fillStats() {
        try {
          const info = await window.__MANIFOLD_CONTEXT__.getModelInfo();
          if (info) { this.volume = info.volume ?? null; this.bbox = info.boundingBox || null; }
        } catch { /* best-effort mirror; worker info optional here */ }
      },
      // ── Stage verification (kernel-truth arbiter for the cadgen pilot) ──
      // Runs a candidate script through the SAME worker the Run button uses and keeps
      // the worker's own report (volume/surfaceArea/status/tris/bbox) beside the mesh.
      // The verdict never depends on the harness's separate npm manifold-3d copy:
      // stageVerify asks the WORKER (bundled built/manifold.wasm) to boolean-compare
      // what its own last execution produced against a staged reference.
      async stageScript(script, timeoutMs = 300000) {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try {
          await ctx.executeScript(script, { timeoutMs });   // worker 'execute' -> lastResult
          const p = ctx.lastResult || {};
          return {
            ok: true,
            volume: p.volume ?? null,
            surfaceArea: p.surfaceArea ?? null,
            status: p.status ?? null,
            tris: p.tris ?? (p.mesh ? p.mesh.triVerts.length / 3 : 0),
            verts: p.mesh ? p.mesh.vertProperties.length / p.mesh.numProp : 0,
            bbox: p.boundingBox ?? null,
          };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      },
      async stageGetLastMesh() {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try { return { ok: true, ...(await ctx.worker.stageGetLastMesh()) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      async stageVerify(reference, opts) {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try { return { ok: true, ...(await ctx.worker.stageVerify(reference, opts || {})) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      async stageReferenceLoad(filename, objString, tolerance, timeoutMs = 180000) {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try { return { ok: true, ...(await ctx.worker.stageReferenceLoad(filename, { objString, tolerance }, { timeoutMs })) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      // Push a reference from raw meshData delivered as a JSON string (keeps the CDP
      // expression a single scalar): { numProp, vertProperties:[...], triVerts:[...] }.
      // Used by the STEP channel: backend /api/convert/step (OCCT) -> meshData -> worker.
      async stageReferenceLoadMesh(filename, meshDataJson, tolerance, timeoutMs = 180000) {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try {
          const meshData = JSON.parse(meshDataJson);
          return { ok: true, ...(await ctx.worker.stageReferenceLoad(filename, { meshData, tolerance }, { timeoutMs })) };
        }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      async stageReferenceList() {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try { return { ok: true, ...(await ctx.worker.stageReferenceList()) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      async stageReferenceClear() {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx || !ctx.isReady) return { ok: false, error: 'manifold context not ready' };
        try { return { ok: true, ...(await ctx.worker.stageReferenceClear()) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
      // Nuclear recovery for a wedged worker: a script stuck in a runaway loop survives
      // the execute() promise timeout (the worker thread keeps chewing), so every later
      // message queues behind it forever. Terminate + re-init drops the thread.
      async stageRestartWorker() {
        const ctx = window.__MANIFOLD_CONTEXT__;
        if (!ctx) return { ok: false, error: 'no context' };
        try {
          ctx.worker.terminate();
          ctx.worker.isReady = false;
          ctx.worker.pendingRequests.clear();
          await ctx.worker.init();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      },
      // Show the reviewed source in Monaco so a screenshot is self-explanatory. setTextOnly
      // declines the write when the buffer already holds this exact text, so re-running the
      // same script (the common case mid-review) leaves the editor -- cursor, scroll, undo
      // stack -- completely alone. Never re-executes: that is what keeps this out of a loop
      // with the mount-time run.
      mirrorToEditor(script) {
        try {
          const ed = window.__STAGE_EDITOR__ || null;
          if (!ed || typeof ed.setTextOnly !== 'function') return 'unavailable';
          const wrote = ed.setTextOnly(script);
          this._lastScript = script;
          return wrote ? 'updated' : 'noop';
        } catch { return 'unavailable'; }
      },
    };
    const poll = setInterval(async () => {
      const s = window.__STAGE__;
      if (!s || s.ready || s.done) return;
      const ctx = window.__MANIFOLD_CONTEXT__;
      if (ctx?.isReady && window.__VIEWPORT__?.ready?.()) { s.ready = true; clearInterval(poll); }
    }, 150);
    setTimeout(() => clearInterval(poll), 60000);
  }, []);

  // Initialize ManifoldWorkerand handle script restoration
  useEffect(() => {
    const initManifold = async () => {
      try {
        console.log('[App] Initializing Manifold Sandbox Worker...');
        
        // Initialize the custom Manifold worker
        await manifoldContext.init();
        
        // Expose context globally
        window.ManifoldContext = manifoldContext;
        
        // Log available helper functions
        const helpers = await manifoldContext.getHelperFunctions();
        console.log('[App] Available helper functions:', helpers);
        
        setManifoldReady(true);
        console.log('[App] Manifold Sandbox Worker ready');
      } catch (error) {
        console.error('[App] Failed to initialize Manifold Sandbox:', error);
        setInitError(error.message);
      }
    };
    
    initManifold();
    
    // Cleanup on unmount
    return () => {
      manifoldContext.terminate();
    };
  }, []);

  // Single initialization effect - runs once when manifold is ready
  useEffect(() => {
    if (!manifoldReady) return undefined;
    let cancelled = false;

    const init = async () => {
      let script = DEFAULT_SCRIPT;
      let filename = null;
      let shouldOpenAccount = false;
      let restoredCheckout = null;
      let restoredEditor = false;
    
      const params = new URLSearchParams(window.location.search);
      const isAuthReturn = params.get('auth') === 'success';
      const isAccountReturn = params.get('account') === 'true';
      const isCheckoutReturn = hasCheckoutReturnFlag();
    
      console.log('[App] Initialization check:', {
        isAuthReturn,
        isAccountReturn,
        isCheckoutReturn,
        hasPendingEditor: hasPendingEditorState(),
        hasPendingCheckout: hasPendingCheckout(),
      });
    
      // Restore editor state if returning from any OAuth flow
      if ((isAuthReturn || isAccountReturn || isCheckoutReturn) && hasPendingEditorState()) {
        const restored = restoreEditorState();
        console.log('[App] Restored editor state:', {
          hasScript: !!restored?.currentScript,
          scriptLength: restored?.currentScript?.length,
        });
        if (restored?.currentScript) {
          script = restored.currentScript;
        }
        if (restored?.currentFilename) {
          filename = restored.currentFilename;
        }
        clearEditorState();
        restoredEditor = true;
      }

      // Plain reload / crash / tab eviction: the IndexedDB draft is the buffer
      // the user last saw. An OAuth hand-off already won above — it is the more
      // specific intent — so only fill in when nothing was restored yet.
      if (!restoredEditor) {
        const draft = await loadEditorDraft();
        if (draft && typeof draft.script === 'string') {
          script = draft.script;
          if (draft.filename) filename = draft.filename;
        }
      }
      if (cancelled) return;

      // Handle checkout-specific restoration
      if (isCheckoutReturn || (isAuthReturn && hasPendingCheckout())) {
        const checkoutState = restoreCheckoutState();
        if (checkoutState) {
          restoredCheckout = {
            quoteData: checkoutState.quoteData,
            modelData: checkoutState.modelData,
            restoredStep: checkoutState.currentStep,
            restoredAddress: checkoutState.address,
            restoredGuestEmail: checkoutState.guestEmail,
          };
        }
        clearCheckoutState();
      }
    
      // Determine if we should open modals
      if (isAccountReturn) {
        shouldOpenAccount = true;
      }
    
      // Clean URL
      if (isAuthReturn || isAccountReturn || isCheckoutReturn) {
        clearCheckoutReturnFlag();
      }
    
      // Set state - order matters for avoiding flicker
      if (filename) setCurrentFilename(filename);
      if (restoredCheckout) {
        setOrderData(restoredCheckout);
        setShowOrderModal(true);
      }
      if (shouldOpenAccount) setShowAccountModal(true);
    
      // Set editor script last - this enables rendering
      setEditorInitialScript(script);
    };

    init();
    return () => { cancelled = true; };
  }, [manifoldReady]);

  // Mirror the live CAD buffer into IndexedDB so a reload restores it.
  // Debounced: the editor calls onExecute on every keystroke, and the draft
  // only has to be no older than the last pause in typing.
  // Game mode is excluded — its buffer is puzzle scratch, and restoring it
  // into the CAD editor on the next load would clobber the user's model.
  useEffect(() => {
    if (!manifoldReady || editorInitialScript === null) return undefined;
    if (appMode === 'game' || !editorLiveRef.current) return undefined;
    const timer = setTimeout(() => {
      saveEditorDraft({ script: currentScript, filename: currentFilename });
    }, 600);
    return () => clearTimeout(timer);
  }, [currentScript, currentFilename, manifoldReady, editorInitialScript, appMode]);

  // A reload can beat the debounce (refresh mid-typing). pagehide covers the
  // iOS/Safari case where unload never fires.
  useEffect(() => {
    if (!manifoldReady || editorInitialScript === null) return undefined;
    const flush = () => {
      if (appModeRef.current === 'game' || !editorLiveRef.current) return;
      const live = codeEditorRef.current?.getContent?.() ?? currentScript;
      saveEditorDraft({ script: live, filename: currentFilename });
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [currentScript, currentFilename, manifoldReady, editorInitialScript]);

  // Check for mobile layout
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 768px)");

    const checkIsMobile = () => {
        setIsMobile(mediaQuery.matches);
      };

    // Initial check
    checkIsMobile();

    // Media query change (works well on desktop + some mobile scenarios)
    const onMediaChange = (e) => {
      setIsMobile(e.matches);
    };
    mediaQuery.addEventListener("change", onMediaChange);

    // Resize event – critical fallback for iOS Safari rotation
    const onResize = () => {
      // Small delay helps when toolbar sliding causes multiple rapid resizes
      const timer = setTimeout(checkIsMobile, 50);
      return () => clearTimeout(timer);
    };
    window.addEventListener("resize", onResize);

    // Cleanup
    return () => {
      mediaQuery.removeEventListener("change", onMediaChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Track visualViewport for mobile keyboard-aware editor height (slice 05).
  useEffect(() => {
    const sync = () => {
      const v = window.visualViewport;
      setVv({
        height: v?.height ?? window.innerHeight,
        offsetTop: v?.offsetTop ?? 0,
        layoutHeight: window.innerHeight,
      });
    };
    sync();
    const vvApi = window.visualViewport;
    vvApi?.addEventListener('resize', sync);
    vvApi?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    return () => {
      vvApi?.removeEventListener('resize', sync);
      vvApi?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  const clearSuccessTimer = () => {
    if (successClearTimerRef.current) {
      clearTimeout(successClearTimerRef.current);
      successClearTimerRef.current = null;
    }
  };

  const resetGameScoring = () => {
    clearSuccessTimer();
    setGameTimerRunning(false);
    setGameElapsedMs(0);
    setGameSuccess(false);
    gameTimerStartRef.current = 0;
  };

  const startGameTimer = () => {
    clearSuccessTimer();
    setGameSuccess(false);
    gameTimerStartRef.current = performance.now();
    setGameElapsedMs(0);
    setGameTimerRunning(true);
  };

  // Puzzle timer: starts on enter, ticks at 10 Hz, stops on match.
  useEffect(() => {
    if (!gameTimerRunning) return undefined;
    const id = setInterval(() => {
      setGameElapsedMs(performance.now() - gameTimerStartRef.current);
    }, 100);
    return () => clearInterval(id);
  }, [gameTimerRunning]);

  useEffect(() => () => {
    if (successClearTimerRef.current) {
      clearTimeout(successClearTimerRef.current);
      successClearTimerRef.current = null;
    }
  }, []);

  /**
   * CAD → game: always start on first pack puzzle (linear progression).
   * Picker stays secondary via toolbar List (handlePickPuzzle).
   */
  const handleStartGame = () => {
    if (gameLoading) return;
    const first = getPuzzle(DEFAULT_PUZZLE_ID) || GAME_PUZZLES[0] || DEMO_PUZZLE;
    loadPuzzle(first, { autoOpenHint: true });
  };

  const handlePickPuzzle = () => {
    if (gameLoading) return;
    setShowPuzzlePicker(true);
  };

  /**
   * Load a puzzle: rebuild ghost, blank editor, reset timer.
   * Used for first enter, auto-advance, and mid-game picker switches.
   * @param {{ autoOpenHint?: boolean }} [opts]
   */
  const loadPuzzle = async (puzzle, opts = {}) => {
    if (!puzzle?.targetScript || gameLoading) return;
    const enteringFromCad = appMode !== 'game';
    const autoOpenHint = Boolean(opts.autoOpenHint);
    resetGameScoring();
    setGameLoading(true);
    setGameError(null);
    setShowPuzzlePicker(false);
    setShowConfetti(false);
    try {
      if (enteringFromCad) {
        const current = codeEditorRef.current?.getContent?.() ?? currentScript;
        setCadScriptBackup(current);
      }

      const result = await manifoldContext.executeScript(puzzle.targetScript, {
        timeoutMs: 30000,
      });
      if (!result?.mesh?.vertProperties) {
        throw new Error('Ghost target produced no mesh');
      }
      await manifoldContext.storeGameTarget();
      setGhostMeshData(result.mesh);
      setCurrentPuzzle(puzzle);
      setGameBestTimeMs(getBestTimeMs(puzzle.id));
      setAppMode('game');
      // Slice 07: first puzzle auto-opens Hint on enter (Artur playtest).
      const isFirst = puzzle.id === DEFAULT_PUZZLE_ID || puzzle.id === GAME_PUZZLES[0]?.id;
      setShowHints(autoOpenHint || isFirst);
      setGameError(null);

      // Blank Monaco + ghost-only until Run (slice 02.1 / 05).
      // Always '' — never starter/target/demo (remount + loadContent auto-run
      // previously leaked DEMO TARGET / Solo Cup into the editor on enter).
      setCurrentScript('');
      const blankEditor = () => codeEditorRef.current?.setTextOnly?.('');
      blankEditor();
      // Layout swap (viewport top / editor bottom) remounts Monaco after this
      // tick; double window.rAF waits for remount/paint so initialScript cannot
      // stick. (No queueMicrotask — rAF covers the remount tick.)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          blankEditor();
          viewportRef.current?.frameGhost?.();
        });
      });
      viewportRef.current?.clearAttempt?.();
      startGameTimer();
    } catch (err) {
      console.error('[App] Failed to start puzzle:', err);
      setGameError(err.message || 'Failed to start puzzle');
      if (enteringFromCad) {
        setGhostMeshData(null);
        setCadScriptBackup(null);
        setAppMode('cad');
        resetGameScoring();
        manifoldContext.clearGameTarget().catch(() => {});
      }
    } finally {
      setGameLoading(false);
    }
  };

  const handleExitGame = () => {
    resetGameScoring();
    manifoldContext.clearGameTarget().catch(() => {});
    setAppMode('cad');
    setGhostMeshData(null);
    setShowHints(false);
    setShowPuzzlePicker(false);
    setShowConfetti(false);
    setGameError(null);
    setGameBestTimeMs(null);
    const restore = cadScriptBackup || DEFAULT_SCRIPT;
    codeEditorRef.current?.loadContent(restore, 'Back to CAD', true);
    setCadScriptBackup(null);
  };

  const handleGameRun = async () => {
    if (gameSuccess || gameRunInFlightRef.current) return;
    const code = codeEditorRef.current?.getContent?.();
    if (code == null) return;
    // Capture puzzle identity at Run — loadPuzzle can change currentPuzzle
    // while execute+compare are in flight (~1s+), which would poison wins.
    // Ref tracks live id (closure would stay stale across the await).
    const puzzleIdAtRun = currentPuzzleRef.current?.id || 'unknown';
    gameRunInFlightRef.current = true;
    setGameRunBusy(true);
    setCurrentScript(code);
    try {
      const run = await viewportRef.current?.executeScript(code);
      if (!run || run.cleared) return;
      const nonce = typeof run === 'object' ? run.nonce : undefined;
      try {
        const verdict = await manifoldContext.compareGameMatch({
          relEps: MATCH_REL_EPS,
          volFloor: MATCH_VOL_FLOOR_MM3,
          nonce,
        });
        if (verdict?.ignored) {
          console.log('[App] Ignoring stale match compare', verdict);
          return;
        }
        if (!verdict?.match) {
          console.log('[App] No match', verdict);
          return;
        }
        // Stale — puzzle switched mid-run; do not treat as success / record win.
        const puzzleIdNow = currentPuzzleRef.current?.id || 'unknown';
        if (puzzleIdNow !== puzzleIdAtRun) {
          console.log('[App] Ignoring stale match — puzzle switched mid-run', {
            puzzleIdAtRun,
            puzzleIdNow,
          });
          return;
        }
        if (verdict.reason === 'boolean_failed_vol_fallback' || verdict.warning) {
          console.warn('[App] Match via volume fallback (boolean unstable)', verdict.warning);
          setGameError('Match used volume fallback (boolean unstable)');
        }
        const elapsed = performance.now() - gameTimerStartRef.current;
        setGameTimerRunning(false);
        setGameElapsedMs(elapsed);
        setGameSuccess(true);
        setShowConfetti(true);
        setShowHints(false);

        // Win capture is non-blocking — match UX continues even if POST fails.
        // Use puzzleIdAtRun (not live currentPuzzle) so the win keys the run that matched.
        recordWin({ puzzleId: puzzleIdAtRun, script: code, timeMs: elapsed })
          .then(({ bestTimeMs }) => {
            setGameBestTimeMs(bestTimeMs);
          })
          .catch((err) => {
            console.warn('[App] Win capture failed (non-blocking):', err);
          });

        const next = getNextPuzzle(puzzleIdAtRun);
        clearSuccessTimer();
        // Brief confetti + banner, then auto-advance (or stay on last).
        successClearTimerRef.current = setTimeout(() => {
          successClearTimerRef.current = null;
          setGameSuccess(false);
          setShowConfetti(false);
          if (next) {
            loadPuzzle(next, { autoOpenHint: false });
            return;
          }
          // End of pack: stay on last, blank editor, restart timer.
          setCurrentScript('');
          codeEditorRef.current?.setTextOnly?.('');
          viewportRef.current?.clearAttempt?.();
          gameTimerStartRef.current = performance.now();
          setGameElapsedMs(0);
          setGameTimerRunning(true);
        }, SUCCESS_CLEAR_MS);
      } catch (err) {
        console.warn('[App] Match check failed:', err);
      }
    } finally {
      // Cover execute+compare only so retry Run works after a miss / failed check.
      gameRunInFlightRef.current = false;
      setGameRunBusy(false);
    }
  };

  const handleGameHint = () => {
    setShowHints(true);
  };

  /**
   * Slice 09/10/11: palette Confirm → compose at caret with params (+ optional
   * faceContext from selected face), then Auto-Run via handleGameRun.
   */
  const handleInsertHelper = (helperId, params = null, faceContext = null, edgeContext = null) => {
    const ok = codeEditorRef.current?.insertHelper?.(helperId, params, faceContext, edgeContext);
    if (ok) {
      // Defer so Monaco state + currentScript settle before execute+compare.
      setTimeout(() => {
        handleGameRun();
      }, 0);
      return;
    }
    // Soft-fail: empty selected-edge fillet/chamfer/path — clear stale chip and toast
    // without writing any JS. Face-scope / compose-null failures stay quiet.
    const isEdgeFeature = helperId === 'filletEdges' || helperId === 'chamferEdges';
    const isSweepPath = helperId === 'sweepPath';
    const scope = params?.edgeScope
      || (edgeContext && edgeContext.length ? 'selected' : null);
    if (isEdgeFeature && scope === 'selected' && !(edgeContext && edgeContext.length)) {
      viewportRef.current?.softFailStaleEdges?.(
        'No edges selected — re-pick after geometry changes, then Fillet/Chamfer.',
      );
    } else if (isSweepPath && !(edgeContext && edgeContext.length)) {
      viewportRef.current?.softFailStaleEdges?.(
        'No edges selected — re-pick a contiguous chain or loop, then Path.',
      );
    }
  };

  /**
   * Slice 24/25/26/28/30: in-mode Confirm. Profile writes makeCrossSection only
   * (no Auto-Run). Extrude / Revolve / Loft / Sweep write the solid and Auto-Run.
   */
  const handleCommitContourProfile = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeContourCommit(buf, payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailContour?.(result.message);
      return false;
    }
    const entry = payload?.entry;
    const solidLabel = entry === 'makeSweep'
      ? 'sweep'
      : entry === 'makeLoft'
        ? 'loft'
        : entry === 'makeRevolve'
          ? 'revolve'
          : 'extrude';
    const msg = entry === 'workplane'
      ? 'Workplane'
      : result.run
        ? `Contour ${solidLabel}`
        : 'Contour profile';
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, msg);
    if (!wrote) {
      const writeName = entry === 'workplane'
        ? 'Workplane'
        : entry === 'makeSweep'
          ? 'Sweep'
          : entry === 'makeLoft'
            ? 'Loft'
            : entry === 'makeRevolve'
              ? 'Revolve'
              : result.run
                ? 'Extrude'
                : 'Contour';
      viewportRef.current?.softFailContour?.(
        `Could not write ${writeName} into the editor — try again.`,
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /**
   * Slice 27: in-mode Fillet Accept. Writes makeSweepPath + filletAlongPath
   * and Auto-Runs. Second Accept replaces the same marked block.
   */
  const handleCommitFillet = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const chamfer = payload?.entry === 'chamferEdges';
    const result = chamfer
      ? composeChamferCommit(buf, payload || {})
      : composeFilletCommit(buf, payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailFillet?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(
      result.buffer,
      chamfer ? 'Chamfer mode' : 'Fillet mode',
    );
    if (!wrote) {
      viewportRef.current?.softFailFillet?.(
        `Could not write ${chamfer ? 'Chamfer' : 'Fillet'} into the editor — try again.`,
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /** Shell face-pick Confirm — hollow() + SHELL markers; Auto-Run. */
  const handleCommitShell = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeShellCommit(buf, payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailShell?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Shell');
    if (!wrote) {
      viewportRef.current?.softFailShell?.(
        'Could not write Shell into the editor — try again.',
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /** Draft face-pick Confirm — one draftFaces() + DRAFT markers; Auto-Run. */
  const handleCommitDraft = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeDraftCommit(buf, payload?.state || payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailDraft?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Draft');
    if (!wrote) {
      viewportRef.current?.softFailDraft?.(
        'Could not write Draft into the editor — try again.',
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /** Cut plane Confirm — one cut() + CUT markers; Auto-Run. */
  const handleCommitCut = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeCutCommit(buf, payload?.state || payload || {}, payload?.mesh || null);
    if (!result.ok) {
      viewportRef.current?.softFailCut?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Cut');
    if (!wrote) {
      viewportRef.current?.softFailCut?.(
        'Could not write Cut into the editor — try again.',
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /** Move body Confirm — one move() + MOVE markers; Auto-Run. */
  const handleCommitMove = (payload) => {
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeMoveCommit(buf, payload?.state || payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailMove?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Move');
    if (!wrote) {
      viewportRef.current?.softFailMove?.(
        'Could not write Move into the editor — try again.',
      );
      return false;
    }
    if (result.run) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  const handleExecute = (script, autoExecute=false) => {
    // The editor has produced a real buffer — the draft autosave may now
    // treat currentScript as authoritative (before this, '' is just "Monaco
    // has not mounted yet" and would overwrite a restored draft with nothing).
    editorLiveRef.current = true;
    setCurrentScript(script);
    // Game mode: never auto-run on Monaco mount/remount (blank-enter / ghost-only).
    if (autoExecute && appModeRef.current !== 'game') {
      // Pass script directly to avoid stale closure
      setTimeout(() => {
        viewportRef.current?.executeScript(script);
      }, 100);
    }
  };

  const handleCodeChange = (code, message = 'Code updated') => {
    setHistory(prev => {
      const branch = prev.branches[prev.currentBranch];
      const newCommit = {
        code,
        message,
        timestamp: Date.now(),
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };

      return {
        ...prev,
        branches: {
          ...prev.branches,
          [prev.currentBranch]: {
            commits: [...branch.commits.slice(0, branch.head + 1), newCommit],
            head: branch.head + 1
          }
        }
      };
    });
    
    // Log after setHistory call (outside the updater)
    console.log('[App] handleCodeChange added commit:', { message, codeLength: code?.length });
  };

  const handleCodeGenerated = (code, promptMessage) => {
    // Only add to history if a prompt message if not empty
    const addToHistory = promptMessage && promptMessage.length > 0;
    codeEditorRef.current?.loadContent(code, promptMessage || 'Code generated', addToHistory);
  };

  const handleUndo = () => {
    const branch = history.branches[history.currentBranch];

    if (branch.head > 0) {
      const newHead = branch.head - 1;
      const commit = branch.commits[newHead];
      
      console.log('[App] Undoing to commit:', {
        newHead,
        commitMessage: commit.message,
        codeLength: commit.code?.length,
      });
      
      setHistory(prev => ({
        ...prev,
        branches: {
          ...prev.branches,
          [prev.currentBranch]: {
            ...branch,
            head: newHead
          }
        }
      }));

      // Restore editor without loadContent autoExecute (CAD-only; game skips).
      // Auto-Run via handleGameRun — same path as palette insert / Confirm.
      codeEditorRef.current?.setTextOnly?.(commit.code);
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
  };

  const handleRedo = () => {
    const branch = history.branches[history.currentBranch];

    if (branch.head < branch.commits.length - 1) {
      const newHead = branch.head + 1;
      const commit = branch.commits[newHead];
      
      console.log('[App] Redoing to commit:', {
        newHead,
        commitMessage: commit.message,
        codeLength: commit.code?.length,
      });
      
      setHistory(prev => ({
        ...prev,
        branches: {
          ...prev.branches,
          [prev.currentBranch]: {
            ...branch,
            head: newHead
          }
        }
      }));

      // Restore editor without loadContent autoExecute (CAD-only; game skips).
      // Auto-Run via handleGameRun — same path as palette insert / Confirm.
      codeEditorRef.current?.setTextOnly?.(commit.code);
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
  };

  const canUndo = () => {
    const branch = history.branches[history.currentBranch];
    return branch.head > 0;
  };

  const canRedo = () => {
    const branch = history.branches[history.currentBranch];
    return branch.head < branch.commits.length - 1;
  };

  const handleFaceSelected = (faceData) => {
    setSelectedFace(faceData);
  };

  const handleClearFaceSelection = () => {
    viewportRef.current?.clearFaceSelection();
    setSelectedFace(null);
  };

  const handleOpen = async (text, filename) => {
    try {
      console.log('[APP] Handling opening script file');
      codeEditorRef.current?.loadContent(text, `Opened ${filename}`);
      setCurrentFilename(filename);
    } catch (error) {
      console.error('[App] Open error:', error);
    }
  };

  // --- Draggable editor/viewport split ---
  // Desktop: percentage width of the editor column. Mobile: an explicit editor
  // height in px that overrides the computed budget until the keyboard opens
  // (the keyboard case still wins — see mobileEditorPx).
  const splitShellRef = useRef(null);
  const handleSplitDragX = (clientX) => {
    const rect = splitShellRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplitPct(Math.min(80, Math.max(20, pct)));
  };
  const handleSplitDragY = (clientY) => {
    const rect = splitShellRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const px = rect.bottom - clientY;
    setMobileEditorPx(Math.min(Math.max(px, 120), Math.max(160, rect.height - 160)));
  };

  /** CAD strip Select all — the button is in the strip, the editor is here. */
  const handleSelectAll = () => {
    codeEditorRef.current?.selectAll?.();
  };

  // Rename from the viewport title chip. Only app state — the name is read by
  // save/export and by the OAuth-redirect snapshot, so nothing else to write.
  const handleRenameFile = (name) => {
    const next = String(name || '').trim();
    if (next) setCurrentFilename(next);
  };

  const handleSave = () => {
    try {
      const code = codeEditorRef.current?.getContent();
      if (!code) return;
      
      const filename = currentFilename || 'model';
      const blob = new Blob([code], { type: 'text/javascript' });
      saveAs(blob, `${filename}.js`);
    } catch (error) {
      console.error('[App] Save error:', error);
    }
  };

  // Handle account button click
  const handleAccount = () => {
    if (isAuthenticated) {
      setAccountModalTab('info');
      setShowAccountModal(true);
    } else {
      setShowLoginModal(true);
    }
  };

  // Handle account modal from order flow
  const handleOpenAccount = (tab = 'info') => {
    setAccountModalTab(tab);
    setShowAccountModal(true);
  };

  // Handle login modal completion
  const handleLoginComplete = async () => {
    setShowLoginModal(false);
    await checkAuth();
  };

  // Handle quote button click
  const handleQuote = () => {
    setShowQuoteModal(true);
  };

  // Handle quote modal close
  const handleQuoteClose = () => {
    setShowQuoteModal(false);
  };

  // Handle get quote button
  const handleGetQuote = async (options) => {
    return await viewportRef.current?.calculateQuote(options);
  };

  // Handle start order
  const handleStartOrder = (quoteData, modelData) => {
    setShowQuoteModal(false);
    setOrderData({ quoteData, modelData });
    setShowOrderModal(true);
  };

  // Handle order modal close
  const handleOrderClose = () => {
    setShowOrderModal(false);
    setOrderData(null);
  };

  // Model import handler function
  const handleImport = async (file) => {
    if (!manifoldReady) {
      setUploadError('Manifold not ready. Please wait...');
      return;
    }
    
    setIsUploading(true);
    setUploadError(null);
    
    const filename = file.name;
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    
    try {
      console.log(`[App] Importing ${ext} file...`);
      
      // Unified import handles routing to frontend (STL/OBJ/3MF) or backend (STEP)
      const result = await importFile(file);
      
      // Load the generated script into the editor
      codeEditorRef.current?.loadContent(result.script, `Imported ${result.filename}`);
      
      // Set filename (without extension for display)
      setCurrentFilename(result.filename.replace(/\.[^/.]+$/, ''));
      
    } catch (error) {
      console.error('[App] Import error:', error);
      setUploadError(error.message || 'Failed to import file');
    } finally {
      setIsUploading(false);
    }
  };

  // Show error state if initialization failed
  if (initError) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center max-w-md p-6">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold mb-2">Initialization Failed</h1>
          <p className="text-gray-400 mb-4">{initError}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show loading state while Manifold initializes
  if (!manifoldReady || editorInitialScript === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // Phone shell:
  //  - CAD (Slice Mobile A): dual stage — CAD = fullscreen viewport+rails,
  //    Script = fullscreen editor+toolbar. No cramped Monaco strip.
  //  - Game: still viewport-on-top + Monaco bottom budget (unchanged).
  // Keyboard open pins the shell to visualViewport (slice 05).
  const keyboardOverlap = Math.max(0, vv.layoutHeight - vv.height - vv.offsetTop);
  const keyboardOpen = keyboardOverlap > 80;
  const mobileEditorPx = keyboardOpen
    ? Math.round(Math.min(Math.max(vv.height * 0.36, 120), vv.height * 0.42))
    : (mobileEditorPxOverride != null
      // A dragged height wins over the default budget, but never so far that
      // the viewport or the editor collapses.
      ? Math.round(Math.min(Math.max(mobileEditorPxOverride, 120), Math.max(160, vv.height - 160)))
      : Math.round(Math.min(Math.max(vv.height * 0.32, 160), vv.height * 0.38)));

  if (isMobile) {
    // Keep h-dvh while the keyboard is closed so Monaco can take a real
    // user-gesture focus (iOS often refuses keyboard inside a fixed+overflow
    // shell). Once open, pin to visualViewport so the editor stays visible.
    const mobileShellStyle = keyboardOpen
      ? {
          height: vv.height,
          top: vv.offsetTop,
          left: 0,
          right: 0,
          position: 'fixed',
        }
      : undefined;

    // Stages apply to mobile CAD only. Game keeps the stacked split.
    const useStages = appMode === 'cad';
    const isCadStage = !useStages || mobileStage === 'cad';
    const isScriptStage = useStages && mobileStage === 'script';

    const viewportEl = (
            <Viewport 
              ref={viewportRef} 
              onAccount={handleAccount}
              currentScript={currentScript}
              onFaceSelected={handleFaceSelected}
              onOpen={handleOpen}
              onSave={handleSave}
              onQuote={handleQuote}
              onUpload={handleImport}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={canUndo()}
              canRedo={canRedo()}
              currentFilename={currentFilename}
              onRenameFile={handleRenameFile}
              onSelectAll={handleSelectAll}
              isUploading={isUploading || gameLoading}
              mode={appMode}
              ghostMeshData={ghostMeshData}
              onStartGame={handleStartGame}
              onExitGame={handleExitGame}
              onRun={handleGameRun}
              onHint={handleGameHint}
              onPickPuzzle={handlePickPuzzle}
              gameElapsedMs={gameElapsedMs}
              gameSuccess={gameSuccess}
              gamePuzzleTitle={currentPuzzle?.title}
              gameBestTimeMs={gameBestTimeMs}
              isMobile={isMobile}
              onInsertHelper={handleInsertHelper}
              onCommitContourProfile={handleCommitContourProfile}
              onCommitFillet={handleCommitFillet}
              onCommitShell={handleCommitShell}
              onCommitDraft={handleCommitDraft}
              onCommitCut={handleCommitCut}
              onCommitMove={handleCommitMove}
              getHelperBuffer={() => codeEditorRef.current?.getContent?.() || ''}
              cadToolbarHost={cadToolbarHost}
              featureSheetEnabled={useStages && isCadStage && !featureSheet}
              onFeatureLongPress={openFeatureSheetFromCad}
            />
    );

    const editorEl = (
                <CodeEditor
                  key={appMode}
                  ref={codeEditorRef}
                  initialScript={appMode === 'game' ? '' : editorInitialScript}
                  onExecute={handleExecute}
                  onCodeChange={handleCodeChange}
                  isMobile={isMobile}
                  mode={appMode}
                  onExitGame={handleExitGame}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  canUndo={canUndo()}
                  canRedo={canRedo()}
                  isExecuting={gameRunBusy}
                  onRun={handleGameRun}
                  onHint={handleGameHint}
                  onPickPuzzle={handlePickPuzzle}
                  gameElapsedMs={gameElapsedMs}
                  gameSuccess={gameSuccess}
                  gameBestTimeMs={gameBestTimeMs}
                  onCadToolbarHost={setCadToolbarHost}
                  monacoEndPadClassName={isScriptStage ? 'pr-11' : ''}
                />
    );

    const aiRow = appMode !== 'game' && (
              <div className="hidden" data-ai-prompt-row="hidden">
                <PromptInput
                  onCodeGenerated={handleCodeGenerated}
                  currentCode={codeEditorRef.current?.getContent() || ''}
                  selectedFace={selectedFace}
                  onClearFaceSelection={handleClearFaceSelection}
                  isMobile={isMobile}
                />
              </div>
    );

    return (
        <div
          ref={splitShellRef}
          className={`relative flex flex-col bg-gray-900 overflow-hidden ${keyboardOpen ? '' : 'h-dvh'}`}
          style={mobileShellStyle}
          data-mobile-stage={useStages ? mobileStage : undefined}
        >
          {useStages ? (
            /* CAD dual-stage: both panes stay mounted (WebGL + Monaco + refs).
               Off-stage pane is invisibly full-size so contexts survive.
               Stage toggle is the bottom home-indicator pill (Slice Mobile B). */
            <div className="relative flex-1 min-h-0">
              <div
                className={`absolute inset-0 overflow-hidden ${
                  isCadStage ? '' : 'invisible pointer-events-none'
                }`}
                data-stage-pane="cad"
                aria-hidden={!isCadStage}
              >
                {viewportEl}
                {/* Slice Mobile C.2: CAD feature strip HORIZONTAL under top ribbon. */}
                {isCadStage && (
                  <div
                    className="absolute left-2 right-2 top-20 z-20 pointer-events-auto flex justify-center"
                    data-cad-feature-strip=""
                    data-feature-strip-placement="under-ribbon-horizontal"
                    data-feature-strip-gap="name-2x"
                  >
                    <FeatureStrip
                      orientation="horizontal"
                      script={currentScript}
                      activeId={featureSheet?.feature?.id || featureStripActiveId}
                      hideWhenEmpty
                      onJump={(f) => openFeatureSheetFor(f)}
                    />
                  </div>
                )}
              </div>
              <div
                className={`absolute inset-0 flex flex-col min-h-0 ${
                  isScriptStage ? 'z-10' : 'invisible pointer-events-none'
                }`}
                data-stage-pane="script"
                aria-hidden={!isScriptStage}
              >
                {/* Script ribbon is full viewport width: editor stack is
                    absolute inset-0 so [data-editor-ribbon] spans the pane.
                    Vertical feature strip overlays on the right, starting
                    BELOW the measured ribbon (no side-by-side shrink). Monaco
                    keeps a w-11 end gutter so chips don't cover code. */}
                <div className="relative flex-1 min-h-0" data-script-stage-body="">
                  <div
                    className="absolute inset-0 z-10 overflow-hidden"
                    data-script-editor-stack=""
                  >
                    <div className="absolute inset-0">
                      {editorEl}
                    </div>
                  </div>
                  {isScriptStage && (
                    <div
                      className="absolute right-0 bottom-0 z-20 flex flex-col pointer-events-none"
                      style={{ top: ribbonPx }}
                      data-script-feature-strip=""
                      data-feature-strip-below-ribbon=""
                      data-feature-strip-ribbon-spacer-h="measured"
                    >
                      <div className="pointer-events-auto flex-1 min-h-0 flex flex-col">
                        <FeatureStrip
                          orientation="vertical"
                          script={currentScript}
                          activeId={featureSheet?.feature?.id || featureStripActiveId}
                          onJump={handleFeatureStripJump}
                        />
                      </div>
                    </div>
                  )}
                </div>
                {aiRow}
              </div>

              {/* C.1: feature sheets — full-width under-title, CAD + Script stages. */}
              {featureSheet?.mode === 'picker' && (
                <FeatureSheet
                  features={listFeatureSheetTargets(currentScript)}
                  script={currentScript}
                  onCancel={closeFeatureSheet}
                  onPickFeature={(f) => openFeatureSheetFor(f)}
                />
              )}
              {featureSheet?.mode === 'edit' && featureSheet.feature && (
                <FeatureSheet
                  feature={featureSheet.feature}
                  script={currentScript}
                  onAccept={handleFeatureSheetAccept}
                  onCancel={closeFeatureSheet}
                  onDelete={handleFeatureSheetDelete}
                  onEditScript={handleFeatureSheetEditScript}
                />
              )}

              {/* Bottom home-indicator stage pill — clears Contour/Fillet chips via their raised mobile bottom. */}
              <div
                className="absolute left-1/2 -translate-x-1/2 z-30"
                style={{ bottom: 0 }}
                data-mobile-stage-home-indicator=""
              >
                <MobileStageToggle stage={mobileStage} onChange={setMobileStageSticky} />
              </div>
            </div>
          ) : (
            /* Game (and any non-staged mobile): viewport TOP, Monaco BOTTOM. */
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                {viewportEl}
              </div>
              <SplitDivider orientation="horizontal" onDrag={(x, y) => handleSplitDragY(y)} />
              <div
                className="flex-shrink-0 flex flex-col min-h-0"
                style={{ height: mobileEditorPx }}
              >
                <div className="relative flex-1 min-h-0">
                  <div className="absolute inset-0">
                    {editorEl}
                  </div>
                </div>
                {aiRow}
              </div>
            </>
          )}

          {/* Login Modal */}
          {showLoginModal && (
            <LoginModal
              onClose={() => setShowLoginModal(false)}
              onComplete={handleLoginComplete}
              currentScript={currentScript}
              currentFilename={currentFilename}
            />
          )}
          
          {/* Account Modal */}
          {showAccountModal && (
            <AccountModal
              onClose={() => setShowAccountModal(false)}
              user={user}
              selectedTab={accountModalTab}
            />
          )}
          
          {/* Quote Modal */}
          {showQuoteModal && (
            <QuoteModal
              onClose={handleQuoteClose}
              onGetQuote={handleGetQuote}
              onOrder={handleStartOrder}
              currentScript={currentScript}
              currentFilename={currentFilename}
            />
          )}
          
          {/* Order Modal */}
          {showOrderModal && orderData && (
            <OrderModal
              onClose={handleOrderClose}
              quoteData={orderData.quoteData}
              modelData={orderData.modelData}
              currentScript={currentScript}
              restoredStep={orderData.restoredStep}
              restoredAddress={orderData.restoredAddress}
              restoredGuestEmail={orderData.restoredGuestEmail}
              onOpenAccount={handleAccount}
            />
          )}
          

          {showPuzzlePicker && (
            <PuzzlePickerModal
              onClose={() => setShowPuzzlePicker(false)}
              onSelect={loadPuzzle}
              currentPuzzleId={appMode === 'game' ? currentPuzzle?.id : null}
              loading={gameLoading}
            />
          )}
          {showHints && (
            <GameHintsModal
              onClose={() => setShowHints(false)}
              puzzle={currentPuzzle}
            />
          )}
          {showConfetti && <GameConfetti durationMs={SUCCESS_CLEAR_MS} />}
          {gameError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md">
              <ErrorPopup
                tone="banner"
                onDismiss={() => setGameError(null)}
                onUndo={handleUndo}
                canUndo={canUndo()}
                className="px-4 py-2"
              >
                {gameError}
              </ErrorPopup>
            </div>
          )}
          {uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md">
              <ErrorPopup
                tone="banner"
                onDismiss={() => setUploadError(null)}
                onUndo={handleUndo}
                canUndo={canUndo()}
                className="px-4 py-2"
              >
                Upload Error: {uploadError}
              </ErrorPopup>
            </div>
          )}
        </div>
    );
  }

  return (
      <div ref={splitShellRef} className="flex h-dvh bg-gray-900">
        <div className="flex flex-col min-w-0" style={{ width: `${splitPct}%` }}>
          <div className="flex-1 min-h-0">
            <CodeEditor 
              ref={codeEditorRef}
              initialScript={editorInitialScript}
              onExecute={handleExecute}
              onCodeChange={handleCodeChange}
              isMobile={isMobile}
              mode={appMode}
              onExitGame={handleExitGame}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={canUndo()}
              canRedo={canRedo()}
              isExecuting={gameRunBusy}
              onRun={handleGameRun}
              onHint={handleGameHint}
              onPickPuzzle={handlePickPuzzle}
              gameElapsedMs={gameElapsedMs}
              gameSuccess={gameSuccess}
              gameBestTimeMs={gameBestTimeMs}
              onCadToolbarHost={setCadToolbarHost}
            />
          </div>
          {/* AI prompt row is HIDDEN, not removed: it stays mounted (and keeps
              its state and handlers) while we design a tighter integration
              into the editor itself. Drop the `hidden` to bring it back. */}
          {appMode !== 'game' && (
            <div className="flex-shrink-0 hidden" data-ai-prompt-row="hidden">
              <PromptInput 
                onCodeGenerated={handleCodeGenerated}
                currentCode={codeEditorRef.current?.getContent() || ''}
                selectedFace={selectedFace}
                onClearFaceSelection={handleClearFaceSelection}
                isMobile={false}
              />
            </div>
          )}
        </div>
        {/* Desktop feature strip: vertical chips in the seam, starting BELOW the
            measured editor ribbon (same spacer pattern as mobile Script stage). */}
        {appMode !== 'game' && (
          <div
            className="shrink-0 flex flex-col self-stretch h-full min-h-0"
            data-desktop-feature-strip=""
            data-feature-strip-placement="desktop-seam"
            data-feature-strip-below-ribbon=""
          >
            <div
              className="shrink-0 w-full"
              style={{ height: ribbonPx }}
              data-feature-strip-ribbon-spacer=""
              data-feature-strip-ribbon-spacer-h="measured"
              aria-hidden="true"
            />
            <div className="flex-1 min-h-0 flex flex-col">
              <FeatureStrip
                orientation="vertical"
                side="between"
                script={currentScript}
                activeId={featureStripActiveId}
                onJump={handleDesktopFeatureStripJump}
              />
            </div>
          </div>
        )}
        <SplitDivider orientation="vertical" onDrag={(x) => handleSplitDragX(x)} />
        <div className="relative flex-1 min-w-0">
          <Viewport 
            ref={viewportRef} 
            onAccount={handleAccount}
            currentScript={currentScript}
            onFaceSelected={handleFaceSelected}
            onOpen={handleOpen}
            onSave={handleSave}
            onQuote={handleQuote}
            onUpload={handleImport}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo()}
            canRedo={canRedo()}
            currentFilename={currentFilename}
            onRenameFile={handleRenameFile}
            onSelectAll={handleSelectAll}
            isUploading={isUploading || gameLoading}
            mode={appMode}
            ghostMeshData={ghostMeshData}
            onStartGame={handleStartGame}
            onExitGame={handleExitGame}
            onRun={handleGameRun}
            onHint={handleGameHint}
            onPickPuzzle={handlePickPuzzle}
            gameElapsedMs={gameElapsedMs}
            gameSuccess={gameSuccess}
            gamePuzzleTitle={currentPuzzle?.title}
            gameBestTimeMs={gameBestTimeMs}
            isMobile={false}
            onInsertHelper={handleInsertHelper}
            onCommitContourProfile={handleCommitContourProfile}
            onCommitFillet={handleCommitFillet}
              onCommitShell={handleCommitShell}
              onCommitDraft={handleCommitDraft}
              onCommitCut={handleCommitCut}
              onCommitMove={handleCommitMove}
            getHelperBuffer={() => codeEditorRef.current?.getContent?.() || ''}
            cadToolbarHost={cadToolbarHost}
          />
          {/* Feature sheets live INSIDE the viewer on desktop: the seam strip
              stays put, and editing a feature happens over the model it
              changes rather than over the script. */}
          {appMode !== 'game' && featureSheet?.mode === 'edit' && featureSheet.feature && (
            <FeatureSheet
              placement="viewport"
              feature={featureSheet.feature}
              script={currentScript}
              onAccept={handleFeatureSheetAccept}
              onCancel={closeFeatureSheet}
              onDelete={handleFeatureSheetDelete}
              onEditScript={handleDesktopFeatureSheetEditScript}
            />
          )}
        </div>

        {/* Login Modal */}
        {showLoginModal && (
          <LoginModal
            onClose={() => setShowLoginModal(false)}
            onComplete={handleLoginComplete}
            currentScript={currentScript}
            currentFilename={currentFilename}
          />
        )}
        
        {/* Account Modal */}
        {showAccountModal && (
          <AccountModal
            onClose={() => setShowAccountModal(false)}
            user={user}
            selectedTab={accountModalTab}
          />
        )}
        
        {/* Quote Modal */}
        {showQuoteModal && (
          <QuoteModal
            onClose={handleQuoteClose}
            onGetQuote={handleGetQuote}
            onOrder={handleStartOrder}
            currentScript={currentScript}
            currentFilename={currentFilename}
          />
        )}
        
        {/* Order Modal */}
        {showOrderModal && orderData && (
          <OrderModal
            onClose={handleOrderClose}
            quoteData={orderData.quoteData}
            modelData={orderData.modelData}
            currentScript={currentScript}
            restoredStep={orderData.restoredStep}
            restoredAddress={orderData.restoredAddress}
            restoredGuestEmail={orderData.restoredGuestEmail}
            onOpenAccount={handleOpenAccount}
          />
        )}
        

          {showPuzzlePicker && (
            <PuzzlePickerModal
              onClose={() => setShowPuzzlePicker(false)}
              onSelect={loadPuzzle}
              currentPuzzleId={appMode === 'game' ? currentPuzzle?.id : null}
              loading={gameLoading}
            />
          )}
          {showHints && (
            <GameHintsModal
              onClose={() => setShowHints(false)}
              puzzle={currentPuzzle}
            />
          )}
          {showConfetti && <GameConfetti durationMs={SUCCESS_CLEAR_MS} />}
        {gameError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md">
              <ErrorPopup
                tone="banner"
                onDismiss={() => setGameError(null)}
                onUndo={handleUndo}
                canUndo={canUndo()}
                className="px-4 py-2"
              >
                {gameError}
              </ErrorPopup>
            </div>
          )}
        {uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md">
              <ErrorPopup
                tone="banner"
                onDismiss={() => setUploadError(null)}
                onUndo={handleUndo}
                canUndo={canUndo()}
                className="px-4 py-2"
              >
                Upload Error: {uploadError}
              </ErrorPopup>
            </div>
          )}
      </div>
  );
};

export default App;
