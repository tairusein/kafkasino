import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { SoundProvider } from './audio/SoundProvider';
import { I18nProvider } from './i18n/I18nProvider';
import { PresenceProvider } from './presence/PresenceProvider';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AuthProvider>
          <PresenceProvider>
            <SoundProvider>
              <App />
            </SoundProvider>
          </PresenceProvider>
        </AuthProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
