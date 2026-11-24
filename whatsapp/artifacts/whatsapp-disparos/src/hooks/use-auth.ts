import { useState, useEffect, useCallback, createContext, useContext } from "react";

interface AuthState {
  authenticated: boolean;
  userId: number | null;
  username: string | null;
  name: string | null;
  role: "super_admin" | "user" | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  logout: () => Promise<void>;
  markLoggedIn: (data: { username: string; role: string; name: string | null }) => void;
  checkAuth: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  userId: null,
  username: null,
  name: null,
  role: null,
  loading: true,
  logout: async () => {},
  markLoggedIn: () => {},
  checkAuth: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthProvider(): AuthContextValue {
  const [auth, setAuth] = useState<AuthState>({
    authenticated: false,
    userId: null,
    username: null,
    name: null,
    role: null,
    loading: true,
  });

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      const data = await res.json();
      setAuth({
        authenticated: data.authenticated,
        userId: data.userId ?? null,
        username: data.username ?? null,
        name: data.name ?? null,
        role: data.role ?? null,
        loading: false,
      });
    } catch {
      setAuth({ authenticated: false, userId: null, username: null, name: null, role: null, loading: false });
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setAuth({ authenticated: false, userId: null, username: null, name: null, role: null, loading: false });
  }, []);

  const markLoggedIn = useCallback(({ username, role, name }: { username: string; role: string; name: string | null }) => {
    setAuth((prev) => ({
      ...prev,
      authenticated: true,
      username,
      name,
      role: role as "super_admin" | "user",
      loading: false,
    }));
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return { ...auth, logout, markLoggedIn, checkAuth };
}
