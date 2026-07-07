import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { api, ApiError } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import type { HarnessSummary } from "@/lib/types";

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function harnessStatusLabel(harness: HarnessSummary): string {
  if (!harness.installed) {
    return "Not installed";
  }
  if (!harness.authenticated) {
    return "Not logged in";
  }
  return harness.version ? harness.version : "Ready";
}

function ProfileSection() {
  const { profile, update } = useProfile();
  const [name, setName] = useState(profile?.name ?? "");

  useEffect(() => {
    setName(profile?.name ?? "");
  }, [profile?.name]);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === (profile?.name ?? "")) {
      return;
    }
    try {
      await update({ name: trimmed });
      toast.success("Name saved.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [name, profile?.name, update]);

  return (
    <section>
      <h2 className="text-sm font-medium">Profile</h2>
      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Label htmlFor="settings-name">Display name</Label>
        <Input
          id="settings-name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void save()}
          className="max-w-sm"
        />
      </form>
    </section>
  );
}

function HarnessRow({
  harness,
  selected,
  loggingIn,
  onSelect,
  onLogin,
}: {
  harness: HarnessSummary;
  selected: boolean;
  loggingIn: boolean;
  onSelect: () => void;
  onLogin: () => void;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <input
        id={`harness-${harness.id}`}
        type="radio"
        name="preferredHarness"
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={selected}
        disabled={!harness.installed}
        onChange={onSelect}
      />
      <div className="min-w-0 flex-1">
        <Label
          htmlFor={`harness-${harness.id}`}
          className="text-sm font-normal"
        >
          {harness.name}
        </Label>
        <div className="mt-1 flex items-center gap-2">
          <Badge
            variant="secondary"
            className={
              harness.authenticated
                ? "bg-success/15 text-success"
                : undefined
            }
          >
            {harnessStatusLabel(harness)}
          </Badge>
        </div>
      </div>
      {harness.installed && !harness.authenticated ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={loggingIn}
          onClick={onLogin}
        >
          {loggingIn ? "Logging in…" : "Log in"}
        </Button>
      ) : null}
    </div>
  );
}

function AgentSection() {
  const { profile, update } = useProfile();
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loggingInId, setLoggingInId] = useState<string>();

  const load = useCallback(async (refresh?: boolean) => {
    setLoading(true);
    try {
      const list = await api.listHarnesses(
        refresh ? { refresh: true } : undefined,
      );
      setHarnesses(list);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSelect = useCallback(
    async (id: string) => {
      try {
        await update({ preferredHarness: id });
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [update],
  );

  const handleLogin = useCallback(async (id: string) => {
    setLoggingInId(id);
    try {
      const result = await api.harnessLogin(id);
      if (result.manual) {
        toast.info(result.note, { description: result.command });
      } else {
        toast.success(result.note);
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setLoggingInId(undefined);
      void load();
    }
  }, [load]);

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Preferred agent</h2>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Refresh
        </Button>
      </div>
      <div className="mt-4 divide-y divide-border">
        {harnesses.length === 0 && loading ? (
          <p className="py-3 text-sm text-muted-foreground">
            Loading agents…
          </p>
        ) : null}
        {harnesses.map((harness) => (
          <HarnessRow
            key={harness.id}
            harness={harness}
            selected={profile?.preferredHarness === harness.id}
            loggingIn={loggingInId === harness.id}
            onSelect={() => void handleSelect(harness.id)}
            onLogin={() => void handleLogin(harness.id)}
          />
        ))}
      </div>
    </section>
  );
}

function DataSection({ dataDir }: { dataDir: string }) {
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(dataDir);
      toast.success("Copied.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [dataDir]);

  return (
    <section>
      <h2 className="text-sm font-medium">Data</h2>
      <div className="mt-4 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 text-sm">
          {dataDir}
        </code>
        <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
    </section>
  );
}

function OnboardingSection() {
  const { refresh } = useProfile();
  const [busy, setBusy] = useState(false);

  const rerun = useCallback(async () => {
    setBusy(true);
    try {
      await api.setOnboarding("welcome");
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section>
      <h2 className="text-sm font-medium">Onboarding</h2>
      <p className="mt-2 text-sm text-pretty text-muted-foreground">
        Walk through the welcome and agent setup steps again.
      </p>
      <div className="mt-4">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void rerun()}
        >
          Re-run onboarding
        </Button>
      </div>
    </section>
  );
}

export function SettingsScreen() {
  const { profile } = useProfile();

  const dataDir = useMemo(() => profile?.dataDir ?? "", [profile?.dataDir]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <h1 className="text-sm font-medium">Settings</h1>
      </header>
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="space-y-10 divide-y divide-border [&>section]:pt-10 [&>section:first-child]:pt-0">
          <ProfileSection />
          <AgentSection />
          {profile ? <DataSection dataDir={dataDir} /> : null}
          <OnboardingSection />
        </div>
      </div>
    </>
  );
}
