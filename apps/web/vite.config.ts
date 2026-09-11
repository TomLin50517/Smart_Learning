import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 開發：`npm run dev -w @iac/web` → http://localhost:5173，/api 代理到本機 API（IAC_API_URL，預設 :3000）。
 * 同源代理讓 session／CSRF cookie 的行為與正式環境（nginx 同源）一致。
 * 正式：`vite build` 產出靜態檔，由 nginx 提供（infra/docker/Dockerfile.web）。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // 直接吃 contracts 的 TS 原始碼（只用到型別與常數），與 vitest 設定一致
    alias: { '@iac/contracts': r('../../packages/contracts/src/index.ts') },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env['IAC_API_URL'] ?? 'http://127.0.0.1:3000' },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2023',
    sourcemap: true,
  },
});
