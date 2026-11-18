import { defineConfig } from 'vitest/config';

// One run for the whole repo. core and config tests run in Node on purpose: that is the rule they must keep.
export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'templates/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
