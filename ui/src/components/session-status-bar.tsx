import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api, subscribeEvents } from "@/lib/api";
import { useRoute } from "@/lib/router";
import type { SessionSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

function useLiveSessions(): readonly SessionSummary[] {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const applySessions = (next: SessionSummary[]) => {
      if (!cancelled) {
        setSessions(next);
      }
    };

    const unsubscribe = subscribeEvents({
      sessions: applySessions,
    });

    void api
      .listSessions()
      .then(applySessions)
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return sessions;
}

export function SessionStatusBar() {
  const sessions = useLiveSessions();
  const { navigate } = useRoute();

  if (sessions.length === 0) {
    return null;
  }

  return (
    <footer className="shrink-0 border-t bg-background/95 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        {sessions.map((session) => {
          const running = session.state === "turn-running";

          return (
            <button
              key={session.courseId}
              type="button"
              aria-label={`Open ${session.courseTitle} (${running ? "running" : "idle"})`}
              className={cn(
                "inline-flex h-8 max-w-64 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                running
                  ? "border-warning/35 bg-warning/10 text-foreground hover:bg-warning/15"
                  : "border-border bg-background text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
              )}
              onClick={() =>
                navigate({ view: "course", courseId: session.courseId })
              }
            >
              {running ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin text-warning"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-muted-foreground/55"
                />
              )}
              <span className="min-w-0 truncate">{session.courseTitle}</span>
            </button>
          );
        })}
      </div>
    </footer>
  );
}
