// A tool is defined once and exposed to the Hull app, over MCP and to Marl AI. There is no command line.
export { defineTool, formatProblem } from './tool.ts';
export type { ToolContext, ToolDef, ProblemOutput } from './tool.ts';
export type { Problem } from 'hull';
export { tools } from './tools/index.ts';
export { projectTools } from './tools/project.ts';
export { findRoot, render, failed, runTool, allTools } from './run.ts';
export { createMcpServer, serveMcpStdio, startMcpHttp } from './mcp/index.ts';
