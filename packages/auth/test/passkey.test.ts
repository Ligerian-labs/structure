import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type AuthAuditEvent,
  type AuthEmail,
  allowAllRateLimiter,
  decodeBase64Url,
  encodeBase64Url,
  InvalidAuthToken,
  inMemoryAuthStore,
  makeAuth,
  type PasskeyRegistrationResponse,
  sha256Bytes,
  type TenantAuthConfig,
  UnsupportedPasskey,
  verifyPasskeyRegistration,
} from "../src/index.js";

type Encodable = number | string | Uint8Array | ReadonlyMap<Encodable, Encodable>;

const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
};

const cborHead = (major: number, value: number): Uint8Array => {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
};

const cbor = (value: Encodable): Uint8Array => {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  const entries = [...value.entries()];
  return concat(
    cborHead(5, entries.length),
    ...entries.flatMap(([key, entry]) => [cbor(key), cbor(entry)]),
  );
};

const clientData = (
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
) => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  );
  return { bytes, encoded: encodeBase64Url(bytes) };
};

const counterBytes = (counter: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, counter);
  return bytes;
};

const toDer = (raw: Uint8Array): Uint8Array => {
  const integer = (value: Uint8Array): Uint8Array => {
    let first = 0;
    while (first < value.length - 1 && value[first] === 0) first += 1;
    const trimmed = value.slice(first);
    const prefixed = (trimmed[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, prefixed.length), prefixed);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32, 64));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
};

const config: TenantAuthConfig = {
  baseUrl: new URL("https://accounts.example.com"),
  passkey: {
    rpId: "accounts.example.com",
    rpName: "Example",
    origins: ["https://accounts.example.com"],
    requireUserVerification: true,
  },
};

const makeCredential = async (
  challenge: string,
  format: "none" | "packed",
  trailingAuthData: Uint8Array = new Uint8Array(),
  aaguid: Uint8Array = new Uint8Array(16),
): Promise<{
  registration: PasskeyRegistrationResponse;
  privateKey: CryptoKey;
  credentialId: string;
}> => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const cose = cbor(
    new Map<Encodable, Encodable>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, rawPublic.slice(1, 33)],
      [-3, rawPublic.slice(33, 65)],
    ]),
  );
  const credential = crypto.getRandomValues(new Uint8Array(20));
  const rpHash = await Effect.runPromise(
    sha256Bytes(new TextEncoder().encode("accounts.example.com")),
  );
  const authData = concat(
    rpHash,
    Uint8Array.of(0x45),
    counterBytes(0),
    aaguid,
    Uint8Array.of(0, credential.length),
    credential,
    cose,
    trailingAuthData,
  );
  const client = clientData("webauthn.create", challenge, "https://accounts.example.com");
  let statement: ReadonlyMap<Encodable, Encodable> = new Map();
  if (format === "packed") {
    const clientHash = await Effect.runPromise(sha256Bytes(client.bytes));
    const rawSignature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        Uint8Array.from(concat(authData, clientHash)).buffer,
      ),
    );
    statement = new Map<Encodable, Encodable>([
      ["alg", -7],
      ["sig", toDer(rawSignature)],
    ]);
  }
  const attestation = cbor(
    new Map<Encodable, Encodable>([
      ["fmt", format],
      ["authData", authData],
      ["attStmt", statement],
    ]),
  );
  return {
    privateKey: keys.privateKey,
    credentialId: encodeBase64Url(credential),
    registration: {
      credentialId: encodeBase64Url(credential),
      response: {
        clientDataJSON: client.encoded,
        attestationObject: encodeBase64Url(attestation),
        transports: ["internal"],
      },
    },
  };
};

