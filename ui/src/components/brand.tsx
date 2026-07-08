import { cn } from "@/lib/utils";

/**
 * Overlearn sprout mark — a seedling whose stem doubles as the "l" in the
 * wordmark. Fills with currentColor so callers pick the tone per theme.
 */
export function SproutMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 140"
      aria-hidden="true"
      className={cn("inline-block", className)}
    >
      <path
        d="M50 134 C50 108 47 88 49 64"
        fill="none"
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="round"
      />
      <path d="M49 66 C28 70 12 58 8 36 C32 32 48 44 49 66 Z" fill="currentColor" />
      <path d="M49 66 C50 34 66 12 94 6 C98 40 78 62 49 66 Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Lowercase "overlearn" wordmark where the sprout stands in for the "l".
 * Scales with font-size; set the size via text-* classes on `className`.
 */
export function OverlearnWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline font-semibold tracking-tight text-foreground",
        className,
      )}
    >
      over
      <SproutMark className="mx-[-0.03em] h-[1.08em] w-auto self-end text-success" />
      earn
    </span>
  );
}
