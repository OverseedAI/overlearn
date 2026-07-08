import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/lib/markdown";
import { api, ApiError } from "@/lib/api";

type FeynmanCardCheck = {
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
};

export function FeynmanPanel({
  courseId,
  check,
  state,
  disabled,
}: {
  courseId: number;
  check: FeynmanCardCheck;
  state: "active" | "acted";
  disabled: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const text = answer.trim();
    if (text.length === 0 || submitting || disabled) {
      return;
    }
    setSubmitting(true);
    try {
      await api.feynmanAnswer(courseId, {
        concept: check.concept,
        text,
        keyPoints: [...check.keyPoints],
      });
      setAnswer("");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn’t submit.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
      <p className="text-xs font-medium text-warning">Feynman check</p>
      <p className="mt-1 text-sm font-medium">{check.concept}</p>
      <div className="mt-1">
        <Markdown text={check.prompt} />
      </div>
      {state === "active" ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Textarea
            name="feynman-answer"
            aria-label="Explain it in your own words"
            placeholder="Explain it in your own words..."
            value={answer}
            disabled={disabled || submitting}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            className="min-h-20 resize-none bg-background"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={disabled || submitting || answer.trim().length === 0}
            >
              Submit answer
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
