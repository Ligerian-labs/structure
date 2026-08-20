import { Effect } from "effect";
import { type CborValue, decodeCbor } from "./cbor.js";
import { decodeBase64Url, encodeBase64Url, sha256Bytes } from "./crypto.js";
import { AuthDependencyError, UnsupportedPasskey } from "./errors.js";
import type { PasskeyAlgorithm, PasskeyRecord, PasskeyTenantConfig } from "./model.js";

export interface PasskeyRegistrationResponse {
  readonly credentialId: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: ReadonlyArray<string>;
  };
}

export interface PasskeyAuthenticationResponse {
  readonly credentialId: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
}

export interface VerifiedPasskeyRegistration {
  readonly challenge: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: PasskeyAlgorithm;
  readonly counter: number;
  readonly transports: ReadonlyArray<string>;
}

export interface VerifiedPasskeyAuthentication {
  readonly challenge: string;
  readonly counter: number;
}

export interface PasskeyRegistrationOptions {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: ReadonlyArray<{
    readonly type: "public-key";
    readonly alg: -7 | -257 | -8;
  }>;
  readonly timeout: number;
  readonly attestation: "none";
  readonly authenticatorSelection: {
    readonly residentKey: "preferred";
    readonly userVerification: "required" | "preferred";
  };
  readonly excludeCredentials: ReadonlyArray<{
    readonly type: "public-key";
    readonly id: string;
    readonly transports: ReadonlyArray<string>;
  }>;
}

export interface PasskeyAuthenticationOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: "required" | "preferred";
  readonly allowCredentials?: ReadonlyArray<{
    readonly type: "public-key";
    readonly id: string;
    readonly transports: ReadonlyArray<string>;
  }>;
}

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: boolean;
}

interface ParsedAuthenticatorData {
  readonly bytes: Uint8Array;
  readonly flags: number;
  readonly counter: number;
  readonly credentialId?: Uint8Array;
  readonly credentialPublicKey?: Uint8Array;
}

interface ParsedCoseKey {
  readonly algorithm: PasskeyAlgorithm;
  readonly key: CryptoKey;
}

const passkeyFailure = (reason: string): UnsupportedPasskey => new UnsupportedPasskey({ reason });

const safeBytes = (value: string, field: string): Effect.Effect<Uint8Array, UnsupportedPasskey> =>
  !/^[A-Za-z0-9_-]*$/u.test(value) || value.length > 1_398_102
    ? Effect.fail(passkeyFailure(`${field} is not bounded base64url`))
    : Effect.try({
        try: () => decodeBase64Url(value),
        catch: () => passkeyFailure(`${field} is not base64url`),
      });

const isMap = (value: CborValue | undefined): value is ReadonlyMap<CborValue, CborValue> =>
  value instanceof Map;

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
};

const clientData = (
  encoded: string,
  expectedType: "webauthn.create" | "webauthn.get",
  config: PasskeyTenantConfig,
): Effect.Effect<{ readonly data: ClientData; readonly bytes: Uint8Array }, UnsupportedPasskey> =>
  Effect.gen(function* () {
    const bytes = yield* safeBytes(encoded, "clientDataJSON");
    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: () => passkeyFailure("clientDataJSON is invalid"),
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* passkeyFailure("clientDataJSON must be an object");
    }
    const object = parsed as Record<string, unknown>;
    if (
      object.type !== expectedType ||
      typeof object.challenge !== "string" ||
      typeof object.origin !== "string" ||
      (object.crossOrigin !== undefined && object.crossOrigin !== false)
    ) {
      return yield* passkeyFailure(
        "client data type, challenge, origin, or cross-origin flag is invalid",
      );
    }
    if (!config.origins.includes(object.origin)) {
      return yield* passkeyFailure("origin is not allowed");
    }
    const challenge = object.challenge;
    const origin = object.origin;
    return {
      data: {
        type: expectedType,
        challenge,
        origin,
        ...(object.crossOrigin === undefined ? {} : { crossOrigin: object.crossOrigin }),
      },
      bytes,
    };
  });

