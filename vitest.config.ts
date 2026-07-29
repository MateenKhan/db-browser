import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Test the sources, so the suite never depends on build order.
      '@jugaaadi/db-browser/core': src('./packages/db-browser/src/core.ts'),
      '@jugaaadi/db-browser': src('./packages/db-browser/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
