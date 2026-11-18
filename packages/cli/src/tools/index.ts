import type { ToolDef } from '../tool.ts';
import { check } from './check.ts';
import { build } from './build.ts';
import { dev } from './dev.ts';
import { newGame } from './new.ts';
import { test } from './test.ts';

export const tools: readonly ToolDef<unknown, unknown>[] = [check, test, build, dev, newGame] as unknown as readonly ToolDef<unknown, unknown>[];
