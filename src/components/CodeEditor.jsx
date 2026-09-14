import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import Editor from '@monaco-editor/react';
import { SquareDashedBottomCode } from 'lucide-react';
import Toolbar from './Toolbar';

// "Select All" in the (long-press) context menu. Monaco 0.52 removed
// registerEditorAction from the public API, so we use the internal
// EditorAction class (same pattern Monaco's own contextmenu contribution
// uses) — this registers a command + the menu item in one shot.
import { EditorAction, registerEditorAction } from 'monaco-editor/esm/vs/editor/browser/editorExtensions.js';

let selectAllMenuRegistered = false;
function registerSelectAllMenu() {
  if (selectAllMenuRegistered) return;
  selectAllMenuRegistered = true;
  class SelectAllAction extends EditorAction {
    constructor() {
      super({
        id: 'surfcad.selectAll',
        label: 'Select All',
        contextMenuOpts: { group: '2_cutcopypaste' },
      });
    }
    run(accessor, editor) {
      editor.focus();
      editor.trigger('menu', 'editor.action.selectAll', null);
    }
  }
  registerEditorAction(SelectAllAction);
}

const CodeEditor = forwardRef(({ 
  initialScript,
  onExecute, 
  onCodeChange,
  isMobile,
  // Slice 08: game action bar lives in this mid-strip (between Monaco and viewport
  // on mobile stack; Monaco header on desktop). CAD chrome stays in Viewport.
  mode = 'cad',
  onExitGame,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  isExecuting = false,
  onRun,
  onHint,
  onPickPuzzle,
  gameElapsedMs = 0,
  gameSuccess = false,
  gameBestTimeMs = null,
}, ref) => {
  const [editorValue, setEditorValue] = useState(initialScript);
  const editorRef = useRef(null);
  const valueRef = useRef(initialScript);
  const historyTimeoutRef = useRef(null);
  const programmaticValueRef = useRef(null);
  /** True while insertAtCursor runs executeEdits (sync onChange must not double-fire). */
  const paletteInsertRef = useRef(false);
  const isGame = mode === 'game';

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    getContent: () => valueRef.current,
    
    loadContent: (content, message = 'Content loaded', addToHistory = true) => {
      // Cancel any pending history timeout
      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
        historyTimeoutRef.current = null;
      }
      
      // Mark this value as programmatic so handleEditorChange ignores it
      programmaticValueRef.current = content;
      
      // Update state and ref
      valueRef.current = content;
      setEditorValue(content);
      
      onExecute(content, true);
      
      // Optionally add to history
      if (addToHistory) {
        onCodeChange?.(content, message);
      }
    },

    // Update the text WITHOUT re-executing. Used by the headless review loop so the
    // editor shows the exact source that produced the picture on screen. Deliberately
    // not loadContent(): that fires onExecute, which would re-run what we just ran.
    //
    // No-op when the buffer already holds this exact source. Compared against the live
    // model rather than the cached valueRef so a debounced manual edit that has not
    // flushed yet cannot trick us into a redundant write (which would disturb the cursor,
    // scroll position, and Monaco's undo stack for no reason).
    // Returns true if it wrote, false if it declined as already-current.
    setTextOnly: (content) => {
      if (typeof content !== 'string') return false;
      const current = editorRef.current ? editorRef.current.getValue() : valueRef.current;
      if (current === content) return false;          // already what we wanted: nothing to do

      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
        historyTimeoutRef.current = null;
      }
      programmaticValueRef.current = content;   // so handleEditorChange ignores this write
      valueRef.current = content;
      setEditorValue(content);
      editorRef.current?.setValue(content);
      return true;
    },

    /**
     * Slice 09: insert text at the Monaco cursor (replaces selection if any).
     * Syncs React state, triggers execute + history. Returns true on success.
     */
    insertAtCursor: (text) => {
      if (typeof text !== 'string' || text.length === 0) return false;
      const ed = editorRef.current;

      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
        historyTimeoutRef.current = null;
      }

      if (ed) {
        const selection = ed.getSelection();
        const range = selection
          || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
        // Flag BEFORE executeEdits — Monaco fires onChange synchronously.
        paletteInsertRef.current = true;
        try {
          ed.executeEdits('helper-palette', [{
            range,
            text,
            forceMoveMarkers: true,
          }]);
          const content = ed.getValue();
          valueRef.current = content;
          setEditorValue(content);
          onExecute(content);
          onCodeChange?.(content, 'Helper insert');
          try {
            const pos = ed.getPosition();
            if (pos) ed.revealPositionInCenter(pos);
            ed.focus();
          } catch { /* ignore */ }
          return true;
        } finally {
          paletteInsertRef.current = false;
        }
      }

      // Editor not mounted yet — append / replace buffer via state.
      const current = valueRef.current || '';
      const content = current.trim()
        ? `${current}${current.endsWith('\n') ? '' : '\n'}${text}`
        : text;
      programmaticValueRef.current = content;
      valueRef.current = content;
      setEditorValue(content);
      onExecute(content);
      onCodeChange?.(content, 'Helper insert');
      return true;
    },
  }));

  const handleEditorChange = (newValue) => {
    // Always sync state and ref
    valueRef.current = newValue;
    setEditorValue(newValue);

    // Palette insert owns execute + history (executeEdits fires this sync).
    if (paletteInsertRef.current) {
      return;
    }

    onExecute(newValue);
    
    // If this change came from loadContent, skip history handling
    if (programmaticValueRef.current === newValue) {
      programmaticValueRef.current = null;
      return;
    }
    programmaticValueRef.current = null;
    
    // Debounced history for manual edits
    if (historyTimeoutRef.current) {
      clearTimeout(historyTimeoutRef.current);
    }
    
    historyTimeoutRef.current = setTimeout(() => {
      onCodeChange?.(newValue, 'Manual edit');
      historyTimeoutRef.current = null;
    }, 1000);
  };

  const editorDidMount = (editor, monaco) => {
    editorRef.current = editor;

    // iOS Safari: programmatic focus on mount marks the editor focused
    // without opening the soft keyboard, so the first user tap is a no-op.
    // Only auto-focus on fine pointers; on touch, focus inside the gesture.
    const coarse = typeof window !== 'undefined'
      && !!window.matchMedia?.('(pointer: coarse)').matches;
    if (!coarse && !isMobile) {
      editor.focus();
    } else {
      const dom = editor.getDomNode();
      const focusFromGesture = () => {
        editor.focus();
        const ta = dom?.querySelector?.('textarea.inputarea');
        if (ta && document.activeElement !== ta) {
          try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
        }
      };
      // touchend stays within the user-gesture window on iOS; click covers pencil/mouse.
      dom?.addEventListener('touchend', focusFromGesture, { passive: true });
      dom?.addEventListener('click', focusFromGesture);
      editor.onDidDispose(() => {
        dom?.removeEventListener('touchend', focusFromGesture);
        dom?.removeEventListener('click', focusFromGesture);
      });
    }

    // Add "Select All" to the editor context menu (once).
    // Never let an optional menu feature crash the mount.
    try {
      registerSelectAllMenu();
    } catch (err) {
      console.warn('[CodeEditor] Select All menu registration failed', err);
    }

    // Guarantee Select-All works even if a parent element swallows
    // Ctrl/Cmd+A (e.g. mobile webview).
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA,
      () => {
        editor.focus();
        editor.trigger('keybinding', 'editor.action.selectAll', null);
      }
    );

    // Execute initial script and add to history
    onExecute(valueRef.current, true);
    
    onCodeChange?.(valueRef.current, 'Initial script');
  };

  // The easy select-all: keyboard-only flow isn't discoverable on mobile.
  const selectAll = () => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    ed.trigger('select-all', 'editor.action.selectAll', null);
  };

  useEffect(() => {
    return () => {
      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
      }
    };
  }, []);

  const options = {
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'off',
    scrollBeyondLastLine: false,
    fontSize: isMobile ? 16 : 12,
    renderLineHighlight: 'all',
    formatOnPaste: true,
    contextmenu: true,
    wordWrap: 'on',
    quickSuggestions: false,
  };

  return (
    <div className="relative flex flex-col h-full bg-gray-900">
      {/* Mid-strip: Select All (icon) always; game action bar in game mode (slice 08). */}
      <div className={`flex items-center gap-1 px-1 py-0.5 border-b border-gray-700/60 bg-gray-900 shrink-0 ${
        isGame ? 'justify-between' : 'justify-end'
      }`}>
        {isGame && (
          <Toolbar
            mode="game"
            variant="strip"
            onExitGame={onExitGame}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            isExecuting={isExecuting}
            onRun={onRun}
            onHint={onHint}
            onPickPuzzle={onPickPuzzle}
            gameElapsedMs={gameElapsedMs}
            gameSuccess={gameSuccess}
            gameBestTimeMs={gameBestTimeMs}
          />
        )}
        <button
          type="button"
          onClick={selectAll}
          title="Select all text in the editor"
          aria-label="Select all text in the editor"
          className="shrink-0 p-1.5 text-gray-400 hover:text-white hover:bg-gray-700/60 rounded transition-colors"
        >
          {/* lucide-react ^0.469.0 exports SquareDashedBottomCode (preferred). */}
          <SquareDashedBottomCode size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          width="100%"
          height="100%"
          language="javascript"
          theme="vs-dark"
          value={editorValue}
          options={options}
          onChange={handleEditorChange}
          onMount={editorDidMount}
        />
      </div>
    </div>
  );
});

export default CodeEditor;
