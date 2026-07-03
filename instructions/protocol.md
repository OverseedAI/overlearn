# Overlearn Loop Protocol

The course directory is the durable teaching surface. Chat is only connective
tissue.

At session start:

- Run `learn start <course>` to create or resume the course daemon.
- Run `learn instructions <course>` and treat the assembled output as binding
  teaching directives for the session.
- If you need the absolute course path, run `learn status <course> --json` and
  read `courseDir`.

Resuming:

- If the learner asks to continue/resume or invokes `/learn --resume [course]`,
  run `learn resume <course>` instead of `learn start <course>`. It must attach
  to an existing course and must not create one.
- If no course name is provided, run `learn status --json`; if that does not
  identify one course, inspect the courses directory for directories containing
  `course.json` and ask which course to resume.
- Before teaching after `learn resume`, rebuild context ONLY from on-disk course
  state: read `course.json` topics, every `lessons/*.md`, `glossary.json`,
  `mastery.json`, and the tail of `transcript.jsonl` (about the last 20
  entries).
- Explicitly forbidden: relying on prior conversation memory for the resumed
  course state.
- The first turn after resume must use `learn say <course> --text <markdown>` to
  greet the learner with an accurate summary of what has been covered, name
  where the course left off, and propose the next step. Then re-enter
  `learn wait <course>` as usual.

Each teaching turn:

1. Read the latest learner events from the `turn.json` path printed by
   `learn wait`, if this is not the first turn.
2. Decide the single learning objective for this turn.
3. Write or update one lesson file as the primary artifact:
   `lessons/<nn>-<slug>.md`.
4. Keep the lesson note short enough that the learner can review it during the
   course.
5. Optionally use `learn say <course> --text <markdown>` for conversational
   glue, a brief prompt, or a pointer to the lesson file.
6. ALWAYS launch `learn wait <course>` as a background task after acting.
7. STOP after launching the background wait. Do not continue until it exits.

Lesson files:

- Use two-digit numbering: `01-rule-of-72.md`, `02-why-72.md`.
- Update the current lesson when the same idea is still being refined.
- Create a new lesson when the learner advances to a new objective.
- Lesson content should capture what was learned, the worked example, and the
  current check question or next small task.

Turn files:

- `turn.json` contains an `events` array.
- `{"type":"message","text":"..."}` means the learner sent a chat message.
- Read every event before responding.
- If several learner messages arrive together, address them in order and still
  keep the teaching turn focused.

Daemon and wait rules:

- `learn wait <course>` exits 0 and prints the next `turn.json` path.
- Exit code 2 means the daemon died or the wait could not continue.
- On wait failure, run `learn start <course>`, inspect `learn status <course>
  --json`, and resume from the course files and transcript.
- Never leave an active learner session without a pending `learn wait`.
- If the learner explicitly ends the session, write a compact final lesson or
  summary, optionally send a closing `learn say`, and then stop without
  re-entering wait.
