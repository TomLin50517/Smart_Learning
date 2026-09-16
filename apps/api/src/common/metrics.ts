/**
 * 最小的 Prometheus 指標註冊表（SD §13.2）。刻意不引入 prom-client：
 * Phase 0 只需要 counter／gauge／histogram 與 text format 0.0.4。
 *
 * 基數保護：每個指標最多 MAX_SERIES 組 label；超過的新組合直接捨棄
 * （route 一律用路由樣板，未命中的路徑記為 "unmatched"，正常情況不會觸及上限）。
 */
type Labels = Record<string, string>;

const MAX_SERIES = 2000;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(names: readonly string[], labels: Labels, extra?: [string, string]): string {
  const parts = names.map((n) => `${n}="${escapeLabel(labels[n] ?? '')}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

abstract class Metric {
  protected readonly series = new Map<string, { labels: Labels }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}

  protected key(labels: Labels): string | null {
    const k = this.labelNames.map((n) => labels[n] ?? '').join('\u0001');
    if (!this.series.has(k) && this.series.size >= MAX_SERIES) return null;
    return k;
  }

  header(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract render(): string;
}

export class Counter extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, labelNames, 'counter');
  }

  inc(labels: Labels = {}, by = 1): void {
    const k = this.key(labels);
    if (k === null) return;
    this.series.set(k, { labels });
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  render(): string {
    let out = this.header();
    for (const [k, { labels }] of this.series) out += `${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(this.values.get(k) ?? 0)}\n`;
    return out;
  }
}

/** 抓取時才計算的值（佇列深度、授權剩餘天數）：每次抓取先 reset 再 set */
export class Gauge extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, labelNames, 'gauge');
  }

  set(labels: Labels, value: number): void {
    const k = this.key(labels);
    if (k === null) return;
    this.series.set(k, { labels });
    this.values.set(k, value);
  }

  reset(): void {
    this.series.clear();
    this.values.clear();
  }

  render(): string {
    let out = this.header();
    for (const [k, { labels }] of this.series) out += `${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(this.values.get(k) ?? 0)}\n`;
    return out;
  }
}

export class Histogram extends Metric {
  private readonly data = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly buckets: readonly number[],
  ) {
    super(name, help, labelNames, 'histogram');
  }

  observe(labels: Labels, value: number): void {
    const k = this.key(labels);
    if (k === null) return;
    this.series.set(k, { labels });
    let d = this.data.get(k);
    if (!d) {
      d = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.data.set(k, d);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) d.counts[i]!++;
    d.sum += value;
    d.count++;
  }

  render(): string {
    let out = this.header();
    for (const [k, { labels }] of this.series) {
      const d = this.data.get(k)!;
      this.buckets.forEach((b, i) => {
        out += `${this.name}_bucket${formatLabels(this.labelNames, labels, ['le', formatValue(b)])} ${d.counts[i]}\n`;
      });
      out += `${this.name}_bucket${formatLabels(this.labelNames, labels, ['le', '+Inf'])} ${d.count}\n`;
      out += `${this.name}_sum${formatLabels(this.labelNames, labels)} ${formatValue(d.sum)}\n`;
      out += `${this.name}_count${formatLabels(this.labelNames, labels)} ${d.count}\n`;
    }
    return out;
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  register<M extends Metric>(m: M): M {
    this.metrics.push(m);
    return m;
  }

  render(): string {
    return this.metrics.map((m) => m.render()).join('');
  }
}

/** 行程內單例（與 logger 相同的使用方式）。多個 API replica 各自被抓取 */
export const registry = new MetricsRegistry();

export const metrics = {
  httpRequests: registry.register(new Counter('iac_http_requests_total', 'HTTP requests', ['route', 'method', 'status'])),
  httpDuration: registry.register(
    new Histogram('iac_http_request_duration_seconds', 'HTTP request duration in seconds', ['route', 'method'], [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2.5, 5, 10,
    ]),
  ),
  loginFailures: registry.register(new Counter('iac_login_failures_total', 'Failed login attempts')),
  rateLimitHits: registry.register(new Counter('iac_rate_limit_hits_total', 'Requests rejected by rate limiting', ['endpoint_group'])),
  jobQueueDepth: registry.register(new Gauge('iac_job_queue_depth', 'Pending jobs', ['queue', 'job_type'])),
  jobOldestPending: registry.register(new Gauge('iac_job_oldest_pending_seconds', 'Age of the oldest runnable pending job', ['queue'])),
  jobDead: registry.register(new Gauge('iac_job_dead_total', 'Jobs in the dead-letter table (not requeued)', ['job_type'])),
  licenseDaysRemaining: registry.register(new Gauge('iac_license_days_remaining', 'Days until license expiry or maintenance end', ['kind'])),
  // 維運（SD §6.28、§13.2）：抓取時從資料庫計算
  esIndexBacklog: registry.register(new Gauge('iac_es_index_backlog_documents', 'Documents waiting to be parsed or indexed')),
  aiTokensToday: registry.register(new Gauge('iac_ai_tokens_today', 'AI tokens used since midnight')),
  aiRequestsToday: registry.register(new Gauge('iac_ai_requests_today', 'AI requests since midnight', ['status'])),
  coachFallbackRatio: registry.register(new Gauge('iac_coach_fallback_ratio', 'Share of today’s coach answers that fell back')),
  storageUsedBytes: registry.register(new Gauge('iac_storage_used_bytes', 'Stored bytes by kind', ['kind'])),
  backupAgeSeconds: registry.register(new Gauge('iac_backup_age_seconds', 'Seconds since the last successful backup')),
  backupFailed: registry.register(new Gauge('iac_backup_failed', '1 when the most recent backup run failed')),
};
