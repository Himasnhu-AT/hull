// A crash in one screen must not blank the window: this catches it, says in plain words what stopped, shows the error text in
// small mono and offers a way back. A new `resetKey` (the step changed) tries the screen again.
//   screen      the screen's name as the person knows it, "Share"
//   resetKey    changes when the person moves to another screen
//   backLabel   the button's text, "Go back" unless the place to go back to needs a name
//   onBack()    where Go back leads

import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';
import { crashText } from './errorText.ts';

export interface ScreenBoundaryProps { screen: string; resetKey?: string; backLabel?: string; onBack(): void; children: ReactNode }
interface State { error: unknown; failed: boolean }

export class ScreenBoundary extends Component<ScreenBoundaryProps, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State { return { error, failed: true }; }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is where a developer looks first; the screen shows the same text to the person.
    console.error(`[${this.props.screen}]`, error, info.componentStack);
  }

  override componentDidUpdate(prev: ScreenBoundaryProps): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ error: null, failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <CrashView screen={this.props.screen} error={this.state.error} backLabel={this.props.backLabel ?? 'Go back'} onBack={this.props.onBack} />;
  }
}

function CrashView({ screen, error, backLabel, onBack }: { screen: string; error: unknown; backLabel: string; onBack(): void }): JSX.Element {
  const t = crashText(screen, error);
  return (
    <div className="cr-pad cr-crash" role="alert">
      <h2>{t.what}</h2>
      <pre className="mono cr-crash-text">{t.detail}</pre>
      <div className="cr-row"><button className="btn primary lg" onClick={onBack}>{backLabel}</button></div>
    </div>
  );
}
