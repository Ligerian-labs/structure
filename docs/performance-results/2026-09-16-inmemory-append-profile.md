# In-memory append CPU profile excerpts, before and after

Bun 1.4.1, 20,000 events, 100 streams, same host (AMD EPYC 7282, 4 logical CPUs, Linux 6.8.0). Generated separately from the timing samples with `bun run profile:cpu packages/eventsourcing/bench/eventstore.ts 20000 100` in each checkout. Paths are relative to each checkout. Raw profiles remain in each checkout's `.performance/`.

## Baseline (main at f661ce3)

| Duration | Samples | Interval | Functions |
|----------|---------|----------|-----------|
| 3.31s | 1693 | 1.0ms | 393 |

**Top 10:** `(anonymous)` 49.7%, `(anonymous)` 11.1%, `Map` 6.0%, `runLoop` 3.6%, `EffectPrimitive` 1.8%, `(anonymous)` 1.6%, `(anonymous)` 1.3%, `EffectPrimitiveSuccess` 1.0%, `(anonymous)` 0.9%, `anonymous` 0.8%

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 49.7% | 1.65s | 49.9% | 1.65s | `(anonymous)` | `packages/eventsourcing/src/memory.ts:123` |
| 11.1% | 370.8ms | 11.1% | 370.8ms | `(anonymous)` | `node_modules/.bun/effect@3.22.1/…/dist/esm/Utils.js` |
| 6.0% | 201.9ms | 6.0% | 201.9ms | `Map` | `[native code]` |
| 3.6% | 122.6ms | 83.3% | 2.76s | `runLoop` | `node_modules/.bun/effect@3.22.1/…/dist/esm/internal/fiberRuntime.js:1142` |
| 1.6% | 54.2ms | 1.6% | 54.2ms | `(anonymous)` | `packages/eventsourcing/src/memory.ts:87` |

Line 123 is the `[...state.all, ...stored]` global-array copy in `append`. The workload printed 2730.6 ms for appends and 23.7 ms for the global read.

## Candidate (in-place append inside the critical section)

| Duration | Samples | Interval | Functions |
|----------|---------|----------|-----------|
| 1.23s | 365 | 1.0ms | 347 |

**Top 10:** `hash` 24.6%, `runLoop` 11.7%, `effect_internal_function` 5.3%, `custom` 3.9%, `EffectPrimitiveSuccess` 3.9%, `(anonymous)` 3.5%, `(anonymous)` 2.9%, `(anonymous)` 2.6%, `pipe` 2.3%, `interruptible` 2.1%

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 24.6% | 304.1ms | 24.6% | 304.1ms | `hash` | `node_modules/.bun/effect@3.22.1/…/dist/esm/Hash.js` |
| 11.7% | 144.7ms | 62.8% | 776.6ms | `runLoop` | `node_modules/.bun/effect@3.22.1/…/dist/esm/internal/fiberRuntime.js:1142` |
| 2.9% | 36.7ms | 3.1% | 39.1ms | `(anonymous)` | `packages/eventsourcing/src/memory.ts:128` |
| 2.1% | 26.3ms | 2.1% | 26.3ms | `(anonymous)` | `packages/eventsourcing/src/memory.ts:95` |

The `memory.ts:123` hotspot disappears. The remaining store cost is the in-place `push` (line 128, 2.9%); the dominant cost moves into the Effect runtime's fiber bookkeeping. Profiled times are diagnostic and are not part of the timing comparison; see the timing record in `2026-09-16-inmemory-append.json`.

## Scope inspection: the same copy pattern elsewhere

Issue #89 asks for the pattern to be inspected in history import and `readAll` filtering before any scope extension.

**`readAll` / `read` (memory.ts:148, 159).** Both readers escape the store state through `Array.prototype.filter`, which returns a fresh array, so in-place appends never leak a live container to a consumer and subscription snapshot semantics are unchanged. The filter is O(n) per read, but it runs once per `readAll` call rather than once per append, and the change does not touch the read path at all — the baseline profile recorded a 23.7 ms global read for 20,000 events against 2730.6 ms of appends, so reads were never the hotspot. No optimization warranted.

**History import (`importBatch`, memory.ts:238-267).** Import deliberately keeps copy-on-write semantics: it builds a new `streams` map, new per-stream arrays and a fresh `all` array per committed batch (`all: [...state.all, ...batch.events]`). The cost is linear in store size **per batch**, not per event, and the batch count of an import is bounded by the exporter's batch size; the append-hotspot profile shows no import frames. Because imports replace the state wholesale (a new `all` array), later in-place appends write into the replacement with no aliasing of the pre-import array. Extending in-place mutation to imports would complicate the resume-token and target-not-empty checks for no measured benefit, so the scope stays append-only.
