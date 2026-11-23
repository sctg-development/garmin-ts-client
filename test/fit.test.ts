import assert from "node:assert/strict";
import { test } from "node:test";
import { activityDescent } from "../src/activityFile.ts";
import { MIN_SAMPLES, analyzeDescent, descentWeight } from "../src/descent.ts";
import { FIT_EPOCH_MS, decodeFit, fitCrc } from "../src/fit.ts";
import { readZipEntry } from "../src/zip.ts";
import { buildFit, buildZip, type Sample } from "./fit-helpers.ts";

const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);

/** A track made of (distance, altitude) legs sampled every 10 m, one sample per 3 s. */
function track(legs: Array<{ metres: number; gradePct: number }>, start = 1000, noise = 0): Sample[] {
  const out: Sample[] = [{ t: T0, altitude: start, distance: 0, hr: 140 }];
  let d = 0;
  let a = start;
  let i = 0;
  for (const leg of legs) {
    for (let m = 10; m <= leg.metres; m += 10) {
      d += 10;
      a += (10 * leg.gradePct) / 100;
      i += 1;
      out.push({ t: T0 + i * 3000, altitude: a + (noise ? (i % 2 ? noise : -noise) : 0), distance: d, hr: 140 });
    }
  }
  return out;
}

test("records are decoded with their scale, units and invalid markers", () => {
  const samples: Sample[] = [
    { t: T0, altitude: 1234.4, distance: 12.5, hr: 150 },
    { t: T0 + 1000, altitude: null, distance: 25, hr: null },
  ];
  const fit = decodeFit(buildFit(samples, { sessionDescent: 321 }));
  assert.equal(fit.records.length, 2);
  assert.equal(fit.records[0]?.timeMs, T0);
  assert.ok(Math.abs((fit.records[0]?.altitudeM ?? 0) - 1234.4) < 0.11);
  assert.equal(fit.records[0]?.distanceM, 12.5);
  assert.equal(fit.records[0]?.heartRate, 150);
  assert.equal(fit.records[1]?.altitudeM, null);
  assert.equal(fit.records[1]?.heartRate, null);
  assert.equal(fit.sessions[0]?.totalDescentM, 321);
  assert.equal(fit.sessions[0]?.totalAscentM, null);
  assert.equal(FIT_EPOCH_MS, Date.UTC(1989, 11, 31));
});

test("big-endian definitions, 12-byte headers, unknown messages and developer fields do not break decoding", () => {
  const samples = track([{ metres: 100, gradePct: 0 }]);
  for (const options of [{ bigEndian: true }, { headerSize: 12 as const }, { unknownMessage: true }, { withDeveloperField: true }]) {
    const fit = decodeFit(buildFit(samples, options));
    assert.equal(fit.records.length, samples.length, JSON.stringify(options));
    assert.equal(fit.records[3]?.distanceM, 30);
  }
});

test("compressed timestamp headers advance the time from the last full timestamp, across a 32-second rollover", () => {
  const samples: Sample[] = Array.from({ length: 12 }, (_, i) => ({ t: T0 + 25_000 + i * 1000, altitude: 100, distance: i * 5, hr: 120 }));
  const fit = decodeFit(buildFit(samples, { compressed: true }));
  assert.deepEqual(fit.records.map((r) => r.timeMs), samples.map((s) => s.t));
});

test("a damaged, truncated or foreign file is refused, unless the CRC check is turned off", () => {
  const good = buildFit(track([{ metres: 100, gradePct: 0 }]));
  // Corrupt the last heart-rate byte: structurally valid, but the CRC no longer matches.
  const flipped = good.slice();
  flipped[good.length - 3] = (flipped[good.length - 3] as number) ^ 0x55;
  assert.throws(() => decodeFit(flipped), /CRC mismatch/);
  assert.doesNotThrow(() => decodeFit(flipped, { verifyCrc: false }));
  assert.throws(() => decodeFit(good.slice(0, good.length - 40)), /truncated/);
  assert.throws(() => decodeFit(new Uint8Array(40)), /header size|signature/);
  assert.throws(() => decodeFit(new Uint8Array(3)), /too short/);
  // The file CRC covers the header too (the original parser skipped it for 14-byte headers).
  assert.equal(fitCrc(good, 0, good.length - 2), (good[good.length - 2] as number) | ((good[good.length - 1] as number) << 8));
});

