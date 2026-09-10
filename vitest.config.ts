import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// NestJS DI 依賴 emitDecoratorMetadata；esbuild 不支援，因此以 SWC 轉譯
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    // 測試直接跑 workspace 套件的 TS 原始碼，不需先 build
    alias: {
      '@iac/contracts': r('./packages/contracts/src/index.ts'),
      '@iac/domain': r('./packages/domain/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          // 不啟用 Ryuk 清理容器（避免額外映像下載）；各測試於 afterAll 自行 stop
          env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
        },
      },
    ],
  },
});
