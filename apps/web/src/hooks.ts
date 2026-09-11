import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';

const APP_NAME = '互動學習平台';

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** GET 資料。重新載入時保留舊資料（避免畫面閃爍）；元件卸載或路徑變更時中止請求 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: null,
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>('GET', path, undefined, { signal: ac.signal }).then(
      (data) => setState({ data, error: null, loading: false }),
      (error: unknown) => {
        if (!ac.signal.aborted) setState((s) => ({ ...s, error, loading: false }));
      },
    );
    return () => ac.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
