import type { ReactNode } from 'react';
import { LanguageSwitcher } from '../i18n/I18nProvider';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-card__top-row">
          <div className="brand brand--large">Kafkasino</div>
          <LanguageSwitcher />
        </div>
        <h1 className="auth-card__title">{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
