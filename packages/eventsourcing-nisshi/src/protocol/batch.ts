import { crc32c, Reader, Writer } from "./primitives.js";

/** One record to produce: byte key (may be null) and byte value. */
export interface RecordToProduce {
  readonly key: Uint8Array | null;
  readonly value: Uint8Array;
}

/** One record read back: its absolute offset plus key and value bytes. */
export interface FetchedRecord {
  readonly offset: bigint;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array;
}

/**
 * Encodes one uncompressed message-format-v2 record batch. Offsets inside the
 * batch are `0..n-1` deltas; the broker assigns the base offset. The CRC
 * covers everything from attributes to the end of the batch.
 */
export const encodeRecordBatch = (records: ReadonlyArray<RecordToProduce>): Uint8Array => {
  if (records.length === 0) {
    throw new Error("kafka protocol: empty record batch");
  }
  const now = BigInt(Date.now());
  const encoded = new Writer();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) {
      continue;
    }
    const body = new Writer()
      .i8(0) // record attributes (unused, must be 0)
      .varint(0) // timestamp delta
      .varint(i); // offset delta
    if (record.key === null) {
      body.varint(-1);
    } else {
      body.varint(record.key.length).raw(record.key);
    }
    body.varint(record.value.length).raw(record.value).varint(0); // headers
    const bodyBytes = body.out();
    encoded.varint(bodyBytes.length).raw(bodyBytes);
  }

  const batchBody = new Writer()
    .i16(0) // attributes: no compression, no flags
    .i32(records.length - 1) // lastOffsetDelta
    .i64(now) // firstTimestamp
    .i64(now) // maxTimestamp
    .i64(-1) // producerId
    .i16(-1) // producerEpoch
    .i32(-1) // baseSequence
    .i32(records.length)
    .raw(encoded.out());
  const bodyBytes = batchBody.out();

  return new Writer()
    .i64(0) // baseOffset (assigned by the broker)
    .i32(4 + 1 + 4 + bodyBytes.length) // batchLength: from partitionLeaderEpoch on
    .i32(-1) // partitionLeaderEpoch
    .i8(2) // magic
    .i32(crc32c(bodyBytes))
    .raw(bodyBytes)
    .out();
};

/**
 * Decodes every record of one message-format-v2 batch starting at `buf[0]`,
 * projecting each record's absolute offset from the batch base offset.
 * Batches from Nisshi are always uncompressed; a compressed batch is an
 * error rather than a silent skip.
 */
export const decodeRecordBatch = (buf: Uint8Array): ReadonlyArray<FetchedRecord> => {
  if (buf.length === 0) {
    return []; // Nisshi encodes "no records" as a zero-length field
  }
  const r = new Reader(buf);
  const baseOffset = r.i64();
  r.i32(); // batchLength
  r.i32(); // partitionLeaderEpoch
  const magic = r.i8();
  if (magic !== 2) {
    throw new Error(`kafka protocol: unsupported record batch magic ${magic}`);
  }
  r.u32(); // crc
  const attributes = r.i16();
  if ((attributes & 0x07) !== 0) {
    throw new Error("kafka protocol: compressed record batches are not supported");
  }
  r.i32(); // lastOffsetDelta
  r.i64(); // firstTimestamp
  r.i64(); // maxTimestamp
  r.i64(); // producerId
  r.i16(); // producerEpoch
  r.i32(); // baseSequence
  const count = r.i32();
  const out: FetchedRecord[] = [];
  for (let i = 0; i < count; i++) {
    const bodyLength = r.varint();
    const end = r.pos + bodyLength;
    r.i8(); // attributes
    r.varint(); // timestamp delta
    const offsetDelta = r.varint();
    const keyLength = r.varint();
    const key = keyLength < 0 ? null : buf.subarray(r.pos, r.pos + keyLength);
    if (keyLength >= 0) {
      r.pos += keyLength;
    }
    const valueLength = r.varint();
    const value = buf.subarray(r.pos, r.pos + valueLength);
    r.pos += valueLength;
    const headers = r.varint();
    for (let h = 0; h < headers; h++) {
      const headerKeyLength = r.varint();
      r.pos += headerKeyLength;
      const headerValueLength = r.varint();
      if (headerValueLength >= 0) {
        r.pos += headerValueLength;
      }
    }
    out.push({ offset: baseOffset + BigInt(offsetDelta), key, value });
    r.pos = end;
  }
  return out;
};
