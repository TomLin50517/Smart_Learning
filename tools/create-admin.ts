/**
 * 建立第一位平台管理員（新環境沒有任何使用者時無法登入）。
 *
 * 密碼刻意從環境變數讀取、不接受命令列參數——避免留在 shell history。
 *
 *   DATABASE_URL=postgres://app_api:...@localhost:55432/iac \
 *   IAC_ADMIN_EMAIL=admin@example.com IAC_ADMIN_NAME="Platform Admin" \
 *   IAC_ADMIN_PASSWORD='...' npm run admin:create
 *
 * 已存在同 email 的使用者時拒絕執行，不覆寫既有帳號。
 */
import pg from 'pg';
import { hashPassword } from '../apps/api/src/modules/identity/infrastructure/password-hasher.js';

const url = process.env['DATABASE_URL'];
const email = process.env['IAC_ADMIN_EMAIL']?.trim().toLowerCase();
const name = process.env['IAC_ADMIN_NAME']?.trim() || 'Platform Admin';
const password = process.env['IAC_ADMIN_PASSWORD'] ?? '';

if (!url || !email) throw new Error('DATABASE_URL and IAC_ADMIN_EMAIL are required');
if (password.length < 12) throw new Error('IAC_ADMIN_PASSWORD must be at least 12 characters for an admin account');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, name, await hashPassword(password)],
  );
  if (!u.rows[0]) throw new Error(`user ${email} already exists — refusing to modify an existing account`);

  const g = await client.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type)
     SELECT $1, id, 'platform' FROM roles WHERE code = 'platform_admin'`,
    [u.rows[0].id],
  );
  if (g.rowCount !== 1) throw new Error('role platform_admin not found — run migrations first');

  await client.query('COMMIT');
  console.log(`created platform admin ${email} (${u.rows[0].id})`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  await client.end();
}
