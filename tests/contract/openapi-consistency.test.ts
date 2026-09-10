/**
 * INV-T4（SA §19.2）：OpenAPI 與程式碼的權限標註必須一致，任何不一致即 CI 失敗。
 *
 * A. 規格自身：x-required-permission ∈ 權限目錄、x-audit ∈ audit 目錄、寫入操作不可漏標
 * B. 實作 vs 規格：每個已實作的路由都在 openapi.yaml 中，且 permission / capability /
 *    audit / public / auth-only 五項標註完全相同
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AUDIT_ACTIONS, PERMISSIONS } from '@iac/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AppModule } from '../../apps/api/src/app.module.js';
import { Audit, AuthOnly, Public, RequireCapability, RequirePermissionMeta } from '../../apps/api/src/common/decorators.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';

type Op = {
  operationId?: string;
  security?: unknown[];
  'x-required-permission'?: string;
  'x-required-capability'?: string;
  'x-required-limit'?: string;
  'x-audit'?: string;
  'x-auth-only'?: boolean;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const spec = parse(readFileSync(fileURLToPath(new URL('../../docs/api/openapi.yaml', import.meta.url)), 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
};
const ops = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ key: `${m.toUpperCase()} ${path}`, op: item[m]! })),
);
const opByKey = new Map(ops.map((o) => [o.key, o.op]));

describe('A. openapi.yaml is internally consistent', () => {
  it('every x-required-permission exists in the permission catalog (SA §6.2)', () => {
    const unknown = ops.filter((o) => o.op['x-required-permission'] && !(o.op['x-required-permission'] in PERMISSIONS));
    expect(unknown.map((o) => `${o.key} → ${o.op['x-required-permission']}`)).toEqual([]);
  });

  it('every x-audit exists in the audit action catalog (SD §12.2)', () => {
    const catalog = new Set<string>(AUDIT_ACTIONS);
    const unknown = ops.filter((o) => o.op['x-audit'] && !catalog.has(o.op['x-audit']));
    expect(unknown.map((o) => `${o.key} → ${o.op['x-audit']}`)).toEqual([]);
  });

  it('no write operation is left without a permission marker (INV-8)', () => {
    const unmarked = ops.filter(
      (o) =>
        !o.key.startsWith('GET ') &&
        !o.op['x-required-permission'] &&
        !o.op['x-auth-only'] &&
        !(Array.isArray(o.op.security) && o.op.security.length === 0),
    );
    expect(unmarked.map((o) => o.key)).toEqual([]);
  });
});

describe('B. implemented routes match openapi.yaml', () => {
  const routes: { key: string; handler: object; cls: object }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
      .overrideProvider(ENV)
      .useValue(
        loadEnv({
          DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/none',
          DATABASE_URL_COACH: 'postgres://nobody:none@127.0.0.1:1/none',
          SESSION_SECRET: 'contract-test-secret-contract-test-secret',
        }),
      )
      .compile();

    for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
      const cls = wrapper.metatype as { prototype: Record<string, unknown> } | null;
      if (!cls) continue;
      const base = String(Reflect.getMetadata('path', cls) ?? '');
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const sub = String(Reflect.getMetadata('path', handler) ?? '');
        let path = ('/' + [base, sub].filter((s) => s && s !== '/').join('/')).replace(/\/+/g, '/');
        path = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        if (path.startsWith('/api/')) path = path.slice(4); // /api 是 openapi 的 server base
        routes.push({ key: `${RequestMethod[method]} ${path}`, handler, cls });
      }
    }
    await moduleRef.close();
  });

  it('found implemented routes', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every implemented route is documented in openapi.yaml', () => {
    expect(routes.map((r) => r.key).filter((k) => !opByKey.has(k))).toEqual([]);
  });

  it('decorators match x- annotations exactly', () => {
    const reflector = new Reflector();
    const mismatches: string[] = [];
    for (const r of routes) {
      const op = opByKey.get(r.key);
      if (!op) continue;
      const t = [r.handler as never, r.cls as never];
      const actual = {
        permission: reflector.getAllAndOverride(RequirePermissionMeta, t)?.permission,
        capability: reflector.getAllAndOverride(RequireCapability, t)?.capability,
        limit: reflector.getAllAndOverride(RequireCapability, t)?.limit,
        audit: reflector.getAllAndOverride(Audit, t)?.action,
        public: reflector.getAllAndOverride(Public, t) === true,
        authOnly: reflector.getAllAndOverride(AuthOnly, t) === true,
      };
      const expected = {
        permission: op['x-required-permission'],
        capability: op['x-required-capability'],
        limit: op['x-required-limit'],
        audit: op['x-audit'],
        public: Array.isArray(op.security) && op.security.length === 0,
        authOnly: op['x-auth-only'] === true,
      };
      for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
        if (actual[k] !== expected[k]) mismatches.push(`${r.key} ${k}: code=${String(actual[k])} spec=${String(expected[k])}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
