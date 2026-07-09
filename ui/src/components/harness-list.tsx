import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, ApiError, subscribeEvents } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import type { HarnessSummary } from "@/lib/types";

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function useHarnesses() {
  const { profile, update } = useProfile();
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loggingInId, setLoggingInId] = useState<string>();
  const [retryingBridgeId, setRetryingBridgeId] = useState<string>();

  const load = useCallback(async (refresh?: boolean) => {
    setLoading(true);
    try {
      const list = await api.listHarnesses({
        scope: "profile",
        ...(refresh === undefined ? {} : { refresh }),
      });
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

  useEffect(
    () =>
      subscribeEvents({
        harnesses: (payload) => {
          if (payload.scope === "profile") {
            setHarnesses(payload.harnesses);
          }
        },
      }),
    [],
  );

  const select = useCallback(
    async (id: string) => {
      try {
        await update({ preferredHarness: id });
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [update],
  );

  const login = useCallback(
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

  const selectedId =
    profile?.preferredHarness ??
    harnesses.find((harness) => harness.selected && harness.installed)?.id;

  const retryBridge = useCallback(
    async (id: string) => {
      setRetryingBridgeId(id);
      try {
        await api.retryHarnessBridge(id);
        toast.success("Agent bridge is ready.");
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setRetryingBridgeId(undefined);
        void load();
      }
    },
    [load],
  );

  return {
    harnesses,
    loading,
    load,
    loggingInId,
    retryingBridgeId,
    select,
    login,
    retryBridge,
    selectedId,
  };
}

// Detection reports the raw first line of `--version` output (e.g.
// "@agentclientprotocol/codex-acp 1.1.0"); pull out just the version number.
function harnessVersion(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }
  const match = version.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/);
  return match ? `v${match[0]}` : version;
}

function InstallGuidance({ harness }: { harness: HarnessSummary }) {
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(harness.install.command);
      toast.success("Copied.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [harness.install.command]);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">{harness.name}</p>
        <Badge variant="outline" className="text-muted-foreground">
          Not installed
        </Badge>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"
          title={harness.install.command}
        >
          {harness.install.command}
        </code>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void copy()}
        >
          Copy
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Run this in a terminal, then hit Refresh.{" "}
        <a
          href={harness.install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Setup guide
        </a>
      </p>
    </div>
  );
}

export function HarnessItem({
  harness,
  idPrefix,
  selected,
  loggingIn,
  retryingBridge,
  onSelect,
  onLogin,
  onRetryBridge,
}: {
  harness: HarnessSummary;
  idPrefix: string;
  selected: boolean;
  loggingIn: boolean;
  retryingBridge: boolean;
  onSelect: () => void;
  onLogin: () => void;
  onRetryBridge: () => void;
}) {
  if (!harness.installed) {
    return (
      <>
        <span aria-hidden="true" className="mt-1 size-4 shrink-0" />
        <InstallGuidance harness={harness} />
      </>
    );
  }

  const inputId = `${idPrefix}-${harness.id}`;
  const version = harnessVersion(harness.version);
  const bridgeError = harness.bridge?.state === "error";
  const bridgeDownloading = harness.bridge?.state === "downloading";

  const copyBridgeInstall = async () => {
    const command = harness.bridge?.manualInstallCommand;
    if (command === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Copied.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  return (
    <>
      <input
        id={inputId}
        type="radio"
        name="preferredHarness"
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={selected}
        onChange={onSelect}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Label htmlFor={inputId} className="text-sm font-normal">
            {harness.name}
          </Label>
          {version ? (
            <div
              className="truncate text-xs text-muted-foreground"
              title={harness.version}
            >
              {version}
            </div>
          ) : null}
        </div>
        <div className="mt-1">
          {bridgeError ? (
            <Badge variant="secondary" className="bg-destructive/15 text-destructive">
              Bridge unavailable
            </Badge>
          ) : bridgeDownloading ? (
            <Badge variant="secondary" className="bg-warning/15 text-warning">
              Preparing bridge…
            </Badge>
          ) : harness.authenticated ? (
            <Badge variant="secondary" className="bg-success/15 text-success">
              Ready
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-warning/15 text-warning">
              Not logged in
            </Badge>
          )}
        </div>
        {bridgeError && harness.bridge ? (
          <div className="mt-2">
            <p className="text-xs text-destructive">{harness.bridge.message}</p>
            <div className="mt-1.5 flex items-center gap-1">
              <code
                className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
                title={harness.bridge.manualInstallCommand}
              >
                {harness.bridge.manualInstallCommand}
              </code>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void copyBridgeInstall()}
              >
                Copy
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Manual fallback: put this bridge on PATH, then refresh.
            </p>
          </div>
        ) : null}
      </div>
      {bridgeError ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={retryingBridge}
          onClick={onRetryBridge}
        >
          {retryingBridge ? "Retrying…" : "Retry"}
        </Button>
      ) : !harness.authenticated ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={loggingIn || bridgeDownloading}
          onClick={onLogin}
        >
          {loggingIn ? "Logging in…" : "Log in"}
        </Button>
      ) : null}
    </>
  );
}
