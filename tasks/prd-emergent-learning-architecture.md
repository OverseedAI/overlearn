# PRD: Emergent Learning Architecture (Fog-of-War Mentor)

## 1. Introduction / Overview

Overlearn currently models learning as a **planned course**: the learner seeds an idea, the agent drafts a complete topic tree up front (`propose_course_plan`), the learner reviews and accepts it in a Wizard screen, and then walks the plan linearly. The daemon compounds this by allowing exactly **one active learning session** — starting or touching a second course returns `409` until the first session ends, and a wrap-up turn shuts the daemon down entirely.

This PRD replaces that model with an **emergent, non-linear one**:

> The mentor helps you navigate a **fog of war** inside a subject. You might start from one point and not know where you'll go. You might start at the end and walk your way back, or start halfway and continue. The topic sidebar is a **map of visited nodes**, not a syllabus. Nothing is planned ahead; territory is created by walking it.

Simultaneously, the daemon becomes **multi-conversation**: any number of courses can hold live agent sessions concurrently, sessions expire on an idle TTL, and running agents are surfaced to the user in a persistent status bar.

### Decision log (from design discussion, 2026-07-07/08)

These decisions are settled. They are recorded here so implementation does not re-litigate them:

| # | Decision | Choice |
|---|----------|--------|
| D1 | Map model | **Emergent** — no plan ever exists, hidden or otherwise. No "hidden atlas". Territory is created by walking it. |
| D2 | Concurrency | Daemon holds a **pool of live sessions, unbounded**, with a per-session **idle TTL** (session subprocess exits after X idle minutes). No LRU cap. |
| D3 | Session visibility | Running agents surfaced in a **bottom status bar** (by course name) plus session state over SSE. |
| D4 | Lessons | **One-to-one with topics.** A lesson is the topic's **journal**: an append-only sequence of entries (study notes, demo pins, summaries), not a replaceable document. |
| D5 | Demos | Surfaced in chat **and** pinned into the topic journal as a **link line** at the chronological position they were emitted. One tool call does both. |
| D6 | Topic discovery | Agent proffers next topics as **clickable cards** (`propose_topics`, 2–3 max), allowed **anytime it feels natural**, not only at topic conclusions. Enforced via system-prompt instructions. |
| D7 | Turn semantics on nav | Entering a **new** (frontier / never-visited) topic starts an agent turn. Selecting an **already-visited** topic does **not** start a turn — it is a local view change. |
| D8 | Transition commit | When a learner enters a new topic (card click or sidebar click), the **daemon commits** `entered_at` + `is_current` immediately, then fires the agent turn. The write is safe because the topic data was agent-authored (the proposal); this is the same pre-authorized-commit trick the old accept-plan used. |
| D9 | Continuity | **One conversation per course.** The full transcript is retained; topic changes are entries *within* that conversation. Every transcript entry records the current topic. Durable per-topic memory lives in the journal, not the transcript. |
| D10 | Topic-change rendering | When the user changes topic **and** sends a new message, a small **metadata line** is written into the chat ("topic changed to *X*"). The chat history must contain the complete transcript so a reader can follow the entire education history from chat alone. |
| D11 | Feynman checks | Become **optional / non-blocking**. The learner can answer the card **or** just type a follow-up question. Same "do A or ask B" interaction contract as topic cards. |
| D12 | Skipped cards | When an optional card (Feynman, topic proposals) is skipped, it is **not shown in chat history** as a stale action item. It disappears; the opportunity resurfaces naturally as learning progresses. |
| D13 | Migration | **Wipe and start fresh.** Pre-1.0, no external users. Bump schema version, drop incompatible data. No migration code. |
| D14 | Course creation | **Seed → mentor orients.** Single seed prompt ("What do you want to learn?"). Course is created `active` immediately with a placeholder title. Turn 1: the mentor orients — asks where the learner wants to enter the territory, names the course, and creates the first topic once the learner engages. No review step. |

## 2. Goals

