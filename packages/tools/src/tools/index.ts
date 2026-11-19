import type { ToolDef } from '../tool.ts';
import { check } from './check.ts';
import { communityList, communityOpen } from './community.ts';
import { build } from './build.ts';
import { dev } from './dev.ts';
import { newGame } from './new.ts';
import { packageTool } from './package.ts';
import { play } from './play.ts';
import { reviewList, reviewNote, reviewSet } from './review.ts';
import { test } from './test.ts';

export const tools: readonly ToolDef<unknown, unknown>[] = [check, test, build, packageTool, dev, newGame, communityList, communityOpen, reviewList, reviewSet, reviewNote, play] as unknown as readonly ToolDef<unknown, unknown>[];
