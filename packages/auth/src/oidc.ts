import { Effect, Redacted } from "effect";
import { AuthDependencyError } from "./errors.js";
import type { OAuthCredentials, OAuthProfile } from "./model.js";
import type { OAuthHttpClient, OAuthProvider } from "./oauth.js";

/** Discovery document (the fields this package consumes). */
export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

/** A discovered generic OIDC provider, ready for the provider resolver. */
export interface DiscoveredOidc {
  readonly provider: OAuthProvider;
  readonly discovery: OidcDiscovery;
}

export interface OidcProviderConfig {
  /** The issuer identifier; discovery happens at `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: URL;
  readonly credentials: OAuthCredentials;
  /** Default `openid email profile`. */
  readonly scopes?: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fetchJson = (
  client: OAuthHttpClient,
  url: string,
  operation: string,
): Effect.Effect<Record<string, unknown>, AuthDependencyError> =>
  client.execute(new Request(url, { headers: { accept: "application/json" } })).pipe(
    Effect.flatMap((response: Response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: (cause) =>
              new AuthDependencyError({ dependency: "oidc-provider", operation, cause }),
          })
        : Effect.fail(
            new AuthDependencyError({
              dependency: "oidc-provider",
              operation: `${operation}-http-${response.status}`,
            }),
          ),
    ),
    Effect.flatMap((body) =>
      isRecord(body)
        ? Effect.succeed(body)
        : Effect.fail(
            new AuthDependencyError({
              dependency: "oidc-provider",
              operation: `${operation}-shape`,
            }),
          ),
    ),
  );

const requiredEndpoint = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<string, AuthDependencyError> =>
  typeof body[field] === "string" && (body[field] as string).length > 0
    ? Effect.succeed(body[field] as string)
    : Effect.fail(
        new AuthDependencyError({
          dependency: "oidc-provider",
          operation: `discovery-missing-${field}`,
        }),
      );

// --- ID token validation (JWKS) ----------------------------------------------------

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

const base64UrlDecode = (input: string): Uint8Array => {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const stringFromBytes = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const decoder = (data: string, context: string): Effect.Effect<unknown, AuthDependencyError> =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: () =>
      new AuthDependencyError({ dependency: "oidc-provider", operation: `decode-${context}` }),
  });

const importVerificationKey = (jwk: Jwk): Effect.Effect<CryptoKey, AuthDependencyError> =>
  Effect.tryPromise({
    try: async (): Promise<CryptoKey> => {
      if (jwk.kty === "RSA" && jwk.n !== undefined && jwk.e !== undefined) {
        return await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, ext: true, key_ops: ["verify"] },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
      }
      if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x !== undefined && jwk.y !== undefined) {
        return await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true, key_ops: ["verify"] },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
      }
      throw new Error("unsupported jwk");
    },
    catch: (cause) =>
      new AuthDependencyError({ dependency: "oidc-provider", operation: "jwk-import", cause }),
  });

/** Raw JWS (r||s, 64 bytes) → DER-encoded ECDSA signature for WebCrypto. */
const jwsSignatureToDer = (raw: Uint8Array): Uint8Array => {
  const half = raw.length / 2;
  const r = raw.slice(0, half);
  const s = raw.slice(half);
  const trim = (value: Uint8Array): { readonly bytes: Uint8Array; readonly leading: boolean } => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const slice = value.slice(start);
    return { bytes: slice, leading: slice[0] !== undefined && slice[0] > 0x7f };
  };
  const trimmedR = trim(r);
  const trimmedS = trim(s);
  const rLength = trimmedR.bytes.length + (trimmedR.leading ? 1 : 0);
  const sLength = trimmedS.bytes.length + (trimmedS.leading ? 1 : 0);
  const length = 2 + rLength + 2 + sLength;
  const der = new Uint8Array(2 + length);
  der[0] = 0x30;
  der[1] = length;
  let offset = 2;
  der[offset] = 0x02;
  der[offset + 1] = rLength;
  offset += 2;
  if (trimmedR.leading) {
    der[offset] = 0x00;
    der.set(trimmedR.bytes, offset + 1);
  } else {
    der.set(trimmedR.bytes, offset);
  }
  offset += rLength;
  der[offset] = 0x02;
  der[offset + 1] = sLength;
  offset += 2;
  if (trimmedS.leading) {
    der[offset] = 0x00;
    der.set(trimmedS.bytes, offset + 1);
  } else {
    der.set(trimmedS.bytes, offset);
  }
  return der;
};