- A learner can jump **topic to topic and course to course** at any time with zero artificial blocking. The `409 "Course N already has the active learning session"` class of failure is eliminated entirely.
- Courses start teaching **within one turn** of the seed. No wizard, no plan review, no accept gate.
- The topic sidebar reads as a **map**: where you are, where you've been, and 2–3 unexplored directions — never a pre-generated syllabus.
- Every piece of durable study material (journal notes, demo pins, summaries) is attributable to **when** it was learned and **which conversation turn** produced it.
- Conversation continuity survives session eviction, TTL expiry, harness swaps, and context compaction — because per-topic memory is durable (journals + mastery), not conversational.
- The user can always see **which agents are running right now** (status bar) without opening each course.

## 3. What is deleted

Explicit teardown list. Each item's removal is in-scope work, including its tests:

| Component | Location | Replacement |
|-----------|----------|-------------|
| Single-session lock (`rejectDifferentActiveCourse`, `activeCourseId`, singleton `runtime`) | `src/daemon/index.ts:1317-1318, 1603` | Session pool (`Map<courseId, CourseRuntime>`) |
| Daemon self-shutdown after wrap-up turn | `src/daemon/index.ts:1666-1673` | Wrap-up ends that course's session only |
| `draft` course status + all draft-only guards | `src/store`, `src/daemon` | Courses are created `active` |
| Wizard screen (plan review, local topic editing, accept/discard) | `ui/src/screens/wizard.tsx` | None — deleted |
| `POST /api/courses/:id/accept-plan` | `src/daemon/index.ts:1804` | None — deleted |
| `ideation` turn mode + ideation preamble | `src/daemon/orchestrator.ts:350`, `index.ts` submit routing (`index.ts:2318`) | `orientation` mode for turn 1 (see FR-20) |
| `propose_course_plan` MCP tool | `src/mcp/teaching.ts:1343` | `propose_topics` (incremental) |
| `upsert_lesson` MCP tool (whole-body replace) | `src/mcp/teaching.ts:1201` | `append_lesson_note` (append-only) |
| `lessons` table + `topics.lesson_id` string ref + `glossary.lesson_id` | `src/store/index.ts:540-553, 564, 603` | `topic_journal_entries` table; `glossary.topic_id` |
| Blocking Feynman semantics (`clearActiveFeynmanCheck` on answer only, card persists in history) | `src/daemon/index.ts`, `src/mcp/teaching.ts`, transcript rendering | Optional cards (FR-30..FR-34) |

## 4. User Stories

Phased. Phases are ordered by dependency: A (concurrency) and B (schema) are independent of each other; C–G depend on B; H depends on A.

### Phase A — Session pool

#### US-A1: Replace the runtime singleton with a session pool
**Description:** As a learner, I want to interact with several courses concurrently so that switching subjects never blocks on another course's session.

**Acceptance Criteria:**
- [ ] `runtime` singleton and `activeCourseId` are removed; daemon holds `Map<courseId, CourseRuntime>`.
- [ ] `rejectDifferentActiveCourse` is deleted; no endpoint returns the `already has the active learning session` 409.
- [ ] Turn serialization remains **per course**: concurrent turns for the *same* course still 409 (`"A turn is already running for this course."`); turns for *different* courses run concurrently.
- [ ] Two courses can each run an agent turn at the same time (integration test: submit to course 1 and course 2 while both are mid-turn; both complete).
- [ ] The teaching MCP token routing keeps tool calls scoped to the correct course when two sessions are live simultaneously (test: `get_course_state` from session A never sees course B).
- [ ] Wrap-up (`session-done`) ends only that course's session and removes it from the pool. The daemon process stays up. The `shutdown()` call at `index.ts:1670` is removed.
- [ ] Typecheck + existing daemon test suite passes.

#### US-A2: Idle TTL on live sessions
**Description:** As a user, I want idle agent subprocesses to exit on their own so that leaving many courses open doesn't accumulate resident processes forever.

**Acceptance Criteria:**
- [ ] Each pooled session tracks `lastActivityAt` (updated when a turn starts and when it completes).
- [ ] A session idle longer than the TTL is ended (`orchestrator.endSession("idle-ttl")`) and removed from the pool.
- [ ] TTL is configurable via `OVERLEARN_SESSION_IDLE_TTL_MS`; default **30 minutes**. Parsed with the same positive-integer validation as existing env knobs (`orchestrator.ts:112`).
- [ ] A TTL-expired course resumes transparently: the next turn cold-starts a session and the existing resume machinery (`nextTurnNeedsResumeContext` → resume preamble → `get_course_state`) rebuilds context. No user-visible error.
- [ ] TTL never fires mid-turn: a running turn counts as activity; expiry checks skip sessions with `runningTurn === true`.
- [ ] Unit tests cover: expiry after idle, no expiry while running, activity reset on new turn.

