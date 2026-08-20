# ADR-0009: Authentication protocols are implemented behind application-owned ports

- Status: accepted
- Date: 2026-08-20

## Context

New applications need a consistent authentication base for passwords, email links, passkeys, sessions, and four OAuth providers. Their persistence, tenancy, account-linking rules, provider credentials, delivery, and operational policies vary. The project also requires no external authentication dependency, so protocol behavior cannot be delegated to an auth framework or WebAuthn/OAuth SDK.

Authentication handles bearer credentials and external identities; silently permissive defaults or application-table coupling would spread security decisions across every application.

## Decision

`@structure-ai/auth` implements the narrowly supported protocol mechanics with Bun Argon2id and Web Crypto, while applications own persistence and policy through explicit Effect ports. Every persisted key is tenant-scoped; opaque tokens are stored only by digest; OAuth linking is deny-by-default; WebAuthn supports only none/packed-self attestation and ES256/RS256/Ed25519, rejecting every unsupported format or algorithm. Optional `auth-sqlite` and `auth-pg` packages implement the storage port with Bun's built-in SQL clients, preserving the dependency boundary without duplicating persistence in each application.

## Consequences

- Applications get one tested password, link, session, passkey, and OAuth lifecycle without an auth-library dependency or provider SDK.
- Applications may use the supplied SQLite/PostgreSQL adapters or implement the documented atomic consumption, uniqueness, password-change/session-revocation, and counter-update boundaries for another store; the in-memory adapter is not production persistence.
- Provider configuration, tenant routing, rate limiting, email, audit, origin policy, HTTP, and account linking remain replaceable without forking the protocol core.
- The package owns more security-sensitive code and requires focused review, conformance fixtures, and prompt maintenance when WebAuthn, OAuth, Bun crypto, or provider contracts change.
- Certificate/enterprise attestation, algorithms beyond ES256/RS256/Ed25519, authorization/RBAC, and application profile modeling are deliberately excluded.
- Supersede this decision if maintenance evidence shows the dependency ban causes unacceptable security or interoperability risk, or if a reviewed platform-native primitive can replace custom protocol parsing.
