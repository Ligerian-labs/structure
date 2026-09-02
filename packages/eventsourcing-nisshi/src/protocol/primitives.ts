/**
 * Kafka wire-protocol primitives: big-endian writer/reader, zigzag varints,
 * and CRC32-Castagnoli. The record-batch format and request/response framing
 * are layered on top (see `batch.ts` and `connection.ts`).
 *
 * Length fields inside record batches are *signed* zigzag varints per the
 * Kafka message-format-v2 spec (`null` is -1); arrays on the request/response
 * level are int32-counted. Verified against Nisshi v0.7.0-pre.2.
 */

/** Appends big-endian and varint fields; call `out()` once at the end. */
export class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  /** One byte. */
  i8(value: number): this {
    this.push(new Uint8Array([value & 0xff]));
    return this;
  }

  i16(value: number): this {
    const b = new Uint8Array(2);
    b[0] = (value >> 8) & 0xff;
    b[1] = value & 0xff;
    this.push(b);
    return this;
  }

  i32(value: number): this {
    const b = new Uint8Array(4);
    const v = value >>> 0;
    b[0] = (v >>> 24) & 0xff;
    b[1] = (v >>> 16) & 0xff;
    b[2] = (v >>> 8) & 0xff;
    b[3] = v & 0xff;
    this.push(b);
    return this;
  }

  i64(value: bigint | number): this {
    let v = BigInt(value);
    const b = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.push(b);
    return this;
  }

  /** int32-length-prefixed raw bytes (request/response level). */
  bytes(value: Uint8Array): this {
    this.i32(value.length);
    this.push(value);
    return this;
  }

  /** int16-length-prefixed string; `null` becomes -1. */
  str(value: string | null): this {
    if (value === null) {
      return this.i16(-1);
    }
    const b = new TextEncoder().encode(value);
    this.i16(b.length);
    this.push(b);
    return this;
  }

  raw(value: Uint8Array): this {
    this.push(value);
    return this;
  }

  /** Unsigned protobuf varint (used only inside zigzag encoding). */
  uvarint(value: number): this {
    let v = value;
    for (;;) {
      let byte = v & 0x7f;
      v = Math.floor(v / 128);
      if (v !== 0) {
        byte |= 0x80;
      }
      this.push(new Uint8Array([byte]));
      if (v === 0) {
        return this;
      }
    }
  }

  /** Signed zigzag varint (record-batch lengths, deltas; `null` is -1). */
  varint(value: number): this {
    return this.uvarint((value << 1) ^ (value >> 31));
  }

  out(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Reads big-endian and varint fields sequentially over one response body. */
export class Reader {
  /** Byte cursor — public for `batch.ts` record parsing. */
  public pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  private need(count: number): void {
    if (this.pos + count > this.buf.length) {
      throw new Error(
        `kafka protocol: truncated response (need ${count} bytes at ${this.pos}, have ${this.buf.length - this.pos})`,
      );
    }
  }

  /** Indexed byte access that refuses to silently yield `undefined`. */
  private at(index: number): number {
    const byte = this.buf[index];
    if (byte === undefined) {
      throw new Error(`kafka protocol: byte read at ${index} out of bounds`);
    }
    return byte;
  }

  i8(): number {
    this.need(1);
    const v = this.at(this.pos);
    this.pos += 1;
    return v >= 128 ? v - 256 : v;
  }

  i16(): number {
    this.need(2);
    const v = (this.at(this.pos) << 8) | this.at(this.pos + 1);
    this.pos += 2;
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  u16(): number {
    this.need(2);
    const v = (this.at(this.pos) << 8) | this.at(this.pos + 1);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v =
      ((this.at(this.pos) << 24) |
        (this.at(this.pos + 1) << 16) |
        (this.at(this.pos + 2) << 8) |
        this.at(this.pos + 3)) >>>
      0;
    this.pos += 4;
    return v | 0;
  }

  i64(): bigint {
    this.need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v = (v << 8n) | BigInt(this.at(this.pos + i));
    }
    this.pos += 8;
    return BigInt.asIntN(64, v);
  }

  u32(): number {
    this.need(4);
    const v = this.i32();
    return v >>> 0;
  }

  str(): string | null {
    const len = this.i16();
    if (len < 0) {
      return null;
    }
    this.need(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  /** int32-length-prefixed bytes; `null` length yields null. */
  bytes(): Uint8Array | null {
    const len = this.i32();
    if (len < 0) {
      return null;
    }
    this.need(len);
    const b = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  uvarint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      this.need(1);
      const byte = this.at(this.pos);
      this.pos += 1;
      v |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return v >>> 0;
      }
      shift += 7;
      if (shift > 31) {
        throw new Error("kafka protocol: varint overflow");
      }
    }
  }

  varint(): number {
    const v = this.uvarint();
    return (v >>> 1) ^ -(v & 1);
  }
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC32-Castagnoli over `value` (record-batch v2 integrity field). */
export const crc32c = (value: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of value) {
    c = (CRC32C_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
