// What the app's main process offers the renderer. The renderer has no Node access: this is the whole surface.
// In Electron it arrives as `window.hullApp` through the preload script; in the web dev mode a shim fills it in
// with fetch calls to the same functions (src/web/shim.ts).

export interface TemplateInfo { name: string; title: string; description: string }

/** A community game: what the launcher shows, and whether this person already has their own copy. */
export interface CommunityGame { id: string; title: string; note: string; cover: string | null; copy: { root: string; exists: boolean } }

export interface RecentProject { root: string; title: string; openedAt: string }

/** A project the main process has started a server for. The renderer talks only to `url` (protocol) and shows `gameUrl`. */
export interface OpenedProject {
  root: string; title: string; url: string; gameUrl: string;
  /** How a local agent (Claude Code, Codex, any MCP client) reaches this project: the app's MCP endpoint, and the stdio launcher for when the app is closed. */
  mcp: { url: string; launcher: string };
}

import type { AgentEvent, AgentInfo, AgentSettings, AgentSettingsInput, ClaudeCodeInfo, EnsureResult, PromptOptions, TermInfo } from './agentApi.ts';

export interface HullApp extends HullAppAgents {
  /** 'darwin' | 'win32' | 'linux' | 'web'. The title bar leaves room for traffic lights on darwin only. */
  readonly platform: string;
  listTemplates(): Promise<TemplateInfo[]>;
  /** Asks where to put a new project, or which existing one to open. Null when cancelled. */
  pickFolder(purpose: 'open' | 'location'): Promise<string | null>;
  createProject(opts: { template: string; title: string; parentDir: string }): Promise<OpenedProject>;
  /** The idea box: the main process picks the closest template, makes the project in the app's own projects folder (never asks for one) and opens it. */
  createFromIdea(opts: { idea: string }): Promise<OpenedProject & { idea: string }>;
  openProject(root: string): Promise<OpenedProject>;
  closeProject(): Promise<void>;
  /** The community games. Opening one copies it into the person's projects folder the first time; `reset` replaces that copy with the original. */
  listCommunity(): Promise<CommunityGame[]>;
  openCommunity(id: string, reset?: boolean): Promise<OpenedProject>;
  recents(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  /** Shows a file or folder in Finder / Explorer. */
  reveal(path: string): Promise<void>;
  /** Web dev mode: the project to open without asking (`--project <dir>`). */
  initialProject(): Promise<OpenedProject | null>;
}

export interface HullAppAgents {
  /** The agents found on this Mac, and the ones that are not (with how to install them). Hull's own agent is first. */
  agentList(): Promise<AgentInfo[]>;
  /** Starts a session in the open project: the agent is handed Hull's MCP server in session/new. Resolves with the session id. */
  agentStart(agentId: string): Promise<string>;
  /** Sends one prompt. Resolves at once; the run streams as events and ends with a 'done' event. `options` set the kind of run and carry a frozen moment (M11). */
  agentPrompt(sid: string, text: string, options?: PromptOptions): Promise<void>;
  /** Hull's own agent for the open project: starts it if it is not running and resolves with its session, or says what is missing (a key). */
  agentEnsure(): Promise<EnsureResult>;
  /** Which model the builder uses. Never contains the key. */
  agentSettings(): Promise<AgentSettings>;
  /** Saves the model choice and, when given, the key (kept with safeStorage in Electron). A running builder is restarted with it on the next agentEnsure. */
  setAgentSettings(s: AgentSettingsInput): Promise<AgentSettings>;
  agentCancel(sid: string): Promise<void>;
  agentStop(sid: string): Promise<void>;
  /** Answers a permission card. `null` denies by cancelling. */
  agentAnswer(sid: string, reqId: string, optionId: string | null): Promise<void>;
  claudeInfo(): Promise<ClaudeCodeInfo>;
  /** Opens `claude` in a terminal in the open project's folder. Output arrives as 'term-data' events. */
  termOpen(cols: number, rows: number): Promise<TermInfo>;
  termWrite(tid: string, data: string): Promise<void>;
  termResize(tid: string, cols: number, rows: number): Promise<void>;
  termKill(tid: string): Promise<void>;
  /** Subscribes to agent and terminal events; returns the unsubscribe. */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
}

declare global {
  interface Window { hullApp?: HullApp }
}
