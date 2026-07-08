import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { OverlearnWordmark } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import type { HarnessSummary, OnboardingState } from "@/lib/types";

const STEPS: OnboardingState[] = ["welcome", "connect-agent", "tutorial-offer"];

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

function StepIndicator({ step }: { step: OnboardingState }) {
  const index = STEPS.indexOf(step);
  return (
    <div className="mb-8 flex items-center justify-center gap-1.5">
      {STEPS.map((candidate, candidateIndex) => (
        <span
          key={candidate}
          className={`size-1.5 rounded-full ${
            candidateIndex === index ? "bg-primary" : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function WelcomeStep() {
  const { profile, update, refresh } = useProfile();
  const [name, setName] = useState(profile?.name ?? "");
  const [busy, setBusy] = useState(false);

  const continueToNext = useCallback(async () => {
    setBusy(true);
    try {
      await update({ name: name.trim() });
      await api.setOnboarding("connect-agent");
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [name, refresh, update]);

  return (
    <div className="text-center">
      <h1 className="text-2xl tracking-tight text-balance">
        <OverlearnWordmark className="text-2xl" />
      </h1>
      <p className="mt-3 text-base text-pretty text-muted-foreground">
        Turn your coding agent into a personal teacher — durable notes,
        mastery checks, and demos stay on this machine.
      </p>
      <form
        className="mt-8 space-y-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void continueToNext();
        }}
      >
        <Label htmlFor="onboarding-name">Name (optional)</Label>
        <Input
          id="onboarding-name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="pt-4">
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Getting started…" : "Get started"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function HarnessCard({
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
    <Card className="flex-row items-start gap-3 p-4">
      <input
        id={`onboarding-harness-${harness.id}`}
        type="radio"
        name="preferredHarness"
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={selected}
        disabled={!harness.installed}
        onChange={onSelect}
      />
      <div className="min-w-0 flex-1">
        <Label
          htmlFor={`onboarding-harness-${harness.id}`}
          className="text-sm font-normal"
        >
          {harness.name}
        </Label>
        <div className="mt-1 flex items-center gap-2">
          <Badge
            variant="secondary"
            className={
              harness.authenticated ? "bg-success/15 text-success" : undefined
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
    </Card>
  );
}

function ConnectAgentStep() {
  const { profile, update, refresh } = useProfile();
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loggingInId, setLoggingInId] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refreshList?: boolean) => {
    setLoading(true);
    try {
      const list = await api.listHarnesses(
        refreshList ? { refresh: true } : undefined,
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

  const handleLogin = useCallback(
    async (id: string) => {
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
    },
    [load],
  );

  const goBack = useCallback(async () => {
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

  const continueToNext = useCallback(async () => {
    setBusy(true);
    try {
      await api.setOnboarding("tutorial-offer");
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div>
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Connect your agent
        </h1>
        <p className="mt-3 text-base text-pretty text-muted-foreground">
          Choose the coding agent Overlearn should use by default. You can
          change this later in settings.
        </p>
      </div>
      <div className="mt-8 flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          Agents
        </span>
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
      <div className="mt-3 space-y-3">
        {harnesses.length === 0 && loading ? (
          <p className="py-3 text-sm text-muted-foreground">
            Looking for installed agents…
          </p>
        ) : null}
        {harnesses.map((harness) => (
          <HarnessCard
            key={harness.id}
            harness={harness}
            selected={profile?.preferredHarness === harness.id}
            loggingIn={loggingInId === harness.id}
            onSelect={() => void handleSelect(harness.id)}
            onLogin={() => void handleLogin(harness.id)}
          />
        ))}
      </div>
      <div className="mt-8 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void goBack()}
        >
          Back
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={busy}
          onClick={() => void continueToNext()}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function TutorialOfferStep() {
  const { refresh } = useProfile();
  const [busy, setBusy] = useState(false);

  const startTutorial = useCallback(async () => {
    setBusy(true);
    try {
      const { courseId } = await api.createTutorial();
      await api.setOnboarding("done");
      await refresh();
      window.location.hash = `#/course/${courseId}`;
    } catch (cause) {
      toast.error(errorMessage(cause));
      setBusy(false);
    }
  }, [refresh]);

  const skip = useCallback(async () => {
    setBusy(true);
    try {
      await api.setOnboarding("done");
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">
        Start with a quick tutorial?
      </h1>
      <p className="mt-3 text-base text-pretty text-muted-foreground">
        The guided tutorial opens a short course about Overlearn itself:
        dialogue turns, topic mastery, Feynman checks, and review tools.
      </p>
      <div className="mt-8 space-y-2">
        <Button
          type="button"
          className="w-full"
          disabled={busy}
          onClick={() => void startTutorial()}
        >
          Start the tutorial course
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => void skip()}
        >
          Skip for now
        </Button>
      </div>
    </div>
  );
}

export function OnboardingScreen() {
  const { profile } = useProfile();

  if (!profile) {
    return null;
  }

  const step = profile.onboardingState;

  return (
    <div className="grid min-h-dvh place-items-center p-8">
      <div className="w-full max-w-md">
        {step === "done" ? null : <StepIndicator step={step} />}
        {step === "welcome" ? <WelcomeStep /> : null}
        {step === "connect-agent" ? <ConnectAgentStep /> : null}
        {step === "tutorial-offer" ? <TutorialOfferStep /> : null}
      </div>
    </div>
  );
}
