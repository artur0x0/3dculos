// App.jsx
import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile/tablet (screen width < 1024px)
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Debug: Log initial mount
  useEffect(() => {
    console.log('[App] Component mounted');
  }, []);

  const handleExecute = async (script) => {
    console.log('[App] handleExecute called with script:', script);
    setIsExecuting(true);
    try {
      setCurrentScript(script);
      console.log('[App] Script updated in state');
    } catch (error) {
      console.error('[App] Execution error:', error);
    } finally {
      setIsExecuting(false);
    }
  };

// Mobile: Viewport on top, Editor on bottom
if (isMobile) {
  return (
    <div className="flex flex-col h-screen bg-gray-900 overflow-hidden">
      {/* Editor: ~40% height + toolbar space */}
      <div className="h-[40vh] border-b border-gray-700">
        <CodeEditor
          onExecute={handleExecute}
          isExecuting={isExecuting}
        />
      </div>
      {/* Viewport: ~60% height */}
      <div className="h-[60vh] bg-gray-900">
        <Viewport currentScript={currentScript} />
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
        isExecuting={isExecuting}
      />
    </div>
    <div className="w-1/2">
      <Viewport currentScript={currentScript} />
    </div>
  </div>
);
};

export default App;