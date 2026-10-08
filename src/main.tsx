import { Analytics } from '@vercel/analytics/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { prefetchPenSounds } from './audio/touch';
import './styles.css';

// Fetch shared piano samples before the first mark on either page.
void prefetchPenSounds().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>,
);
