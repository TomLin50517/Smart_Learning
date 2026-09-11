/** 與伺服器 ResetConfirm schema 一致（SD §8.1） */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < PASSWORD_MIN) return `密碼至少需要 ${PASSWORD_MIN} 個字元`;
  if (pw.length > PASSWORD_MAX) return `密碼不可超過 ${PASSWORD_MAX} 個字元`;
  if (pw !== confirm) return '兩次輸入的密碼不一致';
  return null;
}
