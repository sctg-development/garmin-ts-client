import assert from "node:assert/strict";
import { test } from "node:test";
import { anchors, anchorsFromBiometric } from "../src/anchors.ts";
import type { GarminClient } from "../src/client.ts";

const PAYLOAD = {
  lactateThresholdHeartRate: { sampleId: 1, bioDate: "2026-04-02T08:00:00.0", value: 164 },
  lactateThresholdSpeed: { value: 0.35, bioDate: "2026-04-02T08:00:00.0" },
  functionalThresholdPower: null,
  vo2Max: 52,
  vo2MaxCycling: 0,
};

test("reads the threshold with its date and drops missing values", () => {
  const record = anchorsFromBiometric(PAYLOAD);
  assert.equal(record.lactateThreshold.heartRateBpm, 164);
  assert.equal(record.lactateThreshold.date, "2026-04-02");
  assert.equal(record.lactateThreshold.speedRaw, 0.35);
  assert.equal(record.functionalThresholdPowerW, null);
  assert.equal(record.vo2MaxRunning, 52);
  assert.equal(record.vo2MaxCycling, null);
});

test("implausible or malformed values become null", () => {
  const record = anchorsFromBiometric({ lactateThresholdHeartRate: { value: 20 }, vo2Max: "x" });
  assert.equal(record.lactateThreshold.heartRateBpm, null);
  assert.equal(record.lactateThreshold.date, null);
  assert.equal(record.vo2MaxRunning, null);
  assert.equal(anchorsFromBiometric(null).lactateThreshold.heartRateBpm, null);
});

test("anchors() asks for the profile of the signed-in user", async () => {
  const paths: string[] = [];
  const client = {
    displayName: async () => "some.one",
    get: async (path: string) => (paths.push(path), PAYLOAD),
  } as unknown as GarminClient;
  assert.equal((await anchors(client)).lactateThreshold.heartRateBpm, 164);
  assert.deepEqual(paths, ["/userprofile-service/biometric/current/some.one"]);
});
