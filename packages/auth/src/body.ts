/** Reads a Web stream while enforcing a byte limit before buffering the full payload. */
export const readBoundedText = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> => {
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("body exceeds configured limit");
        throw new Error("body exceeds configured limit");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};
