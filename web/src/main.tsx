import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { SoundProvider } from './audio/SoundProvider';
import { PresenceProvider } from './presence/PresenceProvider';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PresenceProvider>
          <SoundProvider>
            <App />
          </SoundProvider>
        </PresenceProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
