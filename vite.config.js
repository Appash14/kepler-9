import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1400,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: { host: '127.0.0.1', port: 4341 },
  preview: { host: '127.0.0.1', port: 4340 },
});
