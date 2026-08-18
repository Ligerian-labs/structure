import { Effect, FiberRef } from "effect";
import { globalValue } from "effect/GlobalValue";

/**
 * Correlation identifiers propagated across asynchronous boundaries on the
 * fiber, and stamped onto every log record and span in scope.
 */
export interface CorrelationContext {
  /** Groups every step of one workflow, across processes. */
  readonly correlationId?: string;
  /** Identifies the message/command that directly caused this work. */
  readonly causationId?: string;
  /** The inbound request being served, if any. */
  readonly requestId?: string;
  /** Authenticated principal on whose behalf work happens. */
  readonly actor?: string;
}

const ref = globalValue("@structure/observability/Correlation", () =>
  FiberRef.unsafeMake<CorrelationContext>({}),
);

export const current: Effect.Effect<CorrelationContext> = FiberRef.get(ref);

export const newId = (): string => crypto.randomUUID();

const definedEntries = (ctx: CorrelationContext): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
};

/**
 * Runs an effect with the given identifiers merged into the current
 * correlation context. Logs and spans inside the scope carry them
 * automatically.
 */
export const within =
  (ctx: CorrelationContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(current, (parent) => {
      const merged = { ...parent, ...definedEntries(ctx) };
      const annotations = definedEntries(merged);
      return effect.pipe(
        Effect.locally(ref, merged),
        Effect.annotateLogs(annotations),
        Effect.annotateSpans(annotations),
      );
    });

/**
 * Starts a fresh workflow scope: generates a correlationId if none is active
 * yet, keeping an existing one when present.
 */
export const scoped =
  (ctx: Omit<CorrelationContext, "correlationId"> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(current, (parent) =>
      within({ correlationId: parent.correlationId ?? newId(), ...ctx })(effect),
    );