const makeNoneRegistration = async (
  algorithm: "RS256" | "Ed25519",
): Promise<PasskeyRegistrationResponse> => {
  let cose: Uint8Array;
  if (algorithm === "RS256") {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2_048,
        publicExponent: Uint8Array.of(1, 0, 1),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    if (jwk.n === undefined || jwk.e === undefined) throw new Error("RSA JWK is incomplete");
    cose = cbor(
      new Map<Encodable, Encodable>([
        [1, 3],
        [3, -257],
        [-1, decodeBase64Url(jwk.n)],
        [-2, decodeBase64Url(jwk.e)],
      ]),
    );
  } else {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    if (!("publicKey" in keys)) throw new Error("Ed25519 did not return a key pair");
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    cose = cbor(
      new Map<Encodable, Encodable>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, raw],
      ]),
    );
  }
  const credential = crypto.getRandomValues(new Uint8Array(20));
  const rpHash = await Effect.runPromise(
    sha256Bytes(new TextEncoder().encode("accounts.example.com")),
  );
  const authData = concat(
    rpHash,
    Uint8Array.of(0x45),
    counterBytes(0),
    new Uint8Array(16),
    Uint8Array.of(0, credential.length),
    credential,
    cose,
  );
  const client = clientData(
    "webauthn.create",
    `${algorithm}-challenge`,
    "https://accounts.example.com",
  );
  return {
    credentialId: encodeBase64Url(credential),
    response: {
      clientDataJSON: client.encoded,
      attestationObject: encodeBase64Url(
        cbor(
          new Map<Encodable, Encodable>([
            ["fmt", "none"],
            ["authData", authData],
            ["attStmt", new Map<Encodable, Encodable>()],
          ]),
        ),
      ),
    },
  };
};