#### US-A3: Session state over SSE
**Description:** As a UI, I need a live feed of which courses have running agents so that session state can be surfaced anywhere in the app.

**Acceptance Criteria:**
- [ ] New SSE event `sessions` broadcasting: for each pooled course — `courseId`, `courseTitle`, `harnessId`, `state: "turn-running" | "idle"`, `lastActivityAt`, `startedAt`.
- [ ] Broadcast fires on: session start, turn start, turn end, session end (any reason: wrap-up, TTL, crash, harness swap).
- [ ] `GET /api/sessions` returns the same payload for initial load.
- [ ] Courses with no live session are simply absent from the payload (cold is the default state; the UI infers it).

### Phase B — Store schema v2 (wipe, no migration)

#### US-B1: Schema v2 — journals, transcript topic column, glossary re-pointing
**Description:** As a developer, I need the store to model journals and per-entry topic attribution so that all downstream features have a durable substrate.

**Acceptance Criteria:**
- [ ] Schema version bumped; on open, an old-version database is **discarded and recreated** (log a clear one-line warning). No data migration code (decision D13).
- [ ] `lessons` table deleted. `topics.lesson_id` column deleted.
- [ ] New table:
  ```sql
  CREATE TABLE topic_journal_entries (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'demo', 'summary')),
    body_markdown TEXT,                 -- required for note/summary, NULL for demo
    demo_id INTEGER REFERENCES demos(id) ON DELETE CASCADE,  -- required for demo, NULL otherwise
    turn INTEGER,                       -- conversation turn that produced this entry
    created_at TEXT NOT NULL
  );
  CREATE INDEX topic_journal_entries_topic_idx
    ON topic_journal_entries(topic_id, id);
  ```
  with a CHECK enforcing kind/payload consistency (`demo` ⇔ `demo_id NOT NULL ∧ body_markdown IS NULL`).
- [ ] `transcript` gains `topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL` — the current topic at the moment the entry was written (D9). Nullable: pre-first-topic entries have none.
- [ ] `glossary.lesson_id` replaced with `topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL`.
- [ ] `courses.status` CHECK becomes `('active', 'archived')` — `draft` removed.
- [ ] Store helpers: `appendJournalEntry`, `listJournalEntries(courseId, topicId)`, plus updates to `readTopicTree` consumers.
- [ ] Course bundle export/import (`src/store/bundle.ts`) updated to the new schema (journals included; lessons section removed).
- [ ] Typecheck + store test suite passes.

#### US-B2: Topic node states on the existing schema
**Description:** As a developer, I want fog-of-war node states derived from existing columns so that no speculative schema is added.

**Acceptance Criteria:**
- [ ] Node state is a pure derivation, implemented once and exported: `frontier` = `entered_at IS NULL`; `visited` = `entered_at NOT NULL`; `current` = `is_current = 1`.
- [ ] `get_course_state` and the topics REST/SSE payloads expose the derived state per topic node.
- [ ] The one-current-per-course unique index (`src/store/index.ts:576`) is retained.

### Phase C — Course creation (seed → mentor orients)

#### US-C1: Create-course endpoint replaces ideate
**Description:** As a learner, I want to describe what I want to learn and be inside a live course immediately so that no review step separates me from the mentor.

**Acceptance Criteria:**
- [ ] `POST /api/courses/ideate` is replaced by `POST /api/courses` accepting `{ seed: string }`.
- [ ] The course is created with `status: "active"`, placeholder title (`"New course"`), and the seed stored as description and appended to the transcript as the learner's first message.
- [ ] Turn 1 fires immediately in **orientation** mode (FR-20): the mentor asks where the learner wants to enter the territory, proposes a course title via `update_course_info`, and does **not** create topics until the learner engages (D14).
- [ ] Creating a course while other courses have live sessions works (no cross-course gating).
- [ ] The Library "Brainstorm" dialog copy is updated: same single seed prompt, button navigates straight to the Course screen (Wizard route deleted).
- [ ] Typecheck passes; verify in browser using dev-browser skill.

