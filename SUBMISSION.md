# SUBMISSION: Problem 5, Reliable AI Conversation Runtime

> Items marked **TODO(Adii)** need your own input before you submit. They are things only you can
> truthfully write (your demo link, your fork, your real experience). Delete this note when done.

## 1. Selected problem

**Problem 5: Reliable AI Conversation Runtime**: a bounded runtime for one streamed conversational
turn, from request to a single terminal state (`completed`, `rejected`, `cancelled`, `timed_out`, `failed`).

- Repository / fork: **TODO(Adii)**
- Demo video: **TODO(Adii)** (script in [`DEMO.md`](DEMO.md))

## 2. Setup and run

Requirements: Node.js 22.13+ (built-in `node:sqlite`, so no native module to compile). Developed and tested on Node 22.22 / Linux; not yet run on Windows or macOS.

```bash
npm install
npm run verify      # typecheck + 33 tests + verification benchmark (about 5 s)
npm run demo        # all five outcomes, visible streaming, contrasting traces
npm run crash-demo  # SIGKILL a process mid-stream, restart, show recovery
```

Individual commands and hand-run scenarios are listed in [`README.md`](README.md).
No API key, network access or paid service is used anywhere. Nothing secret is committed.

## 3. What is built, mapped to the acceptance scenarios

| Scenario | Behaviour | Evidence |
| --- | --- | --- |
| AC1 successful streamed turn | ordered chunks, completes once, records persisted | `runtime.test.ts` "AC1" (2 tests); benchmark `completed` |
| AC2 pre-response rejection | provider never called, rejection visible, no assistant reply | "AC2" (3 tests, incl. policy that throws = fail closed, cancel during policy check) |
| AC3 cancellation | provider consumption stops, run cancelled, never completes later | "AC3" (2 tests: provider honouring and provider **ignoring** the abort signal) |
| AC4 timeout | deadline stops the run, partial output not a success | "AC4" (3 tests, controlled clock, no sleeps) |
| AC5 provider failure | failure and partial history traceable, no success recorded | "AC5" (2 tests, incl. malformed provider event) |
| AC6 terminal-state race | exactly one terminal state wins, losers recorded | `stateMachine.test.ts` (all 24 orderings of 4 competing terminals) + "AC6" (5 tests) |
| AC7 safe trace | ordered, gapless, no secrets, no hidden reasoning | `trace.test.ts` (5 + 2 redaction unit tests) |
| Restart | non-terminal runs become `failed/interrupted_by_restart` | "restart semantics" (real file DB, two store instances) |
| Terminal commit failure | success is never claimed if not committed | "persistence failures at the terminal commit" (2 tests) |

Required tests from the brief: successful streaming and persistence, policy rejection proving the
provider was not invoked, cancellation during streaming, timeout via controlled time, provider failure
after partial output, competing terminal transitions, trace redaction of a representative secret. All present.

## 4. Verification benchmark

```bash
npm run benchmark
```

Runs **10 iterations of each of 5 scenarios** (completed, rejected, cancelled, timed out, failed),
twice, against in-memory SQLite with a fake provider and a manual clock. Invariants are checked on
**persisted** state (the store is the source of truth), per run:

- exactly one `run.terminal` entry, and it agrees with the run row;
- nothing recorded after the terminal event; sequence numbers gapless;
- what the client streamed equals what was persisted, and the stream ends on the terminal event;
- rejected runs never invoke the provider (checked both on the provider and in the trace);
- cancelled / timed-out / failed runs have **no** assistant message; completed runs have exactly one, equal to the streamed text;
- hidden reasoning and a representative secret never appear in any table.

Observed output (Node 22.22, Linux):

```
scenario      runs  expected terminal   invariant violations
completed     10    completed           0
rejected      10    rejected            0
cancelled     10    cancelled           0
timed_out     10    timed_out           0
failed        10    failed              0

terminal-state counts: completed=10  rejected=10  cancelled=10  timed_out=10  failed=10
repeatable (2 passes, digests 3b6884e308fd595b / 3b6884e308fd595b): yes
RESULT: PASS
```

I also checked that the benchmark can fail: I temporarily broke `turn.ts` so a timed-out run tried to commit an
assistant message, and the benchmark reported violations; I then reverted the change.

## 5. Architecture and documented decisions

**Components and interfaces**