describe("passkeys", () => {
  test("registers none attestation and authenticates an ES256 credential exactly once", async () => {
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      rateLimiter: allowAllRateLimiter,
    });
    await Effect.runPromise(auth.requestMagicLink("tenant-a", "passkey@example.com"));
    const magicLink = emails[0];
    if (magicLink === undefined) throw new Error("magic-link email was not captured");
    const initialSession = await Effect.runPromise(
      auth.consumeMagicLink("tenant-a", magicLink.token),
    );

    const registrationOptions = await Effect.runPromise(
      auth.beginPasskeyRegistration("tenant-a", initialSession.token),
    );
    const credential = await makeCredential(registrationOptions.challenge, "none");
    await Effect.runPromise(
      auth.finishPasskeyRegistration("tenant-a", initialSession.token, credential.registration),
    );
    expect(memory.snapshot().passkeys[0]?.algorithm).toBe("ES256");

    const authenticationOptions = await Effect.runPromise(
      auth.beginPasskeyAuthentication("tenant-a", "passkey@example.com"),
    );
    expect(authenticationOptions.allowCredentials?.[0]?.id).toBe(credential.credentialId);
    const client = clientData(
      "webauthn.get",
      authenticationOptions.challenge,
      "https://accounts.example.com",
    );
    const rpHash = await Effect.runPromise(
      sha256Bytes(new TextEncoder().encode("accounts.example.com")),
    );
    const authenticatorData = concat(rpHash, Uint8Array.of(0x05), counterBytes(1));
    const clientHash = await Effect.runPromise(sha256Bytes(client.bytes));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        credential.privateKey,
        Uint8Array.from(concat(authenticatorData, clientHash)).buffer,
      ),
    );
    const response = {
      credentialId: credential.credentialId,
      response: {
        clientDataJSON: client.encoded,
        authenticatorData: encodeBase64Url(authenticatorData),
        signature: encodeBase64Url(toDer(signature)),
      },
    };
    const session = await Effect.runPromise(auth.finishPasskeyAuthentication("tenant-a", response));
    expect(session.user.email).toBe("passkey@example.com");
    expect(memory.snapshot().passkeys[0]?.counter).toBe(1);
    expect(
      await Effect.runPromise(Effect.flip(auth.finishPasskeyAuthentication("tenant-a", response))),
    ).toBeInstanceOf(InvalidAuthToken);
  });

  test("stores display metadata and lets the owner rename and remove a passkey", async () => {
    const memory = inMemoryAuthStore();
    const emails: Array<AuthEmail> = [];
    const audit: Array<AuthAuditEvent> = [];
    const auth = makeAuth({
      store: memory.store,
      resolveTenant: () => Effect.succeed(config),
      emailSender: { send: (email) => Effect.sync(() => emails.push(email)).pipe(Effect.asVoid) },
      rateLimiter: allowAllRateLimiter,
      audit: { record: (event) => Effect.sync(() => audit.push(event)).pipe(Effect.asVoid) },
    });
    await Effect.runPromise(auth.requestMagicLink("tenant-a", "passkey@example.com"));
    const magicLink = emails[0];
    if (magicLink === undefined) throw new Error("magic-link email was not captured");
    const session = await Effect.runPromise(auth.consumeMagicLink("tenant-a", magicLink.token));
    const options = await Effect.runPromise(
      auth.beginPasskeyRegistration("tenant-a", session.token),
    );
    const aaguid = Uint8Array.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
    const credential = await makeCredential(options.challenge, "none", new Uint8Array(), aaguid);

    await Effect.runPromise(
      auth.finishPasskeyRegistration("tenant-a", session.token, credential.registration, {
        label: "Work laptop",
      }),
    );
    expect(memory.snapshot().passkeys[0]).toEqual(
      expect.objectContaining({
        label: "Work laptop",
        aaguid: "00112233-4455-6677-8899-aabbccddeeff",
      }),
    );

    expect(
      await Effect.runPromise(
        auth.renamePasskey("tenant-a", session.token, credential.credentialId, "Security key"),
      ),
    ).toBe(true);
    expect(memory.snapshot().passkeys[0]?.label).toBe("Security key");
    expect(
      await Effect.runPromise(
        auth.removePasskey("tenant-a", session.token, credential.credentialId),
      ),
    ).toBe(true);
    expect(memory.snapshot().passkeys).toHaveLength(0);
    expect(
      await Effect.runPromise(
        auth.removePasskey("tenant-a", session.token, credential.credentialId),
      ),
    ).toBe(false);
    expect(audit.map((event) => event.action)).toContain("passkey-rename");
    expect(audit.map((event) => event.action)).toContain("passkey-remove");
  });

  test("accepts packed self-attestation and rejects an untrusted origin", async () => {
    const packed = await makeCredential("packed-challenge", "packed");
    const verified = await Effect.runPromise(
      verifyPasskeyRegistration(
        config.passkey ?? { rpId: "", rpName: "", origins: [] },
        packed.registration,
      ),
    );
    expect(verified.algorithm).toBe("ES256");

    const client = clientData("webauthn.create", "packed-challenge", "https://evil.example.com");
    const tampered = {
      ...packed.registration,
      response: { ...packed.registration.response, clientDataJSON: client.encoded },
    };
    expect(
      await Effect.runPromise(
        Effect.flip(
          verifyPasskeyRegistration(
            config.passkey ?? { rpId: "", rpName: "", origins: [] },
            tampered,
          ),
        ),
      ),
    ).toBeInstanceOf(UnsupportedPasskey);
  });

  test("rejects trailing authenticator data when extensions are not declared", async () => {
    const malformed = await makeCredential("trailing-data-challenge", "none", Uint8Array.of(0));

    expect(
      await Effect.runPromise(
        Effect.flip(
          verifyPasskeyRegistration(
            config.passkey ?? { rpId: "", rpName: "", origins: [] },
            malformed.registration,
          ),
        ),
      ),
    ).toBeInstanceOf(UnsupportedPasskey);
  });

  test("imports RS256 and Ed25519 COSE credentials", async () => {
    const passkeyConfig = config.passkey ?? { rpId: "", rpName: "", origins: [] };
    const rsa = await Effect.runPromise(
      verifyPasskeyRegistration(passkeyConfig, await makeNoneRegistration("RS256")),
    );
    const ed25519 = await Effect.runPromise(
      verifyPasskeyRegistration(passkeyConfig, await makeNoneRegistration("Ed25519")),
    );

    expect(rsa.algorithm).toBe("RS256");
    expect(ed25519.algorithm).toBe("Ed25519");
  });
});