#### US-C2: Delete the Wizard and draft machinery
**Description:** As a developer, I want the plan-review flow removed so that the codebase has one way to start learning.

**Acceptance Criteria:**
- [ ] `ui/src/screens/wizard.tsx` deleted; router no longer has a wizard view; `draft`-conditional routing removed from the app shell.
- [ ] `accept-plan` endpoint, `handleAcceptPlan`, `parsePlanTopics` deleted (`src/daemon/index.ts:1703-1890`).
- [ ] Submit routing no longer branches on draft (`index.ts:2318`): all submits are teaching-mode message events.
- [ ] `ideation` removed from `TurnPromptMode`; ideation preamble deleted (`orchestrator.ts:350`).
- [ ] `propose_course_plan` tool removed from the teaching MCP server and from the pre-approved permission list (`orchestrator.ts:277`).
- [ ] DELETE on an active course archives (existing behavior); the hard-delete-draft path is removed.
- [ ] Typecheck + full test suite passes.

### Phase D — Teaching MCP tool surface

#### US-D1: `append_lesson_note`
**Description:** As the mentor agent, I want to append study notes to the current topic's journal so that the lesson accretes chronologically as we talk.

**Acceptance Criteria:**
- [ ] New tool `append_lesson_note`: `{ markdown: string, topicPath?: string }`.
- [ ] `topicPath` **defaults to the current topic**; explicit path overrides for tangents (D9). Errors clearly if there is no current topic and no explicit path.
- [ ] Inserts a `kind: 'note'` journal entry stamped with the active turn number.
- [ ] `upsert_lesson` is removed from the tool surface, schemas, and permission pre-approval list.
- [ ] `writeSummary`/`writeAttachment` metadata produced so the note lands in the transcript stream as an attachment, consistent with existing write surfacing.
- [ ] Unit tests: default-to-current, explicit override, no-current error.

#### US-D2: `emit_demo` pins into the journal
**Description:** As a learner, I want demos to appear in chat and be pinned into the topic journal at the point in time they were shown so that the journal replays the walk faithfully (D5).

**Acceptance Criteria:**
- [ ] When `emit_demo` resolves a topic (explicit `topicPath` or defaulting to the current topic — default added, mirroring US-D1), it also inserts a `kind: 'demo'` journal entry referencing the demo row, stamped with the turn.
- [ ] Journal rendering shows the pin as a **link line** (title + link to the demo) at its chronological position, not the full demo body inline.
- [ ] Existing chat surfacing (`writeAttachment`) unchanged — the demo still appears in the conversation.
- [ ] A demo emitted with no resolvable topic emits to chat only (no journal entry), and this is documented in the tool description.

#### US-D3: `propose_topics`
**Description:** As the mentor agent, I want to proffer 2–3 next directions as clickable cards so that the learner can choose where to walk next or ignore them and keep talking.

**Acceptance Criteria:**
- [ ] New tool `propose_topics`: `{ topics: Array<{ path, title, blurb }> }`, 1–3 items enforced at the schema level.
- [ ] Each proposed topic is upserted as a **frontier stub** (`entered_at NULL`, not current). Re-proposing an existing path is a no-op upsert, never a duplicate.
- [ ] The tool emits a card attachment into the transcript (one card group per call) rendered as clickable topic cards with title + blurb.
- [ ] Proposal cards are **ephemeral** (D12): they render only while they are the latest actionable item. Skipping (see US-E3) removes them from history rendering; the frontier stubs remain on the map.
- [ ] `update_course_info` tool added alongside: `{ title?, description? }`, so the mentor can name the course during orientation (D14). Both tools added to the permission pre-approval list.
- [ ] Unit tests: stub creation, 3-item cap, no-dup upsert.

#### US-D4: Current-topic context in every turn prompt
**Description:** As the mentor agent, I need to know where the learner is standing so that I know whether the topic changed and where journal entries go (D9).

