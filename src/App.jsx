import React, { useState, useEffect, useRef } from 'react';
import CodeEditor from './components/CodeEditor';
import Viewport from './components/Viewport';
import PromptInput from './components/PromptInput';
import { saveAs } from 'file-saver';
import QuoteModal from './components/QuoteModal';
import OrderModal from './components/OrderModal';
import LoginModal from './components/LoginModal';
import AccountModal from './components/AccountModal';
import { useAuth } from './hooks/useAuth';
import { 
  importFile,
} from './utils/importModel';
import { 
  hasCheckoutReturnFlag, 
  hasPendingCheckout,
  restoreCheckoutState, 
  clearCheckoutState,
  clearCheckoutReturnFlag 
} from './utils/checkoutStorage';
import { 
  hasPendingEditorState,
  restoreEditorState, 
  clearEditorState 
} from './utils/editorStorage';
import manifoldContext from './utils/ManifoldWorker';
import DEFAULT_SCRIPT from './utils/defaultScript';

const App = () => {
  const [currentScript, setCurrentScript] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [selectedFace, setSelectedFace] = useState(null);
  const [currentFilename, setCurrentFilename] = useState(null);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderData, setOrderData] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [manifoldReady, setManifoldReady] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalTab, setAccountModalTab] = useState('info');
  const [editorInitialScript, setEditorInitialScript] = useState(null);
  const [initError, setInitError] = useState(null);

  const { user, isAuthenticated, checkAuth } = useAuth();

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

  // Initialize ManifoldWorkerand handle script restoration
  useEffect(() => {
    const initManifold = async () => {
      try {
        console.log('[App] Initializing Manifold Sandbox Worker...');
        
        // Initialize the custom Manifold worker
        await manifoldContext.init();
        
        // Expose context globally
        window.ManifoldContext = manifoldContext;
        
        // Log available helper functions
        const helpers = await manifoldContext.getHelperFunctions();
        console.log('[App] Available helper functions:', helpers);
        
        setManifoldReady(true);
        console.log('[App] Manifold Sandbox Worker ready');
      } catch (error) {
        console.error('[App] Failed to initialize Manifold Sandbox:', error);
        setInitError(error.message);
      }
    };
    
    initManifold();
    
    // Cleanup on unmount
    return () => {
      manifoldContext.terminate();
    };
  }, []);

  // Single initialization effect - runs once when manifold is ready
  useEffect(() => {
    if (!manifoldReady) return;
    
    let script = DEFAULT_SCRIPT;
    let filename = null;
    let shouldOpenAccount = false;
    let restoredCheckout = null;
    
    const params = new URLSearchParams(window.location.search);
    const isAuthReturn = params.get('auth') === 'success';
    const isAccountReturn = params.get('account') === 'true';
    const isCheckoutReturn = hasCheckoutReturnFlag();
    
    console.log('[App] Initialization check:', {
      isAuthReturn,
      isAccountReturn,
      isCheckoutReturn,
      hasPendingEditor: hasPendingEditorState(),
      hasPendingCheckout: hasPendingCheckout(),
    });
    
    // Restore editor state if returning from any OAuth flow
    if ((isAuthReturn || isAccountReturn || isCheckoutReturn) && hasPendingEditorState()) {
      const restored = restoreEditorState();
      console.log('[App] Restored editor state:', {
        hasScript: !!restored?.currentScript,
        scriptLength: restored?.currentScript?.length,
      });
      if (restored?.currentScript) {
        script = restored.currentScript;
      }
      if (restored?.currentFilename) {
        filename = restored.currentFilename;
      }
      clearEditorState();
    }
    
    // Handle checkout-specific restoration
    if (isCheckoutReturn || (isAuthReturn && hasPendingCheckout())) {
      const checkoutState = restoreCheckoutState();
      if (checkoutState) {
        restoredCheckout = {
          quoteData: checkoutState.quoteData,
          modelData: checkoutState.modelData,
          restoredStep: checkoutState.currentStep,
          restoredAddress: checkoutState.address,
          restoredGuestEmail: checkoutState.guestEmail,
        };
      }
      clearCheckoutState();
    }
    
    // Determine if we should open modals
    if (isAccountReturn) {
      shouldOpenAccount = true;
    }
    
    // Clean URL
    if (isAuthReturn || isAccountReturn || isCheckoutReturn) {
      clearCheckoutReturnFlag();
    }
    
    // Set state - order matters for avoiding flicker
    if (filename) setCurrentFilename(filename);
    if (restoredCheckout) {
      setOrderData(restoredCheckout);
      setShowOrderModal(true);
    }
    if (shouldOpenAccount) setShowAccountModal(true);
    
    // Set editor script last - this enables rendering
    setEditorInitialScript(script);
    
  }, [manifoldReady]);

  // Check for mobile layout
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 768px)");

    const checkIsMobile = () => {
        setIsMobile(mediaQuery.matches);
      };

    // Initial check
    checkIsMobile();

    // Media query change (works well on desktop + some mobile scenarios)
    const onMediaChange = (e) => {
      setIsMobile(e.matches);
    };
    mediaQuery.addEventListener("change", onMediaChange);

    // Resize event – critical fallback for iOS Safari rotation
    const onResize = () => {
      // Small delay helps when toolbar sliding causes multiple rapid resizes
      const timer = setTimeout(checkIsMobile, 50);
      return () => clearTimeout(timer);
    };
    window.addEventListener("resize", onResize);

    // Cleanup
    return () => {
      mediaQuery.removeEventListener("change", onMediaChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const handleExecute = (script, autoExecute=false) => {
    setCurrentScript(script);
    if (autoExecute) {
      // Pass script directly to avoid stale closure
      setTimeout(() => {
        viewportRef.current?.executeScript(script);
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
    
    // Log after setHistory call (outside the updater)
    console.log('[App] handleCodeChange added commit:', { message, codeLength: code?.length });
  };

  const handleCodeGenerated = (code, promptMessage) => {
    // Only add to history if a prompt message if not empty
    const addToHistory = promptMessage && promptMessage.length > 0;
    codeEditorRef.current?.loadContent(code, promptMessage || 'Code generated', addToHistory);
  };

  const handleUndo = () => {
    const branch = history.branches[history.currentBranch];

    if (branch.head > 0) {
      const newHead = branch.head - 1;
      const commit = branch.commits[newHead];
      
      console.log('[App] Undoing to commit:', {
        newHead,
        commitMessage: commit.message,
        codeLength: commit.code?.length,
      });
      
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

      // Load the code from the commit
      codeEditorRef.current?.loadContent(commit.code, null, false);
    }
  };

  const handleRedo = () => {
    const branch = history.branches[history.currentBranch];

    if (branch.head < branch.commits.length - 1) {
      const newHead = branch.head + 1;
      const commit = branch.commits[newHead];
      
      console.log('[App] Redoing to commit:', {
        newHead,
        commitMessage: commit.message,
        codeLength: commit.code?.length,
      });
      
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

      // Load the code from the commit
      codeEditorRef.current?.loadContent(commit.code, null, false);
    }
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
    viewportRef.current?.clearFaceSelection();
    setSelectedFace(null);
  };

  const handleOpen = async (text, filename) => {
    try {
      console.log('[APP] Handling opening script file');
      codeEditorRef.current?.loadContent(text, `Opened ${filename}`);
      setCurrentFilename(filename);
    } catch (error) {
      console.error('[App] Open error:', error);
    }
  };

  const handleSave = () => {
    try {
      const code = codeEditorRef.current?.getContent();
      if (!code) return;
      
      const filename = currentFilename || 'model';
      const blob = new Blob([code], { type: 'text/javascript' });
      saveAs(blob, `${filename}.js`);
    } catch (error) {
      console.error('[App] Save error:', error);
    }
  };

  // Handle account button click
  const handleAccount = () => {
    if (isAuthenticated) {
      setAccountModalTab('info');
      setShowAccountModal(true);
    } else {
      setShowLoginModal(true);
    }
  };

  // Handle account modal from order flow
  const handleOpenAccount = (tab = 'info') => {
    setAccountModalTab(tab);
    setShowAccountModal(true);
  };

  // Handle login modal completion
  const handleLoginComplete = async () => {
    setShowLoginModal(false);
    await checkAuth();
  };

  // Handle quote button click
  const handleQuote = () => {
    setShowQuoteModal(true);
  };

  // Handle quote modal close
  const handleQuoteClose = () => {
    setShowQuoteModal(false);
  };

  // Handle get quote button
  const handleGetQuote = async (options) => {
    return await viewportRef.current?.calculateQuote(options);
  };

  // Handle start order
  const handleStartOrder = (quoteData, modelData) => {
    setShowQuoteModal(false);
    setOrderData({ quoteData, modelData });
    setShowOrderModal(true);
  };

  // Handle order modal close
  const handleOrderClose = () => {
    setShowOrderModal(false);
    setOrderData(null);
  };

  // Model import handler function
  const handleImport = async (file) => {
    if (!manifoldReady) {
      setUploadError('Manifold not ready. Please wait...');
      return;
    }
    
    setIsUploading(true);
    setUploadError(null);
    
    const filename = file.name;
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    
    try {
      console.log(`[App] Importing ${ext} file...`);
      
      // Unified import handles routing to frontend (STL/OBJ/3MF) or backend (STEP)
      const result = await importFile(file);
      
      // Load the generated script into the editor
      codeEditorRef.current?.loadContent(result.script, `Imported ${result.filename}`);
      
      // Set filename (without extension for display)
      setCurrentFilename(result.filename.replace(/\.[^/.]+$/, ''));
      
    } catch (error) {
      console.error('[App] Import error:', error);
      setUploadError(error.message || 'Failed to import file');
    } finally {
      setIsUploading(false);
    }
  };

  // Show error state if initialization failed
  if (initError) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center max-w-md p-6">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold mb-2">Initialization Failed</h1>
          <p className="text-gray-400 mb-4">{initError}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show loading state while Manifold initializes
  if (!manifoldReady || editorInitialScript === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
        <div className="flex flex-col h-dvh bg-gray-900 overflow-hidden">
          <div className="h-[33vh] border-b border-gray-700 flex-shrink-0">
            <CodeEditor 
              ref={codeEditorRef}
              initialScript={editorInitialScript}
              onExecute={handleExecute}
              onCodeChange={handleCodeChange}
              isMobile={isMobile}
            />
          </div>
          <div className="flex-1 min-h-0 border-b border-gray-700 overflow-hidden">
            <Viewport 
              ref={viewportRef} 
              onAccount={handleAccount}
              currentScript={currentScript}
              onFaceSelected={handleFaceSelected}
              onOpen={handleOpen}
              onSave={handleSave}
              onQuote={handleQuote}
              onUpload={handleImport}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={canUndo()}
              canRedo={canRedo()}
              currentFilename={currentFilename}
              isUploading={isUploading}
            />
          </div>
          <div className="flex-shrink-0">
            <PromptInput 
              onCodeGenerated={handleCodeGenerated}
              currentCode={codeEditorRef.current?.getContent() || ''}
              selectedFace={selectedFace}
              onClearFaceSelection={handleClearFaceSelection}
              isMobile={isMobile}
            />
          </div>

          {/* Login Modal */}
          {showLoginModal && (
            <LoginModal
              onClose={() => setShowLoginModal(false)}
              onComplete={handleLoginComplete}
              currentScript={currentScript}
              currentFilename={currentFilename}
            />
          )}
          
          {/* Account Modal */}
          {showAccountModal && (
            <AccountModal
              onClose={() => setShowAccountModal(false)}
              user={user}
              selectedTab={accountModalTab}
            />
          )}
          
          {/* Quote Modal */}
          {showQuoteModal && (
            <QuoteModal
              onClose={handleQuoteClose}
              onGetQuote={handleGetQuote}
              onOrder={handleStartOrder}
              currentScript={currentScript}
              currentFilename={currentFilename}
            />
          )}
          
          {/* Order Modal */}
          {showOrderModal && orderData && (
            <OrderModal
              onClose={handleOrderClose}
              quoteData={orderData.quoteData}
              modelData={orderData.modelData}
              currentScript={currentScript}
              restoredStep={orderData.restoredStep}
              restoredAddress={orderData.restoredAddress}
              restoredGuestEmail={orderData.restoredGuestEmail}
              onOpenAccount={handleAccount}
            />
          )}
          
          {uploadError && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
              <div className="flex items-center gap-2">
                <span>Upload Error: {uploadError}</span>
                <button 
                  onClick={() => setUploadError(null)}
                  className="ml-2 text-white hover:text-gray-200"
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
    );
  }

  return (
      <div className="flex h-dvh bg-gray-900">
        <div className="w-1/2 border-r border-gray-700 flex flex-col">
          <div className="flex-1 min-h-0">
            <CodeEditor 
              ref={codeEditorRef}
              initialScript={editorInitialScript}
              onExecute={handleExecute}
              onCodeChange={handleCodeChange}
              isMobile={isMobile}
            />
          </div>
          <div className="flex-shrink-0">
            <PromptInput 
              onCodeGenerated={handleCodeGenerated}
              currentCode={codeEditorRef.current?.getContent() || ''}
              selectedFace={selectedFace}
              onClearFaceSelection={handleClearFaceSelection}
              isMobile={false}
            />
          </div>
        </div>
        <div className="w-1/2">
          <Viewport 
            ref={viewportRef} 
            onAccount={handleAccount}
            currentScript={currentScript}
            onFaceSelected={handleFaceSelected}
            onOpen={handleOpen}
            onSave={handleSave}
            onQuote={handleQuote}
            onUpload={handleImport}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo()}
            canRedo={canRedo()}
            currentFilename={currentFilename}
            isUploading={isUploading}
          />
        </div>

        {/* Login Modal */}
        {showLoginModal && (
          <LoginModal
            onClose={() => setShowLoginModal(false)}
            onComplete={handleLoginComplete}
            currentScript={currentScript}
            currentFilename={currentFilename}
          />
        )}
        
        {/* Account Modal */}
        {showAccountModal && (
          <AccountModal
            onClose={() => setShowAccountModal(false)}
            user={user}
            selectedTab={accountModalTab}
          />
        )}
        
        {/* Quote Modal */}
        {showQuoteModal && (
          <QuoteModal
            onClose={handleQuoteClose}
            onGetQuote={handleGetQuote}
            onOrder={handleStartOrder}
            currentScript={currentScript}
            currentFilename={currentFilename}
          />
        )}
        
        {/* Order Modal */}
        {showOrderModal && orderData && (
          <OrderModal
            onClose={handleOrderClose}
            quoteData={orderData.quoteData}
            modelData={orderData.modelData}
            currentScript={currentScript}
            restoredStep={orderData.restoredStep}
            restoredAddress={orderData.restoredAddress}
            restoredGuestEmail={orderData.restoredGuestEmail}
            onOpenAccount={handleOpenAccount}
          />
        )}
        
        {uploadError && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-900/90 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
            <div className="flex items-center gap-2">
              <span>Upload Error: {uploadError}</span>
              <button 
                onClick={() => setUploadError(null)}
                className="ml-2 text-white hover:text-gray-200"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
  );
};

export default App;
