/**
 * ULID generation and `bigint` mapping for event positions.
 *
 * A ULID is 128 bits: a 48-bit millisecond timestamp plus 80 bits of
 * randomness, rendered as 26 Crockford-base32 characters that sort
 * lexicographically in generation order (within a process, monotonically).
 * Positions are therefore *approximately* globally ordered — per-stream
 * order stays exact via stream versions (ADR-0015).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const encodeTime = (now: number, length: number): string => {
  let mod: number;
  let out = "";
  let time = now;
  for (let i = 0; i < length; i += 1) {
    mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
};

const encodeRandom = (length: number): string => {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const [byte] = randomBytes(1);
    out += ENCODING[(byte ?? 0) % 32] ?? "0";
  }
  return out;
};

/** Last ULID emitted by this process, for same-millisecond monotonicity. */
let lastUlid = "";

/**
 * Generates a ULID. Within one process, ULIDs generated in the same
 * millisecond are monotonically increasing (randomness incremented).
 */
export const ulid = (): string => {
  const now = Date.now();
  let candidate = `${encodeTime(now, TIME_LEN)}${encodeRandom(RANDOM_LEN)}`;
  if (candidate <= lastUlid && candidate.slice(0, TIME_LEN) === lastUlid.slice(0, TIME_LEN)) {
    candidate = incrementBase32(lastUlid);
  }
  lastUlid = candidate;
  return candidate;
};

const incrementBase32 = (value: string): string => {
  const chars = value.split("");
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const index = ENCODING.indexOf(chars[i] ?? "");
    if (index >= 0 && index < 31) {
      chars[i] = ENCODING[index + 1] ?? ENCODING[0] ?? "0";
      return chars.join("");
    }
    chars[i] = ENCODING[0] ?? "0";
  }
  // All-random overflow within the same millisecond: bump the timestamp by 1ms.
  return `${encodeTime(Date.now() + 1, TIME_LEN)}${encodeRandom(RANDOM_LEN)}`;
};

const decodeBase32 = (value: string): bigint => {
  let out = 0n;
  for (const char of value) {
    const index = ENCODING.indexOf(char);
    if (index === -1) {
      throw new Error(`invalid ULID character "${char}"`);
    }
    out = out * 32n + BigInt(index);
  }
  return out;
};

/** Maps a ULID string to the `bigint` position the port exposes. */
export const ulidToPosition = (value: string): bigint => decodeBase32(value);

/** Maps a `bigint` position back to its ULID string (zero-padded to 26). */
export const positionToUlid = (position: bigint): string => {
  let remaining = position;
  let out = "";
  for (let i = 0; i < TIME_LEN + RANDOM_LEN; i += 1) {
    const mod = Number(remaining % 32n);
    out = ENCODING[mod] + out;
    remaining = remaining / 32n;
  }
  return out;
};
