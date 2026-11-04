import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'preserve-go-embed-placeholder',
      apply: 'build',
      closeBundle() { writeFileSync(new URL('./dist/.gitkeep', import.meta.url), '') },
    },
  ],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8080' },
    },
  },
  build: { sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    clearMocks: true,
  },
})
