import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { LocaleProvider } from './app/LocaleProvider.tsx';
import { App } from './app/App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root container is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <App />
      <SpeedInsights />
    </LocaleProvider>
  </StrictMode>,
);
