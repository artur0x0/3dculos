// New: components/LoginModal.jsx
// New component wrapping AuthStep, similar to OrderModal.

import React, { useState } from 'react';
import { X } from 'lucide-react';
import AuthStep from './order/AuthStep';
import { saveEditorState, getAccountReturnUrl } from '../utils/editorStorage';

const LoginModal = ({ onClose, onComplete, currentScript, currentFilename }) => {
  const [error, setError] = useState(null);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#1e1e1e] rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col border border-gray-700/50">
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white">Login</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700/50 rounded-lg transition-colors">
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mx-5 mt-4 p-3 bg-red-900/30 border border-red-500/50 rounded-lg">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-300 text-xs underline mt-1"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <AuthStep
            onComplete={onComplete}
            onOAuthRedirect={(provider) => {
              saveEditorState({ currentScript, currentFilename });
              const returnUrl = encodeURIComponent(getAccountReturnUrl());
              const fullUrl = `/api/auth/${provider}?returnTo=${returnUrl}`;
              window.location.href = fullUrl;
            }}
            onError={setError}
            orderContext={false}
          />
        </div>
      </div>
    </div>
  );
};

export default LoginModal;