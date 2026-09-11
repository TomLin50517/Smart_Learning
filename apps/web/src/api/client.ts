import type { ErrorEnvelope } from '@iac/contracts';
import { ApiError } from './errors';

/** 與 API 的 CSRF_COOKIE_NAME 預設值一致（SD §8.2 double submit） */
export const CSRF_COOKIE = 'iac_csrf';

export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

let unauthorizedHandler: (() => void) | null = null;

/** SessionProvider 註冊：任何請求收到 401 時清除登入狀態並導向登入頁 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  signal?: AbortSignal;
  /** 401 不觸發全域登出（例如：登入失敗、啟動時探測 session） */
  quiet401?: boolean;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 同源呼叫 API。session 在 HttpOnly cookie 內，JS 讀不到也不需要；
 * 狀態變更請求從非 HttpOnly 的 CSRF cookie 讀出 token 放進 X-CSRF-Token。
 */
export async function api<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(document.cookie, CSRF_COOKIE);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(opts.signal && { signal: opts.signal }),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'network error', null);
  }

  const text = res.status === 204 ? '' : await res.text();
  const data = text ? parseJson(text) : undefined;

  if (!res.ok) {
    const env = (data as Partial<ErrorEnvelope> | undefined)?.error;
    const err = new ApiError(
      res.status,
      env?.code ?? 'INTERNAL_ERROR',
      env?.message ?? res.statusText,
      env?.correlation_id ?? res.headers.get('x-request-id'),
      env?.details ?? [],
    );
    if (res.status === 401 && !opts.quiet401) unauthorizedHandler?.();
    throw err;
  }
  return data as T;
}
