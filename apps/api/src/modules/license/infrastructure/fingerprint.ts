import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * 硬體 fingerprint（ARCH §18.5、SD §8.4.3）。
 *
 * 誠實聲明：純 VM / 容器 / 無 TPM 環境下，這只是 tamper detection，不是絕對防護。
 * 可用元素少於 2 個時標記 weak，UI 應據實呈現（ADR-014）。
 */
export interface Fingerprint {
  value: string;
  weak: boolean;
}

function tryRead(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export function computeFingerprint(override?: string): Fingerprint {
  if (override) return { value: override, weak: false };

  const parts = [
    tryRead('/etc/machine-id') || tryRead('/var/lib/dbus/machine-id'),
    tryRead('/sys/class/dmi/id/product_uuid'),
    hostname(),
  ];
  const present = parts.filter(Boolean).length;
  const value = 'sha256:' + createHash('sha256').update(parts.join('|')).digest('hex');
  return { value, weak: present < 2 };
}
