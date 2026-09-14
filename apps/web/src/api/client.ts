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
 * session 在 HttpOnly cookie 內，JS 讀不到也不需要；
 * 狀態變更請求從非 HttpOnly 的 CSRF cookie 讀出 token 放進 X-CSRF-Token。
 */
async function send(method: Method, path: string, body: unknown, opts: RequestOptions, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(document.cookie, CSRF_COOKIE);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  try {
    return await fetch(path, {
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
}

async function failure(res: Response, opts: RequestOptions): Promise<ApiError> {
  const env = (parseJson(await res.text()) as Partial<ErrorEnvelope> | null)?.error;
  if (res.status === 401 && !opts.quiet401) unauthorizedHandler?.();
  return new ApiError(
    res.status,
    env?.code ?? 'INTERNAL_ERROR',
    env?.message ?? res.statusText,
    env?.correlation_id ?? res.headers.get('x-request-id'),
    env?.details ?? [],
  );
}

/** 同源呼叫 API，回傳 JSON（204 → undefined） */
export async function api<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, body, opts, 'application/json');
  if (!res.ok) throw await failure(res, opts);
  const text = res.status === 204 ? '' : await res.text();
  return (text ? parseJson(text) : undefined) as T;
}

/**
 * 上傳檔案（教材，SD §6.17）：以 application/octet-stream 傳送原始內容，不經 JSON；
 * 檔名等資訊放在呼叫端的查詢參數。回傳 JSON。
 */
export async function apiUpload<T>(path: string, file: Blob, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/octet-stream' };
  const csrf = readCookie(document.cookie, CSRF_COOKIE);
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers, credentials: 'same-origin', body: file, ...(opts.signal && { signal: opts.signal }) });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'network error', null);
  }
  if (!res.ok) throw await failure(res, opts);
  const text = await res.text();
  return (text ? parseJson(text) : undefined) as T;
}

/** 下載檔案（例：稽核 CSV）。檔名取自 Content-Disposition */
export async function apiDownload(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string }> {
  const res = await send(method, path, body, opts, '*/*');
  if (!res.ok) throw await failure(res, opts);
  const cd = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'download';
  return { blob: await res.blob(), filename };
}

/** 觸發瀏覽器儲存檔案 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
