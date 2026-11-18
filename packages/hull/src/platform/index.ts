// hull/platform: the browser and the desktop shell behind one object. See platform.ts.
export { createPlatform } from './platform.ts';
export type { Fullscreen, Platform, PlatformOptions, PointerLockPolicy } from './platform.ts';
export { createSaves } from './saves.ts';
export type { Migrations, SaveInfo, Saves, SavesOptions } from './saves.ts';
export { createSettings, sanitize, dbForVolume, DEFAULT_SETTINGS, QUALITIES, QUALITY_PRESETS, SENSITIVITY_RANGE } from './settings.ts';
export type { ApplyTargets, Settings, SettingsOptions, SettingsValues } from './settings.ts';
export { detectKind, shellBridge } from './detect.ts';
export type { PlatformKind } from './detect.ts';
export { localStore, memoryStore } from './store.ts';
export { NAME_RE } from './types.ts';
export type { Area, HullShell, Report, Store } from './types.ts';
export { openSettingsScreen, settingsScreenDef, settingsModel } from './screens/settings.ts';
export type { OpenScreen, SettingsScreenDeps } from './screens/settings.ts';
export { openBindingsScreen } from './screens/bindings.ts';
export type { BindingsDeps, BindingsScreen } from './screens/bindings.ts';
export { attachPadNav, PadNav } from './screens/nav.ts';
export type { NavEvent, NavOptions } from './screens/nav.ts';