**Acceptance Criteria:**
- [ ] `buildTurnPrompt` includes a position block: current topic path + title, its node state, and — when the turn was triggered by or follows a topic change — `previousTopic` and `revisit: true|false` (revisit = topic already had `entered_at` before this entry).
- [ ] The `nav`-descendant turn event (see US-E1) carries `path`, `revisit`, `previous`.
- [ ] Protocol instructions require: on `revisit: true`, read the topic's journal (via `get_course_state` or the journal in its payload) before responding, and greet with where things left off.
- [ ] `get_course_state` response includes each topic's journal entries (or a bounded recent window with total count — bounded is acceptable; document the bound).

### Phase E — Navigation & turn semantics

#### US-E1: Entering a new topic starts a turn; visiting an old one doesn't
**Description:** As a learner, I want clicking around my map to be free, and only *entering new territory* to engage the mentor (D7, D8).

**Acceptance Criteria:**
- [ ] Clicking a **frontier** topic (sidebar node or proposal card): daemon sets `entered_at` + `is_current` immediately in one transaction, broadcasts the map update, **then** starts an agent turn with a `topic-entered` event (`{ path, revisit: false, previous }`). The mentor kickstarts the topic.
- [ ] Clicking a **visited** topic: daemon sets `is_current` (no `entered_at` change), broadcasts, and does **not** start a turn. The lesson rail shows that topic's journal. No agent involvement, zero latency.
- [ ] Clicking the current topic: no-op (existing guard).
- [ ] The pending-topic-change is remembered (per course, in daemon memory): the next learner message's turn payload includes the topic-change context so the agent knows the ground shifted (`revisit: true`, previous topic) (D10).
- [ ] REST: `POST /api/courses/:id/nav` behavior updated accordingly; UI `TopicTree` no longer disables during agent turns for visited-topic clicks (only frontier entry is gated by `runningTurn`).
- [ ] Integration tests: frontier click → turn starts + map committed even if turn later fails; visited click → no turn, current pointer moved.
- [ ] Verify in browser using dev-browser skill.

#### US-E2: Transcript topic attribution + topic-change metadata lines
**Description:** As a learner, I want the chat history alone to tell my entire education story, including when I moved around the map (D9, D10).

**Acceptance Criteria:**
- [ ] Every transcript append records the current `topic_id` at write time (learner, agent, and system entries).
- [ ] When the user changes topic and then sends a message, a **system metadata line** is inserted into the transcript *before* the message: kind `topic-change`, content naming the topic (e.g. "Topic changed to **Queries and Indexes**" / "Back to **Schema Design** (revisit)").
- [ ] Frontier entry (which fires its own turn) also writes the metadata line at the moment of entry.
- [ ] Chat UI renders `topic-change` entries as small divider lines, visually distinct from speech.
- [ ] Metadata lines are persisted transcript entries (they survive reload and appear in bundle export) — the transcript is the complete history.
- [ ] Verify in browser using dev-browser skill.

#### US-E3: Skipped optional cards disappear from history
**Description:** As a learner, I don't want stale action items cluttering my chat when I chose to do something else (D12).

**Acceptance Criteria:**
- [ ] A card (topic proposals, Feynman check) is **actionable** only until the learner takes any other action in that course (sends a message, enters another topic, answers a different card).
- [ ] Once superseded, the card is not rendered in chat history at all (the transcript row is retained in the store with a `skipped` marker for export fidelity, but the renderer hides it).
- [ ] No "expired"/"skipped" placeholder is shown — the item simply isn't there (D12).
- [ ] The underlying opportunities persist naturally: proposal stubs stay on the map as frontier nodes; the agent may re-issue a Feynman check later.
- [ ] Verify in browser using dev-browser skill.

### Phase F — Optional Feynman checks

#### US-F1: Non-blocking Feynman cards
**Description:** As a learner, I want to be able to ask a clarifying question instead of answering a Feynman check so that checks feel like an offer, not a gate (D11).

