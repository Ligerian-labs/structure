export type CborValue =
  | boolean
  | bigint
  | null
  | number
  | string
  | Uint8Array
  | ReadonlyArray<CborValue>
  | ReadonlyMap<CborValue, CborValue>;

export interface DecodedCbor {
  readonly value: CborValue;
  readonly offset: number;
}

const lengthAt = (
  bytes: Uint8Array,
  additional: number,
  offset: number,
): { readonly length: number; readonly offset: number } => {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) {
    const value = bytes[offset];
    if (value === undefined) throw new Error("truncated cbor length");
    return { length: value, offset: offset + 1 };
  }
  if (additional === 25) {
    if (offset + 2 > bytes.length) throw new Error("truncated cbor length");
    return {
      length: new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0),
      offset: offset + 2,
    };
  }
  if (additional === 26) {
    if (offset + 4 > bytes.length) throw new Error("truncated cbor length");
    return {
      length: new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0),
      offset: offset + 4,
    };
  }
  if (additional === 27) {
    if (offset + 8 > bytes.length) throw new Error("truncated cbor length");
    const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("cbor length exceeds safe integer");
    return { length: Number(value), offset: offset + 8 };
  }
  throw new Error("indefinite or reserved cbor lengths are unsupported");
};

export const decodeCbor = (bytes: Uint8Array, start = 0, depth = 0): DecodedCbor => {
  if (depth > 32) throw new Error("cbor nesting limit exceeded");
  const initial = bytes[start];
  if (initial === undefined) throw new Error("truncated cbor value");
  const major = initial >> 5;
  const additional = initial & 31;
  const length = lengthAt(bytes, additional, start + 1);

  if (major === 0) return { value: length.length, offset: length.offset };
  if (major === 1) return { value: -1 - length.length, offset: length.offset };
  if (major === 2 || major === 3) {
    const end = length.offset + length.length;
    if (end > bytes.length) throw new Error("truncated cbor bytes");
    const value = bytes.slice(length.offset, end);
    return {
      value: major === 2 ? value : new TextDecoder("utf-8", { fatal: true }).decode(value),
      offset: end,
    };
  }
  if (major === 4) {
    const values: Array<CborValue> = [];
    let offset = length.offset;
    for (let index = 0; index < length.length; index += 1) {
      const decoded = decodeCbor(bytes, offset, depth + 1);
      values.push(decoded.value);
      offset = decoded.offset;
    }
    return { value: values, offset };
  }
  if (major === 5) {
    const values = new Map<CborValue, CborValue>();
    let offset = length.offset;
    for (let index = 0; index < length.length; index += 1) {
      const key = decodeCbor(bytes, offset, depth + 1);
      const value = decodeCbor(bytes, key.offset, depth + 1);
      if (values.has(key.value)) throw new Error("duplicate cbor map key");
      values.set(key.value, value.value);
      offset = value.offset;
    }
    return { value: values, offset };
  }
  if (major === 6) return decodeCbor(bytes, length.offset, depth + 1);
  if (major === 7) {
    if (additional === 20) return { value: false, offset: start + 1 };
    if (additional === 21) return { value: true, offset: start + 1 };
    if (additional === 22) return { value: null, offset: start + 1 };
  }
  throw new Error("unsupported cbor value");
};
