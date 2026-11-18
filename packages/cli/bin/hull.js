#!/usr/bin/env node
// Runs the TypeScript sources directly until `hull` ships as a built package.
import { register } from 'tsx/esm/api';
register();
await import('../src/main.ts');
