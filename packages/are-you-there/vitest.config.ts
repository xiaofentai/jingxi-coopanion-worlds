import { defineConfig } from 'vitest/config';

// probe.ts, presence.ts, state.ts and format.ts only need node builtins, so this package runs
// without the framework checkout. `tests/world.test.ts` needs the `cortico` stub and has its own
// config: `npm run test:world`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/world.test.ts'],
    environment: 'node',
  },
});