| Component | Responsibility | Interface |
| --- | --- | --- |
| Policy | deterministic allow/reject decision before any model call | `evaluate(input) => PolicyDecision` |
| Provider | produce chunks; knows nothing about runs or storage | `stream({runId, input, history, signal}) => AsyncIterable<ProviderChunk>` |
| Orchestration (`TurnExecution`) | ordering, state machine, cancel, timeout, commit rules | `start() => TurnHandle`, `cancel()` |
| Persistence (`RuntimeStore`) | durable runs, messages, trace, output; atomic terminal commit | synchronous interface, SQLite implementation (Node's built-in `node:sqlite`) |
| Presentation | CLI renders `AsyncIterable<RuntimeEvent>` | no runtime logic |

**Persistence boundary** (what is written, and when)

1. Run row at acceptance, holding only the input **length** (never the text).
2. The user message is committed **atomically with** the move `checking_policy -> streaming`, i.e. only once the policy allowed it. A rejected input never becomes conversation content and is never stored.
3. Each streamed chunk is appended to `run_output` immediately (diagnostic history of what the client saw). It is not a conversation record.
4. The terminal commit is **one transaction**: state update + assistant message (**only** for `completed`) + terminal trace entry.
5. Cancelled, timed-out and failed runs keep their partial output in `run_output` and their user message, but never get an assistant message.

The schema enforces this as defence in depth: a trigger makes terminal states final, and another allows an assistant message only for a `completed` run.

**Allowed transitions and how one terminal outcome wins.** A single transition table in `stateMachine.ts`; terminal states have no outgoing edges. `settle()` in `turn.ts` is the only path to a terminal state. It asks the state machine (synchronous), signals the provider, commits, then publishes and closes the stream, with no `await` in between, so two competing attempts cannot interleave. Losing attempts are rejected and recorded in `ignored_signals` (visible on the run record). They are deliberately **not** put in the trace, so the trace's last entry is always the terminal event.

**How cancellation reaches the provider.** One `AbortController` per run; its signal is passed in the provider request and aborted on any non-success terminal state. Because a provider might ignore the signal, the loop also races every `next()` against a "terminated" promise, so consumption stops immediately and the iterator is closed fire-and-forget. Tested with a provider that ignores the signal.

**Timeouts.** The deadline covers policy check plus streaming (`timeoutMs`, default 30 s, per-turn override). It uses an injected `Clock`; tests and the benchmark use `ManualClock`, which only moves when `advance()` is called (timers due at the same instant fire in creation order, so a deadline that coincides with provider completion resolves deterministically). The timer is cleared on every terminal path.

**What belongs in the trace.** Ordered, flat, primitive-valued entries: `run.accepted`, `state.changed`, `policy.decision` (code only), `provider.invoked`, `provider.chunk` (index and size only), `provider.reasoning_suppressed` (size only), `provider.error`, `provider.abort_signaled`, `run.terminal` (state, reason code, chunk count, whether a reply was committed). Text output lives in a separate table and stream event (`text.delta`), sharing the same `seq`, so the merged timeline is totally ordered.

**Excluding secrets and hidden reasoning.**
- `reasoning` chunks are parsed and dropped; only their length is traced. Verified by a test that greps every table.
- Trace payloads are flat primitives; sensitive **key names** (`apiKey`, `authorization`, ...) are redacted regardless of value, and credential-shaped **values** are redacted inside strings.
- Errors go through a whitelist (`name` + `message` only), so headers/configs/causes attached to provider errors (a common place for API keys) are never read.
- The policy rejects inputs that look like credentials, and rejected input is never persisted.
- Limitation: the value patterns are illustrative heuristics, not a complete secret scanner.

**Restart semantics (honest version).** An in-flight generator does **not** resume. On startup, `recoverInterruptedRuns()` marks every non-terminal run `failed` with reason `interrupted_by_restart` and appends a terminal trace entry. Partial output and the user message stay inspectable, and no assistant message is ever invented.

**Running behind a web or mobile client.** The core has no I/O of its own. `startTurn()` returns `{events, result, cancel}`. A web server maps `events` to SSE/WebSocket frames (`seq` doubles as a resume cursor; Problem 1 builds that on top of the same persisted, gapless log), keeps a `runId -> handle` map for a cancel endpoint, and reads history through `getRun/getTrace/getMessages`. For a mobile client the same server sits between them. Not built here.

## 6. Failure handling summary

- Policy throws: fail closed (`failed/policy_error`), provider never invoked.
- Provider throws, or emits a malformed event: `failed`, partial output kept, reason code distinguishes them.
- Timeout / cancel / failure: provider aborted, stream closed, stored state final.
- Completion commit fails: converted to `failed/persistence_error`; success is never claimed unless committed.
- Non-success commit fails (double fault): reported via `onInternalError`; the caller still sees the true outcome, the stored row may stay non-terminal until `recoverInterruptedRuns()` repairs it (tested).
- Every retry/termination path is bounded: no automatic retries exist; every run ends by timeout at the latest.

## 7. Trade-offs and what I intentionally did not build

- **Built-in `node:sqlite` instead of an npm SQLite package.** Zero install risk (no native build), at the price of requiring Node 22.13+. The `RuntimeStore` interface keeps the choice swappable.
- **Synchronous store interface.** It makes check-state, commit, publish atomic in the event loop and keeps races easy to reason about. It blocks the loop on writes (fine for SQLite locally); a production system would use an async store with the same conditional-update guard (`UPDATE ... WHERE state IN (active)`) and the DB triggers already in place.
- **Two `seq` numbers per chunk** (one trace entry, one text event) instead of a single event type. Slightly noisier, but the trace can never contain model text by construction.
- **No live provider.** The `ModelProvider` interface is the extension point (a Groq/OpenAI-compatible provider would be one class). I did not build it: untestable without a network, and the brief marks it optional.
- **Unbounded in-memory event queue**, no backpressure: acceptable for one local consumer.
- **Single process, single active turn per conversation.** Concurrent turns in one conversation are not coordinated (history is read when the policy accepts). Out of scope.
- **Rule-based policy** (length, credential shapes, a small blocklist) is a stand-in for a real classifier; only the gate's position and fail-closed behaviour are the point.
- Not covered: authentication, billing, cloud deployment, real observability stack, tool use, agents (all out of scope).
- Optional stretch (malformed provider events): implemented in a minimal form (`failed/malformed_provider_event`).

## 8. Production concerns

Async store and per-conversation turn serialization; backpressure or bounded queues for slow consumers;
retention policy for `run_output`/`run_trace` (they hold user-visible text); a real secret scanner and
structured log shipping instead of pattern heuristics; provider adapters with vendor error mapping and
retry only where safe (never after output was streamed); metrics on terminal-state ratios.

## 9. Follow-up: keep partial output after cancellation without calling the turn successful

Design (not implemented):

- `messages` gets a `status` column (`complete` | `partial`). The trigger becomes: `complete` assistant messages require a `completed` run; `partial` ones are allowed only for `cancelled` (product decision whether `timed_out`/`failed` may also keep partials).
- In `turn.ts` `settle()`, for `cancelled` build `partialMessage` from `this.parts` (the runtime already has it) and pass it to `finishRun` in the same transaction. The one-assistant-message-per-run unique index still holds.
- The run stays `cancelled`; `assistantMessageCommitted` keeps meaning "complete reply". Add `partialMessageRetained` to the terminal entry and summary.
- History building decides whether future turns see partial messages (probably yes, marked as interrupted); the UI shows a "stopped" badge.
- Tests: cancel mid-stream produces state `cancelled`, exactly one assistant row with `status = partial` equal to the streamed text, and no path makes the run `completed`. The benchmark invariant changes from "no assistant message" to "no *complete* assistant message" for cancelled runs.
- Files touched: `turn.ts`, `store/store.ts`, `store/sqliteStore.ts`, `test/runtime.test.ts`, `benchmark/runBenchmark.ts`.

## 10. AI usage disclosure

This submission was produced with **Claude (Anthropic)** in a chat session: the architecture, source code, tests, benchmark
and documentation were generated by the assistant from the problem brief, the review scorecard and a plan I agreed to
(TypeScript, Vitest, SQLite, CLI). The assistant ran the typecheck, tests, benchmark and demos in a sandbox; the outputs
quoted above are from those runs. No live model or API key is used at runtime.

**TODO(Adii): state truthfully what you personally did**: what you read and verified, what you changed, what you would
change, and that you can explain `turn.ts` and `settle()` unaided (the follow-up discussion will test this).

## 11. Credibility note

**TODO(Adii): write this yourself; it cannot be generated.** The scorecard asks which parts of a previously shipped
system were yours. Cover, in specifics rather than adjectives:

- the system (what it did, who used it) and your exact role and decisions;
- at least one concrete scale or operational constraint (users, requests, latency budget, failure rate, team size);
- one difficult trade-off or incident and how you reasoned about it, ideally something related to streaming, retries,
  cancellation or partial failure with LLM calls.

Confidential details do not need exact metrics; coherent, specific reasoning is what is being assessed.

## 12. Completeness self-check

| Item | Status |
| --- | --- |
| Fork accessible | TODO(Adii): push and check access |
| Problem clearly identified | yes |
| Setup and run instructions | yes (README, section 2) |
| `SUBMISSION.md` complete | after your TODOs |
| Demo video accessible and covers required scenarios | TODO(Adii): record with `DEMO.md`, check link permissions |
| Source code included | yes |
| Focused automated tests runnable | yes: `npm test` (33 tests) |
| Core acceptance scenario demonstrable | yes: `npm run demo` |
| Failure/recovery scenario demonstrable | yes: `npm run demo`, `npm run crash-demo` |
| Benchmark with command and results | yes: `npm run benchmark` |
| AI usage disclosed | yes, plus your TODO |
| Credibility note | TODO(Adii) |
| No secrets committed | yes (the only key-shaped strings are fake test/demo values) |
