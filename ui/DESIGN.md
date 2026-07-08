# Overlearn UI — design conventions

Vite + React 19 + Tailwind v4 + shadcn/ui SPA served by Tauri. Talks to the
Bun daemon over `/api/*` + SSE (`/api/events`). See `src/lib/api.ts` (client),
`src/lib/types.ts` (protocol).

## Visual language — "warm scholarly"

- Paper-ivory light mode, espresso dark mode, burnt-amber accent. All colors
  come from semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`,
  `bg-card`, `border-border`, `bg-primary`, `bg-success`, `bg-warning`,
  `bg-destructive`, sidebar tokens). Never hardcode palette colors.
- Dark mode is automatic via tokens; only use `dark:` for non-token cases
  (e.g. `dark:shadow-none`). Both modes must hold the same contrast.
- Font is InterVariable (loaded via @fontsource). Headings `font-semibold`
  (never `font-bold`), `tracking-tight` above `text-xl`, `text-balance` on
  headings, `text-pretty` on paragraphs.

## Layout & components

- This is a desktop app UI: body text `text-sm`; `text-base` only for
  hero/onboarding moments. Numbers that change get `tabular-nums`.
- Use the vendored shadcn components in `src/components/ui/` — never invent a
  parallel button/input/dialog. Buttons: `size="sm"` default in dense areas;
  ONE `variant="default"` (primary) per screen/dialog, everything else
  `secondary`, `outline`, or `ghost`. Destructive actions use `outline`/`ghost`
  styling unless confirming inside a dedicated dialog.
- Icons: lucide only, `className="size-4 shrink-0"`, never larger in app chrome;
  no icons in stat tiles; align icons with the first text line (`items-start`),
  not `items-center`, when next to multi-line text.
- Separation hierarchy: whitespace first, then `border-b`/`divide-*`
  (opacity-based, from tokens), wells (`bg-muted`) for nested/secondary
  content, `Card` only for independently interactive or standalone items.
  No white-card-on-gray-page-by-default.
- Flex/grid children use `gap-*` on the parent, never margins between siblings.
  Prefer `size-*` over `h-* w-*` pairs. `min-h-dvh`, never `min-h-screen`.
- Every screen renders inside `SidebarInset`; screens provide their own header
  row: `<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">`
  starting with `<SidebarTrigger />`, then a `text-sm font-medium` title, then
  right-aligned actions (`ms-auto`).

## Forms

- Every input/select/textarea has an associated `<Label htmlFor>` or
  `aria-label`, plus a `name` attribute. `type="button"` on non-submit buttons.
- Inline/secondary form actions (browse, refresh, copy) are small +
  secondary — never the same size/style as the form's primary submit.

## Code conventions

- Functional components, no classes. `exactOptionalPropertyTypes` is ON:
  optional props you spread/pass conditionally should be typed
  `foo?: T | undefined`, or build objects with conditional spreads
  (`...(x !== undefined ? { x } : {})`).
- Errors from the API are `ApiError` with plain-text `message` — surface via
  `toast.error(message)` (sonner) unless the screen has a better inline place.
- No new dependencies without checking the 7-day supply-chain age gate.
- Verify with `./node_modules/.bin/tsc --noEmit` from `ui/`.
