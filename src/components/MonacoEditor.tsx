import React, { useEffect, useRef, useState } from 'react';
import monaco from '../config/monacoConfig';

// Initial example script - keeping the original Manifold format
const DEFAULT_SCRIPT = `// CAD Script
const {cube, sphere} = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
const result = box.subtract(ball);
return result;`;

interface MonacoEditorProps {
  onExecute: (script: string) => Promise<void>;
  isExecuting: boolean;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ onExecute }) => {
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoEl = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number>();

  useEffect(() => {
    if (monacoEl.current && !editor) {
      console.log('[MonacoEditor] Creating editor instance');
      
      // Create editor instance
      const ed = monaco.editor.create(monacoEl.current, {
        value: DEFAULT_SCRIPT,
        language: 'typescript',
        theme: 'vs-dark',
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        fontSize: 14,
        tabSize: 2,
        renderWhitespace: 'selection',
        wordWrap: 'on'
      });
      
      setEditor(ed);

      // Execute initial script
      console.log('[MonacoEditor] Executing initial script');
      onExecute(DEFAULT_SCRIPT);

      // Set up keyboard shortcut for execution
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const script = ed.getValue();
        console.log('[MonacoEditor] Executing script via keyboard shortcut:', script);
        onExecute(script);
      });

      // Set up debounced content change listener
      ed.onDidChangeModelContent(() => {
        console.log('[MonacoEditor] Content changed, debouncing update');
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        
        debounceRef.current = setTimeout(() => {
          const currentValue = ed.getValue();
          console.log('[MonacoEditor] Debounce complete, updating script:', currentValue);
          onExecute(currentValue);
        }, 500); // 500ms debounce delay
      });
    }

    // Only dispose when component is actually unmounting
    return () => {
      if (editor && !monacoEl.current) {
        console.log('[MonacoEditor] Actually disposing editor');
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        editor.dispose();
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-gray-900">
      <div ref={monacoEl} className="flex-grow" />
    </div>
  );
};

export default MonacoEditor;