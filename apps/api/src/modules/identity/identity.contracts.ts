/**
 * MOD-IDENTITY 對外介面。其他模組只能 import 此檔或 identity.module.ts（SD §1.2）。
 */
export type { AuthUser } from '../../common/context.js';

/**
 * 寄送「設定密碼」邀請信（新成員由本人設定密碼，管理員永不經手他人密碼）。
 * 由 AuthService 實作，與密碼重設共用一次性 token 機制。
 * 回傳信件是否已交給郵件伺服器；寄送失敗不拋錯（對方可改用「忘記密碼」）。
 */
export interface UserInvitations {
  invite(userId: string, organizationName: string): Promise<boolean>;
}

export const USER_INVITATIONS = Symbol('USER_INVITATIONS');
