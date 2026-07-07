import { Progress } from "@/components/ui/progress";
import type { MasteryEntry } from "@/lib/types";

/** Mastery scores are 0–100 (see instructions/grading.md). */
export function masterySummary(mastery: MasteryEntry[]) {
  if (mastery.length === 0) {
    return undefined;
  }
  const average = Math.round(
    mastery.reduce((total, entry) => total + entry.score, 0) / mastery.length,
  );
  const weakest = mastery.reduce((min, entry) =>
    entry.score < min.score ? entry : min,
  );
  return { average, weakest, graded: mastery.length };
}

export function MasteryMeter({ mastery }: { mastery: MasteryEntry[] }) {
  const summary = masterySummary(mastery);

  if (!summary) {
    return (
      <p className="text-sm text-muted-foreground">Nothing graded yet.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium tabular-nums">{summary.average}</span>
        <span className="text-muted-foreground tabular-nums">
          {summary.graded} graded
        </span>
      </div>
      <Progress value={summary.average} className="h-1.5" />
      <p className="truncate text-sm text-muted-foreground">
        Weakest: {summary.weakest.concept} ({summary.weakest.score})
      </p>
    </div>
  );
}
