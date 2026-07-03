#!/usr/bin/env bash

set -uo pipefail

find_learn_bin() {
  if command -v learn >/dev/null 2>&1; then
    command -v learn
    return 0
  fi

  if [[ -n "${OVERLEARN_BIN:-}" && -x "${OVERLEARN_BIN}" ]]; then
    printf '%s\n' "${OVERLEARN_BIN}"
    return 0
  fi

  return 1
}

last_learner_said_goodbye() {
  local course_dir="$1"
  local transcript="${course_dir}/transcript.jsonl"

  if [[ ! -f "${transcript}" ]]; then
    return 1
  fi

  local last_learner
  last_learner=$(grep '"role":"learner"' "${transcript}" | tail -n 1 || true)

  if [[ -z "${last_learner}" ]]; then
    return 1
  fi

  printf '%s\n' "${last_learner}" |
    grep -Eiq 'goodbye|bye|end the session|end session|done for now|we are done|that is all'
}

learn_bin=$(find_learn_bin) || exit 0
status_json=$("${learn_bin}" status --json 2>/dev/null || true)

if [[ -z "${status_json}" ]]; then
  exit 0
fi

if ! printf '%s\n' "${status_json}" |
  grep -Eq '"daemonAlive"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

if printf '%s\n' "${status_json}" |
  grep -Eq '"waitPending"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

course_dir=$(
  printf '%s\n' "${status_json}" |
    sed -n 's/.*"courseDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)

if [[ -n "${course_dir}" ]] && last_learner_said_goodbye "${course_dir}"; then
  exit 0
fi

cat >&2 <<'EOF'
Overlearn learner session is active, but no `learn wait` is pending.
Re-enter the loop by launching `learn wait <course>` as a background task, then stop again.
EOF

exit 2
