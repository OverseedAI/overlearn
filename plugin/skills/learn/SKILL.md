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

1. Choose the course name.
   - If the learner provides an explicit course name, use it.
   - Otherwise derive a short, filesystem-safe slug from the learner's topic.
   - Use that exact `<course>` for every command in the session.
   - Future resume/from hints may exist later; do not rely on them now.

2. Start the course.
   - Run `learn start <course>`.
   - Do NOT proceed until the command succeeds.

3. Ingest the teaching directives.
   - Run `learn instructions <course>`.
   - Read the full output and treat it as binding for the rest of the session.
   - Do NOT proceed until the instructions have been ingested.

4. Teach one turn according to the ingested instructions.
   - Write or update the lesson file required by the ingested protocol.
   - Use `learn say <course> --text <markdown>` only when conversational glue is
     useful.
   - Do NOT treat chat as the primary deliverable.

5. Re-enter the wait.
   - MANDATORY: launch `learn wait <course>` as a background task.
   - STOP immediately after launching the background wait.
   - Do NOT produce more output, continue teaching, or end the session while the
     wait is pending.
   - Do NOT proceed until the background wait exits.

6. Handle the next learner turn.
   - When `learn wait` exits 0, read the `turn.json` path it printed.
   - Act on every event in that file.
   - GOTO step 4.

7. Recover from daemon failure.
   - If `learn wait` exits non-zero, run `learn start <course>`.
   - Inspect `learn status <course> --json` if needed.
   - Resume from the course files and transcript.
   - GOTO step 4.

Never end an active learner session without either a pending `learn wait` or a
clear learner goodbye handled according to the ingested protocol.
