/** JSON text for storage; `undefined` collapses to `null`. */
export const jsonText = (value: unknown): string => JSON.stringify(value ?? null);

/** Numeric column value as a `number` (`MAX(...)` of an empty table is null). */
export const toNumber = (value: number | bigint | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/** Numeric column value as a `bigint` (pg returns BIGINT columns as strings). */
export const toBigInt = (value: number | bigint | string): bigint =>
  typeof value === "bigint" ? value : BigInt(value);

/**
 * Splits a stream name into the conflict's entity/id at the first `-`,
 * mirroring the in-memory event store (stream categories must not
 * contain `-`; see `EventStoreService.append`).
 */
export const conflictIdentity = (streamName: string): { entity: string; id: string } => {
  const separator = streamName.indexOf("-");
  return separator === -1
    ? { entity: streamName, id: streamName }
    : { entity: streamName.slice(0, separator), id: streamName.slice(separator + 1) };
};
