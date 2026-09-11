/**
 * 架構護欄（SA INV-T2 / INV-T3 / SD §14.2）
 * 把「模組邊界」從 code review 的約定變成建置期可驗證的規則。
 * 執行：npm run test:arch
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'coach-must-not-write-assessment',
      comment:
        'INV-3：AI Coach 不得觸及成績、註冊狀態、證書的寫入實作。只能透過各模組的 *.contracts.ts 讀取。',
      severity: 'error',
      from: { path: '^apps/api/src/modules/ai-coach/' },
      to: {
        path: '^apps/api/src/modules/(learning-record|enrollment|certificate|completion)/(infrastructure|application)/',
      },
    },
    {
      name: 'domain-must-be-pure',
      comment:
        'INV-4：packages/domain 為純函式（completion evaluator、license capability 等），不得依賴任何 I/O。',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'core'],
        path: '(^|/)(pg|axios|node-fetch|undici|@elastic|@aws-sdk|nodemailer|fs|http|https|net|child_process)(/|$)',
      },
    },
    {
      name: 'domain-must-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'cross-module-via-contracts-only',
      comment:
        '模組 A 只能 import 模組 B 的 *.contracts.ts（介面）或 *.module.ts（Nest DI 需要），不得觸及其內部實作。',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '\\.contracts\\.ts$', '\\.module\\.ts$'],
      },
    },
    {
      name: 'api-must-not-import-worker',
      comment: 'worker 可重用 api 的模組（SD §1.3），反向不行。',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^apps/worker/' },
    },
    {
      name: 'web-only-uses-contracts',
      comment: 'React SPA 只能依賴 @iac/contracts（DTO／錯誤碼／權限碼），不得觸及後端實作或 domain 邏輯。',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^(apps/(api|worker)|packages/domain)/' },
    },
    {
      name: 'h5p-must-not-leak',
      comment: 'ADR-012：H5P 只能存在於 adapter 內。',
      severity: 'error',
      from: { path: '^packages/(domain|contracts)/' },
      to: { path: '(h5p|@lumieducation)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(dist|node_modules|\\.test\\.ts$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['source', 'import', 'default'],
      extensions: ['.ts', '.tsx', '.js'],
    },
  },
};
