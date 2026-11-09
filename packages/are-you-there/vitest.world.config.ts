import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The World imports one runtime symbol from the framework (`isLanguage`). `tests/stub-cortico`
// stands in for it so this file also runs where the framework checkout is missing; the real
// `cortico/core/types.ts` is only imported as types and is erased.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^cortico\/core\/language\.ts$/, replacement: resolve(here, 'tests/stub-cortico/language.ts') },
    ],
  },
  test: {
    include: ['tests/world.test.ts'],
    environment: 'node',
  },
});
