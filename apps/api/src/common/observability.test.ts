import { describe, expect, it } from 'vitest';
import { accessLogEntry, moduleOf } from './access-log.js';
import { logContext, requestContext } from './als.js';
import type { RequestContext } from './context.js';
import { Counter, Gauge, Histogram, MetricsRegistry } from './metrics.js';

describe('Prometheus text format', () => {
  it('counter with labels, escaped values', () => {
    const r = new MetricsRegistry();
    const c = r.register(new Counter('t_total', 'test counter', ['route']));
    c.inc({ route: '/a' });
    c.inc({ route: '/a' }, 2);
    c.inc({ route: 'x"y\\z\nw' });
    expect(r.render()).toBe(
      '# HELP t_total test counter\n# TYPE t_total counter\n' + 't_total{route="/a"} 3\n' + 't_total{route="x\\"y\\\\z\\nw"} 1\n',
    );
  });

  it('histogram buckets are cumulative and end with +Inf, _sum and _count', () => {
    const h = new Histogram('d_seconds', 'dur', ['m'], [0.1, 1]);
    h.observe({ m: 'GET' }, 0.05);
    h.observe({ m: 'GET' }, 0.5);
    h.observe({ m: 'GET' }, 3);
    expect(h.render().split('\n').slice(2, 7)).toEqual([
      'd_seconds_bucket{m="GET",le="0.1"} 1',
      'd_seconds_bucket{m="GET",le="1"} 2',
      'd_seconds_bucket{m="GET",le="+Inf"} 3',
      'd_seconds_sum{m="GET"} 3.55',
      'd_seconds_count{m="GET"} 3',
    ]);
  });

  it('gauges are replaced on every scrape (reset + set)', () => {
    const g = new Gauge('q_depth', 'depth', ['queue']);
    g.set({ queue: 'ingest' }, 5);
    g.reset();
    g.set({ queue: 'ai' }, 1);
    expect(g.render()).not.toContain('ingest');
    expect(g.render()).toContain('q_depth{queue="ai"} 1');
  });

  it('caps label cardinality instead of growing without bound', () => {
    const c = new Counter('many_total', 'x', ['k']);
    for (let i = 0; i < 2100; i++) c.inc({ k: String(i) });
    expect(c.render().split('\n').filter((l) => l.startsWith('many_total{')).length).toBe(2000);
  });
});

describe('access log entry', () => {
  const ctx: RequestContext = {
    correlationId: 'req-12345678',
    user: { id: 'u1', email: 'a@x.test', displayName: 'A', locale: 'zh-TW', activeOrganizationId: 'org-active' },
    target: { organizationId: 'org-target', courseId: null, resourceId: null },
  };

  it('uses the route template and derives module / operation / outcome', () => {
    expect(accessLogEntry({ method: 'GET', route: '/api/organizations/:id', status: 200, durationMs: 12.345, ctx })).toEqual({
      module: 'organizations',
      operation: 'GET /api/organizations/:id',
      method: 'GET',
      route: '/api/organizations/:id',
      status: 200,
      duration_ms: 12.3,
      outcome: 'success',
      correlation_id: 'req-12345678',
      actor_user_id: 'u1',
      organization_id: 'org-target',
    });
  });

  it('outcome is the error code when the exception filter set one; unmatched routes are bucketed', () => {
    const e = accessLogEntry({ method: 'POST', route: undefined, status: 404, durationMs: 1, ctx: { correlationId: 'c-12345678', errorCode: 'NOT_FOUND' } });
    expect(e).toMatchObject({ route: 'unmatched', module: 'unmatched', outcome: 'NOT_FOUND' });
    expect(e).not.toHaveProperty('actor_user_id');
  });

  it('moduleOf', () => {
    expect(moduleOf('/api/auth/login')).toBe('auth');
    expect(moduleOf('/public/certificates/:code')).toBe('certificates');
    expect(moduleOf('/metrics')).toBe('unmatched');
  });
});

describe('logContext (logger mixin)', () => {
  it('is empty outside a request', () => {
    expect(logContext()).toEqual({});
  });

  it('reflects fields written to req.ctx after the request started', async () => {
    const ctx: RequestContext = { correlationId: 'corr-12345678' };
    await requestContext.run(ctx, async () => {
      expect(logContext()).toEqual({ correlation_id: 'corr-12345678' });
      await new Promise((r) => setTimeout(r, 1));
      ctx.user = { id: 'u9', email: 'x@x.test', displayName: 'X', locale: 'en', activeOrganizationId: 'org-1' };
      expect(logContext()).toEqual({ correlation_id: 'corr-12345678', actor_user_id: 'u9', organization_id: 'org-1' });
    });
  });
});
