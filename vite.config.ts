import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  root: 'src',
  publicDir: '../public',
  define: {
    'import.meta.env.VITE_ROSI_E2E': JSON.stringify(mode === 'e2e' ? '1' : ''),
    'import.meta.env.VITE_ROSI_CHANNEL': JSON.stringify(
      process.env.ROSI_DISTRIBUTION_CHANNEL === 'msstore' ? 'msstore' : 'github'
    ),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // WKWebView on macOS 26 and WebView2/WebKitGTK are the supported engines.
    target: ['es2022', 'safari26', 'chrome105'],
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/index.html'),
        splash: resolve(import.meta.dirname, 'src/splash.html'),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
}));
