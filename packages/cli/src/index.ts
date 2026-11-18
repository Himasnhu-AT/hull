// A tool is defined once and exposed as a command, as an MCP tool and to Marl AI.
export { defineTool, formatProblem } from './tool.ts';
export type { ToolContext, ToolDef, CliShape, ProblemOutput } from './tool.ts';
export type { Problem } from 'hull';
export { tools } from './tools/index.ts';
