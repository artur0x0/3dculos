// App.jsx
import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const viewportRef = useRef(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  // Branchable history state
  const [history, setHistory] = useState({
    branches: {
      main: {
        commits: [],
        head: -1
      }
    },
    currentBranch: 'main'
  });

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

  const handleFaceSelected = (faceData) => {
    setSelectedFace(faceData);
  };

  const handleClearFaceSelection = () => {
    setSelectedFace(null);
    viewportRef.current?.clearFaceSelection();
  };

  // Mobile: Stacked layout
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-gray-900">
        <div className="h-[50vh] border-b border-gray-700">
          <CodeEditor 
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
          />
        </div>
      </div>
    );
  }

  // Desktop: Side-by-side
  return (
    <div className="flex h-screen bg-gray-900">
      <div className="w-1/2 border-r border-gray-700">
        <CodeEditor 
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
        />
      </div>
    </div>
  );
};

export default App;