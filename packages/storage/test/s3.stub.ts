import * as http from "node:http";
import type { AddressInfo } from "node:net";

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
  readonly close: () => Promise<void>;
}

/**
 * A minimal S3-compatible stub over loopback HTTP for offline driver tests:
 * PUT/GET/HEAD/DELETE objects, multipart initiate/part/complete, and LIST
 * (v2, prefix only). Rejects unsigned requests with 401 so tests prove the
 * driver signs everything it sends.
 */
export const startS3Stub = async (): Promise<S3StubServer> => {
  const objects = new Map<string, StoredStub>();
  const partUploads = new Map<string, Array<Uint8Array>>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const requests: Array<{ method: string; path: string; signed: boolean }> = [];

  const readBody = async (request: http.IncomingMessage): Promise<Uint8Array> => {
    const chunks: Array<Uint8Array> = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
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
    const url = new URL(request.url ?? "/", "http://stub.local");
    const method = request.method ?? "GET";
    const signed = (request.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256");
    requests.push({ method, path: url.pathname, signed });
    if (!signed) {
      response.writeHead(401, { "content-type": "application/xml" });
      response.end("<Error><Code>AccessDenied</Code></Error>");
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
