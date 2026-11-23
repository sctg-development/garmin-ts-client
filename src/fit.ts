/**
 * Minimal, dependency-free FIT decoder in strict TypeScript.
 *
 * Adapted from the FIT parser of the CFD MV track joiner (Ronan LE MEILLAT, MIT), itself adapted from
 * jimmykane/fit-parser (MIT). It keeps their binary handling (definition and data messages, compressed timestamps,
 * base types, the CRC) but drops what an activity analysis does not need: the 160 KB message profile, callbacks and
 * unit conversion. Only the few fields of the `record` and `session` messages that this package reads are decoded;
 * every other message and field is skipped by its declared size, so an unknown or new field never breaks decoding.
 *
 * Differences from the original worth knowing:
 *  - the file CRC is verified. It covers the whole file from byte 0, header included; the original started after the
 *    header for 14-byte headers, which is why its check never matched and had to be disabled;
 *  - the header CRC is verified only when present (a value of 0 means "not computed" in the FIT specification);
 *  - truncated or corrupt data throws a `GarminError` instead of returning partial results.
 */
import { GarminError } from "./errors.ts";

/** FIT timestamps count seconds from 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

/** CRC-16 of `bytes[start, end)`, as defined by the FIT SDK. */
export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] as number;
    let tmp = CRC_TABLE[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (CRC_TABLE[byte & 0xf] as number);
    tmp = CRC_TABLE[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (CRC_TABLE[(byte >> 4) & 0xf] as number);
  }
  return crc;
}

/** Size in bytes of each FIT base type (the low 5 bits of the base type byte). */
const TYPE_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8 };

/** One sample of the `record` message. Fields the device did not write (or marked invalid) are null. */
export type FitRecord = {
  /** Unix time in milliseconds. */
  timeMs: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Altitude in metres (the enhanced field when present, which has a finer resolution). */
  altitudeM: number | null;
  distanceM: number | null;
  speedMs: number | null;
  heartRate: number | null;
};

/** The few `session` fields the analysis uses, for cross-checking a computed descent against the device's own. */
export type FitSession = { totalAscentM: number | null; totalDescentM: number | null; totalDistanceM: number | null; sport: number | null };

export type FitFile = { records: FitRecord[]; sessions: FitSession[] };

type FieldDef = { num: number; size: number; type: number };
type Definition = { littleEndian: boolean; globalNum: number; fields: FieldDef[]; devSize: number };

const MESG_RECORD = 20;
const MESG_SESSION = 18;

/** Reads one unsigned or signed integer of 1, 2 or 4 bytes; null when it equals the type's "invalid" marker. */
function readNumber(view: DataView, offset: number, def: FieldDef, littleEndian: boolean): number | null {
  const type = def.type & 0x1f;
  if (TYPE_SIZE[type] !== def.size) return null; // an array or an odd size: not a scalar we read
  switch (type) {
    case 0:
    case 2:
    case 10: {
      const v = view.getUint8(offset);
      return v === (type === 10 ? 0 : 0xff) ? null : v;
    }
    case 1: {
      const v = view.getInt8(offset);
      return v === 0x7f ? null : v;
    }
    case 3: {
      const v = view.getInt16(offset, littleEndian);
      return v === 0x7fff ? null : v;
    }
    case 4:
    case 11: {
      const v = view.getUint16(offset, littleEndian);
      return v === (type === 11 ? 0 : 0xffff) ? null : v;
    }
    case 5: {
      const v = view.getInt32(offset, littleEndian);
      return v === 0x7fffffff ? null : v;
    }
    case 6:
    case 12: {
      const v = view.getUint32(offset, littleEndian);
      return v === (type === 12 ? 0 : 0xffffffff) ? null : v;
    }
    default:
      return null;
  }
}

const SEMICIRCLE = 180 / 2 ** 31;

/**
 * Decodes the records and sessions of a FIT file.
 *
 * @param bytes  the raw .fit file
 * @param options.verifyCrc  check the header and file CRC (default true); false only for files known to be damaged
 * @throws GarminError when the file is not FIT, is truncated, or fails its CRC
 */
