import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  // The library is consumed as a built package (its `exports` map), exactly as
  // an external consumer would — so the demo proves the packaging too.
  optimizeDeps: {
    exclude: ['@jugaaadi/db-browser'],
  },
})
