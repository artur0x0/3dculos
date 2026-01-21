// utils/scriptValidator.js

/**
 * Blocked patterns that could be used for malicious purposes.
 * 
 * SECURITY PHILOSOPHY: Defense in depth with:
 * 1. Blocklist of dangerous API patterns
 * 2. Block global object access entirely
 * 3. Block prototype/constructor manipulation (sandbox escape)
 * 4. Block obfuscation techniques
 * 5. Strict mode enforcement
 */
const BLOCKED_PATTERNS = [
  // ============================================
  // DIRECT DANGEROUS API ACCESS
  // ============================================
  
  // DOM access
  { pattern: /\bdocument\b/, reason: 'DOM access (document)' },
  { pattern: /\bgetElementById\b/, reason: 'DOM access' },
  { pattern: /\bquerySelector\b/, reason: 'DOM access' },
  { pattern: /\binnerHTML\b/, reason: 'DOM manipulation' },
  { pattern: /\bouterHTML\b/, reason: 'DOM manipulation' },
  
  // Network
  { pattern: /\bfetch\b/, reason: 'Network access (fetch)' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'Network access (XMLHttpRequest)' },
  { pattern: /\bWebSocket\b/, reason: 'Network access (WebSocket)' },
  { pattern: /\bEventSource\b/, reason: 'Network access (EventSource)' },
  { pattern: /\bsendBeacon\b/, reason: 'Network access (sendBeacon)' },
  
  // Storage
  { pattern: /\blocalStorage\b/, reason: 'Storage access (localStorage)' },
  { pattern: /\bsessionStorage\b/, reason: 'Storage access (sessionStorage)' },
  { pattern: /\bindexedDB\b/, reason: 'Storage access (indexedDB)' },
  { pattern: /\bcaches\b/, reason: 'Storage access (Cache API)' },
  { pattern: /\bcookie\b/, reason: 'Cookie access' },
  
  // Code execution
  { pattern: /\beval\b/, reason: 'Dynamic code execution (eval)' },
  { pattern: /\bFunction\b/, reason: 'Function constructor' },
  { pattern: /\bimport\s*\(/, reason: 'Dynamic import' },
  { pattern: /\bsetTimeout\b/, reason: 'setTimeout (use requestAnimationFrame for animations)' },
  { pattern: /\bsetInterval\b/, reason: 'setInterval' },
  
  // Workers
  { pattern: /\bWorker\b/, reason: 'Worker creation' },
  { pattern: /\bSharedWorker\b/, reason: 'SharedWorker' },
  { pattern: /\bServiceWorker\b/, reason: 'ServiceWorker' },
  
  // Messaging
  { pattern: /\bpostMessage\b/, reason: 'Cross-origin messaging' },
  { pattern: /\bBroadcastChannel\b/, reason: 'Broadcast messaging' },
  
  // Navigation
  { pattern: /\blocation\b/, reason: 'Location access' },
  { pattern: /\bhistory\b/, reason: 'History API' },
  { pattern: /\bnavigator\b/, reason: 'Navigator access' },
  
  // Clipboard, etc
  { pattern: /\bclipboard\b/, reason: 'Clipboard access' },
  { pattern: /\bgeolocation\b/, reason: 'Geolocation' },
  { pattern: /\bmediaDevices\b/, reason: 'Media devices' },
  
  // ============================================
  // GLOBAL OBJECT ACCESS - BLOCK ALL
  // (prevents window['fetch'], self.eval, etc)
  // ============================================
  
  { pattern: /\bglobalThis\b/, reason: 'globalThis access' },
  { pattern: /\bself\b/, reason: 'self access' },
  { pattern: /\bframes\b/, reason: 'frames access' },
  { pattern: /\btop\b/, reason: 'top access' },
  { pattern: /\bparent\b/, reason: 'parent access' },

  // Block any property access on window except the allowed one
  // This catches window.somethingElse, window['anything'], etc.
  { pattern: /\bwindow\b(?!\s*\.\s*__importedManifolds\b)/, reason: 'Window access' },
  { pattern: /\bwindow\s*\.\s*(?!(?:__importedManifolds\b|constructor\b|$))/, reason: 'Access to non-allowed window properties' },
  { pattern: /\bwindow\s*\[\s*(?!(?:"__importedManifolds"|'__importedManifolds'|__importedManifolds\b))/, reason: 'Bracket access to non-allowed window properties' },
  
  // Still block dangerous constructor / prototype things
  { pattern: /__proto__/, reason: '__proto__ access' },
  { pattern: /\.prototype\b/, reason: 'prototype access' },
  
  // ============================================
  // PROTOTYPE & CONSTRUCTOR (sandbox escape)
  // ============================================
  
  { pattern: /__proto__/, reason: '__proto__ access' },
  { pattern: /\.prototype\b/, reason: 'prototype access' },
  { pattern: /\bprototype\b/, reason: 'prototype keyword' },
  { pattern: /\.constructor\b/, reason: 'constructor access' },
  { pattern: /\bsetPrototypeOf\b/, reason: 'setPrototypeOf' },
  { pattern: /\bgetPrototypeOf\b/, reason: 'getPrototypeOf' },
  { pattern: /\bdefineProperty\b/, reason: 'defineProperty' },
  { pattern: /\bdefineProperties\b/, reason: 'defineProperties' },
  { pattern: /\bgetOwnPropertyDescriptor\b/, reason: 'getOwnPropertyDescriptor' },
  
  // ============================================
  // REFLECTION & PROXY
  // ============================================
  
  { pattern: /\bReflect\b/, reason: 'Reflect API' },
  { pattern: /\bProxy\b/, reason: 'Proxy' },
  
  // ============================================
  // THIS BINDING TRICKS
  // ============================================
  
  { pattern: /\.call\s*\(\s*(null|undefined|void)/, reason: 'call() with null/undefined this' },
  { pattern: /\.apply\s*\(\s*(null|undefined|void)/, reason: 'apply() with null/undefined this' },
  { pattern: /\.bind\s*\(\s*(null|undefined|void)/, reason: 'bind() with null/undefined this' },
  
  // ============================================
  // OBFUSCATION TECHNIQUES
  // ============================================
  
  // String building to bypass detection
  { pattern: /\[\s*['"`].*['"`]\s*\+/, reason: 'String concatenation in brackets (obfuscation)' },
  { pattern: /\+\s*['"`].*['"`]\s*\]/, reason: 'String concatenation in brackets (obfuscation)' },
  { pattern: /String\.fromCharCode/, reason: 'String.fromCharCode (obfuscation)' },
  { pattern: /String\.fromCodePoint/, reason: 'String.fromCodePoint (obfuscation)' },
  
  // Escape sequences in identifiers
  { pattern: /\\x[0-9a-fA-F]{2}/, reason: 'Hex escape (obfuscation)' },
  { pattern: /\\u[0-9a-fA-F]{4}/, reason: 'Unicode escape (obfuscation)' },
  { pattern: /\\u\{[0-9a-fA-F]+\}/, reason: 'Unicode escape (obfuscation)' },
  
  // Encoding tricks
  { pattern: /\batob\b/, reason: 'atob (base64 decode)' },
  { pattern: /\bbtoa\b/, reason: 'btoa (base64 encode)' },
  
  // Scope manipulation
  { pattern: /\bwith\s*\(/, reason: 'with statement' },
  
  // ============================================
  // MISC DANGEROUS
  // ============================================
  
  { pattern: /\bdebugger\b/, reason: 'debugger statement' },
  { pattern: /\bimportScripts\b/, reason: 'importScripts' },
];

/**
 * Remove string literals to avoid false positives
 */
const removeStringLiterals = (code) => {
  return code
    .replace(/`(?:[^`\\]|\\.)*`/g, '`__STR__`')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"__STR__"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'__STR__'");
};

/**
 * Remove comments from code
 */
const removeComments = (code) => {
  let result = code.replace(/\/\/.*$/gm, '');
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
};

/**
 * Check if a line is a comment
 */
const isComment = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
};

/**
 * Validate a script for dangerous patterns.
 * Returns { valid: true } or { valid: false, errors: [...] }
 */
export const validateScript = (script) => {
  const errors = [];
  
  // Preprocess: remove comments and string literals
  let processedScript = removeComments(script);
  processedScript = removeStringLiterals(processedScript);
  
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(processedScript)) {
      // Find line number
      const lines = script.split('\n');
      let lineNumber = -1;
      
      for (let i = 0; i < lines.length; i++) {
        if (isComment(lines[i])) continue;
        const processedLine = removeStringLiterals(lines[i]);
        if (pattern.test(processedLine)) {
          lineNumber = i + 1;
          break;
        }
      }
      
      errors.push({
        reason,
        pattern: pattern.toString(),
        line: lineNumber > 0 ? lineNumber : undefined
      });
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  
  return { valid: true };
};

/**
 * Format validation errors for display
 */
export const formatValidationErrors = (errors) => {
  if (errors.length === 1) {
    const err = errors[0];
    return `Blocked: ${err.reason}${err.line ? ` (line ${err.line})` : ''}`;
  }
  
  const displayed = errors.slice(0, 5);
  const remaining = errors.length - displayed.length;
  
  let message = `Blocked ${errors.length} dangerous patterns:\n` + 
    displayed.map(err => `  • ${err.reason}${err.line ? ` (line ${err.line})` : ''}`).join('\n');
  
  if (remaining > 0) {
    message += `\n  ... and ${remaining} more`;
  }
  
  return message;
};

/**
 * Wrap script in strict mode to prevent 'this' leaking to global
 */
export const wrapInStrictMode = (script) => {
  return `"use strict";\n${script}`;
};

export default validateScript;