test("steep descent weighs more than gentle descent, and flat noise adds none", () => {
  assert.equal(descentWeight(5), 1);
  assert.equal(descentWeight(14), 1.25);
  assert.equal(descentWeight(30), 1.5);
  const gentle = analyzeDescent(decodeFit(buildFit(track([{ metres: 12_000, gradePct: -5 }]))));
  const steep = analyzeDescent(decodeFit(buildFit(track([{ metres: 3_000, gradePct: -20 }]))));
  assert.ok(gentle && steep);
  assert.ok(Math.abs(gentle.descentM - 600) <= 12, `gentle ${gentle.descentM}`);
  assert.ok(Math.abs(steep.descentM - 600) <= 12, `steep ${steep.descentM}`);
  assert.equal(gentle.steepDescentM, 0);
  assert.ok(steep.steepDescentM >= 580);
  assert.ok(steep.eccentricUnits > gentle.eccentricUnits * 1.4, "same metres, far more eccentric stress");
  assert.equal(gentle.meanDescentGradePct, 5);

  const flat = analyzeDescent(decodeFit(buildFit(track([{ metres: 8_000, gradePct: 0 }], 1000, 0.3))));
  assert.ok(flat);
  assert.ok(flat.descentM <= 10 && flat.ascentM <= 10, `noise descent ${flat.descentM}, ascent ${flat.ascentM}`);
});

test("a climb then a descent reports both, with the device's own descent alongside", () => {
  const file = decodeFit(buildFit(track([{ metres: 4_000, gradePct: 10 }, { metres: 4_000, gradePct: -10 }]), { sessionDescent: 395 }));
  const result = analyzeDescent(file);
  assert.ok(result);
  assert.ok(Math.abs(result.ascentM - 400) <= 12 && Math.abs(result.descentM - 400) <= 12);
  assert.equal(result.deviceDescentM, 395);
  assert.equal(result.distanceM, 8000);
});

test("too few altitude samples give no analysis, and a missing distance is integrated from speed", () => {
  assert.equal(analyzeDescent({ records: [], sessions: [] }), null);
  const few = decodeFit(buildFit(track([{ metres: 100, gradePct: -10 }]).slice(0, MIN_SAMPLES - 1)));
  assert.equal(analyzeDescent(few), null);
  const records = Array.from({ length: 400 }, (_, i) => ({ timeMs: T0 + i * 1000, latitude: null, longitude: null, altitudeM: 1000 - i * 0.5, distanceM: null, speedMs: 3, heartRate: null }));
  const result = analyzeDescent({ records, sessions: [] });
  assert.ok(result && result.descentM > 150 && result.distanceM > 1000);
});

test("the zip reader returns the fit entry, handles stored entries and refuses what is not an archive", () => {
  const fit = buildFit(track([{ metres: 200, gradePct: -5 }]));
  assert.deepEqual(readZipEntry(buildZip("123_ACTIVITY.fit", fit)), fit);
  assert.deepEqual(readZipEntry(buildZip("a.FIT", fit, 0)), fit);
  assert.throws(() => readZipEntry(buildZip("readme.txt", fit)), /no matching entry/);
  assert.throws(() => readZipEntry(new Uint8Array(10)), /end-of-archive/);
});

test("an activity's descent is analysed from its downloaded archive, and only numeric ids reach the URL", async () => {
  const archive = buildZip("1_ACTIVITY.fit", buildFit(track([{ metres: 3_000, gradePct: -20 }])));
  const calls: string[] = [];
  const client = { request: async (_m: string, path: string, options: { raw?: boolean }) => (calls.push(`${path} raw=${options.raw}`), archive) } as never;
  const result = await activityDescent(client, "123456");
  assert.ok(result && result.steepDescentM > 500);
  assert.deepEqual(calls, ["/download-service/files/activity/123456 raw=true"]);
  await assert.rejects(activityDescent(client, "12; rm"), /must be a number/);
});
