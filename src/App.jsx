import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';
import PromptInput from './components/PromptInput';
import SplitDivider from './components/SplitDivider';
import MobileStageToggle from './components/MobileStageToggle';
import FeatureStrip from './components/FeatureStrip';
import { failedFeatureFromOutcome, failedFeatureIds } from './utils/featureFailure';
import { failedPartIdsFor } from './utils/failedPartOutline';
import { bodyCountOfWorkerMesh } from './utils/meshBodyComponents';
import ErrorPopup from './components/ErrorPopup';
import FeatureSheet from './components/FeatureSheet';
import {
  writeFeatureSheetParams,
  deleteFeatureBlock,
  listFeatureSheetTargets,
  pickDefaultFeatureSheetTarget,
  isFeatureSheetEditable,
  liveSheetFeature,
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
import {
  assemblyName,
  assemblyNameForLoad,
  composeViewportParts,
  dropPartRecord,
  feedRows,
  newLocalPartId,
  normalizeRepoPath,
  parseAssemblyDocument,
  partPosition,
  removePart,
  renamePart,
  renameTargetId,
  reorderParts,
  sanitizeAssemblyName,
  scriptForRow,
  serializeAssembly,
  setPartVisible,
} from './utils/assembly';
import {
  historyForPart,
  pushPartHistory,
  redoPartHistory,
  undoPartHistory,
} from './utils/partHistory';
import { runAssemblyParts } from './utils/assemblyRun';
import { featureWriteTarget, leftoverPickSolids, shouldSyncScript } from './utils/pickRetarget';
import {
  deletePartScript,
  loadAssemblyDocument,
  loadPartScripts,
  saveAssemblyDocument,
  savePartScript,
} from './utils/assemblyStore';
import {
  createMockGithubAdapter,
  findOrCreateVault,
  dirtyPartIds,
  isWorkspaceDirty,
  listVaultAssemblies,
  listAddableVaultParts,
  openVaultAssembly,
  readVaultPart,
  resolveNewPartPath,
  suggestNewPartPath,
  partPathAllowedFor,
  vaultSegment,
  assemblyFilePath,
  commitWorkspace,
  forceMergeCommit,
  forceMergeWarning,
  firstCommitBaseline,
  checkRemoteBehind,
  behindToastMessage,
  remainingBehindMarkers,
  reloadFromRemote,
  advanceBaselineHead,
  checkInMineToBranch,
  listVaultBranches,
  switchVaultBranch,
} from './utils/git';
import PartFeed from './components/PartFeed';
import manifoldContext from './utils/ManifoldWorker';
import DEFAULT_SCRIPT from './utils/defaultScript';
import { newPartStarterScript } from './utils/helperPaletteSnippets';
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
import {
  composeFilletCommit,
  composeChamferCommit,
  hasFilletModeBlock,
  hasChamferModeBlock,
} from './utils/filletMode';
import { composeMultiPartEdgeCommit } from './utils/multiPartEdges';
import { composeShellCommit } from './utils/shellMode';
import { composeDraftCommit } from './utils/draftMode';
import { composeCutCommit } from './utils/cutMode';
import { composeBooleanCommit, validateBooleanAccept } from './utils/booleanMode';
import { planCrossPartSubtract, crossPartSubtractWrites } from './utils/externalCopy';
import { FEATURE_MARKER_KINDS } from './utils/featureMarkers';
import { composeMoveCommit } from './utils/moveMode';
import { composeMoveFaceCommit } from './utils/moveFaceMode';
import { composeDeleteFaceCommit } from './utils/deleteFaceMode';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const [currentFilename, setCurrentFilename] = useState(null);
  /** Assembly list. Scripts live beside it, never inside the document. */
  const [assemblyDoc, setAssemblyDoc] = useState(null);
  const [partScripts, setPartScripts] = useState({});
  const [partRuns, setPartRuns] = useState({});
  const assemblyRef = useRef(null);
  const partScriptsRef = useRef({});
  const partRunsRef = useRef({});
  /** Git mode: mock adapter + vault handle + dirty baseline (G2) + Commit (G3). */
  const gitAdapterRef = useRef(null);
  const gitVaultRef = useRef(null);
  const [gitBaseline, setGitBaseline] = useState(null);
  const gitBaselineRef = useRef(null);
  /** G4: last remote-behind check + paths the user already resolved. */
  const [gitBehind, setGitBehind] = useState(null); // checkRemoteBehind result | null
  const gitBehindRef = useRef(null);
  const [gitBehindResolved, setGitBehindResolved] = useState([]); // path strings
  const gitBehindResolvedRef = useRef([]);
  const [gitBehindToast, setGitBehindToast] = useState(null); // { message, behindBy } | null
  const gitCheckGenRef = useRef(0);
  /** Last successful mesh per part. A failed row can still be picked from this. */
  const partLeftoversRef = useRef({});
  /** CAD pick target. Monaco stays on assembly.activeId until a sync. */
  const cadPartIdRef = useRef(null);
  const [cadPartId, setCadPartId] = useState(null);
  const featureSessionRef = useRef(false);
  const [featureSession, setFeatureSession] = useState(false);
  const syncCadScriptRef = useRef(() => {});
  /** focusWritePart, for handlers declared above it. */
  const focusWritePartRef = useRef(() => true);
  /** Bumped when the active part changes out from under a pending autosave. */
  const partSaveEpochRef = useRef(0);
  const refreshGenRef = useRef(0);
  const refreshAssemblyRef = useRef(async () => false);
  /** Missing-row placeholder must not become that part's stored script. */
  const suppressPartSaveRef = useRef(false);
  /** Editor column width % (desktop) and editor height px (mobile, null = auto). */
  const [splitPct, setSplitPct] = useState(50);
  const [mobileEditorPxOverride, setMobileEditorPx] = useState(null);
  /** Mobile CAD only: 'cad' (viewport+rails) vs 'script' (fullscreen editor). Session-sticky. */
  const [mobileStage, setMobileStage] = useState(() => {
    try {
      const s = sessionStorage.getItem('3dculos.mobileStage');
      if (s === 'parts') return 'parts';
      return s === 'script' ? 'script' : 'cad';
    } catch {
      return 'cad';
    }
  });
  const setMobileStageSticky = (stage) => {
    const next = stage === 'parts' ? 'parts' : stage === 'script' ? 'script' : 'cad';
    setMobileStage(next);
    try { sessionStorage.setItem('3dculos.mobileStage', next); } catch { /* private mode */ }
    if (shouldSyncScript({ surface: next })) syncCadScriptRef.current();
  };
  /** Script-stage feature strip: which chip is selected (null = none). */
  const [featureStripActiveId, setFeatureStripActiveId] = useState(null);
  /**
   * Feature block the last viewport run failed in ({ id, kind, typeIndex,
   * block }), or null. The strip draws that chip with a red border while its
   * block text is unchanged; the next good run clears it.
   */
  const [runFailure, setRunFailure] = useState(null);
  const handleRunOutcome = ({ script, ok, scriptLine, featureId, featureBlock } = {}) => {
    // Tracked block first (works on Safari), the stack's line second.
    const next = ok ? null : failedFeatureFromOutcome(script, { featureId, featureBlock, scriptLine });
    setRunFailure((prev) => (
      (prev?.id ?? null) === (next?.id ?? null) && (prev?.block ?? null) === (next?.block ?? null) ? prev : next
    ));
  };
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
    // Chips are the picked part's features; jump in that part's buffer.
    focusWritePartRef.current(null);
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
    focusWritePartRef.current(null);
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
    // The sheet reads and writes the editor buffer: make it the picked part's.
    focusWritePartRef.current(null);
    setFeatureStripActiveId(feature.id);
    setFeatureSheet({ mode: 'edit', feature });
  };
  const openFeatureSheetFromCad = () => {
    focusWritePartRef.current(null);
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
  const STALE_FEATURE_MSG = 'That feature is not in this part\'s script any more — pick it again.';
  const handleFeatureSheetAccept = (feature, params) => {
    if (!feature) return;
    focusWritePartRef.current(null);
    const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
    // Re-parse markers against live buffer so offsets stay valid after prior edits.
    // Only a block of this kind in THIS buffer. The stale chip's own offsets
    // (another part's script) used to fall through here: "invalid range".
    const live = liveSheetFeature(buf, feature);
    if (!live) {
      viewportRef.current?.softFailContour?.(STALE_FEATURE_MSG);
      return;
    }
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
    focusWritePartRef.current(null);
    const buf = codeEditorRef.current?.getContent?.() || currentScript || '';
    // Only a block of this kind in THIS buffer. The stale chip's own offsets
    // (another part's script) used to fall through here: "invalid range".
    const live = liveSheetFeature(buf, feature);
    if (!live) {
      viewportRef.current?.softFailContour?.(STALE_FEATURE_MSG);
      return;
    }
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
      // The Script stage loaded the picked part; reveal the block as it is there.
      const live = liveSheetFeature(buf, feature);
      if (live) codeEditorRef.current?.revealRange?.(live.startOffset, live.endOffset);
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
  /** One undo stack per part id. Game uses its own key. */
  const partHistoriesRef = useRef({});
  const historyRef = useRef(history);
  historyRef.current = history;

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
    
      // Assembly wraps the editor buffer. The document stores ids only.
      // The buffer we just restored is the active part's script.
      let doc = null;
      let scripts = {};
      try {
        doc = await loadAssemblyDocument();
        if (doc) scripts = await loadPartScripts(doc.parts.map((part) => part.id));
      } catch (err) {
        console.warn('[App] Assembly restore failed:', err);
        doc = null;
      }
      if (cancelled) return;
      if (!doc || !doc.parts.length) {
        const id = newLocalPartId();
        doc = serializeAssembly({
          source: 'local',
          activeId: id,
          parts: [{ id, name: filename || 'Part 1', visible: true, order: 0 }],
        });
        scripts = { [id]: script };
        await savePartScript(id, script);
        await saveAssemblyDocument(doc);
      } else {
        const active = doc.parts.find((part) => part.id === doc.activeId) || doc.parts[0];
        doc = serializeAssembly({ ...doc, activeId: active.id });
        if (typeof scripts[active.id] === 'string' && !restoredEditor) {
          script = scripts[active.id];
          filename = filename || active.name;
        } else {
          scripts = { ...scripts, [active.id]: script };
          await savePartScript(active.id, script);
        }
        if (!filename) filename = active.name;
      }
      if (cancelled) return;
      assemblyRef.current = doc;
      partScriptsRef.current = scripts;
      setAssemblyDoc(doc);
      setPartScripts(scripts);

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
    const epoch = partSaveEpochRef.current;
    const timer = setTimeout(() => {
      if (epoch !== partSaveEpochRef.current) return;
      saveEditorDraft({ script: currentScript, filename: currentFilename });
      const id = assemblyRef.current?.activeId;
      if (id && !suppressPartSaveRef.current && typeof currentScript === 'string') {
        const next = { ...partScriptsRef.current, [id]: currentScript };
        partScriptsRef.current = next;
        setPartScripts(next);
        savePartScript(id, currentScript);
      }
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
      const id = assemblyRef.current?.activeId;
      if (id && !suppressPartSaveRef.current && typeof live === 'string') {
        partScriptsRef.current = { ...partScriptsRef.current, [id]: live };
        savePartScript(id, live);
      }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [currentScript, currentFilename, manifoldReady, editorInitialScript]);

  // Leaving a puzzle puts the assembly back in the viewport. appModeRef is
  // still 'game' during the exit click, so the editor's auto-run skips it.
  const prevAppModeRef = useRef(appMode);
  useEffect(() => {
    const prev = prevAppModeRef.current;
    prevAppModeRef.current = appMode;
    if (prev === 'game' && appMode === 'cad' && assemblyRef.current) {
      const code = codeEditorRef.current?.getContent?.();
      refreshAssemblyRef.current?.(code);
    }
  }, [appMode]);

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

  const rememberScripts = (next) => {
    partScriptsRef.current = next;
    setPartScripts(next);
  };

  const commitPartRuns = (runs) => {
    partRunsRef.current = runs || {};
    setPartRuns(partRunsRef.current);
  };

  const rememberAssembly = (doc) => {
    const clean = serializeAssembly(doc);
    assemblyRef.current = clean;
    setAssemblyDoc(clean);
    saveAssemblyDocument(clean);
    return clean;
  };

  const historyKey = () => {
    if (appModeRef.current === 'game') return '__game__';
    const id = assemblyRef.current?.activeId;
    return id ? String(id) : '__cad__';
  };

  const applyPartHistory = (entry) => {
    const state = {
      branches: { main: { commits: entry.commits, head: entry.head } },
      currentBranch: 'main',
    };
    historyRef.current = state;
    setHistory(state);
  };

  const focusPartHistory = (partId, script) => {
    if (appModeRef.current === 'game') return;
    const key = partId ? String(partId) : '__cad__';
    const next = historyForPart(partHistoriesRef.current, key, script ?? '');
    partHistoriesRef.current[key] = next;
    applyPartHistory(next);
  };

  const dropPartHistory = (partId) => {
    if (partId == null) return;
    delete partHistoriesRef.current[String(partId)];
  };

  // The editor buffer is this part's latest script. Keep it on that part's
  // stack before the active id changes, so a later Undo cannot see another part.
  const stashPartHistory = (partId, script) => {
    if (appModeRef.current === 'game' || partId == null || typeof script !== 'string') return;
    const key = String(partId);
    partHistoriesRef.current[key] = pushPartHistory(
      historyForPart(partHistoriesRef.current, key, script),
      script,
      'Part',
    );
  };

  /**
   * Run every visible part. The active part goes through executeScript so
   * face and edge graphs still rebuild on that solid alone. A failed active
   * part passes noShadow and is omitted. Other parts are meshes beside it.
   */
  const refreshAssembly = async (activeScript, opts = {}) => {
    const doc = assemblyRef.current;
    if (!doc || appModeRef.current === 'game') return false;
    const persistActive = opts.persistActive !== false && !suppressPartSaveRef.current;
    let scripts = { ...partScriptsRef.current };
    const activeId = doc.activeId;
    const wanted = cadPartIdRef.current;
    const viewId = wanted && doc.parts.some((part) => part.id === wanted) ? wanted : activeId;
    if (typeof activeScript === 'string' && activeId && persistActive) {
      scripts = { ...scripts, [activeId]: activeScript };
      rememberScripts(scripts);
      savePartScript(activeId, activeScript);
    }
    const gen = ++refreshGenRef.current;
    const activePart = doc.parts.find((part) => part.id === viewId);
    const activeVisible = !!(activePart && activePart.visible !== false);
    const otherIds = doc.parts
      .filter((part) => part.visible !== false && part.id !== viewId)
      .map((part) => part.id);
    let other;
    try {
      other = await runAssemblyParts({
        doc,
        scripts,
        ids: otherIds,
        execute: (script) => manifoldContext.executeScript(script, { timeoutMs: 30000 }),
      });
    } catch (err) {
      console.error('[App] assembly run failed', err);
      return false;
    }
    if (gen !== refreshGenRef.current) return false;

    const runs = { ...(other.runs || {}) };
    if (viewId && activeVisible && typeof scripts[viewId] === 'string') {
      const runOpts = { noShadow: true, preservePicks: opts.preservePicks === true };
      let run = await viewportRef.current?.executeScript(scripts[viewId], runOpts);
      if (run == null || run === false) {
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        if (gen !== refreshGenRef.current) return false;
        run = await viewportRef.current?.executeScript(scripts[viewId], runOpts);
      }
      if (gen !== refreshGenRef.current) return false;
      if (run?.cleared) {
        runs[viewId] = { ok: false, mesh: null, empty: true, error: null };
      } else if (run?.ok && run.mesh?.vertProperties) {
        const bodyCount = Number.isFinite(run.bodyCount)
          ? run.bodyCount
          : (Array.isArray(run.bodyCentroids) ? run.bodyCentroids.length : undefined);
        runs[viewId] = { ok: true, mesh: run.mesh, error: null, bodyCount };
      } else if (run && run.ok === false) {
        runs[viewId] = { ok: false, mesh: null, error: run.error || 'Script failed' };
        manifoldContext.clearResult().catch(() => {});
      }
    } else if (viewId) {
      runs[viewId] = {
        ok: false,
        mesh: null,
        skipped: !activeVisible,
        missing: typeof scripts[viewId] !== 'string',
        error: typeof scripts[viewId] === 'string' ? null : 'missing',
      };
    }

    if (gen !== refreshGenRef.current) return false;
    for (const [id, run] of Object.entries(runs)) {
      if (run?.ok && run.mesh?.vertProperties) partLeftoversRef.current[id] = run.mesh;
    }
    commitPartRuns(runs);
    const solids = composeViewportParts(doc, runs);
    const leftovers = leftoverPickSolids(doc, runs, partLeftoversRef.current);
    const activeOk = !!(viewId && runs[viewId]?.ok === true && activeVisible);
    viewportRef.current?.placeAssembly?.({
      solids,
      leftovers,
      activeId: viewId,
      blankActive: !activeOk,
      // Red outline in the viewer, same rule as the Parts feed's red row.
      failedIds: failedPartIdsFor(doc, runs),
    });
    return true;
  };
  refreshAssemblyRef.current = refreshAssembly;

  const rememberCadPart = (id) => {
    const next = id || null;
    cadPartIdRef.current = next;
    setCadPartId(next);
  };

  const meshForPart = (id) => {
    const run = partRunsRef.current?.[id];
    if (run?.ok && run.mesh?.vertProperties) return run.mesh;
    const leftover = partLeftoversRef.current?.[id];
    if (leftover?.vertProperties) return leftover;
    return null;
  };

  const handleSelectPart = (id, opts = {}) => {
    const doc = assemblyRef.current;
    if (!doc || id == null) return;
    rememberCadPart(id);
    const partNow = doc.parts.find((row) => row.id === id);
    if (id === doc.activeId) {
      // The title may still show a part picked in the viewer; bring it back.
      setCurrentFilename(partNow?.name || null);
      // A face or edge pick can show another part's mesh while Monaco stays
      // here. Clicking this row brings that mesh back.
      const mesh = meshForPart(id);
      if (mesh?.vertProperties) {
        viewportRef.current?.swapPickPart?.({
          partId: id,
          mesh,
          position: partPosition(partNow) || [0, 0, 0],
        });
      }
      if (!opts.keepPicks || opts.bodyHighlight) viewportRef.current?.showCadBodyHighlight?.();
      return;
    }
    const live = codeEditorRef.current?.getContent?.();
    const prev = doc.activeId;
    if (prev && !suppressPartSaveRef.current && typeof live === 'string') {
      const nextScripts = { ...partScriptsRef.current, [prev]: live };
      rememberScripts(nextScripts);
      savePartScript(prev, live);
      stashPartHistory(prev, live);
    }
    // Drop an in-flight refresh of the part we are leaving so it cannot
    // paint that solid back over the one we are about to show.
    refreshGenRef.current += 1;
    const nextDoc = rememberAssembly({ ...doc, activeId: id });
    const part = nextDoc.parts.find((row) => row.id === id);
    setCurrentFilename(part?.name || null);
    const picked = scriptForRow(nextDoc, partScriptsRef.current, id);
    const nextScript = picked.ok ? picked.script : '';
    focusPartHistory(id, nextScript);
    const cachedMesh = meshForPart(id);
    if (!opts.keepPicks && cachedMesh?.vertProperties) {
      viewportRef.current?.adoptActiveSolid?.({
        mesh: cachedMesh,
        position: partPosition(part) || [0, 0, 0],
        partId: id,
      });
    }
    if (opts.keepPicks) {
      if (picked.ok) {
        suppressPartSaveRef.current = false;
        codeEditorRef.current?.setTextOnly?.(picked.script);
        setCurrentScript(picked.script);
      }
      if (opts.bodyHighlight) viewportRef.current?.showCadBodyHighlight?.();
      return;
    }
    if (picked.ok) {
      suppressPartSaveRef.current = false;
      codeEditorRef.current?.loadContent(picked.script, part?.name || 'Part', false);
      viewportRef.current?.showCadBodyHighlight?.();
      return;
    }
    suppressPartSaveRef.current = true;
    const note = '// This part has no file yet.\n';
    codeEditorRef.current?.setTextOnly?.(note);
    setCurrentScript(note);
    refreshAssemblyRef.current?.(undefined, { persistActive: false });
  };

  const handlePickRetarget = ({ partId, syncScript = false, kind = 'face' } = {}) => {
    if (!partId || !assemblyRef.current) return false;
    rememberCadPart(partId);
    const part = assemblyRef.current.parts.find((row) => row.id === partId);
    if (part?.name) setCurrentFilename(part.name);
    if (syncScript) {
      handleSelectPart(partId, {
        keepPicks: true,
        bodyHighlight: kind === 'body',
      });
      return true;
    }
    const mesh = meshForPart(partId);
    if (mesh?.vertProperties) {
      viewportRef.current?.swapPickPart?.({
        partId,
        mesh,
        position: partPosition(part) || [0, 0, 0],
      });
    }
    return true;
  };

  /** A palette tap opens a Block sheet or feature mode: edit the picked part. */
  const handleFeatureOpen = () => {
    focusWritePart(null);
  };

  const handleFeatureSession = (active) => {
    const on = !!active;
    // Opening a feature on a picked part edits that part from the start, so
    // its buffer, commit mode and Undo stack are the ones the feature sees.
    if (on && !featureSessionRef.current) focusWritePart(null);
    featureSessionRef.current = on;
    setFeatureSession((prev) => (prev === on ? prev : on));
  };

  /**
   * Load the part a feature acts on into the editor before it writes, opens
   * a feature sheet or undoes. A face / edge pick on part B moves the viewer
   * (and the Block preview anchor) to B but leaves the editor on A; every
   * writer writes the editor buffer, so without this a Block confirmed on B
   * landed in A, the strip showed B, and B's sheet Delete hit A's offsets
   * ("invalid range"). Target: the viewport's part for this payload, else the
   * picked part (featureWriteTarget). Loading keeps the picks and focuses that
   * part's own Undo stack. Returns false when that part cannot be loaded.
   */
  const focusWritePart = (payloadPartId = null) => {
    const doc = assemblyRef.current;
    if (!doc || appModeRef.current === 'game') return true;
    const target = featureWriteTarget(doc, { pickedId: cadPartIdRef.current, payloadPartId });
    if (!target.load) return true;
    if (!scriptForRow(doc, partScriptsRef.current, target.id).ok) return false;
    handleSelectPart(target.id, { keepPicks: true });
    return assemblyRef.current?.activeId === target.id;
  };
  focusWritePartRef.current = focusWritePart;
  const PICKED_PART_FAIL = 'Could not open the picked part in the editor — try again.';

  syncCadScriptRef.current = () => {
    const id = cadPartIdRef.current;
    const doc = assemblyRef.current;
    if (!id || !doc || id === doc.activeId) return;
    handleSelectPart(id);
  };

  const handleTogglePartVisible = (id) => {
    const doc = assemblyRef.current;
    if (!doc) return;
    const part = doc.parts.find((row) => row.id === id);
    const next = setPartVisible(doc, id, part?.visible === false);
    rememberAssembly(next);
    const live = codeEditorRef.current?.getContent?.();
    refreshAssemblyRef.current?.(live, {
      persistActive: !suppressPartSaveRef.current,
      preservePicks: featureSessionRef.current,
    });
  };

  const handleReorderParts = (from, to) => {
    if (!assemblyRef.current) return;
    rememberAssembly(reorderParts(assemblyRef.current, from, to));
  };

  const handleLoadAssembly = async (text, filename) => {
    let doc;
    let raw;
    try {
      raw = typeof text === 'string' ? JSON.parse(text) : text;
      doc = parseAssemblyDocument(raw);
    } catch (err) {
      setUploadError(err.message || 'Could not read assembly');
      return;
    }
    const loadedName = assemblyNameForLoad(raw, filename);
    if (loadedName !== doc.name) doc = serializeAssembly({ ...doc, name: loadedName });
    refreshGenRef.current += 1;
    const scripts = await loadPartScripts(doc.parts.map((part) => part.id));
    rememberScripts(scripts);
    const saved = rememberAssembly(doc);
    const keep = new Set(saved.parts.map((part) => String(part.id)));
    for (const key of Object.keys(partHistoriesRef.current)) {
      if (key !== '__game__' && !keep.has(key)) delete partHistoriesRef.current[key];
    }
    const active = saved.parts.find((part) => part.id === saved.activeId) || saved.parts[0];
    if (!active) return;
    setCurrentFilename(active.name);
    const picked = scriptForRow(saved, scripts, active.id);
    focusPartHistory(active.id, picked.ok ? picked.script : '');
    if (picked.ok) {
      suppressPartSaveRef.current = false;
      codeEditorRef.current?.loadContent(picked.script, active.name, false);
      return;
    }
    suppressPartSaveRef.current = true;
    codeEditorRef.current?.setTextOnly?.('// This part has no file yet.\n');
    refreshAssemblyRef.current?.(undefined, { persistActive: false });
  };

  const handleResolvePartFile = async (id, text) => {
    if (!id || typeof text !== 'string') return;
    await savePartScript(id, text);
    const scripts = { ...partScriptsRef.current, [id]: text };
    rememberScripts(scripts);
    suppressPartSaveRef.current = false;
    if (assemblyRef.current?.activeId === id) {
      codeEditorRef.current?.loadContent(text, 'Part file', false);
      return;
    }
    refreshAssemblyRef.current?.(codeEditorRef.current?.getContent?.());
  };

  const rememberGitBaseline = (baseline) => {
    gitBaselineRef.current = baseline;
    setGitBaseline(baseline);
  };

  const rememberGitBehind = (check, { showToast = true, resetResolved = true } = {}) => {
    gitBehindRef.current = check;
    setGitBehind(check);
    if (resetResolved) {
      gitBehindResolvedRef.current = [];
      setGitBehindResolved([]);
    }
    if (check && check.behindBy > 0) {
      if (showToast) {
        setGitBehindToast({
          message: behindToastMessage({ behindBy: check.behindBy }),
          behindBy: check.behindBy,
        });
      }
    } else {
      setGitBehindToast(null);
    }
  };

  const markBehindResolved = (path) => {
    if (!path) return;
    const next = gitBehindResolvedRef.current.includes(path)
      ? gitBehindResolvedRef.current
      : [...gitBehindResolvedRef.current, path];
    gitBehindResolvedRef.current = next;
    setGitBehindResolved(next);
    const markers = remainingBehindMarkers(gitBehindRef.current, next);
    if (!markers.any) setGitBehindToast(null);
  };

  /** G4: compare baseline head to main; show toast + markers when behind. */
  const checkGitRemoteBehind = async ({ showToast = true, reason = 'manual' } = {}) => {
    const doc = assemblyRef.current;
    const baseline = gitBaselineRef.current;
    if (!doc || doc.source !== 'git' || !baseline?.headSha) return null;
    const gen = ++gitCheckGenRef.current;
    try {
      const vault = await ensureGitVault();
      const asmPath = baseline.assemblyPath
        || assemblyFilePath(vaultSegment(doc.name) || doc.name);
      const check = await checkRemoteBehind(gitAdapterRef.current, vault.repo, {
        branch: baseline.branch || vault.defaultBranch || 'main',
        baselineSha: baseline.headSha,
        assemblyPath: asmPath,
        partIds: (doc.parts || []).map((p) => p.id),
      });
      if (gen !== gitCheckGenRef.current) return null; // stale
      // Preserve already-resolved paths across focus rechecks of the same remote tip.
      const sameTip = gitBehindRef.current?.remoteSha === check.remoteSha;
      rememberGitBehind(check, {
        showToast: showToast && check.behindBy > 0,
        resetResolved: !sameTip,
      });
      return check;
    } catch (err) {
      console.warn('[git] behind check failed', reason, err);
      return null;
    }
  };

  const ensureGitVault = async () => {
    if (!gitAdapterRef.current) {
      gitAdapterRef.current = createMockGithubAdapter({ login: 'local-user' });
    }
    if (gitVaultRef.current) return gitVaultRef.current;
    const result = await findOrCreateVault(gitAdapterRef.current);
    if (result.status === 'invalid-name' || result.status === 'not-a-vault' || result.status === 'missing') {
      throw new Error(`Vault unavailable (${result.status})`);
    }
    const vault = {
      repo: result.repo,
      defaultBranch: result.defaultBranch || 'main',
      headSha: result.headSha || null,
      private: result.private !== false,
    };
    gitVaultRef.current = vault;
    return vault;
  };

  /** Branch the working copy is on (baseline), else the vault default. */
  const gitWorkingBranch = () => {
    const baseline = gitBaselineRef.current;
    const vault = gitVaultRef.current;
    return baseline?.branch || vault?.defaultBranch || 'main';
  };

  /**
   * After a rename-on-Commit (or any commit that remaps paths), fold the new
   * doc/scripts into the working copy and IndexedDB so part ids match git.
   */
  const applyCommittedWorkspace = async (result) => {
    if (!result?.doc || !result?.scripts) return;
    const nextDoc = result.doc;
    const nextScripts = result.scripts;
    for (const [id, script] of Object.entries(nextScripts)) {
      await savePartScript(id, script);
    }
    // Drop IndexedDB keys for old paths that moved away.
    const keep = new Set(Object.keys(nextScripts));
    for (const id of Object.keys(partScriptsRef.current || {})) {
      if (!keep.has(id)) {
        try { await deletePartScript(id); } catch { /* ignore */ }
      }
    }
    for (const key of Object.keys(partHistoriesRef.current)) {
      if (key !== '__game__' && !keep.has(key)) delete partHistoriesRef.current[key];
    }
    rememberScripts(nextScripts);
    const saved = rememberAssembly(nextDoc);
    const active = saved.parts.find((part) => part.id === saved.activeId) || saved.parts[0];
    if (active) {
      setCurrentFilename(active.name);
      const picked = scriptForRow(saved, nextScripts, active.id);
      focusPartHistory(active.id, picked.ok ? picked.script : '');
      if (picked.ok) {
        suppressPartSaveRef.current = false;
        codeEditorRef.current?.loadContent(picked.script, active.name, false);
      }
    }
  };

  const handleToggleSource = async () => {
    const doc = assemblyRef.current;
    if (!doc) return;
    if (doc.source === 'git') {
      rememberAssembly({ ...doc, source: 'local' });
      rememberGitBaseline(null);
      rememberGitBehind(null, { showToast: false, resetResolved: true });
      setGitBehindToast(null);
      return;
    }
    try {
      await ensureGitVault();
    } catch (err) {
      setUploadError(err.message || 'Could not open vault');
      return;
    }
    // Keep current rows; paths that are not repo-safe stay until Open replaces them.
    rememberAssembly({ ...doc, source: 'git' });
    // No baseline until a vault Open — dirty badges stay off.
    rememberGitBaseline(null);
    rememberGitBehind(null, { showToast: false, resetResolved: true });
    setGitBehindToast(null);
  };

  const handleListVaultAssemblies = async () => {
    const vault = await ensureGitVault();
    return listVaultAssemblies(gitAdapterRef.current, vault.repo, gitWorkingBranch());
  };

  const handleOpenVaultAssembly = async (name) => {
    try {
      const vault = await ensureGitVault();
      const branch = gitWorkingBranch();
      const tip = (await gitAdapterRef.current.getBranch(vault.repo, branch))?.sha || null;
      const opened = await openVaultAssembly(
        gitAdapterRef.current,
        vault.repo,
        name,
        { branch, headSha: tip },
      );
      refreshGenRef.current += 1;
      for (const [id, script] of Object.entries(opened.scripts)) {
        await savePartScript(id, script);
      }
      rememberScripts(opened.scripts);
      const saved = rememberAssembly(opened.doc);
      rememberGitBaseline(opened.baseline);
      gitVaultRef.current = { ...vault, headSha: opened.baseline.headSha };
      // G4: check remote on open (usually current; catches a race with a push).
      void checkGitRemoteBehind({ showToast: true, reason: 'open' });
      const keep = new Set(saved.parts.map((part) => String(part.id)));
      for (const key of Object.keys(partHistoriesRef.current)) {
        if (key !== '__game__' && !keep.has(key)) delete partHistoriesRef.current[key];
      }
      const active = saved.parts.find((part) => part.id === saved.activeId) || saved.parts[0];
      if (!active) return;
      setCurrentFilename(active.name);
      const picked = scriptForRow(saved, opened.scripts, active.id);
      focusPartHistory(active.id, picked.ok ? picked.script : '');
      if (picked.ok) {
        suppressPartSaveRef.current = false;
        codeEditorRef.current?.loadContent(picked.script, active.name, false);
      } else {
        suppressPartSaveRef.current = true;
        codeEditorRef.current?.setTextOnly?.('// This part has no file yet.\n');
        refreshAssemblyRef.current?.(undefined, { persistActive: false });
      }
    } catch (err) {
      setUploadError(err.message || 'Could not open assembly');
    }
  };

  const handleListAddableParts = async () => {
    const doc = assemblyRef.current;
    if (!doc) return [];
    const vault = await ensureGitVault();
    const name = vaultSegment(doc.name) || doc.name;
    return listAddableVaultParts(gitAdapterRef.current, vault.repo, name, {
      branch: gitWorkingBranch(),
      existingIds: doc.parts.map((p) => p.id),
    });
  };

  const handleAddExistingPart = async (path) => {
    const doc = assemblyRef.current;
    if (!doc || doc.source !== 'git') return;
    try {
      const vault = await ensureGitVault();
      const id = normalizeRepoPath(path);
      if (!id || !partPathAllowedFor(doc.name, id)) {
        setUploadError('That path is not allowed for this assembly');
        return;
      }
      const got = await readVaultPart(gitAdapterRef.current, vault.repo, id, gitWorkingBranch());
      if (!got) {
        setUploadError(`Missing in vault: ${id}`);
        return;
      }
      const live = codeEditorRef.current?.getContent?.();
      const prev = doc.activeId;
      const scripts = { ...partScriptsRef.current };
      if (prev && !suppressPartSaveRef.current && typeof live === 'string') {
        scripts[prev] = live;
        savePartScript(prev, live);
        stashPartHistory(prev, live);
      }
      scripts[id] = got.content;
      await savePartScript(id, got.content);
      rememberScripts(scripts);
      const existing = doc.parts.some((part) => part.id === id);
      const parts = existing
        ? doc.parts
        : [...doc.parts, {
          id,
          name: id.split('/').pop()?.replace(/\.js$/i, '') || id,
          visible: true,
          order: doc.parts.length,
        }];
      refreshGenRef.current += 1;
      rememberAssembly({ ...doc, source: 'git', activeId: id, parts });
      focusPartHistory(id, got.content);
      suppressPartSaveRef.current = false;
      setCurrentFilename(id.split('/').pop() || id);
      codeEditorRef.current?.loadContent(got.content, id, false);
    } catch (err) {
      setUploadError(err.message || 'Could not add part');
    }
  };

  const handleFindInRepo = async (id) => {
    const doc = assemblyRef.current;
    if (!doc || doc.source !== 'git') return;
    try {
      const vault = await ensureGitVault();
      const got = await readVaultPart(gitAdapterRef.current, vault.repo, id, gitWorkingBranch());
      if (!got) {
        setUploadError(`Not in vault: ${id}`);
        return;
      }
      await savePartScript(id, got.content);
      const scripts = { ...partScriptsRef.current, [id]: got.content };
      rememberScripts(scripts);
      suppressPartSaveRef.current = false;
      if (doc.activeId === id) {
        codeEditorRef.current?.loadContent(got.content, id, false);
      } else {
        refreshAssemblyRef.current?.(codeEditorRef.current?.getContent?.());
      }
    } catch (err) {
      setUploadError(err.message || 'Find in repo failed');
    }
  };

  /** G5: list vault branches with the current working branch marked. */
  const handleListBranches = async () => {
    const vault = await ensureGitVault();
    return listVaultBranches(gitAdapterRef.current, vault.repo, {
      current: gitWorkingBranch(),
    });
  };

  /**
   * G5: switch working branch — reload the open assembly from that tip.
   * Dirty working copy is replaced (PartFeed confirms first when dirty).
   */
  const handleSwitchBranch = async (branchName) => {
    const doc = assemblyRef.current;
    if (!doc || doc.source !== 'git') {
      return { status: 'error', error: 'Not in Git mode' };
    }
    const name = vaultSegment(doc.name) || doc.name;
    if (!name) return { status: 'error', error: 'No assembly open' };
    const current = gitWorkingBranch();
    if (!branchName || branchName === current) {
      return { status: 'same', branch: current };
    }
    try {
      const vault = await ensureGitVault();
      const opened = await switchVaultBranch(
        gitAdapterRef.current, vault.repo, name, branchName,
      );
      refreshGenRef.current += 1;
      for (const [id, script] of Object.entries(opened.scripts)) {
        await savePartScript(id, script);
      }
      rememberScripts(opened.scripts);
      const saved = rememberAssembly(opened.doc);
      rememberGitBaseline(opened.baseline);
      gitVaultRef.current = { ...vault, headSha: opened.baseline.headSha };
      rememberGitBehind(null, { showToast: false, resetResolved: true });
      setGitBehindToast(null);
      void checkGitRemoteBehind({ showToast: true, reason: 'branch-switch' });
      const keep = new Set(saved.parts.map((part) => String(part.id)));
      for (const key of Object.keys(partHistoriesRef.current)) {
        if (key !== '__game__' && !keep.has(key)) delete partHistoriesRef.current[key];
      }
      const active = saved.parts.find((part) => part.id === saved.activeId) || saved.parts[0];
      if (active) {
        setCurrentFilename(active.name);
        const picked = scriptForRow(saved, opened.scripts, active.id);
        focusPartHistory(active.id, picked.ok ? picked.script : '');
        if (picked.ok) {
          suppressPartSaveRef.current = false;
          codeEditorRef.current?.loadContent(picked.script, active.name, false);
        } else {
          suppressPartSaveRef.current = true;
          codeEditorRef.current?.setTextOnly?.('// This part has no file yet.\n');
          refreshAssemblyRef.current?.(undefined, { persistActive: false });
        }
      }
      return { status: 'switched', branch: branchName, baseline: opened.baseline };
    } catch (err) {
      return { status: 'error', error: err.message || 'Could not switch branch' };
    }
  };

  /**
   * G3 Commit: changed parts + assembly as one commit to the current branch.
   * When the tip has moved, the commit lands on surfcad/<assembly>-<date> and
   * the result asks (in PartFeed) whether to force merge.
   */
  const handleGitCommit = async (message) => {
    const doc = assemblyRef.current;
    if (!doc || doc.source !== 'git') return { status: 'error', error: 'Not in Git mode' };
    try {
      const vault = await ensureGitVault();
      // No Open yet: first commit of this assembly onto the vault head.
      const baseline = gitBaselineRef.current || firstCommitBaseline({
        branch: vault.defaultBranch,
        headSha: (await gitAdapterRef.current.getBranch(vault.repo, vault.defaultBranch))?.sha || vault.headSha,
      });
      const live = codeEditorRef.current?.getContent?.();
      const liveId = (!suppressPartSaveRef.current && typeof live === 'string') ? doc.activeId : null;
      if (liveId) {
        savePartScript(liveId, live);
        rememberScripts({ ...partScriptsRef.current, [liveId]: live });
      }
      const result = await commitWorkspace(gitAdapterRef.current, vault.repo, {
        doc,
        scripts: partScriptsRef.current,
        baseline,
        message,
        liveId,
        liveScript: liveId ? live : null,
      });
      if (result.status === 'committed') {
        if (result.renamed || result.moved?.length) {
          await applyCommittedWorkspace(result);
        }
        rememberGitBaseline(result.baseline);
        gitVaultRef.current = { ...vault, headSha: result.sha };
        rememberGitBehind(null, { showToast: false, resetResolved: true });
        setGitBehindToast(null);
      } else if (result.status === 'branched') {
        return { ...result, warning: forceMergeWarning(result) };
      }
      return result;
    } catch (err) {
      return { status: 'error', error: err.message || 'Commit failed' };
    }
  };

  /** G3 force merge after a branched commit (user confirmed the warning). */
  const handleForceMerge = async (branched) => {
    try {
      const vault = await ensureGitVault();
      const result = await forceMergeCommit(gitAdapterRef.current, vault.repo, branched);
      if (result.status === 'merged') {
        if (result.doc && result.scripts) {
          await applyCommittedWorkspace(result);
        }
        rememberGitBaseline(result.baseline);
        gitVaultRef.current = { ...vault, headSha: result.sha };
        rememberGitBehind(null, { showToast: false, resetResolved: true });
        setGitBehindToast(null);
      }
      return result;
    } catch (err) {
      return { status: 'error', error: err.message || 'Force merge failed' };
    }
  };

  /**
   * G4 conflict choice for one behind path: reload | keep | branch.
   * Reload updates working copy + baseline for that path; keep / branch only
   * clear the marker (branch also parks mine on surfcad/<asm>-<date>).
   */
  const handleBehindChoice = async ({ action, path, kind }) => {
    const doc = assemblyRef.current;
    const baseline = gitBaselineRef.current;
    if (!doc || doc.source !== 'git' || !baseline || !path) {
      return { status: 'error', error: 'Not in Git mode' };
    }
    try {
      const vault = await ensureGitVault();
      const branch = baseline.branch || vault.defaultBranch || 'main';
      if (action === 'keep') {
        markBehindResolved(path);
        return { status: 'kept', path };
      }
      if (action === 'branch') {
        const live = codeEditorRef.current?.getContent?.();
        const scripts = { ...partScriptsRef.current };
        if (doc.activeId && !suppressPartSaveRef.current && typeof live === 'string') {
          scripts[doc.activeId] = live;
        }
        const result = await checkInMineToBranch(gitAdapterRef.current, vault.repo, {
          doc,
          scripts,
          baseline,
          path,
          kind: kind === 'assembly' ? 'assembly' : 'part',
        });
        markBehindResolved(path);
        return result;
      }
      if (action === 'reload') {
        const live = codeEditorRef.current?.getContent?.();
        const scripts = { ...partScriptsRef.current };
        if (doc.activeId && !suppressPartSaveRef.current && typeof live === 'string') {
          scripts[doc.activeId] = live;
        }
        const reloaded = await reloadFromRemote(gitAdapterRef.current, vault.repo, {
          path,
          kind: kind === 'assembly' ? 'assembly' : 'part',
          branch,
          doc,
          scripts,
          baseline,
        });
        if (reloaded.kind === 'assembly') {
          // Replace assembly document; keep scripts for ids still present.
          const nextDoc = reloaded.doc;
          const keepScripts = {};
          for (const part of nextDoc.parts || []) {
            keepScripts[part.id] = reloaded.scripts[part.id] ?? scripts[part.id] ?? '';
          }
          // Fetch any part scripts the remote assembly lists that we do not have.
          for (const part of nextDoc.parts || []) {
            if (keepScripts[part.id] === '' || keepScripts[part.id] == null) {
              const got = await readVaultPart(gitAdapterRef.current, vault.repo, part.id, branch);
              if (got) keepScripts[part.id] = got.content;
            }
          }
          for (const [id, script] of Object.entries(keepScripts)) {
            await savePartScript(id, script);
          }
          rememberScripts(keepScripts);
          const saved = rememberAssembly(nextDoc);
          let nextBaseline = reloaded.baseline;
          // Refresh baseline scripts to match what we loaded.
          nextBaseline = {
            ...nextBaseline,
            scripts: { ...keepScripts },
            partIds: (nextDoc.parts || []).map((p) => p.id),
          };
          markBehindResolved(path);
          const markers = remainingBehindMarkers(gitBehindRef.current, gitBehindResolvedRef.current);
          if (!markers.any && gitBehindRef.current?.remoteSha) {
            nextBaseline = advanceBaselineHead(nextBaseline, gitBehindRef.current.remoteSha);
            rememberGitBehind(null, { showToast: false, resetResolved: true });
            setGitBehindToast(null);
          }
          rememberGitBaseline(nextBaseline);
          const active = saved.parts.find((p) => p.id === saved.activeId) || saved.parts[0];
          if (active) {
            const picked = scriptForRow(saved, keepScripts, active.id);
            focusPartHistory(active.id, picked.ok ? picked.script : '');
            setCurrentFilename(active.name);
            if (picked.ok) {
              suppressPartSaveRef.current = false;
              codeEditorRef.current?.loadContent(picked.script, active.name, false);
            }
          }
          return { status: 'reloaded', path, kind: 'assembly' };
        }
        // Part reload
        await savePartScript(path, reloaded.content);
        const nextScripts = reloaded.scripts;
        rememberScripts(nextScripts);
        let nextBaseline = reloaded.baseline;
        markBehindResolved(path);
        const markers = remainingBehindMarkers(gitBehindRef.current, gitBehindResolvedRef.current);
        if (!markers.any && gitBehindRef.current?.remoteSha) {
          nextBaseline = advanceBaselineHead(nextBaseline, gitBehindRef.current.remoteSha);
          rememberGitBehind(null, { showToast: false, resetResolved: true });
          setGitBehindToast(null);
        }
        rememberGitBaseline(nextBaseline);
        if (doc.activeId === path) {
          suppressPartSaveRef.current = false;
          codeEditorRef.current?.loadContent(reloaded.content, path, false);
        } else {
          refreshAssemblyRef.current?.(codeEditorRef.current?.getContent?.());
        }
        return { status: 'reloaded', path, kind: 'part' };
      }
      return { status: 'error', error: `Unknown action: ${action}` };
    } catch (err) {
      return { status: 'error', error: err.message || 'Behind action failed' };
    }
  };

  // G4: re-check remote when the window is focused / tab becomes visible.
  useEffect(() => {
    const onFocus = () => {
      if (assemblyRef.current?.source !== 'git' || !gitBaselineRef.current?.headSha) return;
      void checkGitRemoteBehind({ showToast: true, reason: 'focus' });
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- refs + stable helpers

  const handleAddPart = async (gitPath) => {
    const doc = assemblyRef.current;
    if (!doc) return;
    const live = codeEditorRef.current?.getContent?.();
    const prev = doc.activeId;
    const scripts = { ...partScriptsRef.current };
    if (prev && !suppressPartSaveRef.current && typeof live === 'string') {
      scripts[prev] = live;
      savePartScript(prev, live);
      stashPartHistory(prev, live);
    }
    let id;
    let name;
    if (doc.source === 'git') {
      id = resolveNewPartPath(doc.name, gitPath);
      if (!id) {
        setUploadError('Enter a path under this assembly parts/ or shared parts/');
        return;
      }
      if (doc.parts.some((part) => part.id === id)) {
        setUploadError(`Part already in assembly: ${id}`);
        return;
      }
      name = id.split('/').pop()?.replace(/\.js$/i, '') || id;
    } else {
      id = newLocalPartId();
      name = `Part ${doc.parts.length + 1}`;
    }
    const order = doc.parts.length;
    const starter = newPartStarterScript();
    const part = {
      id,
      name,
      visible: true,
      order,
      position: order === 0 ? undefined : [order * 40, 0, 0],
    };
    scripts[id] = starter;
    await savePartScript(id, starter);
    rememberScripts(scripts);
    refreshGenRef.current += 1;
    rememberAssembly({ ...doc, activeId: id, parts: [...doc.parts, part] });
    focusPartHistory(id, starter);
    suppressPartSaveRef.current = false;
    setCurrentFilename(part.name);
    codeEditorRef.current?.loadContent(starter, part.name, false);
  };

  const handleDeletePart = (id) => {
    const doc = assemblyRef.current;
    if (!doc || id == null) return;
    const key = String(id);
    if (!doc.parts.some((part) => part.id === key)) return;

    // An in-flight refresh still has the old document. Drop it so it cannot
    // put this part's solid back.
    refreshGenRef.current += 1;

    const live = codeEditorRef.current?.getContent?.();
    const prevActive = doc.activeId;
    const deletingActive = prevActive === key;
    let scripts = { ...partScriptsRef.current };
    if (!deletingActive && prevActive && !suppressPartSaveRef.current && typeof live === 'string') {
      scripts[prevActive] = live;
      savePartScript(prevActive, live);
    }
    if (deletingActive) {
      // The pending autosave still holds this part's script. Do not write it
      // onto whichever row becomes active.
      partSaveEpochRef.current += 1;
      suppressPartSaveRef.current = true;
    }

    scripts = dropPartRecord(scripts, key);
    rememberScripts(scripts);
    deletePartScript(key);
    dropPartHistory(key);
    delete partLeftoversRef.current[key];

    const nextDoc = rememberAssembly(removePart(doc, key));
    const runs = dropPartRecord(partRunsRef.current, key);
    commitPartRuns(runs);

    const nextActive = nextDoc.activeId;
    if (cadPartIdRef.current === key) rememberCadPart(nextActive);
    const nextPart = nextDoc.parts.find((row) => row.id === nextActive);
    const nextRun = nextActive ? runs[nextActive] : null;
    if (deletingActive && nextRun?.ok && nextRun.mesh?.vertProperties) {
      viewportRef.current?.adoptActiveSolid?.({
        mesh: nextRun.mesh,
        position: partPosition(nextPart) || [0, 0, 0],
        partId: nextActive,
      });
    }
    viewportRef.current?.placeAssembly?.({
      solids: composeViewportParts(nextDoc, runs),
      leftovers: leftoverPickSolids(nextDoc, runs, partLeftoversRef.current),
      activeId: deletingActive && !(nextRun?.ok && nextRun.mesh) ? null : nextActive,
      blankActive: (deletingActive && !(nextRun?.ok && nextRun.mesh?.vertProperties)) || !nextActive,
      failedIds: failedPartIdsFor(nextDoc, runs),
    });

    if (!nextActive) {
      applyPartHistory({ commits: [], head: -1 });
      const note = '// No parts.\n';
      setCurrentFilename(null);
      saveEditorDraft({ script: note, filename: null });
      codeEditorRef.current?.setTextOnly?.(note);
      setCurrentScript(note);
      return;
    }

    if (!deletingActive) {
      refreshAssemblyRef.current?.(live, { persistActive: !suppressPartSaveRef.current });
      return;
    }

    const part = nextPart;
    setCurrentFilename(part?.name || null);
    const picked = scriptForRow(nextDoc, scripts, nextActive);
    focusPartHistory(nextActive, picked.ok ? picked.script : '');
    if (picked.ok) {
      suppressPartSaveRef.current = false;
      if (codeEditorRef.current?.loadContent) {
        codeEditorRef.current.loadContent(picked.script, part?.name || 'Part', false);
      } else {
        setCurrentScript(picked.script);
        refreshAssemblyRef.current?.(picked.script);
      }
      return;
    }
    const note = '// This part has no file yet.\n';
    codeEditorRef.current?.setTextOnly?.(note);
    setCurrentScript(note);
    refreshAssemblyRef.current?.(undefined, { persistActive: false });
  };

  const handleGameRun = async () => {
    if (appModeRef.current !== 'game') {
      const code = codeEditorRef.current?.getContent?.();
      if (code == null) return;
      setCurrentScript(code);
      await refreshAssemblyRef.current?.(code);
      return;
    }
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
   * Scripts, names, positions, and last-run status of every part, for
   * cross-part writes. The active part's script is the live editor buffer.
   */
  const assemblyPartContext = () => {
    const doc = assemblyRef.current;
    const parts = {};
    if (!doc) return { parts, activeId: null };
    const live = codeEditorRef.current?.getContent?.();
    for (const row of doc.parts) {
      const run = partRunsRef.current?.[row.id];
      const script = row.id === doc.activeId && typeof live === 'string' && !suppressPartSaveRef.current
        ? live
        : partScriptsRef.current[row.id];
      parts[row.id] = {
        script: typeof script === 'string' ? script : null,
        name: row.name || row.id,
        position: partPosition(row) || [0, 0, 0],
        visible: row.visible !== false,
        ok: !(run && run.ok === false && run.error && !run.skipped),
      };
    }
    return { parts, activeId: doc.activeId ?? null };
  };

  /**
   * Write scripts into parts that are not in the editor. Each write is one
   * feature step on that part's own undo stack. Then every visible part is
   * run again, so the active part's graphs rebuild on the success path and
   * the other parts show their new solids.
   */
  const writeOtherPartScripts = (writes) => {
    const doc = assemblyRef.current;
    if (!doc || !Array.isArray(writes) || !writes.length) return false;
    let scripts = { ...partScriptsRef.current };
    let wrote = 0;
    for (const w of writes) {
      if (!w?.id || typeof w.buffer !== 'string' || w.id === doc.activeId) continue;
      if (!doc.parts.some((row) => row.id === w.id)) continue;
      const prevScript = typeof scripts[w.id] === 'string' ? scripts[w.id] : '';
      scripts = { ...scripts, [w.id]: w.buffer };
      savePartScript(w.id, w.buffer);
      partHistoriesRef.current[w.id] = pushPartHistory(
        historyForPart(partHistoriesRef.current, w.id, prevScript),
        w.buffer,
        w.message || 'External copy',
      );
      wrote += 1;
    }
    if (!wrote) return false;
    rememberScripts(scripts);
    refreshAssemblyRef.current?.(codeEditorRef.current?.getContent?.());
    return true;
  };

  /**
   * Subtract mode on a Block or Shape: the active part keeps its own block
   * (already written). Every other visible part the cutter overlaps gets a
   * frozen copy of that cutter, posed into its frame, as one feature step
   * with a yellow-bordered chip. Re-confirming the same feature replaces
   * that copy; a cutter moved off a part drops it there.
   */
  const crossPartSubtract = async (before, after) => {
    const doc = assemblyRef.current;
    if (!doc || appModeRef.current === 'game' || doc.parts.length < 2) return;
    if (typeof before !== 'string' || typeof after !== 'string' || before === after) return;
    const sourceRow = doc.parts.find((row) => row.id === doc.activeId);
    if (!sourceRow) return;
    const ctx = assemblyPartContext();
    const parts = doc.parts.map((row) => ({ id: row.id, ...ctx.parts[row.id] }));
    const source = {
      id: sourceRow.id,
      name: sourceRow.name || sourceRow.id,
      position: partPosition(sourceRow) || [0, 0, 0],
    };
    const plan = planCrossPartSubtract({ before, after, source, parts, markers: FEATURE_MARKER_KINDS });
    if (!plan || !plan.candidates.length) return;
    const probeParts = plan.candidates
      .map((c) => ({ id: c.id, mesh: meshForPart(c.id), offset: c.offset }))
      .filter((p) => p.mesh?.vertProperties);
    let overlapIds = [];
    try {
      const res = await manifoldContext.probeOverlap({ cutterScript: plan.cutterScript, parts: probeParts });
      overlapIds = (res?.overlaps || []).map((o) => String(o.id));
    } catch (err) {
      console.warn('[App] cross-part subtract probe failed', err);
      return;
    }
    // The user may have switched parts while the probe ran.
    if (assemblyRef.current?.activeId !== source.id) return;
    const fresh = assemblyPartContext();
    const freshParts = doc.parts.map((row) => ({ id: row.id, ...fresh.parts[row.id] }));
    const writes = crossPartSubtractWrites(plan, { source, parts: freshParts, overlapIds });
    if (!writes.length) return;
    if (writeOtherPartScripts(writes)) {
      const names = writes
        .filter((w) => w.message === 'External copy')
        .map((w) => fresh.parts[w.id]?.name || w.id);
      if (names.length) viewportRef.current?.notify?.(`Also cut ${names.join(', ')} (external copy).`);
    }
  };

  /**
   * Slice 09/10/11: palette Confirm → compose at caret with params (+ optional
   * faceContext from selected face), then Auto-Run via handleGameRun.
   */
  const handleInsertHelper = (helperId, params = null, faceContext = null, edgeContext = null) => {
    // The Block preview is drawn on the picked part; Confirm writes there too.
    if (!focusWritePart(null)) {
      viewportRef.current?.notify?.(PICKED_PART_FAIL);
      return;
    }
    const beforeInsert = codeEditorRef.current?.getContent?.();
    const ok = codeEditorRef.current?.insertHelper?.(helperId, params, faceContext, edgeContext);
    if (ok) {
      if (params && params.combine === 'subtract') {
        crossPartSubtract(beforeInsert, codeEditorRef.current?.getContent?.());
      }
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
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailContour?.(PICKED_PART_FAIL);
      return false;
    }
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
      crossPartSubtract(buf, result.buffer);
    }
    return true;
  };

  /**
   * Slice 27: in-mode Fillet Accept. Writes makeSweepPath + filletAlongPath
   * and Auto-Runs. A second Accept appends to the marked block.
   * Picks can span parts: the editor part is written through the editor;
   * each other part with picks gets its own block in its own script, as one
   * feature step on that part's stack (writeOtherPartScripts). Every part is
   * composed first, so a refusal writes nothing.
   */
  const handleCommitFillet = (payload) => {
    const chamfer = payload?.entry === 'chamferEdges';
    const label = chamfer ? 'Chamfer' : 'Fillet';
    // The viewport's own part is the editor part; other picks stay "others".
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailFillet?.(PICKED_PART_FAIL);
      return false;
    }
    const others = Array.isArray(payload?.otherParts) ? payload.otherParts : [];
    const doc = assemblyRef.current;
    const editorId = doc?.activeId ?? null;
    const buf = codeEditorRef.current?.getContent?.() || '';
    let editorBuffer = null;
    let writes = [];
    if (!others.length) {
      const result = chamfer
        ? composeChamferCommit(buf, payload || {})
        : composeFilletCommit(buf, payload || {});
      if (!result.ok) {
        viewportRef.current?.softFailFillet?.(result.message);
        return false;
      }
      editorBuffer = result.buffer;
    } else {
      const ctx = assemblyPartContext();
      const ownId = payload?.partId ?? editorId;
      const plan = composeMultiPartEdgeCommit({
        chamfer,
        groups: [
          {
            partId: ownId,
            edges: payload?.edges || [],
            params: payload?.params || {},
            filletClass: payload?.filletClass ?? null,
            geometry: payload?.geometry ?? null,
          },
          ...others,
        ],
        editorId,
        editorBuffer: buf,
        parts: ctx.parts,
        compose: chamfer ? composeChamferCommit : composeFilletCommit,
        hasBlock: chamfer ? hasChamferModeBlock : hasFilletModeBlock,
      });
      if (!plan.ok) {
        viewportRef.current?.softFailFillet?.(plan.message);
        return false;
      }
      editorBuffer = plan.editor ? plan.editor.buffer : null;
      writes = plan.writes;
    }
    if (editorBuffer != null) {
      const wrote = codeEditorRef.current?.applyBuffer?.(editorBuffer, `${label} mode`);
      if (!wrote) {
        viewportRef.current?.softFailFillet?.(
          `Could not write ${label} into the editor — try again.`,
        );
        return false;
      }
    }
    // writeOtherPartScripts re-runs every visible part with the live editor
    // buffer, so the editor part does not need a second Auto-Run.
    if (writes.length && writeOtherPartScripts(writes)) {
      const live = codeEditorRef.current?.getContent?.();
      if (typeof live === 'string') setCurrentScript(live);
      const names = writes.map((w) => w.name || w.id);
      viewportRef.current?.notify?.(`${label} also written to ${names.join(', ')}.`);
      return true;
    }
    if (editorBuffer != null) {
      setTimeout(() => {
        handleGameRun();
      }, 0);
    }
    return true;
  };

  /** Shell face-pick Confirm — hollow() + SHELL markers; Auto-Run. */
  const handleCommitShell = (payload) => {
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailShell?.(PICKED_PART_FAIL);
      return false;
    }
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
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailDraft?.(PICKED_PART_FAIL);
      return false;
    }
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
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailCut?.(PICKED_PART_FAIL);
      return false;
    }
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

  /**
   * Boolean Confirm — one booleanBodies() + markers; Auto-Run.
   * The first pick's part is written. When that is not the part in the
   * editor, it is loaded first, so the write is one feature step on its
   * own stack. Tool bodies from other parts are frozen copies (externalBody).
   */
  const handleCommitBoolean = (payload) => {
    const state = payload?.state || payload || {};
    const gate = validateBooleanAccept(state, payload?.partId, payload?.mesh || null);
    if (!gate.ok) {
      viewportRef.current?.softFailBoolean?.(gate.message);
      return false;
    }
    const ctx = assemblyPartContext();
    const doc = assemblyRef.current;
    const target = gate.targetPartId;
    if (doc && target && target !== doc.activeId && doc.parts.some((row) => row.id === target)) {
      if (typeof ctx.parts[target]?.script !== 'string') {
        viewportRef.current?.softFailBoolean?.('Boolean: the target part has no script yet.');
        return false;
      }
      handleSelectPart(target, { keepPicks: true });
      if (assemblyRef.current?.activeId !== target) {
        viewportRef.current?.softFailBoolean?.('Could not open the target part — try again.');
        return false;
      }
    }
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeBooleanCommit(
      buf,
      state,
      payload?.partId,
      payload?.mesh || null,
      ctx,
    );
    if (!result.ok) {
      viewportRef.current?.softFailBoolean?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Boolean');
    if (!wrote) {
      viewportRef.current?.softFailBoolean?.(
        'Could not write Boolean into the editor — try again.',
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

  /** Delete Face Confirm — one deleteFace() + markers; Auto-Run. */
  const handleCommitDeleteFace = (payload) => {
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailDeleteFace?.(PICKED_PART_FAIL);
      return false;
    }
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeDeleteFaceCommit(buf, payload?.state || payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailDeleteFace?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Delete Face');
    if (!wrote) {
      viewportRef.current?.softFailDeleteFace?.(
        'Could not write Delete Face into the editor — try again.',
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

  /** Move Face Confirm — one moveFace() + markers; Auto-Run. Not body move(). */
  const handleCommitMoveFace = (payload) => {
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailMoveFace?.(PICKED_PART_FAIL);
      return false;
    }
    const buf = codeEditorRef.current?.getContent?.() || '';
    const result = composeMoveFaceCommit(buf, payload?.state || payload || {});
    if (!result.ok) {
      viewportRef.current?.softFailMoveFace?.(result.message);
      return false;
    }
    const wrote = codeEditorRef.current?.applyBuffer?.(result.buffer, 'Move Face');
    if (!wrote) {
      viewportRef.current?.softFailMoveFace?.(
        'Could not write Move Face into the editor — try again.',
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
    if (!focusWritePart(payload?.partId)) {
      viewportRef.current?.softFailMove?.(PICKED_PART_FAIL);
      return false;
    }
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
      // Pass script directly to avoid stale closure. CAD runs the assembly
      // so every visible part is drawn, not only the buffer in Monaco.
      setTimeout(() => {
        refreshAssemblyRef.current?.(script);
      }, 100);
    }
  };

  const handleCodeChange = (code, message = 'Code updated') => {
    if (suppressPartSaveRef.current && message === 'Manual edit') {
      suppressPartSaveRef.current = false;
    }
    const id = historyKey();
    const branch = historyRef.current?.branches?.main;
    const prev = partHistoriesRef.current[id] || {
      commits: branch?.commits || [],
      head: Number.isInteger(branch?.head) ? branch.head : -1,
    };
    const pushed = pushPartHistory(prev, code, message);
    partHistoriesRef.current[id] = pushed;
    applyPartHistory(pushed);
    console.log('[App] handleCodeChange added commit:', { message, codeLength: code?.length, partId: id });
  };

  const handleCodeGenerated = (code, promptMessage) => {
    // Only add to history if a prompt message if not empty
    const addToHistory = promptMessage && promptMessage.length > 0;
    codeEditorRef.current?.loadContent(code, promptMessage || 'Code generated', addToHistory);
  };

  const handleUndo = () => {
    // Undo the part the strip and title show (the picked part).
    if (!focusWritePart(null)) return;
    const id = historyKey();
    const branch = historyRef.current?.branches?.main;
    const current = partHistoriesRef.current[id] || {
      commits: branch?.commits || [],
      head: Number.isInteger(branch?.head) ? branch.head : -1,
    };
    const undone = undoPartHistory(current);
    if (undone.code == null) return;
    partHistoriesRef.current[id] = undone.history;
    applyPartHistory(undone.history);
    console.log('[App] Undoing to commit:', {
      partId: id,
      head: undone.history.head,
      codeLength: undone.code?.length,
    });
    // Restore editor without loadContent autoExecute (CAD-only; game skips).
    // Auto-Run via handleGameRun — same path as palette insert / Confirm.
    // Only this part's stack moves, so the script written here is this part's.
    codeEditorRef.current?.setTextOnly?.(undone.code);
    setTimeout(() => {
      handleGameRun();
    }, 0);
  };

  const handleRedo = () => {
    if (!focusWritePart(null)) return;
    const id = historyKey();
    const branch = historyRef.current?.branches?.main;
    const current = partHistoriesRef.current[id] || {
      commits: branch?.commits || [],
      head: Number.isInteger(branch?.head) ? branch.head : -1,
    };
    const redone = redoPartHistory(current);
    if (redone.code == null) return;
    partHistoriesRef.current[id] = redone.history;
    applyPartHistory(redone.history);
    console.log('[App] Redoing to commit:', {
      partId: id,
      head: redone.history.head,
      codeLength: redone.code?.length,
    });
    // Restore editor without loadContent autoExecute (CAD-only; game skips).
    // Auto-Run via handleGameRun — same path as palette insert / Confirm.
    codeEditorRef.current?.setTextOnly?.(redone.code);
    setTimeout(() => {
      handleGameRun();
    }, 0);
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

  // Rename one part by id (Parts feed row). The title follows when that part
  // is the one it shows. The name is read by save/export and by the
  // OAuth-redirect snapshot, so nothing else to write.
  const handleRenamePart = (id, name) => {
    const doc = assemblyRef.current;
    if (!doc) return;
    const nextDoc = renamePart(doc, id, name);
    if (nextDoc === doc) return;
    rememberAssembly(nextDoc);
    if (renameTargetId(nextDoc, cadPartIdRef.current) === id) {
      setCurrentFilename(nextDoc.parts.find((part) => part.id === id)?.name || null);
    }
  };

  // Rename from the viewer title chip. It lands on the part the title shows:
  // a pick on another part moves the title (cadPartId) but not the editor's
  // activeId, so writing to activeId renamed the wrong part.
  const handleRenameFile = (name) => {
    const doc = assemblyRef.current;
    const id = renameTargetId(doc, cadPartIdRef.current);
    if (!doc || id == null) {
      const next = String(name || '').trim();
      if (next) setCurrentFilename(next);
      return;
    }
    handleRenamePart(id, name);
  };

  const handleRenameAssembly = (name) => {
    const next = sanitizeAssemblyName(name);
    if (!next) return;
    const doc = assemblyRef.current;
    if (!doc || next === assemblyName(doc)) return;
    rememberAssembly({ ...doc, name: next });
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

  const cadHighlightId = cadPartId || assemblyDoc?.activeId || null;
  const liveDirtyScript = (
    assemblyDoc?.source === 'git'
    && cadHighlightId
    && assemblyDoc.activeId === cadHighlightId
    && typeof currentScript === 'string'
  ) ? currentScript : null;
  const gitDirtyIds = (
    assemblyDoc?.source === 'git' && gitBaseline
  ) ? dirtyPartIds(assemblyDoc, partScripts, gitBaseline, {
    liveId: assemblyDoc.activeId,
    liveScript: liveDirtyScript,
  }) : new Set();
  const sourceDirty = (
    assemblyDoc?.source === 'git'
    && isWorkspaceDirty(assemblyDoc, partScripts, gitBaseline, {
      liveId: assemblyDoc.activeId,
      liveScript: liveDirtyScript,
    })
  );
  const behindMarkers = (
    assemblyDoc?.source === 'git' && gitBehind
  ) ? remainingBehindMarkers(gitBehind, gitBehindResolved) : { assemblyBehind: false, partIds: [], any: false };
  const behindPartIdSet = new Set(behindMarkers.partIds || []);
  const gitAssemblyPath = (
    gitBaseline?.assemblyPath
    || (assemblyDoc?.source === 'git'
      ? assemblyFilePath(vaultSegment(assemblyDoc.name) || assemblyDoc.name)
      : '')
  );
  const partRows = assemblyDoc
    ? feedRows(assemblyDoc, partRuns, partScripts).map((row) => ({
      ...row,
      dirty: gitDirtyIds.has(row.id),
      behind: behindPartIdSet.has(row.id),
    }))
    : [];
  const stripScript = (
    cadHighlightId && assemblyDoc && cadHighlightId !== assemblyDoc.activeId
  ) ? (partScripts[cadHighlightId] || '') : currentScript;
  const stripFailedIds = failedFeatureIds(stripScript, runFailure);
  // Live body count for the separate-body chip marker (clears after Boolean union).
  const stripRun = cadHighlightId ? partRuns[cadHighlightId] : null;
  const stripBodyCount = (stripRun?.ok && stripRun.mesh)
    ? (Number.isFinite(stripRun.bodyCount)
      ? stripRun.bodyCount
      : bodyCountOfWorkerMesh(stripRun.mesh))
    : 0;
  // Feature sheets read the editor's script, so match the failure there.
  const sheetFailedIds = failedFeatureIds(currentScript, runFailure);
  const partLabels = {};
  for (const row of assemblyDoc?.parts || []) partLabels[row.id] = row.name || row.id;
  const assemblyLabel = assemblyName(assemblyDoc);
  const partFeed = appMode !== 'game' && assemblyDoc ? (
    <PartFeed
      placement={isMobile ? 'mobile' : 'desktop'}
      source={assemblyDoc.source}
      assemblyName={assemblyLabel}
      onRenameAssembly={handleRenameAssembly}
      onRenamePart={handleRenamePart}
      rows={partRows}
      activeId={cadHighlightId}
      onSelect={handleSelectPart}
      onToggleVisible={handleTogglePartVisible}
      onReorder={handleReorderParts}
      onLoadFile={handleLoadAssembly}
      onResolveFile={handleResolvePartFile}
      onAddPart={handleAddPart}
      onDeletePart={handleDeletePart}
      onToggleSource={handleToggleSource}
      sourceDirty={!!sourceDirty}
      onListVaultAssemblies={handleListVaultAssemblies}
      onOpenVaultAssembly={handleOpenVaultAssembly}
      onListAddableParts={handleListAddableParts}
      onAddExistingPart={handleAddExistingPart}
      onFindInRepo={handleFindInRepo}
      canCommit={assemblyDoc.source === 'git' && (!gitBaseline || !!sourceDirty)}
      onGitCommit={handleGitCommit}
      onForceMerge={handleForceMerge}
      behindPartIds={behindPartIdSet}
      assemblyBehind={!!behindMarkers.assemblyBehind}
      assemblyPath={gitAssemblyPath || ''}
      onBehindChoice={handleBehindChoice}
      currentBranch={assemblyDoc.source === 'git' ? (gitBaseline?.branch || 'main') : ''}
      onListBranches={handleListBranches}
      onSwitchBranch={handleSwitchBranch}
      suggestNewPartPath={
        assemblyDoc.source === 'git'
          ? suggestNewPartPath(assemblyDoc.name, assemblyDoc.parts)
          : ''
      }
    />
  ) : null;

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
    const isPartsStage = useStages && mobileStage === 'parts';

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
              assemblyName={assemblyLabel}
              onRenameFile={handleRenameFile}
              onRenameAssembly={handleRenameAssembly}
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
              onFeatureOpen={handleFeatureOpen}
              onCommitContourProfile={handleCommitContourProfile}
              onCommitFillet={handleCommitFillet}
              onCommitShell={handleCommitShell}
              onCommitDraft={handleCommitDraft}
              onCommitCut={handleCommitCut}
              onCommitBoolean={handleCommitBoolean}
              onCommitMove={handleCommitMove}
              onCommitMoveFace={handleCommitMoveFace}
              onCommitDeleteFace={handleCommitDeleteFace}
              getHelperBuffer={() => codeEditorRef.current?.getContent?.() || ''}
              cadToolbarHost={cadToolbarHost}
              onRunAssembly={() => {
                const code = codeEditorRef.current?.getContent?.();
                if (code == null) return false;
                setCurrentScript(code);
                return refreshAssemblyRef.current?.(code);
              }}
              featureSheetEnabled={useStages && isCadStage && !featureSheet}
              onFeatureLongPress={openFeatureSheetFromCad}
              onPickRetarget={handlePickRetarget}
              onRunOutcome={handleRunOutcome}
              getBooleanContext={assemblyPartContext}
              onFeatureSessionChange={handleFeatureSession}
              partLabels={partLabels}
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
                    className="absolute inset-x-0 top-20 z-20 pointer-events-auto flex"
                    data-cad-feature-strip=""
                    data-feature-strip-placement="under-ribbon-horizontal"
                    data-feature-strip-gap="name-2x"
                    data-feature-bar-row="full"
                  >
                    <FeatureStrip
                      orientation="horizontal"
                      script={stripScript}
                      bodyCount={stripBodyCount}
                      failedIds={stripFailedIds}
                      hidden={featureSession}
                      activeId={featureSheet?.feature?.id || featureStripActiveId}
                      hideWhenEmpty
                      onJump={(f) => openFeatureSheetFor(f)}
                      onUndo={handleUndo}
                      onRedo={handleRedo}
                      canUndo={canUndo()}
                      canRedo={canRedo()}
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
                          script={stripScript}
                          bodyCount={stripBodyCount}
                          failedIds={stripFailedIds}
                          hidden={featureSession}
                          activeId={featureSheet?.feature?.id || featureStripActiveId}
                          onJump={handleFeatureStripJump}
                        />
                      </div>
                    </div>
                  )}
                </div>
                {aiRow}
              </div>
              <div
                className={`absolute inset-0 flex min-h-0 flex-col ${
                  isPartsStage ? 'z-10' : 'invisible pointer-events-none'
                }`}
                data-stage-pane="parts"
                aria-hidden={!isPartsStage}
              >
                {partFeed}
              </div>

              {/* C.1: feature sheets — full-width under-title, CAD + Script stages. */}
              {featureSheet?.mode === 'picker' && (
                <FeatureSheet
                  features={listFeatureSheetTargets(currentScript)}
                  script={currentScript}
                  failedIds={sheetFailedIds}
                  onCancel={closeFeatureSheet}
                  onPickFeature={(f) => openFeatureSheetFor(f)}
                />
              )}
              {featureSheet?.mode === 'edit' && featureSheet.feature && (
                <FeatureSheet
                  feature={featureSheet.feature}
                  script={currentScript}
                  failedIds={sheetFailedIds}
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
          {gitBehindToast && !uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md" data-git-behind-toast="">
              <ErrorPopup
                tone="warn"
                onDismiss={() => setGitBehindToast(null)}
                className="px-4 py-2"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span data-git-behind-toast-msg="">{gitBehindToast.message}</span>
                  <button
                    type="button"
                    data-git-behind-toast-parts=""
                    className="shrink-0 rounded-md bg-amber-500/30 px-2 py-0.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/45"
                    onClick={() => {
                      setMobileStageSticky('parts');
                      setGitBehindToast(null);
                    }}
                  >
                    Parts
                  </button>
                </div>
              </ErrorPopup>
            </div>
          )}
        </div>
    );
  }

  return (
      <div className="flex h-dvh bg-gray-900">
        {appMode !== 'game' && (
          <div data-parts-feed-placement="desktop-left" className="h-full shrink-0">
            {partFeed}
          </div>
        )}
        <div ref={splitShellRef} className="relative flex h-full min-w-0 flex-1">
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
                script={stripScript}
                bodyCount={stripBodyCount}
                failedIds={stripFailedIds}
                hidden={featureSession}
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
            assemblyName={assemblyLabel}
            onRenameFile={handleRenameFile}
            onRenameAssembly={handleRenameAssembly}
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
            onFeatureOpen={handleFeatureOpen}
            onCommitContourProfile={handleCommitContourProfile}
            onCommitFillet={handleCommitFillet}
              onCommitShell={handleCommitShell}
              onCommitDraft={handleCommitDraft}
              onCommitCut={handleCommitCut}
              onCommitBoolean={handleCommitBoolean}
              onCommitMove={handleCommitMove}
              onCommitMoveFace={handleCommitMoveFace}
              onCommitDeleteFace={handleCommitDeleteFace}
            getHelperBuffer={() => codeEditorRef.current?.getContent?.() || ''}
            cadToolbarHost={cadToolbarHost}
            onRunAssembly={() => {
              const code = codeEditorRef.current?.getContent?.();
              if (code == null) return false;
              setCurrentScript(code);
              return refreshAssemblyRef.current?.(code);
            }}
            onPickRetarget={handlePickRetarget}
            onRunOutcome={handleRunOutcome}
            getBooleanContext={assemblyPartContext}
            onFeatureSessionChange={handleFeatureSession}
            partLabels={partLabels}
          />
          {/* Feature sheets live INSIDE the viewer on desktop: the seam strip
              stays put, and editing a feature happens over the model it
              changes rather than over the script. */}
          {appMode !== 'game' && featureSheet?.mode === 'edit' && featureSheet.feature && (
            <FeatureSheet
              placement="viewport"
              feature={featureSheet.feature}
              script={currentScript}
              failedIds={sheetFailedIds}
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
          {gitBehindToast && !uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md" data-git-behind-toast="">
              <ErrorPopup
                tone="warn"
                onDismiss={() => setGitBehindToast(null)}
                className="px-4 py-2"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span data-git-behind-toast-msg="">{gitBehindToast.message}</span>
                  <button
                    type="button"
                    data-git-behind-toast-parts=""
                    className="shrink-0 rounded-md bg-amber-500/30 px-2 py-0.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/45"
                    onClick={() => {
                      setMobileStageSticky('parts');
                      setGitBehindToast(null);
                    }}
                  >
                    Parts
                  </button>
                </div>
              </ErrorPopup>
            </div>
          )}
        </div>
      </div>
  );
};

export default App;