**Acceptance Criteria:**
- [ ] While a Feynman card is active, the message composer stays fully enabled; sending a message is a normal teaching turn and marks the check `skipped` (new status alongside `active`/`replaced`/`cleared`) — hiding the card per US-E3.
- [ ] Answering the card still routes through `feynman-answer` → grading → `record_mastery` (unchanged happy path).
- [ ] The one-active-check-per-course invariant is retained (`feynman_one_active_per_course_idx`) — skipped counts as not-active.
- [ ] The turn payload after a skip tells the agent the check was skipped in favor of the learner's message (event or payload flag), so the mentor can respond to the question and *choose* whether to re-issue the check later.
- [ ] Protocol/pedagogy instructions updated: the check is an offer; "answer A or ask B" is the standing interaction contract for all cards.
- [ ] Verify in browser using dev-browser skill.

### Phase G — Instructions rewrite (protocol.md / pedagogy.md)

#### US-G1: Rewrite the teaching protocol for emergent mode
**Description:** As the mentor agent, I need instructions that describe the fog-of-war model so that my tool use matches the architecture.

**Acceptance Criteria:**
- [ ] `instructions/protocol.md` rewritten: topic states (frontier/visited/current), `topic-entered` event with `revisit` semantics, journal-first revisit behavior, `append_lesson_note` default-to-current, `propose_topics` contract.
- [ ] `propose_topics` guidance (D6): allowed **anytime it feels natural** — at a topic's natural conclusion *or* mid-topic when a genuine fork appears; at most 3 topics per call; never proffer twice in a row without teaching in between; frontier stubs are local judgment about adjacency, not a syllabus.
- [ ] Journal guidance: append short study notes as concepts land (not one dump at the end); drop a `summary` entry when leaving a topic; demos pin automatically.
- [ ] Orientation-mode section (replaces ideation): ask where to enter the territory, name the course via `update_course_info`, create the first topic only once the learner engages, then proceed as a normal teaching turn.
- [ ] Feynman section updated for optionality (D11): the card is an offer; a skip is signal, not failure; re-issue when natural.
- [ ] "Mark exactly one current topic when the learner advances" replaced with the daemon-commits model (D8): the agent *reads* current from state and never fights it.
- [ ] `instructions/pedagogy.md` reviewed for planned-course assumptions (linear progression language) and updated.

### Phase H — UI: map, journal rail, status bar

#### US-H1: Sidebar becomes the map
**Description:** As a learner, I want the sidebar to show where I've been, where I am, and where I could go so that it reads as a map of my exploration (D1).

