// Opening Settings from anywhere: the launcher, the title bars, the builder's "Add a key", and Cmd+, (App.tsx owns it).

import { createContext, useContext } from 'react';

export type SettingsSection = 'builder' | 'claude' | 'codex' | 'mcp';

export interface SettingsOpener {
  /** Opens Settings at a section. `onKeysSaved` runs after a key is saved there (the builder retries what was waiting for it). */
  open(section?: SettingsSection, onKeysSaved?: () => void): void;
}

export const SettingsCtx = createContext<SettingsOpener>({ open: () => {} });
export const useSettings = (): SettingsOpener => useContext(SettingsCtx);
