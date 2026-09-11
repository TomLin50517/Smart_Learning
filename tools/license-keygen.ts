/**
 * 【供應方專用】產生授權簽章用的 Ed25519 金鑰對。不隨產品交付。
 *
 *   LICENSE_PRIVATE_KEY_OUT=/secure/offline/iac-license.pem npm run license:keygen
 *
 * - 私鑰只寫到 repo 以外的路徑（寫進 repo 內會被拒絕），權限 0600，不覆寫既有檔案
 * - public key 印到畫面，貼進 apps/api/src/modules/license/infrastructure/vendor-public-key.ts
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env['LICENSE_PRIVATE_KEY_OUT'];
if (!out) throw new Error('set LICENSE_PRIVATE_KEY_OUT to a path OUTSIDE this repository');

const repo = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(out);
const rel = relative(repo, target);
if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('refusing to write the private key inside the repository');
if (existsSync(target)) throw new Error(`refusing to overwrite existing file ${target}`);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });

console.log(`private key written to ${target}`);
console.log('keep it offline and backed up; never commit it, never ship it.\n');
console.log('paste this into apps/api/src/modules/license/infrastructure/vendor-public-key.ts:\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
