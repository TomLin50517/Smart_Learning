/**
 * 供應方授權簽章的 Ed25519 public key（ARCH §18.2：產品只內建 public key）。
 *
 * 刻意以程式碼嵌入，而不是環境變數：若部署設定可以替換 public key，
 * 客戶就能自己產生金鑰對、簽出任意授權。
 *
 * 正式交付前，由供應方執行 `npm run license:keygen` 產生金鑰對，
 * 把印出的 public key 貼到下方。私鑰絕不進入此 repo，也不隨產品交付。
 *
 * 尚未設定時（null），正式環境的所有啟用都會被拒絕（fail closed）；
 * 非正式環境可用 LICENSE_PUBLIC_KEY_OVERRIDE 注入測試用 key。
 */
export const VENDOR_LICENSE_PUBLIC_KEY_PEM: string | null = null;
