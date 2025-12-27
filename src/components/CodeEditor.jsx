import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import Editor from '@monaco-editor/react';

const DEFAULT_SCRIPT = `// Modify CAD script directly or use the AI assistant to code for you
// It's helpful to use the assistant to get started and edit from there
// Assistant is good at iterating on an object, similar to how you would use a CAD program
// You can click on faces to guide the assistant
// When coding directly, use javascript syntax and return a single manifold object

const {cube, sphere} = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
const result = box.subtract(ball);
return result;`;

const CodeEditor = forwardRef(({ 
  onExecute, 
  onCodeChange, 
  onUndo, 
  onRedo, 
  canUndo, 
  canRedo,
  isMobile
}, ref) => {
  const [editorValue, setEditorValue] = useState(DEFAULT_SCRIPT);
  const editorRef = useRef();
  const historyTimeoutRef = useRef(null);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    getContent: () => editorValue,
    loadContent: (content, message = 'File loaded', skipHistory = false) => {
      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
      }
      setEditorValue(content);
      onExecute(content, true);
      
      // Only save to history if not using undo/redo buttons
      if (!skipHistory) {
        onCodeChange?.(content, message);
      }
    }
  }));

  const handleEditorChange = (newValue) => {
    setEditorValue(newValue);
    onExecute(newValue);
    
    if (historyTimeoutRef.current) {
      clearTimeout(historyTimeoutRef.current);
    }
    
    historyTimeoutRef.current = setTimeout(() => {
      onCodeChange?.(newValue, 'Manual edit');
    }, 1000);
  };

  const handleUndo = () => {
    const code = onUndo?.();
    if (code) {
      setEditorValue(code);
    }
  };

  const handleRedo = () => {
    const code = onRedo?.();
    if (code) {
      setEditorValue(code);
    }
  };

  const editorDidMount = (editor) => {
    editorRef.current = editor;
    editor.focus();
    onExecute(DEFAULT_SCRIPT, true);
    onCodeChange?.(DEFAULT_SCRIPT, 'Initial script');
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
    domReadOnly: false,
    readOnly: false,
  };

  return (
    <div className="relative flex flex-col h-full bg-gray-900">
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