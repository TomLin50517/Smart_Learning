import { pino } from 'pino';
import { logContext } from './als.js';

/**
 * 結構化 JSON log（SD §13.1）。
 * - mixin：請求內的每一筆 log 自動帶上 correlation_id／actor_user_id／organization_id（SD §13.4）；
 *   呼叫端明確傳入的同名欄位優先
 * - redact 清單對應 SD §12.1 的裁剪規則：絕不記錄密碼、token、金鑰
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: process.env['IAC_SERVICE'] ?? 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: logContext,
  redact: {
    paths: [
      'password',
      '*.password',
      'newPassword',
      '*.newPassword',
      'password_hash',
      '*.password_hash',
      'token',
      '*.token',
      'session_token_hash',
      'req.headers.cookie',
      'req.headers.authorization',
      '*.apiKey',
      '*.api_key',
      'AI_API_KEY',
      'S3_SECRET_KEY',
      'SMTP_PASSWORD',
      'raw_payload',
    ],
    censor: '[REDACTED]',
  },
});
