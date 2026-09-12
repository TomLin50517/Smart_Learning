import { randomUUID } from 'node:crypto';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError } from './domain-error.js';
import { logger } from './logger.js';

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  413: 'UPLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

/** 由 DB 觸發器 RAISE 的業務錯誤（migrations 0004、0008） */
const DB_RAISED: ErrorCode[] = ['COURSE_VERSION_IMMUTABLE', 'TRANSCRIPT_VISIBILITY_IMMUTABLE'];

interface PgLikeError {
  code?: string;
  message?: string;
}

/**
 * 所有錯誤統一為 ARCH §29 格式。5xx 不回傳內部細節，只給 correlation_id 供追查（THR-I-008）。
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const correlationId = req.ctx?.correlationId ?? randomUUID();

    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'Internal error';
    let details: ErrorEnvelope['error']['details'];

    if (exception instanceof DomainError) {
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      code = HTTP_TO_CODE[exception.getStatus()] ?? 'INTERNAL_ERROR';
      message = exception.message;
    } else if (isPgError(exception) && exception.code === 'P0001') {
      const raised = DB_RAISED.find((c) => exception.message?.startsWith(c));
      if (raised) {
        code = raised;
        message = raised;
      }
    }

    const status = ERROR_CODES[code];
    if (req.ctx) req.ctx.errorCode = code; // 請求 log 的 outcome
    if (status >= 500) {
      logger.error({ err: exception, correlation_id: correlationId, url: req.url }, 'unhandled error');
      message = 'Internal error';
    }

    if (exception instanceof DomainError && exception.options.retryAfterSec) {
      void reply.header('retry-after', String(exception.options.retryAfterSec));
    }

    const body: ErrorEnvelope = { error: { code, message, correlation_id: correlationId, ...(details && { details }) } };
    void reply.status(status).header('x-request-id', correlationId).send(body);
  }
}

function isPgError(e: unknown): e is PgLikeError {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as PgLikeError).code === 'string';
}