export const passkeyChallengeFromClientData = (
  encoded: string,
): Effect.Effect<string, UnsupportedPasskey> =>
  Effect.gen(function* () {
    const bytes = yield* safeBytes(encoded, "clientDataJSON");
    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: () => passkeyFailure("clientDataJSON is invalid"),
    });
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).challenge !== "string"
    ) {
      return yield* passkeyFailure("clientDataJSON challenge is missing");
    }
    const challenge = (parsed as Record<string, unknown>).challenge;
    return typeof challenge === "string"
      ? challenge
      : yield* passkeyFailure("clientDataJSON challenge is missing");
  });

const parseAuthenticatorData = (
  bytes: Uint8Array,
  requireAttestedData: boolean,
): Effect.Effect<ParsedAuthenticatorData, UnsupportedPasskey> =>
  Effect.try({
    try: () => {
      if (bytes.length < 37) throw new Error("authenticator data is truncated");
      const flags = bytes[32];
      if (flags === undefined) throw new Error("authenticator flags are missing");
      if ((flags & 0x80) !== 0) throw new Error("authenticator extensions are unsupported");
      const counter = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
      if (!requireAttestedData) {
        if ((flags & 0x40) !== 0 || bytes.length !== 37) {
          throw new Error("authentication data has unexpected trailing fields");
        }
        return { bytes, flags, counter };
      }
      if ((flags & 0x40) === 0) throw new Error("attested credential data flag is missing");
      if (bytes.length < 55) throw new Error("attested credential data is truncated");
      const credentialLength = new DataView(bytes.buffer, bytes.byteOffset + 53, 2).getUint16(0);
      if (credentialLength === 0 || credentialLength > 1_023) {
        throw new Error("credential id length is invalid");
      }
      const credentialStart = 55;
      const credentialEnd = credentialStart + credentialLength;
      if (credentialEnd >= bytes.length) throw new Error("credential id is truncated");
      const decodedKey = decodeCbor(bytes, credentialEnd);
      if (decodedKey.offset !== bytes.length) {
        throw new Error("attested credential data has trailing bytes");
      }
      return {
        bytes,
        flags,
        counter,
        credentialId: bytes.slice(credentialStart, credentialEnd),
        credentialPublicKey: bytes.slice(credentialEnd, decodedKey.offset),
      };
    },
    catch: (cause) =>
      passkeyFailure(cause instanceof Error ? cause.message : "authenticator data is invalid"),
  });

const validateAuthenticator = (
  parsed: ParsedAuthenticatorData,
  config: PasskeyTenantConfig,
): Effect.Effect<void, UnsupportedPasskey | AuthDependencyError> =>
  Effect.gen(function* () {
    const expectedRpHash = yield* sha256Bytes(new TextEncoder().encode(config.rpId));
    if (!equalBytes(parsed.bytes.slice(0, 32), expectedRpHash)) {
      return yield* passkeyFailure("RP ID hash does not match");
    }
    if ((parsed.flags & 0x01) === 0) return yield* passkeyFailure("user presence is required");
    if ((config.requireUserVerification ?? true) && (parsed.flags & 0x04) === 0) {
      return yield* passkeyFailure("user verification is required");
    }
  });

const importCoseKey = (
  encoded: Uint8Array,
): Effect.Effect<ParsedCoseKey, UnsupportedPasskey | AuthDependencyError> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => {
        const decoded = decodeCbor(encoded);
        if (decoded.offset !== encoded.length) throw new Error("trailing credential key data");
        return decoded.value;
      },
      catch: () => passkeyFailure("credential public key is invalid CBOR"),
    });
    if (!isMap(value)) return yield* passkeyFailure("credential public key must be a COSE map");
    const kty = value.get(1);
    const alg = value.get(3);
    if (kty === 2 && alg === -7 && value.get(-1) === 1) {
      const x = value.get(-2);
      const y = value.get(-3);
      if (
        !(x instanceof Uint8Array) ||
        !(y instanceof Uint8Array) ||
        x.length !== 32 ||
        y.length !== 32
      ) {
        return yield* passkeyFailure("ES256 public key coordinates are invalid");
      }
      const raw = concat(Uint8Array.of(4), x, y);
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            Uint8Array.from(raw).buffer,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          ),
        catch: (cause) =>
          new AuthDependencyError({ dependency: "webcrypto", operation: "import-es256", cause }),
      });
      return { algorithm: "ES256", key };
    }
    if (kty === 3 && alg === -257) {
      const n = value.get(-1);
      const e = value.get(-2);
      if (
        !(n instanceof Uint8Array) ||
        !(e instanceof Uint8Array) ||
        n.length < 256 ||
        n.length > 1_024 ||
        e.length === 0 ||
        e.length > 8
      ) {
        return yield* passkeyFailure("RS256 public key parameters are invalid");
      }
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "jwk",
            {
              kty: "RSA",
              n: encodeBase64Url(n),
              e: encodeBase64Url(e),
              alg: "RS256",
              ext: true,
              key_ops: ["verify"],
            },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        catch: (cause) =>
          new AuthDependencyError({ dependency: "webcrypto", operation: "import-rs256", cause }),
      });
      return { algorithm: "RS256", key };
    }
    if (kty === 1 && alg === -8 && value.get(-1) === 6) {
      const x = value.get(-2);
      if (!(x instanceof Uint8Array) || x.length !== 32) {
        return yield* passkeyFailure("Ed25519 public key is invalid");
      }
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey("raw", Uint8Array.from(x).buffer, "Ed25519", false, ["verify"]),
        catch: (cause) =>
          new AuthDependencyError({ dependency: "webcrypto", operation: "import-ed25519", cause }),
      });
      return { algorithm: "Ed25519", key };
    }
    return yield* passkeyFailure("credential algorithm is not ES256, RS256, or Ed25519");
  });

