import { Metadata as NativeMetadata } from "@grpc/grpc-js";

export type MetadataValue = string | Uint8Array;
/** Owns copies of binary values. Use `-bin` keys for binary metadata. */
export class Metadata {
  private readonly native: NativeMetadata;
  constructor(values: Readonly<Record<string, MetadataValue | ReadonlyArray<MetadataValue>>> = {}) {
    this.native = new NativeMetadata();
    for (const [key, value] of Object.entries(values)) {
      for (const entry of typeof value === "string" || value instanceof Uint8Array
        ? [value]
        : value) {
        this.native.add(key, typeof entry === "string" ? entry : Buffer.from(entry));
      }
    }
  }
  static fromNative(value: NativeMetadata): Metadata {
    const result = new Metadata();
    for (const key of Object.keys(value.getMap())) {
      for (const entry of value.get(key))
        result.native.add(key, typeof entry === "string" ? entry : Buffer.from(entry));
    }
    return result;
  }
  get(key: string): ReadonlyArray<string | Buffer> {
    return this.native.get(key).map((v) => (typeof v === "string" ? v : Buffer.from(v)));
  }
  text(key: string): string | undefined {
    const value = this.get(key)[0];
    return typeof value === "string" ? value : undefined;
  }
  /** Internal transport conversion; callers receive an independent copy. */
  toNative(): NativeMetadata {
    return this.native.clone();
  }
}
export const safeId = (value: string | undefined): string | undefined =>
  value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
