/**
 * 備份代理（SA UC-PLT-008、§16；SD §6.28）。在 compose 的 backup 服務中執行，與 api／worker 同一個 image
 * （另裝 PostgreSQL client 以使用 pg_dump）。
 *
 * 每次循環：
 *   1. 有平台管理員要求的備份（backup_runs.status='requested'）→ 立刻執行
 *   2. 否則，若今天還沒有成功的每日備份且已過 BACKUP_HOUR → 執行每日備份
 *
 * 一次備份＝ pg_dump -Fc（資料庫，決定 RPO）→ 物件儲存增量同步（先資料庫後物件，SA §16.1）→ 依保留策略刪除舊檔。
 * 結果寫回 backup_runs；備份檔留在備份主機（volume），還原步驟見 SA §16.3 與 docs/ops/backup-restore.md。
 *
 * CLI：
 *   DATABASE_URL_BACKUP=postgres://postgres:...@postgres:5432/iac node tools/backup.ts
 *   node tools/backup.ts --once     # 執行一次就結束（排程或手動使用）
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

const env = {
  url: process.env['DATABASE_URL_BACKUP'] ?? '',
  dir: process.env['BACKUP_DIR'] ?? '/backups',
  hour: Number(process.env['BACKUP_HOUR'] ?? 3),
  pollSeconds: Number(process.env['BACKUP_POLL_SECONDS'] ?? 60),
  keep: {
    daily: Number(process.env['BACKUP_KEEP_DAILY'] ?? 7),
    weekly: Number(process.env['BACKUP_KEEP_WEEKLY'] ?? 4),
    monthly: Number(process.env['BACKUP_KEEP_MONTHLY'] ?? 6),
  },
  s3: {
    endpoint: process.env['S3_ENDPOINT'] ?? '',
    region: process.env['S3_REGION'] ?? 'us-east-1',
    bucket: process.env['S3_BUCKET'] ?? 'iac-data',
    accessKey: process.env['S3_ACCESS_KEY'] ?? '',
    secretKey: process.env['S3_SECRET_KEY'] ?? '',
  },
};

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'backup', msg, ...extra }));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 檔名用的時間戳（UTC，可排序） */
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

interface RunRow {
  id: string;
  kind: 'daily' | 'manual';
}

async function pgDump(target: string): Promise<number> {
  await mkdir(dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // 密碼只在連線字串中傳給子行程，不寫進 log
    const p = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', target, env.url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    p.on('error', (e) => reject(new Error(`pg_dump could not be started: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${err.slice(0, 500)}`))));
  });
  return (await stat(target)).size;
}

/** 物件儲存增量同步：大小相同就跳過（SA §16.1：物件的時間點不早於資料庫） */
async function syncObjects(root: string): Promise<{ files: number; bytes: number }> {
  if (!env.s3.endpoint) return { files: 0, bytes: 0 };
  const client = new S3Client({
    endpoint: env.s3.endpoint,
    region: env.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
  });
  let token: string | undefined;
  let files = 0;
  let bytes = 0;
  try {
    do {
      const list = await client.send(new ListObjectsV2Command({ Bucket: env.s3.bucket, ...(token && { ContinuationToken: token }) }));
      for (const o of list.Contents ?? []) {
        if (!o.Key) continue;
        const target = join(root, o.Key);
        const size = o.Size ?? 0;
        const existing = await stat(target).catch(() => null);
        if (!existing || existing.size !== size) {
          const r = await client.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: o.Key }));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(await r.Body!.transformToByteArray()));
        }
        files++;
        bytes += size;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    // 全新安裝、還沒有人上傳教材時 bucket 尚不存在（api／worker 第一次上傳才建立，見 S3ObjectStorage.ensureBucket）。
    // 視為「沒有物件要備份」，不讓已經成功的資料庫備份跟著被標成失敗；仍留一筆 log，
    // bucket 名稱設錯才不會被靜默吞掉。其餘錯誤（連不上、認證失敗、權限不足）照常往外拋。
    if (!isMissingBucket(e)) throw e;
    log('object storage bucket does not exist yet; nothing to back up', { bucket: env.s3.bucket });
  }
  return { files, bytes };
}

/** bucket 不存在：MinIO／S3 回 NoSuchBucket，部分實作只回 404 */
export function isMissingBucket(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: string }).name;
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchBucket' || name === 'NotFound' || status === 404;
}

