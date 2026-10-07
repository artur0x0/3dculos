// main.js
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import GitCallback from './components/GitCallback';
import { AuthProvider } from './hooks/useAuth';
import { GITHUB_CALLBACK_PATH } from './utils/git/githubAuth.js';

const root = createRoot(document.getElementById('root'));
const isGitCallback = window.location.pathname.replace(/\/$/, '') === GITHUB_CALLBACK_PATH;

// GitCallback stays outside StrictMode: Strict remount double-fires the
// OAuth effect and would clear sessionStorage state before the exchange.
root.render(
  isGitCallback ? (
    <GitCallback />
  ) : (
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  ),
);
