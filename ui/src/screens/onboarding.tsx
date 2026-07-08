import { useCallback, useState } from "react";
import { toast } from "sonner";
import { OverlearnWordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HarnessItem, useHarnesses } from "@/components/harness-list";
import { api, ApiError } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import type { OnboardingState } from "@/lib/types";

const STEPS: OnboardingState[] = ["welcome", "connect-agent", "tutorial-offer"];

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
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
        <Label htmlFor="onboarding-name">Preferred name (optional)</Label>
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

function ConnectAgentStep() {
  const { refresh } = useProfile();
  const { harnesses, loading, load, loggingInId, select, login, selectedId } =
    useHarnesses();
  const [busy, setBusy] = useState(false);

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
          <Card key={harness.id} className="flex-row items-start gap-3 p-4">
            <HarnessItem
              harness={harness}
              idPrefix="onboarding-harness"
              selected={selectedId === harness.id}
              loggingIn={loggingInId === harness.id}
              onSelect={() => void select(harness.id)}
              onLogin={() => void login(harness.id)}
            />
          </Card>
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
    <div className="h-dvh overflow-y-auto p-8">
      <div
        data-tauri-drag-region
        aria-hidden="true"
        className="app-onboarding-drag-region"
      />
      <div className="grid min-h-full place-items-center">
        <div className="w-full max-w-md">
          {step === "done" ? null : <StepIndicator step={step} />}
          {step === "welcome" ? <WelcomeStep /> : null}
          {step === "connect-agent" ? <ConnectAgentStep /> : null}
          {step === "tutorial-offer" ? <TutorialOfferStep /> : null}
        </div>
      </div>
    </div>
  );
}