const derEcdsaToRaw = (signature: Uint8Array): Uint8Array | undefined => {
  if (signature[0] !== 0x30) return undefined;
  const declaredLength = signature[1];
  if (declaredLength === undefined) return undefined;
  let offset = 2;
  let sequenceLength = declaredLength;
  if (declaredLength >= 0x80) {
    const count = declaredLength & 0x7f;
    if (count !== 1) return undefined;
    const longLength = signature[2];
    if (longLength === undefined) return undefined;
    sequenceLength = longLength;
    offset = 3;
  }
  if (offset + sequenceLength !== signature.length) return undefined;
  if (signature[offset] !== 0x02) return undefined;
  const rLength = signature[offset + 1];
  if (rLength === undefined) return undefined;
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (signature[offset] !== 0x02) return undefined;
  const sLength = signature[offset + 1];
  if (sLength === undefined) return undefined;
  const s = signature.slice(offset + 2, offset + 2 + sLength);
  if (offset + 2 + sLength !== signature.length) return undefined;
  const normalize = (integer: Uint8Array): Uint8Array | undefined => {
    if (integer.length === 0 || ((integer[0] ?? 0) & 0x80) !== 0) return undefined;
    if (integer.length > 1 && integer[0] === 0 && ((integer[1] ?? 0) & 0x80) === 0) {
      return undefined;
    }
    const value = integer[0] === 0 ? integer.slice(1) : integer;
    if (value.length > 32) return undefined;
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const normalizedR = normalize(r);
  const normalizedS = normalize(s);
  return normalizedR === undefined || normalizedS === undefined
    ? undefined
    : concat(normalizedR, normalizedS);
};

const verifySignature = (
  cose: ParsedCoseKey,
  signature: Uint8Array,
  signed: Uint8Array,
): Effect.Effect<boolean, UnsupportedPasskey | AuthDependencyError> => {
  const normalized = cose.algorithm === "ES256" ? derEcdsaToRaw(signature) : signature;
  if (normalized === undefined)
    return Effect.fail(passkeyFailure("ES256 signature is invalid DER"));
  const algorithm =
    cose.algorithm === "ES256"
      ? ({ name: "ECDSA", hash: "SHA-256" } as const)
      : cose.algorithm === "RS256"
        ? ({ name: "RSASSA-PKCS1-v1_5" } as const)
        : ({ name: "Ed25519" } as const);
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(
        algorithm,
        cose.key,
        Uint8Array.from(normalized).buffer,
        Uint8Array.from(signed).buffer,
      ),
    catch: (cause) =>
      new AuthDependencyError({ dependency: "webcrypto", operation: "verify-passkey", cause }),
  });
};

