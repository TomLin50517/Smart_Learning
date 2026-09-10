import { pino } from 'pino';

/**
 * 結構化 JSON log（SD §13.1）。
 * redact 清單對應 SD §12.1 的裁剪規則：絕不記錄密碼、token、金鑰。
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: process.env['IAC_SERVICE'] ?? 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'session_token_hash',
      'req.headers.cookie',
      'req.headers.authorization',
      '*.apiKey',
      '*.api_key',
      'AI_API_KEY',
      'S3_SECRET_KEY',
      'raw_payload',
    ],
    censor: '[REDACTED]',
  },
});
