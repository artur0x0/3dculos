// components/MonacoEditor.js
import React, { useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import FileToolbar from './FileToolbar';

// Initial example script
const DEFAULT_SCRIPT = `// CAD Script
const {cube, sphere} = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
const result = box.subtract(ball);
return result;`;

const CodeEditor = ({ onExecute }) => {
    const [editorValue, setEditorValue] = useState(DEFAULT_SCRIPT);
    const editorRef = useRef()

    const handleEditorChange = (newValue) => {
        setEditorValue(newValue);
        onExecute(newValue);
    };

    const handleLoadFile = (content) => {
        console.log('Loading new file content into editor');
        setEditorValue(content);
        onExecute(content);
    };

    const getEditorContent = () => {
        return editorValue;
    };

    const editorDidMount = (editor) => {
        editorRef.current = editor
        console.log('Editor mounted', editor);
        editor.focus();
        
        // Execute initial script
        console.log('[MonacoEditor] Executing initial script');
        onExecute(DEFAULT_SCRIPT);
    };

    const options = {
        automaticLayout: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        roundedSelection: false,
        contextmenu: true,
        fontSize: 14,
        renderLineHighlight: 'all',
        formatOnPaste: true,
        scrollbar: {
            useShadows: false,
            verticalHasArrows: true,
            horizontalHasArrows: true,
            vertical: 'visible',
            horizontal: 'visible'
        }
    };

    return (
        <div className="flex flex-col h-full bg-gray-900 relative overflow-visible">
            <FileToolbar
                onLoadFile={handleLoadFile}
                getEditorContent={getEditorContent}
            />
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
    );
};

export default CodeEditor;