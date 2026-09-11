import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/domain-error.js';
import { ENV, type Env } from '../../../config/env.js';

/** 線上啟用（SEQ-08）：向供應方 Activation Service 換取綁定本機 fingerprint 的簽章授權 */
export interface ActivationClient {
  activate(req: { activationCode: string; fingerprint: string; productVersion: string }): Promise<string>;
}

export const ACTIVATION_CLIENT = Symbol('ACTIVATION_CLIENT');

@Injectable()
export class HttpActivationClient implements ActivationClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async activate(req: { activationCode: string; fingerprint: string; productVersion: string }): Promise<string> {
    if (!this.env.LICENSE_ACTIVATION_URL) {
      throw new DomainError('LICENSE_ACTIVATION_UNAVAILABLE', 'Online activation is not configured; use offline activation');
    }
    let res: Response;
    try {
      res = await fetch(this.env.LICENSE_ACTIVATION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DomainError('LICENSE_ACTIVATION_UNAVAILABLE', 'Activation service unreachable; use offline activation');
    }
    if (res.status >= 500) throw new DomainError('LICENSE_ACTIVATION_UNAVAILABLE');
    if (!res.ok) throw new DomainError('LICENSE_ACTIVATION_REJECTED');

    const body = (await res.json().catch(() => null)) as { license?: unknown } | null;
    if (typeof body?.license !== 'string') throw new DomainError('LICENSE_ACTIVATION_UNAVAILABLE', 'Invalid activation response');
    // 回傳內容仍須經過完整驗簽——不因為來自供應方 URL 就信任
    return body.license;
  }
}
