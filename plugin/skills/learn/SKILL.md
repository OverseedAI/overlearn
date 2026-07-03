---
name: learn
description: Use when the user wants Claude Code to teach an interactive Overlearn course, asks to learn a topic, or invokes /learn.
---

# learn

This skill is a thin Overlearn loop driver. It defines how to run the loop.
It does not define how to teach.

Do not inline or invent teaching policy. The teaching directives must come from
`learn instructions`.

## Mandatory Loop

1. Choose the course name and mode.
   - If the learner asks to continue/resume a course or invokes
     `/learn --resume [course]`, use resume mode.
   - If the learner provides an explicit course name, use it.
   - Otherwise derive a short, filesystem-safe slug from the learner's topic.
   - For resume mode with no explicit name: run `learn status --json`; if that
     does not identify one course, inspect the courses directory for directories
     containing `course.json` and ask which course to resume.
   - Use that exact `<course>` for every command in the session.

2. Start the course.
   - In resume mode, run `learn resume <course>`.
   - Otherwise run `learn start <course>`.
   - Do NOT proceed until the command succeeds.

3. Ingest the teaching directives.
   - Run `learn instructions <course>`.
   - Read the full output and treat it as binding for the rest of the session.
   - Do NOT proceed until the instructions have been ingested.

4. Rebuild resume context, when resuming.
   - MANDATORY before teaching after `learn resume`: rebuild context ONLY from
     on-disk course state.
   - Read `course.json`, every `lessons/*.md`, `glossary.json`, `mastery.json`,
     and the tail of `transcript.jsonl` (about the last 20 entries).
   - Explicitly forbidden: relying on prior conversation memory.
   - First turn after resume: use `learn say <course> --text <markdown>` to
     greet the learner with an accurate summary of what was covered, name where
     the course left off, and propose the next step. Then go to step 6.

5. Teach one turn according to the ingested instructions.
   - Write or update the lesson file required by the ingested protocol.
   - Use `learn say <course> --text <markdown>` only when conversational glue is
     useful.
   - Do NOT treat chat as the primary deliverable.

6. Re-enter the wait.
   - MANDATORY: launch `learn wait <course>` as a background task.
   - STOP immediately after launching the background wait.
   - Do NOT produce more output, continue teaching, or end the session while the
     wait is pending.
   - Do NOT proceed until the background wait exits.

7. Handle the next learner turn.
   - When `learn wait` exits 0, read the `turn.json` path it printed.
   - Act on every event in that file.
   - GOTO step 5.

8. Recover from daemon failure.
   - If `learn wait` exits non-zero, run `learn start <course>`.
   - Inspect `learn status <course> --json` if needed.
   - Resume from the course files and transcript.
   - GOTO step 5.

Never end an active learner session without either a pending `learn wait` or a
clear learner goodbye handled according to the ingested protocol.
