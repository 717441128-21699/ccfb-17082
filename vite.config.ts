import { defineConfig } from 'vite';

// AudioWorklet 处理器由 scripts/bundle-worklets.mjs 用 esbuild
// 单独打包到 public/worklets/，dev 与 build 都直接作为静态资源提供。
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
