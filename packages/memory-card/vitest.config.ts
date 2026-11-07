import { defineConfig } from 'vitest/config';

// card.ts only needs node builtins, so this package runs without the framework checkout.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
