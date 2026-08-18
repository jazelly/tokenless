import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const bareNodeBuiltins = builtinModules.filter((name) => !name.startsWith('node:'))

export default defineConfig({
  resolve: {
    alias: bareNodeBuiltins.map((name) => ({ find: name, replacement: `node:${name}` })),
  },
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
      output: {
        banner: "import { createRequire as __tokenlessCreateRequire } from 'node:module'; const require = __tokenlessCreateRequire(import.meta.url);",
        codeSplitting: false,
      },
    },
  },
})
