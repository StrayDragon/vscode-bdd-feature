import { open, stat } from 'node:fs/promises';

/** Default head size — step imports/decorators almost always appear early. */
export const READ_HEAD_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` from a file. Returns whether the entire file was read.
 * Memory: single buffer, no string until decode.
 */
export async function readFileHead(
  absPath: string,
  maxBytes = READ_HEAD_BYTES,
): Promise<{ text: string; complete: boolean }> {
  const st = await stat(absPath);
  const toRead = Math.min(st.size, maxBytes);
  const buf = Buffer.allocUnsafe(toRead);
  const fh = await open(absPath, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const complete = bytesRead >= st.size;
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return { text, complete };
  } finally {
    await fh.close();
  }
}

export async function readFileHeadOrFull(
  absPath: string,
  mightContain: (chunk: string) => boolean,
  maxHead = READ_HEAD_BYTES,
): Promise<string> {
  const head = await readFileHead(absPath, maxHead);
  if (head.complete) {
    return head.text;
  }
  // Negative fingerprint on the head — skip reading the tail (large generated files).
  if (!mightContain(head.text)) {
    return head.text;
  }
  const fh = await open(absPath, 'r');
  try {
    const st = await stat(absPath);
    const buf = Buffer.allocUnsafe(st.size);
    await fh.read(buf, 0, st.size, 0);
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text;
  } finally {
    await fh.close();
  }
}
