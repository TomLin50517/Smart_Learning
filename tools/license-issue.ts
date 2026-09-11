/**
 * 【供應方專用】簽發授權檔。不隨產品交付。
 *
 *   LICENSE_PRIVATE_KEY_FILE=/secure/offline/iac-license.pem \
 *   LICENSE_SPEC=customer-a.json \
 *   LICENSE_CHALLENGE=<客戶提供的 challenge blob>   # 離線啟用（SEQ-09）時提供
 *   npm run --silent license:issue > customer-a.lic
 *
 * spec.json 範例：
 *   { "license_id": "lic-2026-001", "customer_id": "cust-a", "edition": "enterprise",
 *     "license_type": "perpetual", "expires_at": null, "maintenance_until": "2027-09-30T23:59:59Z",
 *     "features": { "ai_coach": true }, "limits": { "max_organizations": 10, "max_active_learners": 5000 } }
 *
 * 提供 challenge 時，hardware_binding 與 nonce 取自 challenge；否則 spec 必須自帶 hardware_binding。
 * 簽發前以產品端相同的 schema 驗證，避免發出客戶裝不上的授權。
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LicensePayloadSchema } from '../apps/api/src/modules/license/infrastructure/license-token.js';
import { decodeChallenge, signLicense } from './license-lib.js';

const keyFile = process.env['LICENSE_PRIVATE_KEY_FILE'];
const specFile = process.env['LICENSE_SPEC'];
if (!keyFile || !specFile) throw new Error('LICENSE_PRIVATE_KEY_FILE and LICENSE_SPEC are required');

const privateKey = createPrivateKey(readFileSync(keyFile));
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as Record<string, unknown>;

const challenge = process.env['LICENSE_CHALLENGE'];
const binding = challenge ? decodeChallenge(challenge) : null;

const payload = {
  ...spec,
  issued_at: new Date().toISOString(),
  ...(binding && { hardware_binding: binding.fingerprint, nonce: binding.nonce }),
};

const check = LicensePayloadSchema.safeParse(payload);
if (!check.success) {
  console.error(check.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
  throw new Error('license spec is invalid');
}

process.stdout.write(signLicense(payload, privateKey) + '\n');
