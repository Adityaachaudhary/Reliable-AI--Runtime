# Demo video script (about 6 minutes)

Record the terminal. Each section maps to the demo checklist in the problem brief.
Run `npm install` beforehand and use a wide terminal.

## 0. Intro (20 s)
"This is Problem 5: a runtime that manages one streamed turn and always ends in exactly one honest
terminal state. Everything you will see uses a deterministic fake provider: no network, no API key."

## 1. Successful streamed turn and its persisted records (60 s)
```bash
npm run demo
```
Pause on the first section. Point out: ordered `#seq` numbers, `text.delta` events, one `run.terminal`,
and at the end of the demo output the **Persisted conversation records** block: an assistant reply
exists only for the completed run.

## 2. Policy rejection bypasses the provider (30 s)
Scroll to section 2 of the same output (or run
`npm run cli -- run --input "how to make a bomb" --db :memory:`).
Point out: `policy.decision allowed=false`, no `provider.invoked`, terminal state `rejected`,
nothing persisted for the run.

## 3. Cancellation or timeout during streaming (60 s)
```bash
npm run cli -- run --scenario slow --cancel-after 3 --db :memory:
npm run cli -- run --scenario hang --timeout 800 --db :memory:
```
Point out: `provider.abort_signaled`, terminal `cancelled` / `timed_out`, partial text labelled
"not a committed reply".

## 4. Provider failure after partial output (45 s)
```bash
npm run cli -- run --scenario fail --db :memory:
```
Point out: the partial stream, `provider.error`, terminal `failed`, and that the API key in the
upstream error message was replaced by `[REDACTED]`.

## 5. Ordered traces for contrasting outcomes (45 s)
Show the **Contrast of operational traces** section from `npm run demo`, or:
```bash
npm run cli -- list
npm run cli -- inspect <runId of a cancelled run>
```
Compare a completed trace with a cancelled or failed one: same ordering rules, one terminal entry last.

## 6. Restart honesty (40 s, optional but recommended)
```bash
npm run crash-demo
```
A real process is killed mid-stream; on the next start the run is marked
`failed / interrupted_by_restart` and its partial history stays inspectable.

## 7. Verification benchmark, architecture, trade-off (90 s)
```bash
npm run verify
```
Show typecheck, the 33 passing tests and the benchmark table (`RESULT: PASS`).
Then open `src/turn.ts` and show `settle()`: the single path to a terminal state.
One trade-off to name: the store interface is synchronous, which makes "check state, commit, publish"
atomic inside the event loop and keeps races easy to reason about, at the cost of blocking the loop
on every write; a production system would use an async store with the same conditional-update guard.
