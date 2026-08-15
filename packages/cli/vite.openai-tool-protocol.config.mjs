import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    target: 'node22',
    outDir: path.join(packageRoot, 'dist', 'src', 'daemon'),
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.join(packageRoot, 'src', 'daemon', 'openai-tool-protocol.ts'),
      formats: ['es'],
      fileName: () => 'openai-tool-protocol.js',
    },
    rollupOptions: {
      external: (id) => id.startsWith('node:'),
    },
  },
})
