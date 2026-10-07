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

root.render(
  <StrictMode>
    {isGitCallback ? (
      <GitCallback />
    ) : (
      <AuthProvider>
        <App />
      </AuthProvider>
    )}
  </StrictMode>
);
