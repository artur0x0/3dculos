import React, { useState, useEffect } from 'react';
import MonacoEditor from './components/MonacoEditor';
import Viewport from './components/Viewport';

const App: React.FC = () => {
  const [currentScript, setCurrentScript] = useState<string>('');
  const [isExecuting, setIsExecuting] = useState<boolean>(false);

  // Debug: Log initial mount
  useEffect(() => {
    console.log('[App] Component mounted');
  }, []);

  const handleExecute = async (script: string): Promise<void> => {
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

  return (
    <div className="flex h-screen bg-gray-900">
      <div className="w-1/2 border-r border-gray-700">
        <MonacoEditor
          onExecute={handleExecute}
          isExecuting={isExecuting}
        />
      </div>
      <div className="w-1/2">
        <Viewport
          width={window.innerWidth / 2}
          height={window.innerHeight}
          currentScript={currentScript}
        />
      </div>
    </div>
  );
};

export default App;