export const verifyPasskeyRegistration = (
  config: PasskeyTenantConfig,
  input: PasskeyRegistrationResponse,
): Effect.Effect<VerifiedPasskeyRegistration, UnsupportedPasskey | AuthDependencyError> =>
  Effect.gen(function* () {
    const client = yield* clientData(input.response.clientDataJSON, "webauthn.create", config);
    const attestationBytes = yield* safeBytes(
      input.response.attestationObject,
      "attestationObject",
    );
    const attestation = yield* Effect.try({
      try: () => {
        const decoded = decodeCbor(attestationBytes);
        if (decoded.offset !== attestationBytes.length)
          throw new Error("trailing attestation data");
        return decoded.value;
      },
      catch: () => passkeyFailure("attestationObject is invalid CBOR"),
    });
    if (!isMap(attestation)) return yield* passkeyFailure("attestationObject must be a map");
    const format = attestation.get("fmt");
    const authDataValue = attestation.get("authData");
    const statement = attestation.get("attStmt");
    if (typeof format !== "string" || !(authDataValue instanceof Uint8Array) || !isMap(statement)) {
      return yield* passkeyFailure("attestation fields are invalid");
    }
    const authData = yield* parseAuthenticatorData(authDataValue, true);
    yield* validateAuthenticator(authData, config);
    if (authData.credentialId === undefined || authData.credentialPublicKey === undefined) {
      return yield* passkeyFailure("attested credential data is missing");
    }
    const suppliedCredential = yield* safeBytes(input.credentialId, "credentialId");
    if (!equalBytes(authData.credentialId, suppliedCredential)) {
      return yield* passkeyFailure("credential id does not match attested data");
    }
    const cose = yield* importCoseKey(authData.credentialPublicKey);
    if (format === "none") {
      if (statement.size !== 0)
        return yield* passkeyFailure("none attestation statement must be empty");
    } else if (format === "packed") {
      if (statement.has("x5c"))
        return yield* passkeyFailure("certificate attestation is unsupported");
      if (statement.has("ecdaaKeyId") || statement.size !== 2) {
        return yield* passkeyFailure("packed attestation must be self-attestation");
      }
      const algorithm = statement.get("alg");
      const signature = statement.get("sig");
      const expectedAlgorithm =
        cose.algorithm === "ES256" ? -7 : cose.algorithm === "RS256" ? -257 : -8;
      if (algorithm !== expectedAlgorithm || !(signature instanceof Uint8Array)) {
        return yield* passkeyFailure("self-attestation statement is invalid");
      }
      const clientHash = yield* sha256Bytes(client.bytes);
      const verified = yield* verifySignature(cose, signature, concat(authData.bytes, clientHash));
      if (!verified) return yield* passkeyFailure("self-attestation signature is invalid");
    } else {
      return yield* passkeyFailure("attestation format is not none or packed self-attestation");
    }
    return {
      challenge: client.data.challenge,
      credentialId: input.credentialId,
      publicKey: encodeBase64Url(authData.credentialPublicKey),
      algorithm: cose.algorithm,
      counter: authData.counter,
      transports: input.response.transports ?? [],
    };
  });

export const verifyPasskeyAuthentication = (
  config: PasskeyTenantConfig,
  passkey: PasskeyRecord,
  input: PasskeyAuthenticationResponse,
): Effect.Effect<VerifiedPasskeyAuthentication, UnsupportedPasskey | AuthDependencyError> =>
  Effect.gen(function* () {
    if (input.credentialId !== passkey.credentialId) {
      return yield* passkeyFailure("credential id does not match stored passkey");
    }
    const client = yield* clientData(input.response.clientDataJSON, "webauthn.get", config);
    const authDataBytes = yield* safeBytes(input.response.authenticatorData, "authenticatorData");
    const signature = yield* safeBytes(input.response.signature, "signature");
    const authData = yield* parseAuthenticatorData(authDataBytes, false);
    yield* validateAuthenticator(authData, config);
    if (passkey.counter > 0 && authData.counter <= passkey.counter) {
      return yield* passkeyFailure("signature counter did not increase");
    }
    const coseBytes = yield* safeBytes(passkey.publicKey, "stored public key");
    const cose = yield* importCoseKey(coseBytes);
    if (cose.algorithm !== passkey.algorithm) {
      return yield* passkeyFailure("stored passkey algorithm does not match its key");
    }
    const clientHash = yield* sha256Bytes(client.bytes);
    const verified = yield* verifySignature(cose, signature, concat(authData.bytes, clientHash));
    if (!verified) return yield* passkeyFailure("authentication signature is invalid");
    return { challenge: client.data.challenge, counter: authData.counter };
  });
