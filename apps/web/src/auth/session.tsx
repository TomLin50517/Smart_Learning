import type { MeResponse } from '@iac/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from '../api/client';
import { ApiError } from '../api/errors';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface SessionValue {
  status: SessionStatus;
  me: MeResponse | null;
  /** 上一次 session 如何結束：主動登出不帶 ?next=，逾時則提示並帶回原頁 */
  endedBy: 'logout' | 'expired' | null;
  reload(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [endedBy, setEndedBy] = useState<SessionValue['endedBy']>(null);

  const reload = useCallback(async () => {
    try {
      const m = await api<MeResponse>('GET', '/api/me', undefined, { quiet401: true });
      setMe(m);
      setStatus('authenticated');
    } catch (e) {
      setMe(null);
      setStatus(e instanceof ApiError && e.status === 401 ? 'anonymous' : 'error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 任何 API 回 401（逾時、閒置過久、被撤銷）→ 回到未登入狀態，RequireAuth 會導向登入頁
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      setStatus('anonymous');
      setEndedBy('expired');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      await api('POST', '/api/auth/login', { email, password }, { quiet401: true });
      setEndedBy(null);
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await api('POST', '/api/auth/logout', undefined, { quiet401: true });
    } finally {
      setMe(null);
      setStatus('anonymous');
      setEndedBy('logout');
    }
  }, []);

  const value = useMemo(() => ({ status, me, endedBy, reload, login, logout }), [status, me, endedBy, reload, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used inside <SessionProvider>');
  return s;
}

/** 只能用在 RequireAuth 之內的頁面 */
export function useMe(): MeResponse {
  const { me } = useSession();
  if (!me) throw new Error('useMe used outside an authenticated route');
  return me;
}
