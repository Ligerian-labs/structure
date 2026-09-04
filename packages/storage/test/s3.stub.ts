import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Redacted } from "effect";
import { signRequest } from "../src/sigv4.js";

interface StoredStub {
  bytes: Uint8Array;
  contentType: string;
  disposition: string;
  metadata: Record<string, string>;
  etag: string;
  lastModified: Date;
}

export interface S3StubServer {
  readonly url: string;
  readonly objects: Map<string, StoredStub>;
  readonly partUploads: Map<string, Array<Uint8Array>>;
  readonly requests: Array<{ method: string; path: string; signed: boolean }>;
  /** Signed requests whose signature did not verify; `path` is the target as received. */
  readonly unverified: Array<{ method: string; path: string }>;
  readonly close: () => Promise<void>;
}

export interface S3StubOptions {
  /** Credentials the stub verifies signatures against. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
}

export const STUB_ACCESS_KEY_ID = "test-access-key";
export const STUB_SECRET_ACCESS_KEY = "test-secret-key";

const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u;
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$/u;

/**
 * A minimal S3-compatible stub over loopback HTTP for offline driver tests:
 * PUT/GET/HEAD/DELETE objects, multipart initiate/part/complete, and LIST
 * (v2, prefix only). Rejects unsigned requests with 401 so tests prove the
 * driver signs everything it sends, and verifies every SigV4 signature the
 * way a real store does — over the path with repeated slashes collapsed —
 * answering a MinIO-shaped 403 `SignatureDoesNotMatch` when the signature
 * covers a different path than the one the store canonicalises to.
 */
export const startS3Stub = async (options: S3StubOptions = {}): Promise<S3StubServer> => {
  const objects = new Map<string, StoredStub>();
  const partUploads = new Map<string, Array<Uint8Array>>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const unverified: Array<{ method: string; path: string }> = [];
  const requests: Array<{ method: string; path: string; signed: boolean }> = [];

  const readBody = async (request: http.IncomingMessage): Promise<Uint8Array> => {
    const chunks: Array<Uint8Array> = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };

  const accessKeyId = options.accessKeyId ?? STUB_ACCESS_KEY_ID;
  const secretAccessKey = Redacted.make(options.secretAccessKey ?? STUB_SECRET_ACCESS_KEY);

  /**
   * Recomputes the `Authorization` header the client should have sent for
   * the canonical path, from the signed headers it named; `undefined` when
   * the header is malformed, names an unknown key, or a signed header is
   * missing from the request.
   */
  const expectedAuthorization = (
    request: http.IncomingMessage,
    method: string,
    canonicalPath: string,
    search: string,
  ): string | undefined => {
    const match = AUTHORIZATION.exec(request.headers.authorization ?? "");
    const amzDate = request.headers["x-amz-date"];
    const payloadHash = request.headers["x-amz-content-sha256"];
    const host = request.headers.host;
    if (
      match === null ||
      typeof amzDate !== "string" ||
      typeof payloadHash !== "string" ||
      host === undefined
    ) {
      return undefined;
    }
    const [, keyId, region, service, signedHeaders] = match;
    if (keyId !== accessKeyId || signedHeaders === undefined) return undefined;
    const date = AMZ_DATE.exec(amzDate);
    if (date === null) return undefined;
    const now = new Date(`${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}.000Z`);
    const headers: Record<string, string> = {};
    for (const name of signedHeaders.split(";")) {
      if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
      const value = request.headers[name];
      if (typeof value !== "string") return undefined;
      headers[name] = value;
    }
    return signRequest({
      credentials: { accessKeyId, secretAccessKey, region: region ?? "", service: service ?? "" },
      method,
      url: new URL(`http://${host}${canonicalPath}${search}`),
      headers,
      payloadHash,
      now,
    }).headers.authorization;
  };

  const listXml = (prefix: string): string => {
    const contents = [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, object]) =>
          `<Contents><Key>${key}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>"${object.etag}"</ETag><Size>${object.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${contents}</ListBucketResult>`;
  };

