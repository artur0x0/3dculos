import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import Editor from '@monaco-editor/react';

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
  isMobile
}, ref) => {
  const [editorValue, setEditorValue] = useState(initialScript);
  const editorRef = useRef(null);
  const valueRef = useRef(initialScript);
  const historyTimeoutRef = useRef(null);
  const programmaticValueRef = useRef(null);

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
    }
  }));

  const handleEditorChange = (newValue) => {
    // Always sync state and ref
    valueRef.current = newValue;
    setEditorValue(newValue);
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
    editor.focus();

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
      <div className="flex items-center justify-end px-1 py-0.5 border-b border-gray-700/60 bg-gray-900 shrink-0">
        <button
          type="button"
          onClick={selectAll}
          title="Select all text in the editor"
          className="text-[10px] font-medium text-gray-400 hover:text-white hover:bg-gray-700/60 rounded px-1.5 py-0.5 transition-colors"
        >
          Select All
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