import { type ChannelCredentials, credentials, ServerCredentials } from "@grpc/grpc-js";
import { Effect, Redacted } from "effect";
import { GrpcConfigError } from "./errors.js";
export type Security =
  | { readonly mode: "insecure" }
  | {
      readonly mode: "tls";
      readonly ca?: Uint8Array;
      /** Client TLS identity when connecting to an IP address. Certificate verification stays enabled. */
      readonly serverName?: string;
      readonly certificate?: Uint8Array;
      readonly privateKey?: Redacted.Redacted<Uint8Array>;
      /** Server only. Requires a CA. */
      readonly requireClientCertificate?: boolean;
    };
export interface TransportOptions {
  readonly address: string;
  readonly security: Security;
  readonly maxReceiveBytes?: number;
  readonly maxSendBytes?: number;
  /** Client response queue capacity, in messages. Default: 16. Transport windows are separate. */
  readonly bufferSize?: number;
}
export const limits = (options: TransportOptions) => ({
  receive: options.maxReceiveBytes ?? 4 * 1024 * 1024,
  send: options.maxSendBytes ?? 4 * 1024 * 1024,
  buffer: options.bufferSize ?? 16,
});
export const validate = (
  options: TransportOptions,
  server: boolean,
  graceMs = 1000,
): Effect.Effect<void, GrpcConfigError> =>
  Effect.suspend(() => {
    const violations: string[] = [];
    if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):\d+$/.test(options.address))
      violations.push("address must be host:port");
    const port = Number(options.address.slice(options.address.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < (server ? 0 : 1) || port > 65535)
      violations.push("port is outside its valid range");
    for (const [key, value] of Object.entries(limits(options))) {
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > (key === "buffer" ? 65536 : 64 * 1024 * 1024)
      )
        violations.push(`${key} must be a bounded positive integer`);
    }
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 60000)
      violations.push("graceMs must be between 0 and 60000");
    const sec = options.security;
    if (sec?.mode !== "insecure" && sec?.mode !== "tls")
      violations.push("security must explicitly select tls or insecure");
    if (sec?.mode === "tls") {
      if (sec.serverName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(sec.serverName))
        violations.push("serverName must be a DNS name");
      if (server && (sec.certificate === undefined || sec.privateKey === undefined))
        violations.push("server TLS requires certificate and privateKey");
      if ((sec.certificate === undefined) !== (sec.privateKey === undefined))
        violations.push("certificate and privateKey must be configured together");
      if (sec.requireClientCertificate && sec.ca === undefined)
        violations.push("client certificate verification requires a CA");
    }
    return violations.length === 0 ? Effect.void : Effect.fail(new GrpcConfigError({ violations }));
  });
export const serverCredentials = (security: Security): ServerCredentials => {
  if (security.mode === "insecure") return ServerCredentials.createInsecure();
  if (security.certificate === undefined || security.privateKey === undefined)
    throw new Error("Invalid TLS configuration");
  return ServerCredentials.createSsl(
    security.ca === undefined ? null : Buffer.from(security.ca),
    [
      {
        cert_chain: Buffer.from(security.certificate),
        private_key: Buffer.from(Redacted.value(security.privateKey)),
      },
    ],
    security.requireClientCertificate ?? false,
  );
};
export const clientCredentials = (security: Security): ChannelCredentials =>
  security.mode === "insecure"
    ? credentials.createInsecure()
    : credentials.createSsl(
        security.ca === undefined ? undefined : Buffer.from(security.ca),
        security.privateKey === undefined
          ? undefined
          : Buffer.from(Redacted.value(security.privateKey)),
        security.certificate === undefined ? undefined : Buffer.from(security.certificate),
      );
