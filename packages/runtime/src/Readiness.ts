import { Context, Effect, Layer, Ref } from "effect";

/** A named probe evaluated on every `checkAll`. Failures and defects count as not-ok. */
export interface ReadinessCheck {
  readonly name: string;
  readonly run: Effect.Effect<boolean>;
}

/** Aggregate readiness state, suitable for rendering as an HTTP health response. */
export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Array<{ readonly name: string; readonly ok: boolean }>;
}

/**
 * Process readiness: a flag flipped by the application lifecycle plus a set of
 * registered checks. A process starts NOT ready and must call `setReady` once
 * startup completed; `checkAll` reports ready only while the flag is set and
 * every registered check passes. Check failures or defects are reported as
 * not-ok and never crash the probe.
 */
export class Readiness extends Context.Tag("@structure-ai/runtime/Readiness")<
  Readiness,
  {
    readonly isReady: Effect.Effect<boolean>;
    readonly setReady: Effect.Effect<void>;
    readonly setUnready: Effect.Effect<void>;
    readonly register: (check: ReadinessCheck) => Effect.Effect<void>;
    readonly checkAll: Effect.Effect<ReadinessReport>;
  }
>() {
  static readonly layer: Layer.Layer<Readiness> = Layer.effect(
    Readiness,
    Effect.gen(function* () {
      const ready = yield* Ref.make(false);
      const checks = yield* Ref.make<ReadonlyArray<ReadinessCheck>>([]);
      const checkAll: Effect.Effect<ReadinessReport> = Effect.gen(function* () {
        const flag = yield* Ref.get(ready);
        const registered = yield* Ref.get(checks);
        const results = yield* Effect.forEach(registered, (check) =>
          check.run.pipe(
            // A failing or defect-throwing check is a "not ready" answer, never a crash.
            Effect.catchAllCause(() => Effect.succeed(false)),
            Effect.map((ok) => ({ name: check.name, ok })),
          ),
        );
        return { ready: flag && results.every((result) => result.ok), checks: results };
      });
      return {
        isReady: Ref.get(ready),
        setReady: Ref.set(ready, true),
        setUnready: Ref.set(ready, false),
        register: (check) => Ref.update(checks, (list) => [...list, check]),
        checkAll,
      };
    }),
  );
}
