import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(packageRoot, 'src'),
  base: '/ui/',
  plugins: [svelte()],
  build: {
    target: 'es2022',
    outDir: path.join(packageRoot, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.css'))
          ? 'styles.css'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
