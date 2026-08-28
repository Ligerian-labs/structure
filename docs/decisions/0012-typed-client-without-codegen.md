# ADR-0012: Typed API client without codegen

- Status: accepted
- Date: 2026-08-28

## Context

Consumers of a `@structure-ai/http` API (first and foremost a frontend app in the same workspace) need typed calls and typed errors, and they want client/api drift caught at compile time. Two industry-standard routes exist: generate client code from the served `openapi.json`, or derive a client from the TypeScript `HttpApi` type at compile time (`@effect/platform` `HttpApiClient`). Codegen adds a generation step, drift risk between generated files and the api, and a CI gate to keep them honest; type derivation has neither, but requires the consumer to import the `Api` type (and, for response decoding, its runtime value) from the defining app — acceptable inside one workspace, unacceptable for unknown external consumers.

A second force: the CQRS bridge flattened every dispatch failure into generic problem responses, so no client — generated or derived — could know a command's business failure types. `MessageDefinition.failure` existed only for typing.

## Decision

We derive, we do not generate. A new leaf package `@structure-ai/client` wraps `HttpApiClient` with the platform's transport opinions: correlation ids on every request (reusing ambient `Correlation`), per-request bearer tokens, a per-attempt deadline, and bounded jittered exponential retries for transient transport failures only (network errors, 5xx, dispatch timeouts, `classification: "transient"`); business failures and permanent problems are never retried.

To make errors known, the bridge now declares a definition's `failure` schema on its endpoint (annotated 422, `_tag`-discriminated) and lets declared failures reach the platform's schema encoder via an internal marker the `problems` middleware unwraps — so taxonomy-tag collisions (e.g. a declared `InvariantViolation`) no longer flatten to 500. The bridge also forwards `x-idempotency-key` into the dispatch envelope, completing the retry-safety story for retried commands.

External and non-TypeScript consumers are served by the existing `openapi.json` endpoint and bring their own generator; the framework owes them nothing more until a real consumer appears.

## Consequences

Easier: zero generation step, zero drift, zero committed artifacts; typed business failures on both wire and client; retry semantics follow the classification taxonomy with one owner (the client) per call.

Harder: the consumer must share the `Api` value at runtime, which pulls Effect schemas into its bundle (acceptable for an Effect-tolerant frontend; measured ~hundreds of KB gzipped); declared-failure passthrough depends on the standard middleware stack being installed (`serve`/`serveTest` do); the internal marker (`DeclaredBusinessFailure`) is a contract between the bridge and the middleware that a custom stack must honor.

Revisit trigger: a real external consumer needing stable artifacts without the type dependency — then generate from `openapi.json` for that consumer, still without changing the in-workspace story.
