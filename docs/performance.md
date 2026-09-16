# Performance work in Structure

Start with a user-visible operation, a representative workload, and a profile. Record the suspected cost and the behavior that must stay correct in the issue before changing implementation. Keep each optimization small enough to review. The [initial audit](performance-audit-2026-09.md) records the current measurements and follow-ups.

## Profile the right process

Use the Bun version in `package.json#packageManager`, install with `bun install --frozen-lockfile`, and check `bun --version` and `bun x turbo --version`. Record any difference from CI's runtime. Do not change runtimes between baseline and candidate unless the runtime upgrade is the experiment.

From the repository root:

```sh
# Execute typechecks and tests without reading or writing Turbo task caches.
bun run profile:tasks

# Inspect task durations, waits and scheduling in the Markdown companion.
rg 'visit_recv_wait|build_http_client|parse_lockfile' .performance/tasks.json.md

# Profile a real package operation in Bun, emitting JSON and Markdown.
bun run profile:cpu packages/eventsourcing/bench/eventstore.ts 20000 100
```

`profile:tasks` writes `.performance/tasks.json`, its `.md` companion, and a run summary under `.turbo/runs/`. It exits unsuccessfully if a task fails. Use the summary's per-task start/end times to locate slow packages. Turbo trace spans include asynchronous waits and overlap, so their percentages can exceed 100%. A wait for a child process is not evidence that the scheduler itself consumes that CPU time.

`profile:cpu` accepts a Bun entrypoint and arguments. It writes timestamped `.cpuprofile` and `.md` files in `.performance/`. Inspect the Markdown hotspot rows and their source locations; open the JSON in a CPU profiler when the call tree needs closer inspection. For test-suite bottlenecks, start with the per-test timings in Bun output, then extract a representative operation into a standalone workload for CPU profiling. Verify that profile files were actually emitted; a successful test exit alone does not establish that profiling ran.

Profile a workload long enough to collect useful samples. Include loading, decoding, persistence and dispatch when those are part of the affected operation. A test-suite profile can reveal slow verification but does not establish production throughput. SQL and network workloads need their actual adapters and isolated services.

## Compare two revisions

Install [hyperfine](https://github.com/sharkdp/hyperfine#installation) for repeated wall-clock measurements. Keep two dedicated checkouts, with dependencies installed independently. For example, from a task workspace:

```sh
jj workspace add ../performance-main --name performance-main -r main
(cd ../performance-main && bun install --frozen-lockfile)

# Measures scheduling/hash preparation only; no package tasks execute.
bun run bench:compare ../performance-main . .performance/scheduling -- \
  ./node_modules/.bin/turbo run typecheck test --dry=json

# Measures uncached typecheck execution, including process startup.
bun run bench:compare ../performance-main . .performance/typecheck -- \
  ./node_modules/.bin/turbo run typecheck --cache=local:
```

The runner executes exactly the same argument list in each checkout, with two warmups and fifteen measured runs by default. Override with `WARMUP=3 RUNS=30` when needed. It requires a new report directory, refuses identical checkout paths, and stops on a failed command. It writes:

- `results.json` with individual samples and summary statistics;
- `results.md` with mean, standard deviation, minimum, maximum and relative timings;
- `environment.md` with revisions, working-copy changes, lockfile hashes, tool versions, machine details and the exact command.

For jj workspaces, metadata uses the workspace's `@` commit. `git rev-parse HEAD` can resolve the parent repository instead. Do not edit either checkout during a comparison. Record external service versions, dataset sizes and safe configuration separately; the runner does not dump environment variables. Pass no credentials or customer data in command arguments or workloads.

The checked-in event-store workload exercises single-event appends across several streams, reads the global feed and validates positions, versions, stream names, payloads and tail paging. It uses fixed metadata and fresh in-memory state per process:

```sh
bun run bench:eventsourcing 10000 100
bun run bench:compare ../performance-main . .performance/eventstore -- \
  bun packages/eventsourcing/bench/eventstore.ts 10000 100
```

Both checkouts must contain the **same workload file**. If the baseline predates it, copy only `packages/eventsourcing/bench/eventstore.ts` into the baseline at that path and record that setup change. Relative imports then resolve each checkout's implementation. Do not copy candidate source or dependencies into the baseline. Repeat at 1,000, 10,000 and 20,000 events, and vary stream count when it affects the proposed optimization. The JSON printed by the workload separates append and read time for diagnosis; hyperfine measures the full process, including startup and correctness checks.

## Control noise and cache state

Run baseline and candidate sequentially in the **same sandbox instance** or on the same quiet machine, with equal CPU and memory limits. Pause competing verification jobs and other heavy workloads. A container can still share its host's CPU; separate containers or CI jobs are not comparable hardware. A local run is useful for finding large effects. Reconfirm small effects on a quiet, controlled host before claiming them.

Use frozen lockfiles, identical inputs and the same services. Reset application data before every measured invocation, outside the timed operation when appropriate. The event-store workload resets its own in-memory state; a persistent workload must define its own reset procedure. Preinstall tools and dependencies so downloads are not timed.

State which cache is under test:

- The examples with `--cache=local:` disable both local and remote Turbo task caches. `--force` alone can still write caches.
- A dry run measures task graph/hash preparation, not task execution or Time to First Task.
- Warm cache tests need equally primed caches in both checkouts and a separate report from uncached task runs.
- Hyperfine warmups warm OS caches. An uncached Turbo task run is not a cold-disk measurement. Use an explicit, repeatable reset procedure for a cold-cache claim.

Keep CPU profiling separate from timing. Remove inherited profiling flags such as `BUN_OPTIONS` during benchmarks. Run in both orders when a small difference might be drift, retain every sample, and investigate outliers. A difference comparable to run-to-run variation is inconclusive. Avoid hard wall-clock thresholds on shared CI runners.

## Evidence required for an optimization

A performance PR links the before/after profiles and benchmark reports and states the workload, revision pair, environment, cache state, sample count and variability. It explains the end-to-end effect as well as any microbenchmark improvement. No overall-speed claim follows from a faster helper alone.

Keep a regression test for any bug found during optimization. Tests should protect observable behavior, including ordering, concurrency, failure and cancellation where relevant. Benchmarks do not replace correctness tests, and timing assertions do not belong in ordinary unit tests. Run the usual quality gates and the affected adapter suites.

Review the proposed change against the profile before implementation and review the evidence before merge. If a hypothesis fails, record it and choose the next measured target. Search for the same source pattern elsewhere after correcting it; include related changes only when the same tests and measurements support them, otherwise open a follow-up. Use merged code and executable tests as examples for subsequent agent work.

These practices adapt the [Vercel Turborepo performance investigation](https://vercel.com/blog/making-turborepo-ninety-six-percent-faster-with-agents-sandboxes-and-humans). Flag details are documented by [Bun](https://bun.com/docs/project/benchmarking), [Turborepo](https://turborepo.dev/docs/reference/run), and [hyperfine](https://github.com/sharkdp/hyperfine).
