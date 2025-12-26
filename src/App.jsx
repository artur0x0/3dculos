import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';
import { saveAs } from 'file-saver';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const [currentFilename, setCurrentFilename] = useState(null);
  const viewportRef = useRef(null);
  const codeEditorRef = useRef(null);
  
  const [history, setHistory] = useState({
    branches: {
      main: {
        commits: [],
        head: -1
      }
    },
    currentBranch: 'main'
  });

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const handleExecute = (script, autoExecute=false) => {
    setCurrentScript(script);
    if (autoExecute) {
      setTimeout(() => {
        viewportRef.current?.executeScript();
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
  };

const handleUndo = () => {
    const branch = history.branches[history.currentBranch];
    if (branch.head > 0) {
      const newHead = branch.head - 1;
      const commit = branch.commits[newHead];
      
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
      
      // Update editor without creating new history
      codeEditorRef.current?.loadContent(commit.code, 'Undo', true);
      handleExecute(commit.code, true);
      return commit.code;
    }
    return null;
  };

  const handleRedo = () => {
    const branch = history.branches[history.currentBranch];
    if (branch.head < branch.commits.length - 1) {
      const newHead = branch.head + 1;
      const commit = branch.commits[newHead];
      
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
      
      // Update editor without creating new history
      codeEditorRef.current?.loadContent(commit.code, 'Redo', true);
      handleExecute(commit.code, true);
      return commit.code;
    }
    return null;
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
    setSelectedFace(null);
    viewportRef.current?.clearFaceSelection();
  };

  const handleOpen = (content, filename) => {
    codeEditorRef.current?.loadContent(content, `Loaded ${filename}`);
    setCurrentFilename(filename);
  };

  const handleSave = async () => {
    const content = codeEditorRef.current?.getContent();
    if (!content) return;

    if (window.showSaveFilePicker && typeof window.showSaveFilePicker === 'function') {
      try {
        const options = {
          suggestedName: currentFilename || 'script.js',
          types: [
            {
              description: 'JavaScript files',
              accept: { 'text/javascript': ['.js'] }
            },
            {
              description: 'Text files',
              accept: { 'text/plain': ['.txt'] }
            }
          ]
        };

        const handle = await window.showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        
        setCurrentFilename(handle.name);
        console.log('File saved successfully');
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.log('Falling back to download method');
          const blob = new Blob([content], { type: 'text/plain' });
          saveAs(blob, currentFilename || 'script.js');
        }
      }
    } else {
      console.log('File System Access API not supported, using download method');
      const blob = new Blob([content], { type: 'text/plain' });
      saveAs(blob, currentFilename || 'script.js');
    }
  };

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-gray-900">
        <div className="h-[50vh] border-b border-gray-700">
          <CodeEditor 
            ref={codeEditorRef}
            onExecute={handleExecute}
            onCodeChange={handleCodeChange}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo()}
            canRedo={canRedo()}
            selectedFace={selectedFace}
            onClearFaceSelection={handleClearFaceSelection}
            isMobile={isMobile}
          />
        </div>
        <div className="h-[50vh]">
          <Viewport 
            ref={viewportRef} 
            currentScript={currentScript}
            onFaceSelected={handleFaceSelected}
            onOpen={handleOpen}
            onSave={handleSave}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo()}
            canRedo={canRedo()}
            currentFilename={currentFilename}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-900">
      <div className="w-1/2 border-r border-gray-700">
        <CodeEditor 
          ref={codeEditorRef}
          onExecute={handleExecute}
          onCodeChange={handleCodeChange}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo()}
          canRedo={canRedo()}
          selectedFace={selectedFace}
          onClearFaceSelection={handleClearFaceSelection}
        />
      </div>
      <div className="w-1/2">
        <Viewport 
          ref={viewportRef} 
          currentScript={currentScript}
          onFaceSelected={handleFaceSelected}
          onOpen={handleOpen}
          onSave={handleSave}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo()}
          canRedo={canRedo()}
          currentFilename={currentFilename}
        />
      </div>
    </div>
  );
};

export default App;