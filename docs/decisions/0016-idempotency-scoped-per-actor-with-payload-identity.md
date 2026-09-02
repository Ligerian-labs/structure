# ADR-0016: Idempotency keys scoped per actor, bound to payload identity

- Status: accepted
- Date: 2026-09-02

## Context

The `IdempotencyStore` port of `@structure-ai/cqrs` was `begin(key, tag) → Option<result>` / `complete(key, tag, result)`. The bus consulted it before entering the dispatch's correlation scope, so the store never saw the actor or the payload. The HTTP bridge forwards `x-idempotency-key` verbatim. Three consequences: two principals sending the same key for the same command collided, the second receiving the first's cached result (a cross-tenant leak); the same key with a different payload silently replayed the first result; and there was no in-flight state, so concurrent dispatches of one key both ran the handler. Applications worked around it by hashing `actor + key` in middleware and owning a durable table themselves — exactly the duplication a framework port exists to prevent.

## Decision

The store receives an `IdempotencyContext` `{ key, tag, actor?, payloadHash }` and answers `begin` with `Completed(result) | Claimed | InFlight | Mismatch`; `complete(context, result)` records a success, `release(context)` frees a failed claim. The bus derives `payloadHash` (sha-256 of the wire-encoded validated payload with sorted keys), passes the actor from `DispatchOptions` or the ambient correlation, fails `Mismatch` as `IdempotencyMismatch` (`conflict`) and `InFlight` as `IdempotencyInFlight` (`transient`), both 409 at the HTTP edge, and releases the claim when the handler fails, times out or is interrupted. Results are stored in their *encoded* form and decoded on replay, so durable stores hold JSON only. The anonymous actor is its own scope, not a wildcard. `@structure-ai/eventsourcing-pg` ships the durable implementation (conditional upsert on `(tag, actor, key)`, TTL, purge helper) since it already owns the PostgreSQL client and respects the dependency direction cqrs ← eventsourcing ← SQL adapters.

## Consequences

- Replay is per principal: the same key from two actors runs twice by design. Callers that want cross-actor deduplication must express it in the domain (an aggregate invariant), not through the key.
- Store implementations must make `begin` atomic (one `Claimed` among concurrent callers) — the contract now carries a concurrency guarantee the previous one lacked.
- A command's `success` schema must round-trip through encode/decode; non-encodable successes are a defect at dispatch, surfacing immediately in tests.
- The store's error channel stays `never`: durable stores die on infrastructure failure like the other adapters, and a dispatch cannot succeed without its claim.
- A crashed process leaves its claim until the TTL expires; the dispatch `timeout` bounds the normal path, and operators size the TTL to the client retry window (see `docs/operations.md`).
- Revisit if a transport needs the in-flight case to wait for the running dispatch instead of failing fast, or if per-key TTLs (not per store) become necessary.
