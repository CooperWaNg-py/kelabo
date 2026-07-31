import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  resolve: {
    alias: {
      // The variant seam: an overlay build re-points this one id to its own
      // module (see src/variant.js). Everything else resolves normally.
      '@kelabo/variant': fileURLToPath(new URL('./src/variant.js', import.meta.url)),
    },
  },
})