**Acceptance Criteria:**
- [ ] Three visual states in `TopicTree`: **current** (highlighted, existing `isActive`), **visited** (normal weight), **frontier** (dimmed/outlined — visibly "unexplored").
- [ ] Frontier nodes show an affordance indicating clicking will engage the mentor (visited nodes don't).
- [ ] Visited-node clicks are never disabled by a running turn (per US-E1).
- [ ] Empty state copy updated ("No topics yet" → orientation-appropriate, e.g. "Your map is empty — tell your mentor where to start.").
- [ ] Verify in browser using dev-browser skill.

#### US-H2: Lesson rail renders the journal
**Description:** As a learner, I want the Lesson tab to show the selected topic's journal so that I can review the study notes from my walk through it.

**Acceptance Criteria:**
- [ ] Lesson rail shows the **current/selected topic's** journal entries in chronological order: notes as markdown blocks, demo pins as link lines (title, opens the demo), summaries visually distinguished (e.g. header or accent).
- [ ] Empty journal state: "No notes yet — the mentor writes study notes here as you explore this topic."
- [ ] Selecting a visited topic in the sidebar switches the rail instantly (local data, no agent turn).
- [ ] Verify in browser using dev-browser skill.

#### US-H3: Status bar with running agents
**Description:** As a user, I want a persistent status bar at the bottom of the app showing running agents by course name so that I always know what's active (D3).

**Acceptance Criteria:**
- [ ] Persistent bar at the bottom of the app window (all views: Library, Course, Settings).
- [ ] Shows one chip per **live session**, labeled with the course name; a working indicator (spinner/pulse) when that course's turn is running, quiet otherwise (idle-but-warm).
- [ ] Clicking a chip navigates to that course.
- [ ] Bar hides (or collapses to zero height) when no sessions are live.
- [ ] Driven by the `sessions` SSE feed (US-A3) with `GET /api/sessions` for initial state.
- [ ] Verify in browser using dev-browser skill.

## 5. Functional Requirements

### Session pool & lifecycle
- **FR-1:** The daemon must support an unbounded number of concurrent live course sessions, each with its own orchestrator, harness subprocess, MCP token, and permission policy.
- **FR-2:** The daemon must serialize turns per course and must not serialize turns across courses.
- **FR-3:** Each session must be ended automatically after `OVERLEARN_SESSION_IDLE_TTL_MS` (default 30 minutes) of inactivity, never while a turn is running.
- **FR-4:** A course whose session ended (TTL, crash, wrap-up, harness swap) must transparently cold-resume on its next turn using the existing resume-context machinery.
- **FR-5:** Wrap-up turns must end only that course's session; the daemon process must keep serving.
- **FR-6:** Session state (course, harness, turn-running/idle, timestamps) must be exposed via `GET /api/sessions` and a `sessions` SSE event on every state change.

### Course lifecycle
- **FR-7:** `POST /api/courses { seed }` must create an `active` course with placeholder title and immediately run an orientation turn. There must be no draft state, no plan review, and no accept gate anywhere in the system.
- **FR-8:** Course status values are exactly `active` and `archived`.

### Topics & map
- **FR-9:** Topics must only come into existence through agent tool calls (`upsert_topic`, `propose_topics`) during live turns — never through a bulk plan.
- **FR-10:** Topic node state must be derived: frontier (`entered_at IS NULL`), visited (`entered_at` set), current (`is_current`), with the one-current-per-course invariant enforced by the store.
- **FR-11:** Entering a frontier topic (card or sidebar) must: commit `entered_at` + `is_current` transactionally in the daemon, broadcast the map update, write a `topic-change` transcript line, then start an agent turn carrying `{ path, revisit: false, previous }`.
- **FR-12:** Selecting a visited topic must commit `is_current`, broadcast, and **not** start a turn. The change must be included as context (`revisit: true`, previous topic) in the next turn payload, whenever that happens.
- **FR-13:** `propose_topics` must create at most 3 frontier stubs per call and render one ephemeral card group in the chat.

### Journals & demos
- **FR-14:** Each topic has exactly one journal: an append-only, chronologically ordered sequence of entries of kind `note`, `demo`, or `summary`, each stamped with the producing turn.
- **FR-15:** `append_lesson_note` must default to the current topic and support an explicit `topicPath` override.
- **FR-16:** `emit_demo` with a resolvable topic must atomically produce both the chat attachment and the journal `demo` pin entry.
- **FR-17:** The Lesson rail must render the selected topic's journal (notes inline, demo pins as link lines, summaries distinguished).

### Transcript & continuity
- **FR-18:** Every transcript entry must record the current topic at write time.
- **FR-19:** The persisted transcript must be a complete, self-sufficient education history: all messages, all topic-change metadata lines, all card outcomes that were acted on.
- **FR-20:** Turn prompts must include the current-topic position block; orientation mode replaces ideation mode for turn 1 of a new course.
- **FR-21:** On revisit turns, protocol instructions must direct the agent to consult the topic's journal (and mastery history) before responding.

### Optional cards
- **FR-22:** Feynman checks and topic proposals must never block the composer; the learner can always type instead.
- **FR-23:** Any learner action other than engaging a card marks it skipped; skipped cards must not be rendered in chat history (stored with a skipped marker, hidden by the renderer).
- **FR-24:** A skip must be communicated to the agent in the next turn payload so it can re-offer later at its judgment.

### Status bar
- **FR-25:** A bottom status bar must show live sessions by course name with a turn-running indicator, navigate on click, and disappear when no sessions are live.

## 6. Non-Goals (Out of Scope)

- **No hidden atlas / background planning.** The agent must not pre-generate an unshown course plan (decision D1). If a zoomed-out overview is ever wanted, it is synthesized on demand from the visited map — not stored.
- **No topic graph edges / re-parenting UI.** Topics stay a tree with stable slash paths for now. Cross-links, merging, and restructuring of visited nodes is future work.
- **No progress denominator.** Emergent maps have no "% complete". Progress surfaces stay mastery-based (Review weak spots is unaffected — it operates on mastery events and needs no plan).
- **No per-topic conversations.** One transcript per course, period (D9). No forking or branching chat threads.
- **No data migration.** Old databases are wiped on schema bump (D13).
- **No multi-window / multi-device session coordination.** One daemon, one app instance assumption is unchanged.
- **No changes to grading (`grading.md`) or the mastery model** beyond re-pointing glossary/journal references.

## 7. Design Considerations

- **Cards as a pattern:** `feynman_check` already implements the structured-card → typed-turn-event round trip. `propose_topics` should reuse that rendering/plumbing pattern rather than invent a parallel one. The standing interaction contract for every card is **"do A or ask B"** — acting on the card and typing a message are both always valid.
- **Topic-change divider lines** should be quiet (small, muted, centered) — metadata, not speech. Include revisit phrasing ("Back to X") vs first entry ("Entered X").
- **Frontier styling** carries the fog-of-war metaphor: dimmed/dashed = unexplored. Don't overload color; state should read in both themes.
- **Status bar** is a system surface, not a notification center: course name + working indicator only. No token counts, no logs.
- **Existing components:** `TopicTree` (`ui/src/components/topic-tree.tsx`), transcript renderer (`ui/src/components/transcript.tsx`), and the sidebar shell are extension points — no new screens are added in this PRD, and one (Wizard) is deleted.

## 8. Technical Considerations

- **Pre-authorized daemon writes (D8):** the daemon committing `entered_at`/`is_current` on card/frontier click is the one deliberate exception to "the agent owns durable writes." It is safe because the written data was agent-authored at proposal time. If the kickstart turn fails, the map still says the learner is there — acceptable; the turn-retry machinery covers it and `get_course_state` always shows committed truth.
- **MCP scoping under concurrency:** teaching-session tokens already scope tool calls per course; US-A1 must add a regression test proving isolation with two simultaneous live sessions (this was previously untestable by construction).
- **Turn-number stamping for journal entries:** the teaching MCP server needs access to the active turn number for the session (already tracked in `activeTurnByCourse`) to stamp `topic_journal_entries.turn` and transcript `topic_id` consistently.
- **`get_course_state` payload growth:** journals make state bigger. Bound journal content in the state payload (e.g. last N entries per topic + counts, full journal for the current topic) and document the bound in the tool description.
- **TTL scheduling:** a single interval sweep (e.g. every 60s) over the pool is sufficient; per-session timers are unnecessary complexity.
- **Wipe-on-bump:** implement as schema-version check at store open. Keep the bundle export working *before* the bump lands in a release so current test courses can be manually exported if wanted (no converter promised).
- **Ordering within the plan:** Phase A and Phase B are independent and can land in either order or in parallel worktrees. C–G depend on B. H3 depends on A3. E and F depend on D.

## 9. Success Metrics

- Zero occurrences of cross-course 409s; switching courses mid-turn-elsewhere always works.
- Time from seed submission to first mentor response: one turn (no wizard round-trips).
- Selecting a visited topic renders its journal in < 100 ms with no agent turn started.
- A TTL-expired course's next turn completes without user-visible errors (cold resume works).
- The transcript of a multi-topic session, read top to bottom, narrates the full path including every topic change (manual review criterion).
- Journal of any visited topic is non-empty after a teaching session touched it (mentor instructions are being followed).

## 10. Open Questions

- **OQ-1:** Default TTL value — 30 minutes is assumed; confirm or tune once real usage exists. Should TTL eventually be a Settings field? (Deferred; env var only for now.)
- **OQ-2:** Should the status bar also show the *harness* per session (Claude Code vs Codex icon), or is course name + working state enough for v1?
- **OQ-3:** When a frontier topic's kickstart turn crashes *and* retry fails, should the daemon offer to un-enter (`entered_at → NULL`) or leave the node visited-but-empty? Current answer: leave it; the mentor recovers on the next turn. Revisit if it feels bad in practice.
- **OQ-4:** `propose_topics` path semantics: proposals for children of the current topic vs siblings vs arbitrary paths — leave to agent judgment, or constrain? Current answer: agent judgment, stable slash paths required.
- **OQ-5:** Does `review-weak` deserve a card treatment consistent with the new pattern (offer + follow-up) instead of a sidebar button? Out of scope here; note for later.
