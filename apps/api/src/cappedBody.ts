/**
 * A response body read chunk by chunk and abandoned past `maxBytes`, so an
 * upstream that streams without end cannot fill the API's memory: the
 * runner's answers, an organization's avatar. Null past the cap; an empty
 * buffer for a response without a body.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}
