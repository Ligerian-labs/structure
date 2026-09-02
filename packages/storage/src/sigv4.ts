import { createHash, createHmac } from "node:crypto";
import { Redacted } from "effect";

/** Credentials for AWS Signature Version 4 request signing. */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly region: string;
  readonly service: string;
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

const signingKey = (
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");

const hex = (byte: number): string => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;

/** RFC 3986 percent-encoding; `/` kept when `encodeSlash` is false. */
export const uriEncode = (value: string, encodeSlash = true): string => {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9-._~]/u.test(character)) {
      out += character;
    } else if (byte === 0x2f && !encodeSlash) {
      out += "/";
    } else {
      out += hex(byte);
    }
  }
  return out;
};

const canonicalUri = (pathName: string): string =>
  pathName
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment), false))
    .join("/");

const canonicalQuery = (search: string): string => {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of new URLSearchParams(search).entries()) {
    pairs.push([uriEncode(key), uriEncode(value)]);
  }
  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
};

const canonicalHeaders = (
  headers: Readonly<Record<string, string>>,
): { readonly canonical: string; readonly signed: string } => {
  const lowered = Object.entries(headers)
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    canonical: lowered.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: lowered.map(([name]) => name).join(";"),
  };
};

/** Bodies this package signs: fixed bytes or a pre-rendered string. */
export type RequestBody = Uint8Array | string;

export interface SignedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: RequestBody;
}

/**
 * Signs one request with AWS Signature Version 4. `payloadHash` is the
 * hex-encoded SHA-256 of the body, or the literal `UNSIGNED-PAYLOAD` for
 * streamed bodies. Returns the request with `Authorization`, `x-amz-date`,
 * and `x-amz-content-sha256` set.
 */
export const signRequest = (options: {
  readonly credentials: SigV4Credentials;
  readonly method: string;
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly body?: RequestBody;
  readonly now?: Date;
}): SignedRequest => {
  const now = options.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: options.url.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
    ...(options.headers ?? {}),
  };
  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    options.method,
    canonicalUri(options.url.pathname),
    canonicalQuery(options.url.search),
    canonical,
    signed,
    options.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${options.credentials.region}/${options.credentials.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(
    Redacted.value(options.credentials.secretAccessKey),
    dateStamp,
    options.credentials.region,
    options.credentials.service,
  );
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return {
    url: options.url.toString(),
    method: options.method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  };
};
