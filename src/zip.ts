/**
 * Reads one entry of a ZIP archive without a dependency. Garmin serves an activity file as a ZIP holding a single
 * .fit. The central directory is used (not the local headers) because writers that stream put the sizes in a trailing
 * data descriptor, so the local headers cannot be trusted for them.
 */
import { inflateRawSync } from "node:zlib";
import { GarminError } from "./errors.ts";

/** Upper bound on an entry once inflated: a FIT file of several hours is well under this, a zip bomb is not. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * @param zip   the archive bytes
 * @param match picks the entry by its name (default: the first entry ending in `.fit`, case-insensitive)
 * @throws GarminError when the archive is malformed, has no matching entry, or the entry is too large
 */
export function readZipEntry(zip: Uint8Array, match: (name: string) => boolean = (name) => /\.fit$/i.test(name)): Uint8Array {
  const fail = (why: string) => new GarminError("error", `Unreadable archive: ${why}.`);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail("no end-of-archive record");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > zip.length || view.getUint32(pos, true) !== 0x02014b50) throw fail("bad central directory");
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;
    if (!match(name)) continue;
    if (size > MAX_ENTRY_BYTES) throw fail("entry too large");
    if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) throw fail("bad local header");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > zip.length) throw fail("truncated entry");
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    throw fail(`unsupported compression method ${method}`);
  }
  throw fail("no matching entry");
}
