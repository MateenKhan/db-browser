import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * Library build, mirroring `@jugaaadi/table`'s own packaging: ESM only, an
 * `exports` map with a `./core` entry and a `./style.css` entry, React as a
 * peer, and `.d.ts` emitted next to the bundles.
 *
 * Everything with a runtime cost is **external**: React (peer), the table
 * (peer — and it must stay a separate module so its `localStorage` reads
 * happen after our scope is installed, see `react/lazyTable.tsx`), CodeMirror,
 * `sql-formatter`, `lucide-react` and `framer-motion` (declared dependencies,
 * so a consumer's bundler deduplicates them with any copy they already have —
 * and for `lucide-react` and `framer-motion` they always have one, because
 * `@jugaaadi/table` depends on both, which is exactly why the icons and the
 * motion cost nothing extra to use).
 */
export default defineConfig({
  plugins: [react(), dts({ rollupTypes: false, include: ['src'] })],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: true,
    lib: {
      entry: {
        'db-browser': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        core: fileURLToPath(new URL('./src/core.ts', import.meta.url)),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        '@jugaaadi/table',
        '@jugaaadi/table/style.css',
        'sql-formatter',
        'lucide-react',
        'framer-motion',
        /^@codemirror\//,
        /^@lezer\//,
      ],
      output: {
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith('.css')) ? 'style.css' : '[name][extname]',
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
})
