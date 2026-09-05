import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Diagnostic: surface renderer crashes (stack included) so the E2E harness can
// see them through the main-process console forward.
window.addEventListener('error', (event) => {
  console.error(`RENDERER_UNCAUGHT: ${event.error?.stack ?? event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error(`RENDERER_UNHANDLED: ${event.reason?.stack ?? String(event.reason)}`);
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
