import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
  test: {
    // Code imports public files by site path ("/icons/x.svg"). Under Vitest that
    // becomes file:///icons/x.svg, which has no drive letter on Windows and won't
    // load; point those imports at the real files in public/ instead. Only names
    // that exist in public/ match, so the rewritten absolute path never matches again.
    alias: fs.readdirSync(path.resolve(__dirname, 'public')).map((name) => ({
      find: new RegExp(`^/${name.replaceAll('.', '\\.')}(?=/|$)`),
      replacement: path.resolve(__dirname, 'public', name),
    })),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // three.js is a single ~800 kB library behind the lazily loaded 3D avatar;
    // it can't be split further and never blocks first paint.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Long-lived vendor files: an app release doesn't bust their cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@azure')) return 'vendor-msal';
          if (/[\\/]node_modules[\\/](three|three-stdlib)[\\/]/.test(id)) return 'vendor-three';
          if (id.includes('@react-three')) return 'vendor-r3f';
          if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|es-toolkit|decimal\.js-light|@reduxjs|redux|immer|reselect|react-redux)[\\/]/.test(id)) return 'vendor-charts';
          return undefined;
        },
      },
    },
  },
})