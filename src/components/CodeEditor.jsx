// components/CodeEditor.jsx
import React, { useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import FileToolbar from './FileToolbar';
import PromptInput from './PromptInput';

const DEFAULT_SCRIPT = `// CAD Script
const {cube, sphere} = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
const result = box.subtract(ball);
return result;`;

const CodeEditor = ({ onExecute, onCodeChange, onUndo, onRedo, canUndo, canRedo, selectedFace, onClearFaceSelection, isMobile=false }) => {
  const [editorValue, setEditorValue] = useState(DEFAULT_SCRIPT);
  const editorRef = useRef();
  const historyTimeoutRef = useRef(null);

  const handleEditorChange = (newValue) => {
    setEditorValue(newValue);
    onExecute(newValue);
    
    // Debounce history saving - only save after 1 second of no typing
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

  const handleCodeGenerated = (code, promptMessage) => {
    setEditorValue(code);
    onExecute(code, true);
    onCodeChange?.(code, promptMessage);
  };

  const handleLoadFile = (content) => {
    setEditorValue(content);
    onExecute(content);
    onCodeChange?.(content, 'File loaded');
  };

  const getEditorContent = () => editorValue;

  const editorDidMount = (editor) => {
    editorRef.current = editor;
    editor.focus();
    onExecute(DEFAULT_SCRIPT);
    onCodeChange?.(DEFAULT_SCRIPT, 'Initial script');
  };

  const options = {
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    fontSize: 14,
    renderLineHighlight: 'all',
    formatOnPaste: true,
    contextmenu: true,
  };

  return (
    <div className="relative flex flex-col h-full bg-gray-900">
      <FileToolbar
        onLoadFile={handleLoadFile}
        getEditorContent={getEditorContent}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
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
      <PromptInput 
        onCodeGenerated={handleCodeGenerated}
        currentCode={editorValue}
        selectedFace={selectedFace}
        onClearFaceSelection={onClearFaceSelection}
        isMobile={isMobile}
      />
    </div>
  );
};

export default CodeEditor;