/// <reference types="vite/client" />
import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { HullApp } from '../shared/appApi.ts';
import { App } from './App.tsx';
import { webShim } from './lib/webShim.ts';
import './styles.css';

// Electron's preload provides window.hullApp. In a plain browser (web dev mode) a shim calls the dev server instead.
const app: HullApp = window.hullApp ?? webShim();

function Fatal({ message }: { message: string }): JSX.Element {
  return <div className="fatal"><div><b style={{ fontSize: 16 }}>Hull could not start</b><div className="note-err">{message}</div></div></div>;
}

const root = createRoot(document.getElementById('root')!);
try {
  root.render(<StrictMode><App app={app} /></StrictMode>);
} catch (e) {
  root.render(<Fatal message={e instanceof Error ? e.message : String(e)} />);
}