export function decodeFit(bytes: Uint8Array, options: { verifyCrc?: boolean } = {}): FitFile {
  const fail = (why: string) => new GarminError("error", `Not a readable FIT file: ${why}.`);
  if (bytes.length < 14) throw fail("too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = bytes[0] as number;
  if (headerSize !== 12 && headerSize !== 14) throw fail("unexpected header size");
  if (String.fromCharCode(bytes[8] as number, bytes[9] as number, bytes[10] as number, bytes[11] as number) !== ".FIT") throw fail("missing .FIT signature");
  const dataSize = view.getUint32(4, true);
  const end = headerSize + dataSize;
  if (end + 2 > bytes.length) throw fail("truncated");
  if (options.verifyCrc !== false) {
    const headerCrc = headerSize === 14 ? view.getUint16(12, true) : 0;
    if (headerCrc !== 0 && headerCrc !== fitCrc(bytes, 0, 12)) throw fail("header CRC mismatch");
    if (view.getUint16(end, true) !== fitCrc(bytes, 0, end)) throw fail("file CRC mismatch");
  }

  const definitions = new Map<number, Definition>();
  const records: FitRecord[] = [];
  const sessions: FitSession[] = [];
  let lastTimestamp = 0; // FIT seconds, for compressed timestamp headers
  let pos = headerSize;

  while (pos < end) {
    const header = bytes[pos] as number;
    pos += 1;
    let localType: number;
    let compressedOffset: number | null = null;
    if (header & 0x80) {
      localType = (header >> 5) & 0x03;
      compressedOffset = header & 0x1f;
    } else if (header & 0x40) {
      // Definition message.
      localType = header & 0x0f;
      const hasDeveloper = (header & 0x20) !== 0;
      if (pos + 5 > end) throw fail("truncated definition");
      const littleEndian = bytes[pos + 1] === 0;
      const globalNum = view.getUint16(pos + 2, littleEndian);
      const count = bytes[pos + 4] as number;
      pos += 5;
      if (pos + count * 3 > end) throw fail("truncated definition");
      const fields: FieldDef[] = [];
      for (let i = 0; i < count; i += 1) fields.push({ num: bytes[pos + i * 3] as number, size: bytes[pos + i * 3 + 1] as number, type: bytes[pos + i * 3 + 2] as number });
      pos += count * 3;
      let devSize = 0;
      if (hasDeveloper) {
        const devCount = bytes[pos] as number;
        pos += 1;
        if (pos + devCount * 3 > end) throw fail("truncated definition");
        for (let i = 0; i < devCount; i += 1) devSize += bytes[pos + i * 3 + 1] as number;
        pos += devCount * 3;
      }
      definitions.set(localType, { littleEndian, globalNum, fields, devSize });
      continue;
    } else {
      localType = header & 0x0f;
    }

    const def = definitions.get(localType);
    if (!def) throw fail("data message without a definition");
    const messageStart = pos;
    const size = def.fields.reduce((sum, field) => sum + field.size, 0) + def.devSize;
    if (pos + size > end) throw fail("truncated message");
    // Every message may carry the full timestamp (field 253) that later compressed headers are relative to.
    let hadStamp = false;
    {
      let at = messageStart;
      for (const field of def.fields) {
        if (field.num === 253) {
          const v = readNumber(view, at, field, def.littleEndian);
          if (v !== null) {
            lastTimestamp = v;
            hadStamp = true;
          }
        }
        at += field.size;
      }
    }
    if (compressedOffset !== null && !hadStamp) {
      // Compressed header: the offset replaces the low 5 bits of the last full timestamp (rolling over by 32 s).
      let next = (lastTimestamp & ~0x1f) + compressedOffset;
      if (compressedOffset < (lastTimestamp & 0x1f)) next += 0x20;
      lastTimestamp = next;
    }
    if (def.globalNum === MESG_RECORD || def.globalNum === MESG_SESSION) {
      const values = new Map<number, number | null>();
      let at = messageStart;
      for (const field of def.fields) {
        if (def.globalNum === MESG_RECORD ? [0, 1, 2, 3, 5, 6, 73, 78].includes(field.num) : [5, 9, 22, 23].includes(field.num)) values.set(field.num, readNumber(view, at, field, def.littleEndian));
        at += field.size;
      }
      const num = (key: number, scale = 1, offset = 0): number | null => {
        const v = values.get(key);
        return v === undefined || v === null ? null : v / scale - offset;
      };
      if (def.globalNum === MESG_RECORD) {
        const lat = num(0);
        const lon = num(1);
        records.push({
          timeMs: lastTimestamp ? FIT_EPOCH_MS + lastTimestamp * 1000 : null,
          latitude: lat === null ? null : lat * SEMICIRCLE,
          longitude: lon === null ? null : lon * SEMICIRCLE,
          // enhanced_altitude (78) supersedes altitude (2); both are scale 5, offset 500 m.
          altitudeM: num(78, 5, 500) ?? num(2, 5, 500),
          distanceM: num(5, 100),
          speedMs: num(73, 1000) ?? num(6, 1000),
          heartRate: num(3),
        });
      } else {
        sessions.push({ totalAscentM: num(22), totalDescentM: num(23), totalDistanceM: num(9, 100), sport: num(5) });
      }
    }
    pos = messageStart + size;
  }
  return { records, sessions };
}
