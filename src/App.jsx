import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';
import PromptInput from './components/PromptInput';
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
import manifoldContext from './utils/ManifoldWorker';
import DEFAULT_SCRIPT from './utils/defaultScript';
import {
  DEMO_PUZZLE,
  MATCH_REL_EPS,
  MATCH_VOL_FLOOR_MM3,
  SUCCESS_CLEAR_MS,
} from './utils/gamePuzzle';
import { getBestTimeMs, recordWin } from './utils/gameWins';
import GameHintsModal from './components/GameHintsModal';
import PuzzlePickerModal from './components/PuzzlePickerModal';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const [currentFilename, setCurrentFilename] = useState(null);
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

  const { user, isAuthenticated, checkAuth } = useAuth();

  const viewportRef = useRef(null);
  const codeEditorRef = useRef(null);
  const gameTimerStartRef = useRef(0);
  const successClearTimerRef = useRef(null);
  const gameRunInFlightRef = useRef(false);
  // Latest puzzle id — handleGameRun closes over render-time state; ref lets
  // verdict-time validate that the puzzle did not switch mid-run.
  const currentPuzzleRef = useRef(currentPuzzle);
  currentPuzzleRef.current = currentPuzzle;
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
    if (!manifoldReady) return;
    
    let script = DEFAULT_SCRIPT;
    let filename = null;
    let shouldOpenAccount = false;
    let restoredCheckout = null;
    
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
    }
    
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
    
  }, [manifoldReady]);

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

  /** CAD: open picker. Game toolbar List also opens picker. */
  const handleStartGame = () => {
    if (gameLoading) return;
    setShowPuzzlePicker(true);
  };

  const handlePickPuzzle = () => {
    if (gameLoading) return;
    setShowPuzzlePicker(true);
  };

  /**
   * Load a puzzle: rebuild ghost, blank editor, reset timer.
   * Used for first enter and mid-game switches.
   */
  const loadPuzzle = async (puzzle) => {
    if (!puzzle?.targetScript || gameLoading) return;
    const enteringFromCad = appMode !== 'game';
    resetGameScoring();
    setGameLoading(true);
    setGameError(null);
    setShowPuzzlePicker(false);
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
      setShowHints(false);
      setGameError(null);

      // Blank Monaco + ghost-only until Run (slice 02.1 / 05).
      // Always '' — never starter/target/demo (remount + loadContent auto-run
      // previously leaked DEMO TARGET / Solo Cup into the editor on enter).
      setCurrentScript('');
      const blankEditor = () => codeEditorRef.current?.setTextOnly?.('');
      blankEditor();
      // Layout swap (viewport top / editor bottom) remounts Monaco after this
      // tick; double window.rAF blanks after remount/paint so initialScript
      // cannot stick. (No queueMicrotask — remount is covered by rAF.)
      window.requestAnimationFrame(() => {
        blankEditor();
        window.requestAnimationFrame(blankEditor);
      });
      viewportRef.current?.clearAttempt?.();
      // Extra margin frame after layout settles (phone viewport).
      window.requestAnimationFrame(() => {
        viewportRef.current?.frameGhost?.();
      });
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
    setCurrentScript(code);
    try {
      const run = await viewportRef.current?.executeScript(code);
      if (!run) return;
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

        // Win capture is non-blocking — match UX continues even if POST fails.
        // Use puzzleIdAtRun (not live currentPuzzle) so the win keys the run that matched.
        recordWin({ puzzleId: puzzleIdAtRun, script: code, timeMs: elapsed })
          .then(({ bestTimeMs }) => {
            setGameBestTimeMs(bestTimeMs);
          })
          .catch((err) => {
            console.warn('[App] Win capture failed (non-blocking):', err);
          });

        clearSuccessTimer();
        // Default: no Submit. Brief success, then clear attempt + blank editor
        // so the same puzzle can be tried again. Timer restarts after the clear.
        successClearTimerRef.current = setTimeout(() => {
          successClearTimerRef.current = null;
          setGameSuccess(false);
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
    }
  };

  const handleGameHint = () => {
    setShowHints(true);
  };

  const handleExecute = (script, autoExecute=false) => {
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

      // Load the code from the commit
      codeEditorRef.current?.loadContent(commit.code, null, false);
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

      // Load the code from the commit
      codeEditorRef.current?.loadContent(commit.code, null, false);
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

  // Mobile game: keyboard-aware editor height from visualViewport.
  const keyboardOverlap = Math.max(0, vv.layoutHeight - vv.height - vv.offsetTop);
  const keyboardOpen = keyboardOverlap > 80;
  const mobileGameEditorPx = keyboardOpen
    ? Math.round(Math.min(Math.max(vv.height * 0.36, 120), vv.height * 0.42))
    : Math.round(Math.min(Math.max(vv.height * 0.32, 160), vv.height * 0.38));

  if (isMobile) {
    const mobileShellStyle = appMode === 'game'
      ? {
          height: vv.height,
          top: vv.offsetTop,
          left: 0,
          right: 0,
          position: 'fixed',
        }
      : undefined;

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
            />
    );

    return (
        <div
          className={`flex flex-col bg-gray-900 overflow-hidden ${appMode === 'game' ? '' : 'h-dvh'}`}
          style={mobileShellStyle}
        >
          {appMode === 'game' ? (
            <>
              {/* Slice 05: viewport TOP, Monaco BOTTOM (near keyboard) */}
              <div className="flex-1 min-h-0 border-b border-gray-700 overflow-hidden">
                {viewportEl}
              </div>
              <div
                className="flex-shrink-0 border-t border-gray-700"
                style={{ height: mobileGameEditorPx }}
              >
                <CodeEditor 
                  ref={codeEditorRef}
                  initialScript=""
                  onExecute={handleExecute}
                  onCodeChange={handleCodeChange}
                  isMobile={isMobile}
                />
              </div>
            </>
          ) : (
            <>
              <div className="h-[33vh] border-b border-gray-700 flex-shrink-0">
                <CodeEditor 
                  ref={codeEditorRef}
                  initialScript={editorInitialScript}
                  onExecute={handleExecute}
                  onCodeChange={handleCodeChange}
                  isMobile={isMobile}
                />
              </div>
              <div className="flex-1 min-h-0 border-b border-gray-700 overflow-hidden">
                {viewportEl}
              </div>
              <div className="flex-shrink-0">
                <PromptInput 
                  onCodeGenerated={handleCodeGenerated}
                  currentCode={codeEditorRef.current?.getContent() || ''}
                  selectedFace={selectedFace}
                  onClearFaceSelection={handleClearFaceSelection}
                  isMobile={isMobile}
                />
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
          {gameError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
              <div className="flex items-center gap-2">
                <span>{gameError}</span>
                <button 
                  onClick={() => setGameError(null)}
                  className="ml-2 text-white hover:text-gray-200"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
              <div className="flex items-center gap-2">
                <span>Upload Error: {uploadError}</span>
                <button 
                  onClick={() => setUploadError(null)}
                  className="ml-2 text-white hover:text-gray-200"
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
    );
  }

  return (
      <div className="flex h-dvh bg-gray-900">
        <div className="w-1/2 border-r border-gray-700 flex flex-col">
          <div className="flex-1 min-h-0">
            <CodeEditor 
              ref={codeEditorRef}
              initialScript={editorInitialScript}
              onExecute={handleExecute}
              onCodeChange={handleCodeChange}
              isMobile={isMobile}
            />
          </div>
          {appMode !== 'game' && (
            <div className="flex-shrink-0">
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
        <div className="w-1/2">
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
          />
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
        {gameError && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
            <div className="flex items-center gap-2">
              <span>{gameError}</span>
              <button 
                onClick={() => setGameError(null)}
                className="ml-2 text-white hover:text-gray-200"
              >
                ×
              </button>
            </div>
          </div>
        )}
        {uploadError && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
            <div className="flex items-center gap-2">
              <span>Upload Error: {uploadError}</span>
              <button 
                onClick={() => setUploadError(null)}
                className="ml-2 text-white hover:text-gray-200"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
  );
};

export default App;
