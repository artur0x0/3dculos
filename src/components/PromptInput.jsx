// components/PromptInput.jsx
import React, { useState, useRef } from 'react';
import { Send, Loader2, X } from 'lucide-react';
import { SYSTEM_PROMPT } from '../systemPrompt';

const MAX_HISTORY = 10; // Keep last 10 messages for context

const PromptInput = ({ onCodeGenerated, currentCode, selectedFace, onClearFaceSelection, isMobile }) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const textareaRef = useRef(null);

  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
    adjustHeight();
  };

  const formatFaceContext = (face) => {
    if (!face) return '';
    
    return `
SELECTED FACE CONTEXT:
The user has selected a face on the 3D model with these properties:
- Face center position: [${face.center[0].toFixed(2)}, ${face.center[1].toFixed(2)}, ${face.center[2].toFixed(2)}]
- Face normal (outward direction): [${face.normal[0].toFixed(3)}, ${face.normal[1].toFixed(3)}, ${face.normal[2].toFixed(3)}]
- Face area: ${face.area.toFixed(2)} square units

When the user references "this face", "the selected face", or "here", they mean this face.
You can use the face center for positioning new geometry and the normal for orientation.
`;
  };

  const buildMessages = (userMessage) => {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT }
    ];

    // Add conversation history (last MAX_HISTORY messages)
    const recentHistory = conversationHistory.slice(-MAX_HISTORY);
    messages.push(...recentHistory);

    // Add context about current code if it exists
    let contextualMessage = userMessage;
    if (currentCode && currentCode.trim().length > 0) {
      contextualMessage = `Current code in editor:
\`\`\`javascript
${currentCode}
\`\`\`

User request: ${userMessage}

You can choose to modify the existing code or create something completely new based on what makes the most sense for this request. Always return a complete, executable script that returns a single Manifold object.`;
    }

    // Add face selection context if available
    if (selectedFace) {
      contextualMessage = formatFaceContext(selectedFace) + '\n\n' + contextualMessage;
    }

    messages.push({ role: 'user', content: contextualMessage });

    return messages;
  };

  const extractCode = (response) => {
    // Extract code from markdown code block
    const match = response.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
    if (!match) {
      // If no code block found, check if the entire response looks like code
      if (response.includes('Manifold') || response.includes('return')) {
        return response.trim();
      }
      return null;
    }
    
    return match[1].trim();
  };

  const validateCode = (code) => {
    // Basic validation to ensure the code returns something
    if (!code.includes('return')) {
      throw new Error('Generated code must include a return statement');
    }
    
    // Check if it uses Manifold
    if (!code.includes('Manifold') && !code.includes('cube') && 
        !code.includes('sphere') && !code.includes('cylinder')) {
      throw new Error('Code must use Manifold library functions');
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    setError(null);
    setIsLoading(true);
    const userMessage = input.trim();

    try {
      const messages = buildMessages(userMessage);

      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: messages,
          temperature: 0.7,
          max_tokens: 2048,
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const assistantResponse = data.choices[0].message.content;
      const code = extractCode(assistantResponse);

      if (code && validateCode(code)) {
        // Update conversation history
        setConversationHistory(prev => [
          ...prev,
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantResponse }
        ]);

        onCodeGenerated(code, userMessage);

        // Clear face selection after using it
        if (selectedFace) {
          onClearFaceSelection?.();
        }

        setInput('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      } else {
        setError('No valid code generated. Try being more specific about the shape you want.');
      }
    } catch (err) {
      console.error('Error generating code:', err);
      if (err.message.includes('401')) {
        setError('Invalid API key. Please check your VITE_GROQ_API_KEY');
      } else if (err.message.includes('429')) {
        setError('Rate limit exceeded. Please wait a moment and try again.');
      } else {
        setError(err.message || 'Failed to generate code. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="border-t border-gray-700/50 bg-[#1e1e1e] p-3">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        {error && (
          <div className="text-xs text-red-400 px-2">
            {error}
          </div>
        )}
        {selectedFace && (
          <div className="flex items-center justify-left bg-yellow-500/10 border border-yellow-500/30 rounded py-2">
            <button
              type="button"
              onClick={onClearFaceSelection}
              className="text-yellow-200 hover:text-yellow-100 px-3"
            >
              <X size={14} />
            </button>
            <span className="text-xs text-yellow-200">
              Face selected - try "add a hole" or "add a boss"
            </span>
          </div>
        )}
        {conversationHistory.length > 0 && (
          <div className="text-xs text-gray-200 px-2">
            {conversationHistory.filter(m => m.role === 'user').length} messages
          </div>
        )}
        <div className="flex gap-2 items-center">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              selectedFace 
                ? "Describe what to do on the selected face..." 
                : "Describe a shape to create or modify..."
            }
            rows={1}
            className="flex-1 bg-[#1e1e1e] text-gray-200 rounded px-3 py-2 text-base border border-gray-600 opacity-50 focus:outline-none focus:ring-1 focus:ring-white focus:border-transparent focus:opacity-100 placeholder-gray-500 resize-none overflow-hidden"
            disabled={isLoading}
          />
          {!isMobile && (
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="h-[38px] px-3 bg-[#1e1e1e] text-white rounded border border-gray-600 enabled:hover:ring-1 enabled:hover:ring-white enabled:hover:border-transparent disabled:opacity-50 transition-colors"
            >
              {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default PromptInput;