const verifySignature = (
  key: CryptoKey,
  algorithm: string,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Effect.Effect<boolean, AuthDependencyError> =>
  Effect.tryPromise({
    try: async (): Promise<boolean> => {
      if (algorithm === "RS256") {
        return await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          signingInput as unknown as ArrayBuffer,
          signature as unknown as ArrayBuffer,
        );
      }
      if (algorithm === "ES256") {
        return await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          signingInput as unknown as ArrayBuffer,
          jwsSignatureToDer(signature) as unknown as ArrayBuffer,
        );
      }
      return false;
    },
    catch: () =>
      new AuthDependencyError({ dependency: "oidc-provider", operation: "signature-verify" }),
  }).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
  );

export interface OidcTokenValidationInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly jwksUri: string;
  readonly idToken: string;
  readonly httpClient: OAuthHttpClient;
  readonly now?: () => Date;
}

/**
 * Validates an OpenID Connect ID token against the provider's JWKS:
 * signature (RS256/ES256 via WebCrypto), `iss`, `aud` (must include the
 * client id), and `exp`, then maps the standard claims to a profile. The
 * JWKS is fetched once and cached; an unknown `kid` triggers one refetch.
 */
export const validateIdToken = (
  input: OidcTokenValidationInput,
): Effect.Effect<OAuthProfile, AuthDependencyError> => {
  const now = input.now === undefined ? () => new Date() : input.now;
  const fetchJwks = (attempt: number): Effect.Effect<ReadonlyArray<Jwk>, AuthDependencyError> =>
    fetchJson(input.httpClient, input.jwksUri, "jwks").pipe(
      Effect.flatMap((body) => {
        const keys = body.keys;
        return Array.isArray(keys)
          ? Effect.succeed(keys.filter((key): key is Jwk => isRecord(key)))
          : Effect.fail(
              new AuthDependencyError({ dependency: "oidc-provider", operation: "jwks-shape" }),
            );
      }),
      Effect.flatMap((keys) =>
        attempt === 0
          ? validateWith(keys)
              .pipe(Effect.option)
              .pipe(
                Effect.flatMap((result) =>
                  result._tag === "Some"
                    ? Effect.succeed(keys)
                    : Effect.fail(
                        new AuthDependencyError({
                          dependency: "oidc-provider",
                          operation: "id-token-unknown-kid",
                        }),
                      ),
                ),
              )
          : Effect.succeed(keys),
      ),
    );

  const validateWith = (
    keys: ReadonlyArray<Jwk>,
  ): Effect.Effect<OAuthProfile, AuthDependencyError> =>
    Effect.gen(function* () {
      const parts = input.idToken.split(".");
      if (parts.length !== 3) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-shape",
        });
      }
      const header = yield* decoder(
        stringFromBytes(base64UrlDecode(parts[0] ?? "")),
        "id-token-header",
      );
      if (!isRecord(header)) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-header-shape",
        });
      }
      const algorithm = header.alg;
      const kid = header.kid;
      if (algorithm !== "RS256" && algorithm !== "ES256") {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: `id-token-alg-${String(algorithm)}`,
        });
      }
      const jwk =
        kid === undefined
          ? keys.find((key) => key.alg === algorithm)
          : keys.find((key) => key.kid === kid);
      if (jwk === undefined) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-unknown-kid",
        });
      }
      const signature = base64UrlDecode(parts[2] ?? "");
      const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const key = yield* importVerificationKey(jwk);
      const valid = yield* verifySignature(key, algorithm, signingInput, signature);
      if (!valid) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-signature",
        });
      }
      const claims = yield* decoder(
        stringFromBytes(base64UrlDecode(parts[1] ?? "")),
        "id-token-claims",
      );
      if (!isRecord(claims)) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-claims-shape",
        });
      }
      if (claims.iss !== input.issuer) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-issuer",
        });
      }
      const audiences = Array.isArray(claims.aud)
        ? claims.aud
        : typeof claims.aud === "string"
          ? [claims.aud]
          : [];
      if (!audiences.includes(input.clientId)) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-audience",
        });
      }
      const expiresAt = Number(claims.exp);
      if (!Number.isFinite(expiresAt) || expiresAt * 1_000 <= now().getTime()) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-expired",
        });
      }
      const subject = claims.sub;
      if (typeof subject !== "string" || subject.length === 0) {
        return yield* new AuthDependencyError({
          dependency: "oidc-provider",
          operation: "id-token-subject",
        });
      }
      const email =
        typeof claims.email === "string" && claims.email.length > 0
          ? claims.email.trim().toLowerCase()
          : undefined;
      const emailVerified = claims.email_verified === true;
      const displayName =
        typeof claims.name === "string" && claims.name.length > 0 ? claims.name : undefined;
      return {
        subject,
        ...(email === undefined ? {} : { email }),
        emailVerified,
        ...(displayName === undefined ? {} : { displayName }),
      };
    });

  return fetchJson(input.httpClient, input.jwksUri, "jwks").pipe(
    Effect.flatMap((body) => {
      const keys = Array.isArray(body.keys)
        ? body.keys.filter((key): key is Jwk => isRecord(key))
        : [];
      return validateWith(keys).pipe(
        Effect.catchIf(
          (error) => error.operation === "id-token-unknown-kid",
          () => fetchJwks(1).pipe(Effect.flatMap(validateWith)),
        ),
      );
    }),
  );
};

