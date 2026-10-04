import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { get, onAuthError, post } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = async () => {
    try {
      const r = await get<{ user: User }>("/api/auth/me");
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return onAuthError((e) => {
      if (e.body.mustChangePassword) setUser((u) => (u ? { ...u, mustChangePassword: true } : u));
      else { setUser(null); qc.clear(); }
    });
  }, []);

  const logout = async () => {
    await post("/api/auth/logout").catch(() => undefined);
    setUser(null);
    qc.clear();
  };

  return <Ctx.Provider value={{ user, loading, setUser, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("AuthProvider missing");
  return c;
}