/** 保留策略（ARCH §26.2）：7 日 + 4 週（週日）+ 6 月（每月 1 日） */
export function keepDumps(names: readonly string[], keep: { daily: number; weekly: number; monthly: number }, parse = parseStamp): string[] {
  const dated = names
    .map((name) => ({ name, at: parse(name) }))
    .filter((x): x is { name: string; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const keepSet = new Set<string>();
  dated.slice(0, keep.daily).forEach((x) => keepSet.add(x.name));
  const pick = (test: (d: Date) => boolean, n: number) => {
    const seen = new Set<string>();
    for (const x of dated) {
      const day = x.at.toISOString().slice(0, 10);
      if (!test(x.at) || seen.has(day)) continue;
      seen.add(day);
      keepSet.add(x.name);
      if (seen.size >= n) break;
    }
  };
  pick((d) => d.getUTCDay() === 0, keep.weekly);
  pick((d) => d.getUTCDate() === 1, keep.monthly);
  return dated.filter((x) => !keepSet.has(x.name)).map((x) => x.name);
}

/** iac-20260916-030000.dump → Date */
export function parseStamp(name: string): Date | null {
  const m = /^iac-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

async function prune(dbDir: string): Promise<number> {
  const names = await readdir(dbDir).catch(() => [] as string[]);
  const drop = keepDumps(names, env.keep);
  for (const name of drop) await rm(join(dbDir, name), { force: true });
  return drop.length;
}

async function runBackup(db: pg.Client, run: RunRow): Promise<void> {
  const started = new Date();
  const dbDir = join(env.dir, 'db');
  const file = join(dbDir, `iac-${stamp(started)}.dump`);
  log('backup started', { run_id: run.id, kind: run.kind });
  try {
    const databaseBytes = await pgDump(file);
    const objects = await syncObjects(join(env.dir, 'objects'));
    const removed = await prune(dbDir);
    await db.query(
      `UPDATE backup_runs SET status = 'succeeded', finished_at = now(), database_bytes = $2, object_files = $3, object_bytes = $4, location = $5, error = NULL WHERE id = $1`,
      [run.id, databaseBytes, objects.files, objects.bytes, file],
    );
    log('backup succeeded', { run_id: run.id, database_bytes: databaseBytes, object_files: objects.files, pruned: removed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.query(`UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2, location = $3 WHERE id = $1`, [run.id, message.slice(0, 1000), file]);
    log('backup failed', { run_id: run.id, error: message.slice(0, 300) });
  }
}

/** 取一件要做的備份：先手動要求，其次今天尚未完成的每日備份 */
async function claim(db: pg.Client): Promise<RunRow | null> {
  const manual = await db.query<RunRow>(
    `UPDATE backup_runs SET status = 'running', started_at = now()
      WHERE id = (SELECT id FROM backup_runs WHERE status = 'requested' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind`,
  );
  if (manual.rows[0]) return manual.rows[0];

  const due = await db.query<RunRow>(
    `INSERT INTO backup_runs (kind, status, started_at)
     SELECT 'daily', 'running', now()
      WHERE extract(hour FROM now()) >= $1
        AND NOT EXISTS (SELECT 1 FROM backup_runs WHERE kind = 'daily' AND created_at >= date_trunc('day', now()) AND status IN ('running', 'succeeded'))
     RETURNING id, kind`,
    [env.hour],
  );
  return due.rows[0] ?? null;
}

async function main(): Promise<void> {
  if (!env.url) throw new Error('DATABASE_URL_BACKUP is required');
  const once = process.argv.includes('--once');
  const db = new pg.Client({ connectionString: env.url, application_name: 'iac-backup' });
  await db.connect();
  log('backup agent started', { dir: env.dir, hour: env.hour, once });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  do {
    try {
      const run = once ? { id: (await db.query<RunRow>(`INSERT INTO backup_runs (kind, status, started_at) VALUES ('manual', 'running', now()) RETURNING id, kind`)).rows[0]!.id, kind: 'manual' as const } : await claim(db);
      if (run) await runBackup(db, run);
    } catch (e) {
      log('backup loop error', { error: e instanceof Error ? e.message : String(e) });
    }
    if (once || !running) break;
    await sleep(env.pollSeconds * 1000);
  } while (running);

  await db.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    log('backup agent crashed', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