/**
 * Discovers a generic OIDC provider from its issuer URL and builds an
 * `OAuthProvider` whose profile comes from a JWKS-validated ID token —
 * no userinfo roundtrip, no raw provider tokens exposed downstream.
 */
export const discoverOidc = (
  config: OidcProviderConfig,
  httpClient: OAuthHttpClient,
): Effect.Effect<DiscoveredOidc, AuthDependencyError> =>
  Effect.gen(function* () {
    const discoveryUrl = new URL(
      ".well-known/openid-configuration",
      config.issuer.toString().endsWith("/")
        ? config.issuer
        : new URL(`${config.issuer.toString()}/`),
    );
    const body = yield* fetchJson(httpClient, discoveryUrl.toString(), "discovery");
    const authorizationEndpoint = yield* requiredEndpoint(body, "authorization_endpoint");
    const tokenEndpoint = yield* requiredEndpoint(body, "token_endpoint");
    const jwksUri = yield* requiredEndpoint(body, "jwks_uri");
    const issuer =
      typeof body.issuer === "string" && body.issuer.length > 0
        ? body.issuer
        : config.issuer.toString();
    const scopes = config.scopes ?? ["openid", "email", "profile"];
    const provider: OAuthProvider = {
      id: "oidc",
      credentials: config.credentials,
      authorizationEndpoint,
      tokenEndpoint,
      scopes,
      tokenAuthMethod: "client-secret-basic",
      fetchProfile: (tokens, _client) => {
        const idToken = tokens.idToken;
        if (idToken === undefined) {
          return Effect.fail(
            new AuthDependencyError({
              dependency: "oidc-provider",
              operation: "id-token-missing",
            }),
          );
        }
        return validateIdToken({
          issuer,
          clientId: config.credentials.clientId,
          jwksUri,
          idToken: Redacted.value(idToken),
          httpClient,
        });
      },
    };
    return {
      provider,
      discovery: { issuer, authorizationEndpoint, tokenEndpoint, jwksUri },
    };
  });
