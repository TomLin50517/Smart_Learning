/**
 * Migration runner（SD §2.9）。依檔名順序套用 migrations/*.sql，已套用者跳過。
 *
 * 0011 使用 psql 變數（:api_pw 等）設定角色密碼；此處以安全引號代換，
 * 讓同一批 SQL 可由 psql（tests/db/run-db-tests.sh）與 Node（e2e、部署）共用。
 *
 * CLI：
 *   DATABASE_URL_MIGRATE=postgres://postgres:...@host/iac \
 *   MIGRATE_API_PW=... MIGRATE_COACH_PW=... MIGRATE_WORKER_PW=... MIGRATE_RO_PW=... \
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export type RolePasswords = Record<'api_pw' | 'coach_pw' | 'worker_pw' | 'ro_pw', string>;

const DEFAULT_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PSQL_VAR = /(?<!:):(api_pw|coach_pw|worker_pw|ro_pw)\b/g;

function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export async function applyMigrations(
  client: pg.Client | pg.PoolClient,
  opts: { rolePasswords?: Partial<RolePasswords>; dir?: string; log?: (msg: string) => void } = {},
): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? (() => undefined);

  const exists = await client.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations')::text AS t`);
  const applied = new Set<string>();
  if (exists.rows[0]?.t) {
    const r = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    for (const row of r.rows) applied.add(row.version);
  }

  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(join(dir, file), 'utf8').replace(PSQL_VAR, (_m, name: keyof RolePasswords) => {
      const v = opts.rolePasswords?.[name];
      if (!v) throw new Error(`${file} requires role password "${name}"`);
      return quoteLiteral(v);
    });

    await client.query(sql); // 每個檔案自帶 BEGIN/COMMIT
    ran.push(version);
    log(`applied ${version}`);
  }
  return ran;
}

// ---- CLI ---------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env['DATABASE_URL_MIGRATE'];
  if (!url) throw new Error('DATABASE_URL_MIGRATE is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const ran = await applyMigrations(client, {
      rolePasswords: {
        api_pw: process.env['MIGRATE_API_PW'] ?? '',
        coach_pw: process.env['MIGRATE_COACH_PW'] ?? '',
        worker_pw: process.env['MIGRATE_WORKER_PW'] ?? '',
        ro_pw: process.env['MIGRATE_RO_PW'] ?? '',
      },
      log: (m) => console.log(m),
    });
    console.log(ran.length ? `${ran.length} migration(s) applied` : 'database is up to date');
  } finally {
    await client.end();
  }
}
