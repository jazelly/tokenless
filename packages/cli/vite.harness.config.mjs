import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    target: 'node22',
    outDir: path.join(packageRoot, 'dist', 'web-agent-harness', 'src'),
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    lib: {
      entry: path.join(packageRoot, '..', 'web-agent-harness', 'src', 'index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: (id) => id.startsWith('node:'),
    },
  },
})
