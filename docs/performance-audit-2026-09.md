# Performance audit, September 2026

The main measured runtime target is repeated array copying in the in-memory event store. Turbo scheduling is a much smaller cost in this repository. The audit also found and fixed a Bun version mismatch that made local verification fail while CI used a working runtime.

This audit implements [issue #88](https://github.com/Ligerian-labs/structure/issues/88). The commands and review requirements are in [performance.md](performance.md).

## What is in place

| Practice | Repository evidence and action |
| --- | --- |
| Isolated task checkout and reviewable changes | Dedicated jj workspace based on `main`; existing contribution flow requires an issue, regression tests and a PR. |
| Reproducible runtime | Manifest now pins Bun 1.4.1, the runtime CI already used. Every CI and release setup step reads that manifest. |
| Readable profiling | `profile:tasks` writes Turbo trace/Markdown and a run summary; `profile:cpu` writes Bun JSON/Markdown profiles for a workload. |
| Repeated full-operation measurements | `bench:compare` runs both checkouts on the same host with warmups, samples and revision/toolchain metadata. |
| Correctness alongside performance | The event-store workload checks its output; CI runs a small instance without a wall-clock threshold. Existing unit, adapter and browser suites remain the correctness gates. |
| Evidence and human review | Contribution guide and PR template require the workload, hotspot, before/after measurements, variance and regression coverage. |
| Controlled environments | Guide specifies comparisons within one sandbox instance and explicit cache/data reset. This audit used a local host, not a dedicated benchmark sandbox. |
| Follow-up on repeated source patterns | Array copies in append/import and full-feed filtering are identified below, with a bounded follow-up issue. |

## Measured baseline

Runtime source is `main` at `cb86394d`. No library implementation changed during measurement. The added [workload](../packages/eventsourcing/bench/eventstore.ts) uses deterministic metadata, appends one event at a time, reads the global feed and checks correctness. Its hash and every raw timing sample are in [the measurement record](performance-results/2026-09-16.json).

Environment: Apple M2 Max, 12 logical CPUs, 96 GiB RAM, Darwin 25.6.0 arm64; Bun 1.4.1, Effect 3.22.1, Turbo 2.10.10 and hyperfine 1.20.0. Each timing has two warmups and fifteen measured runs. The event-store state is fresh per process; OS caches are warm. No other verification command ran alongside the timing commands, but background host activity was not controlled. These measurements identify local targets and do not establish production capacity or a small speedup.

| Workload | Mean ± standard deviation | Range |
| --- | --- | --- |
| Task graph/hash preparation, `turbo run typecheck test --dry=json` | 115.2 ± 17.7 ms | 100.5 to 166.2 ms |
| Event store, 1,000 events / 100 streams | 136.9 ± 13.2 ms | 125.3 to 176.5 ms |
| Event store, 10,000 events / 100 streams | 280.9 ± 7.7 ms | 270.3 to 293.9 ms |
| Event store, 20,000 events / 100 streams | 628.2 ± 13.8 ms | 605.2 to 650.0 ms |

Event-store timings include process startup, module loading, input creation, appends, global read and assertions. The small case contains substantial fixed overhead. Doubling events from 10,000 to 20,000 takes about 2.24 times as long in the complete workload.

A control comparison ran the identical workload against unchanged library source in separate baseline and candidate jj workspaces on Bun 1.4.1. It measured 284.5 ± 10.4 ms versus 285.2 ± 12.8 ms at 10,000 events. That difference is inconclusive and supports no speedup claim. Only the workload file was copied into the older baseline; its implementation and dependencies stayed independent.

## Bottlenecks and next work

**In-memory appends.** A separate 20,000-event [CPU profile excerpt](performance-results/2026-09-16-eventstore-profile.md) attributes 56.2% of sampled time, 347 ms, to `memory.ts:123`, the `[...state.all, ...stored]` copy. The per-stream copy at line 117 accounts for another 1.4%; native `Map` work accounts for 4.8%. The profiled workload printed 497 ms for appends and 7 ms for the global read. Profiled times are diagnostic and are not part of the timing comparison.

The source explains the scaling risk: every append copies all prior global events. Repeated single-event appends therefore copy a quadratic total number of entries. A change to storage representation must preserve lazy subscription snapshots, optimistic concurrency, global ordering and history-import atomicity. [Issue #89](https://github.com/Ligerian-labs/structure/issues/89) records this optimization target and its required verification; its before/after measurements live in [performance-results/2026-09-16-inmemory-append.json](performance-results/2026-09-16-inmemory-append.json).

**Verification cost.** One uncached, profiled run of all typechecks and tests completed 54 tasks successfully in 16.615 s on Bun 1.4.1. The longest task was `auth#test` at 8.402 s. Several compiler processes took roughly 3.5 to 5 s while sharing CPU. These are single diagnostic task durations, not repeated performance comparisons. Start any verification optimization with the auth test timings and TypeScript profiles. Preserve crypto, timing and concurrency assertions. Do not infer a production auth bottleneck from test-suite duration.

**Other source patterns.** `InMemoryEventStore.readAll` filters the whole global array before limiting the batch. History import copies the global array and stream map for each imported batch. These are source-based candidates, not separately measured bottlenecks. Use paginated projection and import workloads before proposing changes there. The in-memory append result does not describe SQLite, PostgreSQL or Nisshi performance.

**Runtime mismatch, fixed here.** The manifest originally pinned Bun 1.3.14 while CI/release used 1.4.1. The unchanged mailer suite produced 57 passes and five failures on 1.3.14, including a five-second timeout; running it alone reproduced those failures. On 1.4.1 it produced 62 passes and no failures. Aligning the manifest and workflow version source removes this local reproduction failure. Earlier exploratory timings on 1.3.14 were not mixed into the baseline table.

## Verification and limits

- Frozen install, lint, all 27 package typechecks and the full test command pass on Bun 1.4.1. The uncached task profile confirms 54 successful tasks with no cached results.
- All six browser E2E tests pass locally.
- The comparison runner was exercised with real hyperfine, including spaces and shell metacharacters in paths/arguments. Failed workloads, reused report directories and identical checkout paths return failure. Bash syntax and ShellCheck pass.
- CPU JSON/Markdown files and Turbo JSON/Markdown/summary output were generated and inspected. Full artifacts stay in ignored `.performance/`; compact raw samples and the CPU excerpt are checked in above.
- PostgreSQL and real-broker tests require services and skip locally when their environment variables are absent. The existing CI service jobs cover these integrations. This report's measurements do not cover them.
- No wall-clock regression threshold or dedicated sandbox deployment was added. Small improvements need confirmation on a controlled host with both revisions in the same instance.
