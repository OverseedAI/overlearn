import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { ProfileResource } from "./types";

type ProfileContextValue = {
  profile: ProfileResource | undefined;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  update: (body: {
    name?: string;
    settings?: Record<string, unknown>;
    preferredHarness?: string | null;
  }) => Promise<ProfileResource>;
};

const ProfileContext = createContext<ProfileContextValue | undefined>(
  undefined,
);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ProfileResource>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setProfile(await api.getProfile());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const update = useCallback<ProfileContextValue["update"]>(async (body) => {
    const next = await api.patchProfile(body);
    setProfile(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      profile,
      loading,
      ...(error !== undefined ? { error } : {}),
      refresh,
      update,
    }),
    [profile, loading, error, refresh, update],
  );

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile must be used within ProfileProvider");
  }
  return context;
}
