import { Effect, Metric } from "effect";

/**
 * Standard signals for a runtime boundary (ingress handler, outbound
 * dependency, background job): traffic, errors, latency. Names are the
 * boundary label — keep them bounded, never per-request values.
 */
export interface BoundaryMetrics {
  readonly calls: Metric.Metric.Counter<number>;
  readonly errors: Metric.Metric.Counter<number>;
  readonly duration: ReturnType<typeof Metric.timerWithBoundaries>;
}

const DEFAULT_BOUNDARIES: ReadonlyArray<number> = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

export const boundary = (name: string): BoundaryMetrics => ({
  calls: Metric.counter(`${name}_calls_total`, { incremental: true }),
  errors: Metric.counter(`${name}_errors_total`, { incremental: true }),
  duration: Metric.timerWithBoundaries(`${name}_duration_ms`, [...DEFAULT_BOUNDARIES]),
});

/**
 * Instruments an effect as a named boundary: a span, a call counter, an
 * error counter, and a latency histogram.
 */
export const track =
  (name: string, metrics: BoundaryMetrics = boundary(name)) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Metric.trackDuration(metrics.duration),
      Effect.tap(() => Metric.increment(metrics.calls)),
      Effect.tapError(() =>
        Effect.all([Metric.increment(metrics.calls), Metric.increment(metrics.errors)]),
      ),
      Effect.withSpan(name),
    );

/** Reads a counter's current value — mostly useful in tests. */
export const counterValue = (
  counter: Metric.Metric.Counter<number>,
): Effect.Effect<number | bigint> => Effect.map(Metric.value(counter), (state) => state.count);
