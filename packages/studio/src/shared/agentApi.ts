// What the agent panel and the app's main process say to each other. The main process runs agents (ACP, stdio) and the
// terminal; the renderer only sees these plain, serialisable shapes. Nothing here depends on the ACP library.

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
  | { type: 'permission-done'; sid: string; reqId: string; optionId: string | null }
  | { type: 'done'; sid: string; stopReason: string }
  | { type: 'term-data'; tid: string; data: string }
  | { type: 'term-exit'; tid: string; code: number | null };

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
