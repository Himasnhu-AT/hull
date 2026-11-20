// What the agent panel and the app's main process say to each other. The main process runs agents (ACP, stdio) and the
// terminal; the renderer only sees these plain, serialisable shapes. Nothing here depends on the ACP library.

import type { AgentMode, GameMoment, StageId, UiBlock } from 'hull/dev/protocol';

export type AgentKind = 'hull' | 'acp' | 'terminal';

/** One agent the panel can offer. `installed` false means it was not found on this Mac; `install` says how to get it. */
export interface AgentInfo {
  id: string;
  name: string;
  kind: AgentKind;
  installed: boolean;
  /** One line on what it is and whose account it uses. */
  note: string;
  /** The command that installs it, shown when it was not found. */
  install?: string;
  /** What to do after installing it (sign in). */
  after?: string;
  /** Present when the agent is found but needs something first (a key, a sign-in); the panel shows it as a warning. */
  needs?: string;
  /** The path or command that will be run, for the panel's detail line. */
  command?: string;
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolContent =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; path: string; oldText: string | null; newText: string }
  | { kind: 'terminal'; id: string };

export interface PlanEntry { content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }

export interface PermissionOption { id: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

export interface ToolView {
  id: string;
  title: string;
  /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
  toolKind: string;
  status: ToolStatus;
  content: ToolContent[];
  paths: string[];
}

/** Events the main process pushes. `sid` is the session; one per agent started in the panel. */
export type AgentEvent =
  | { type: 'status'; sid: string; state: 'starting' | 'ready' | 'running' | 'closed' | 'error'; message?: string; agent?: string }
  | { type: 'message'; sid: string; role: 'agent' | 'thought' | 'user'; text: string }
  | { type: 'plan'; sid: string; entries: PlanEntry[] }
  | { type: 'tool'; sid: string; tool: ToolView }
  | { type: 'permission'; sid: string; reqId: string; tool: ToolView; options: PermissionOption[] }
  /** A card from the builder (docs/IDEA-TO-PLAY.md 4.4), sent whole and again with the same id to update it. `reqId` is present when it waits: answer with agentAnswer (the option id, or null to answer in words instead). */
  | { type: 'ui'; sid: string; block: UiBlock; reqId?: string }
  | { type: 'permission-done'; sid: string; reqId: string; optionId: string | null }
  | { type: 'done'; sid: string; stopReason: string }
  | { type: 'term-data'; tid: string; data: string }
  | { type: 'term-exit'; tid: string; code: number | null }
  /** A tool call an outside agent (Claude Code, Codex, any MCP client) made on the open project, as it starts and ends. */
  | { type: 'mcp-call'; tool: string; author: string; phase: 'start' | 'end'; ok?: boolean };

export interface TermInfo {
  tid: string;
  /** What is running in the pane, e.g. the path of `claude`. */
  command: string;
}

/** What the Claude Code pane needs to know before it opens. */
export interface ClaudeCodeInfo {
  installed: boolean;
  path: string | null;
  install: string;
  /** The line the person runs once so `claude` can reach this project's tools. */
  mcpAdd: string;
}

/** What a prompt may carry besides its text (M11). No mode means "fix". */
export interface PromptOptions {
  mode?: AgentMode;
  /** For mode 'build': the one stage to run. */
  stage?: StageId;
  /** A frozen moment: its screenshot and what just played go with the note. */
  moment?: GameMoment;
  /** Review keys the note is about: config ids, 'tunables:<block>', 'explain:<id>'. */
  about?: string[];
}

export type KeyProvider = 'anthropic' | 'openai';
/** Who serves the builder's model: a key of the person's own, or their Hull account (backend/, which holds the key). */
export type BuilderProvider = KeyProvider | 'account';

/** Which model the builder uses. The keys are kept by the app and never handed back to the page. */
export interface AgentSettings {
  provider: BuilderProvider;
  /** The Hull account: the server's address, and who is signed in (null when no one is). The token never reaches the page. */
  account?: { url: string; email: string | null };
  /** A key for the provider in use (saved, or from the environment), or a signed-in account. */
  hasKey: boolean;
  /** Which providers have a saved key. One key per provider, so switching back and forth keeps both. Absent when the environment decides. */
  keys?: Record<KeyProvider, boolean>;
  baseUrl?: string;
  model?: string;
  /** 'app' when the app keeps the key; 'environment' in web mode, where the shell's environment decides and nothing here can change it. */
  source?: 'app' | 'environment';
}
/** `apiKey` is saved for `provider`; an empty one keeps the key already saved. `clearKey` forgets that provider's key. */
export interface AgentSettingsInput { provider: BuilderProvider; /** The Hull account server's address. */ accountUrl?: string; apiKey?: string; /** Whose key `apiKey` is, when not the provider in use. */ keyFor?: KeyProvider; baseUrl?: string; model?: string; clearKey?: KeyProvider }

/** The coding agents a person may already have on this Mac and sign in to themselves. */
export type CliId = 'claude' | 'codex';

/** What Settings shows for one of them. Hull asks the program itself (`claude auth status`, `codex login status`); it never reads their credential files. */
export interface CliStatus {
  id: CliId;
  name: string;
  installed: boolean;
  version: string | null;
  /** Null when the program could not say. */
  signedIn: boolean | null;
  /** How it is signed in, in a few words ("Claude Max", "ChatGPT", "API key"). Never an email, a token or a key. */
  via: string | null;
  /** Whether it reaches the open project's tools over MCP. Null when no project is open or it could not tell. */
  connected: boolean | null;
  /** How to get it when it is missing. */
  install: string;
}

/** What Settings can ask a coding agent to do without a terminal. Codex's sign-in needs one (TermProgram); 'logout' is Codex only (PLAN D15). */
export type CliAction = 'connect' | 'disconnect' | 'logout';

/** What a terminal pane may run: the person's own `claude`, or Codex's own sign-in. Hull offers no Claude sign-in (PLAN D15). */
export type TermProgram = 'claude' | 'codex-login';

/** The answer of agentEnsure: a session ready for prompts, or what is missing first (a key). */
export type EnsureResult = { sid: string } | { needs: string };