  const server = http.createServer(async (request, response) => {
    const target = request.url ?? "/";
    const queryAt = target.indexOf("?");
    const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
    const search = queryAt === -1 ? "" : target.slice(queryAt);
    // A real store (MinIO, S3) routes on the path with repeated slashes
    // collapsed and verifies the signature over that canonical path, so a
    // client that signed `//bucket/key` disagrees with it.
    const canonicalPath = rawPath.replace(/\/{2,}/gu, "/");
    const url = new URL(`${canonicalPath}${search}`, "http://stub.local");
    const method = request.method ?? "GET";
    const signed = (request.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256");
    requests.push({ method, path: rawPath, signed });
    if (!signed) {
      response.writeHead(401, { "content-type": "application/xml" });
      response.end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    if (
      expectedAuthorization(request, method, canonicalPath, search) !==
      request.headers.authorization
    ) {
      unverified.push({ method, path: rawPath });
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided. Check your key and signing method.</Message><Resource>${decodeURIComponent(canonicalPath)}</Resource></Error>`,
      );
      return;
    }
    const pathName = decodeURIComponent(url.pathname);
    // Bucket-level list: /bucket?list-type=2&prefix=...
    const bucketMatch = /^\/([^/]+)$/u.exec(pathName);
    if (method === "GET" && bucketMatch !== null && url.searchParams.get("list-type") === "2") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(listXml(url.searchParams.get("prefix") ?? ""));
      return;
    }
    const objectMatch = /^\/[^/]+\/(.*)$/u.exec(pathName);
    const key = objectMatch?.[1] ?? "";
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = url.searchParams.get("partNumber");
    const wantsUploads = url.searchParams.has("uploads");
    const metaFromRequest = (bytes: Uint8Array): StoredStub => ({
      bytes,
      contentType: request.headers["content-type"] ?? "application/octet-stream",
      disposition:
        (request.headers["x-amz-meta-disposition"] as string | undefined) ?? "attachment",
      metadata: Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => name.startsWith("x-amz-meta-") && name !== "x-amz-meta-disposition")
          .map(([name, value]) => [name.slice("x-amz-meta-".length), String(value)]),
      ),
      etag: crypto.randomUUID(),
      lastModified: new Date(),
    });

    if (method === "PUT" && uploadId === null) {
      const body = await readBody(request);
      objects.set(key, metaFromRequest(body));
      response.writeHead(200, { etag: objects.get(key)?.etag ?? "etag" });
      response.end();
      return;
    }
    if (method === "POST" && wantsUploads) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, parts: new Map() });
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<InitiateMultipartUploadResult><Bucket>stub</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (method === "PUT" && uploadId !== null && partNumber !== null) {
      const body = await readBody(request);
      const session = uploads.get(uploadId);
      if (session === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      session.parts.set(Number(partNumber), body);
      const recorded = partUploads.get(uploadId) ?? [];
      recorded.push(body);
      partUploads.set(uploadId, recorded);
      response.writeHead(200, { etag: `part-${partNumber}` });
      response.end();
      return;
    }
    if (method === "POST" && uploadId !== null) {
      const session = uploads.get(uploadId);
      if (session === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      const completeBody = await readBody(request);
      const count = (new TextDecoder().decode(completeBody).match(/<Part>/gu) ?? []).length;
      const assembled = new Array(count)
        .fill(0)
        .flatMap((_, index) => session.parts.get(index + 1) ?? []);
      const merged = new Uint8Array(assembled.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of assembled) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      objects.set(session.key, metaFromRequest(merged));
      uploads.delete(uploadId);
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<CompleteMultipartUploadResult><Bucket>stub</Bucket><Key>${session.key}</Key><ETag>final</ETag></CompleteMultipartUploadResult>`,
      );
      return;
    }
    if (method === "GET" || method === "HEAD") {
      const object = objects.get(key);
      if (object === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      const headers: Record<string, string | number> = {
        "content-type": object.contentType,
        "content-length": object.bytes.byteLength,
        etag: object.etag,
        "last-modified": object.lastModified.toUTCString(),
        "x-amz-meta-disposition": object.disposition,
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      if (method === "HEAD") {
        response.end();
        return;
      }
      response.end(object.bytes);
      return;
    }
    if (method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(400);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    objects,
    partUploads,
    requests,
    unverified,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
