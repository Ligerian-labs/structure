# Event-store CPU profile excerpt

Bun 1.4.1, 20,000 events, 100 streams. Generated separately from the timing samples with `bun run profile:cpu packages/eventsourcing/bench/eventstore.ts 20000 100`. Paths are relative to the checkout. Raw profiles remain in `.performance/`.

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 617.2ms | 420 | 1.0ms | 164 |

**Top 10:** `(anonymous)` 56.2%, `(module)` 12.5%, `Map` 4.8%, `runLoop` 3.9%, `(anonymous)` 1.4%, `effect_internal_function` 1.0%, `EffectPrimitive` 0.9%, `(module)` 0.7%, `(anonymous)` 0.6%, `OnSuccessAndFailure` 0.6%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 56.2% | 347.0ms | 56.2% | 347.0ms | `(anonymous)` | `packages/eventsourcing/src/memory.ts:123` |
| 12.5% | 77.4ms | 12.5% | 77.4ms | `(module)` | `node_modules/.bun/effect@3.22.1/node_modules/effect/dist/esm/internal/core.js:102` |
| 4.8% | 29.7ms | 4.8% | 29.7ms | `Map` | `[native code]` |
| 3.9% | 24.6ms | 82.1% | 506.8ms | `runLoop` | `node_modules/.bun/effect@3.22.1/node_modules/effect/dist/esm/internal/fiberRuntime.js:1142` |
| 1.4% | 8.9ms | 1.4% | 8.9ms | `(anonymous)` | `packages/eventsourcing/src/memory.ts:117` |
