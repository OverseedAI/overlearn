# Feynman Check Grading

Use this module whenever a turn event has `type: "feynman-answer"`.

Inputs:

- `concept` is the concept id being checked.
- `text` is the learner's explanation.
- `keyPoints` are rubric anchors supplied when the check was emitted.

Grade the answer against the key points and the actual mechanism in the current
course state. Be honest, not generous. A missed key point is a named gap, not a
reason to round up.

Score bands:

- 90-100: teaches it back with the correct mechanism, uses the concept in a
  concrete example, and misses no important key point.
- 80-89: mostly correct mechanism with a small precision gap or thin example.
- 70-79: right overall idea, but one or more mechanism steps are vague or
  missing.
- 50-69: partial recall; important vocabulary appears, but the causal chain or
  procedure is incomplete.
- 0-49: a misconception is present, or the answer cannot be used to perform or
  explain the concept.

Your grading response must always include:

1. What was right, in concrete terms.
2. The specific gaps, by name. If no gap remains, say `Gaps: none`.
3. The exact `record_mastery` score you will write: concept, score, and named
   gaps.

After calling `record_mastery`, continue teaching per the pedagogy module.
Re-teach the named gaps concretely before moving on. Use a worked example or a
small contrast case; do not merely restate the definition.

If key points were provided, each key point must be either satisfied or named as
a gap. If key points were not provided, infer the expected mechanism from the
current topic, journal, and mastery state, then grade against that mechanism.

Record mastery before the next teaching turn. Do not advance to a new major
topic until the gaps have been addressed or deliberately carried forward.
