import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HarnessItem, useHarnesses } from "@/components/harness-list";
import { api, ApiError } from "@/lib/api";
import { useProfile } from "@/lib/profile";

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
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
        <Label htmlFor="settings-name">Preferred name</Label>
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

function AgentSection() {
  const { harnesses, loading, load, loggingInId, select, login, selectedId } =
    useHarnesses();

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
      <p className="mt-2 text-sm text-pretty text-muted-foreground">
        Overlearn teaches by driving a coding agent installed on this machine.
        Every agent it supports is listed below — installed ones can be picked
        as the default.
      </p>
      <div className="mt-4 divide-y divide-border">
        {harnesses.length === 0 && loading ? (
          <p className="py-3 text-sm text-muted-foreground">
            Loading agents…
          </p>
        ) : null}
        {harnesses.map((harness) => (
          <div key={harness.id} className="flex items-start gap-3 py-3">
            <HarnessItem
              harness={harness}
              idPrefix="harness"
              selected={selectedId === harness.id}
              loggingIn={loggingInId === harness.id}
              onSelect={() => void select(harness.id)}
              onLogin={() => void login(harness.id)}
            />
          </div>
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
      <AppHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-10">
          <div className="divide-y divide-border [&>section]:py-10 [&>section:first-child]:pt-0 [&>section:last-child]:pb-0">
            <ProfileSection />
            <AgentSection />
            {profile ? <DataSection dataDir={dataDir} /> : null}
            <OnboardingSection />
          </div>
        </div>
      </div>
    </>
  );
}
