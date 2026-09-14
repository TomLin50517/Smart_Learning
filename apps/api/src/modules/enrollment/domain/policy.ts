import { JOIN_BY, type EnrollmentPolicyDto, type JoinBy } from '@iac/contracts';

/** 選課碼字元：不含容易看錯的 0／O、1／I（與 DB CHECK 一致） */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 產生 8 碼選課碼；randomInt 由呼叫端提供（伺服器用 crypto.randomInt，測試可固定） */
export function generateEnrollmentCode(randomInt: (max: number) => number): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** 學員輸入的選課碼：去掉空白與連字號、轉大寫 */
export const normalizeEnrollmentCode = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase();

/** courses.enrollment_policy（jsonb）→ 政策；缺漏或不認得的值一律視為「只由管理者指派」 */
export function parsePolicy(raw: unknown): EnrollmentPolicyDto {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    joinBy: (JOIN_BY as readonly string[]).includes(p['joinBy'] as string) ? (p['joinBy'] as JoinBy) : 'assign',
    requireApproval: p['requireApproval'] === true,
    code: str(p['code']),
    opensAt: str(p['opensAt']),
    closesAt: str(p['closesAt']),
    maxSeats: typeof p['maxSeats'] === 'number' && Number.isInteger(p['maxSeats']) && p['maxSeats'] > 0 ? p['maxSeats'] : null,
  };
}

/** 現在能不能加入：尚未開放 → 已截止 → 額滿 → 開放 */
export function joinAvailability(p: Pick<EnrollmentPolicyDto, 'opensAt' | 'closesAt' | 'maxSeats'>, seatsUsed: number, now: number): 'open' | 'not_yet' | 'closed' | 'full' {
  if (p.opensAt && now < Date.parse(p.opensAt)) return 'not_yet';
  if (p.closesAt && now > Date.parse(p.closesAt)) return 'closed';
  if (p.maxSeats !== null && seatsUsed >= p.maxSeats) return 'full';
  return 'open';
}
