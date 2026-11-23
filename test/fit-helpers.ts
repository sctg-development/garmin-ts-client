/** Builds synthetic FIT and ZIP files for tests: the decoder is checked on bytes whose content is known exactly. */
import { deflateRawSync } from "node:zlib";
import { FIT_EPOCH_MS, fitCrc } from "../src/fit.ts";

export type Sample = { t: number; altitude: number | null; distance: number | null; hr?: number | null };

const u32 = (v: number, le: boolean) => {
  const b = Buffer.alloc(4);
  le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0);
  return b;
};
const u16 = (v: number, le: boolean) => {
  const b = Buffer.alloc(2);
  le ? b.writeUInt16LE(v) : b.writeUInt16BE(v);
  return b;
};

export type BuildOptions = {
  bigEndian?: boolean;
  /** Use a compressed timestamp header for records after the first (needs 1-second steps within 32 s). */
  compressed?: boolean;
  sessionDescent?: number;
  withDeveloperField?: boolean;
  /** Insert an unknown message (global number 999) before the records. */
  unknownMessage?: boolean;
  headerSize?: 12 | 14;
};

/** One FIT activity file: a record message definition, one data message per sample, an optional session message. */
export function buildFit(samples: Sample[], options: BuildOptions = {}): Uint8Array {
  const le = !options.bigEndian;
  const parts: Buffer[] = [];
  const definition = (local: number, globalNum: number, fields: Array<[number, number, number]>, dev: Array<[number, number, number]> = []) => {
    const head = Buffer.from([0x40 | (dev.length ? 0x20 : 0) | local, 0, le ? 0 : 1]);
    parts.push(head, u16(globalNum, le), Buffer.from([fields.length]), Buffer.from(fields.flat()));
    if (dev.length) parts.push(Buffer.from([dev.length]), Buffer.from(dev.flat()));
  };
  if (options.unknownMessage) {
    definition(1, 999, [[0, 2, 4]]);
    parts.push(Buffer.from([0x01]), u16(0x1234, le));
  }
  // record: timestamp(253) u32, distance(5) u32, enhanced_altitude(78) u32, heart_rate(3) u8 [, developer field of 3 bytes]
  definition(0, 20, [[253, 4, 6], [5, 4, 6], [78, 4, 6], [3, 1, 2]], options.withDeveloperField ? [[0, 3, 0]] : []);
  samples.forEach((s, i) => {
    const seconds = Math.round((s.t - FIT_EPOCH_MS) / 1000);
    const alt = s.altitude === null ? 0xffffffff : Math.round((s.altitude + 500) * 5);
    const dist = s.distance === null ? 0xffffffff : Math.round(s.distance * 100);
    const hr = s.hr === undefined || s.hr === null ? 0xff : s.hr;
    if (options.compressed && i > 0) {
      // compressed header: bit 7 set, local type 0, 5-bit time offset; the record then has no timestamp field, so use a second definition
      if (i === 1) definition(2, 20, [[5, 4, 6], [78, 4, 6], [3, 1, 2]]);
      parts.push(Buffer.from([0x80 | (2 << 5) | (seconds & 0x1f)]), u32(dist, le), u32(alt, le), Buffer.from([hr]));
      return;
    }
    parts.push(Buffer.from([0x00]), u32(seconds, le), u32(dist, le), u32(alt, le), Buffer.from([hr]), ...(options.withDeveloperField ? [Buffer.from([1, 2, 3])] : []));
  });
  if (options.sessionDescent !== undefined) {
    definition(3, 18, [[23, 2, 4], [22, 2, 4]]);
    parts.push(Buffer.from([0x03]), u16(options.sessionDescent, le), u16(0xffff, le));
  }
  const data = Buffer.concat(parts);
  const headerSize = options.headerSize ?? 14;
  const header = Buffer.alloc(headerSize);
  header[0] = headerSize;
  header[1] = 0x20;
  header.writeUInt16LE(2140, 2);
  header.writeUInt32LE(data.length, 4);
  header.write(".FIT", 8, "latin1");
  if (headerSize === 14) header.writeUInt16LE(fitCrc(header, 0, 12), 12);
  const body = Buffer.concat([header, data]);
  const out = Buffer.concat([body, Buffer.alloc(2)]);
  out.writeUInt16LE(fitCrc(body), body.length);
  return new Uint8Array(out);
}

/** A ZIP with one entry, deflated or stored. */
export function buildZip(name: string, content: Uint8Array, method: 0 | 8 = 8): Uint8Array {
  const data = method === 8 ? deflateRawSync(content) : Buffer.from(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localPart = Buffer.concat([local, nameBytes, data]);
  const centralPart = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return new Uint8Array(Buffer.concat([localPart, centralPart, eocd]));
}
