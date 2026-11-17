import assert from "node:assert/strict";
import { test } from "node:test";
import { GarminAuthError, GarminRateLimitError } from "../src/errors.ts";
import { applyHrvSummary, applySleepDetail, applySleepStatsRow, applyUserSummary, collectDaily, daily, emptyRecord, keyPaths, type DailySource } from "../src/daily.ts";

// 2025-01-14 22:30:00 UTC and 2025-01-15 06:00:00 UTC, in milliseconds.
const START_MS = 1736893800000;
const END_MS = 1736920800000;

const STATS_ROW = {
  calendarDate: "2025-01-15",
  values: {
    totalSleepTimeInSeconds: 25200, deepTime: 5400, lightTime: 14400, remTime: 5400, awakeTime: 1800, sleepScore: 82,
    gmtSleepStartTimeInMillis: START_MS, gmtSleepEndTimeInMillis: END_MS,
    localSleepStartTimeInMillis: START_MS + 3600000, localSleepEndTimeInMillis: END_MS + 3600000,
    restingHeartRate: 47, avgOvernightHrv: 62.0, hrv7dAverage: 60.0, hrvStatus: "BALANCED", respiration: 13.5, spO2: 95.0,
    skinTempC: -0.3, bodyBatteryChange: 61, sleepNeed: 480,
  },
};

const SLEEP_DETAIL = {
  dailySleepDTO: {
    sleepTimeSeconds: 25200, deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 5400, awakeSleepSeconds: 1800,
    sleepStartTimestampGMT: START_MS, sleepEndTimestampGMT: END_MS,
    sleepStartTimestampLocal: START_MS + 3600000, sleepEndTimestampLocal: END_MS + 3600000,
    averageSpO2Value: 94.0, lowestSpO2Value: 88, averageRespirationValue: 13.0, lowestRespirationValue: 11.0, highestRespirationValue: 17.0,
    avgSleepStress: 18.0, awakeCount: 2, sleepScores: { overall: { value: 80 } }, sleepNeed: { baseline: 480, actual: 500 },
  },
  restingHeartRate: 48, avgOvernightHrv: 61.0, hrvStatus: "BALANCED", bodyBatteryChange: 60, avgSkinTempDeviationC: 0.4,
};

test("a stats row fills every recovery signal", () => {
  const record = emptyRecord("2025-01-15");
  applySleepStatsRow(record, STATS_ROW);
  assert.equal(record.sleep?.durationS, 25200);
  assert.equal(record.sleep?.startGmt, "2025-01-14T22:30:00Z");
  assert.equal(record.sleep?.startLocal, "2025-01-14T23:30:00");
  assert.equal(record.sleep?.score, 82);
  assert.equal(record.sleep?.needS, 480 * 60);
  assert.equal(record.hrv?.lastNightAvgMs, 62);
  assert.equal(record.restingHr, 47);
  assert.equal(record.respiration?.sleepAvg, 13.5);
  assert.equal(record.spo2?.sleepAvg, 95);
  assert.equal(record.skinTempDeviationC, -0.3);
  assert.equal(record.bodyBattery?.sleepChange, 61);
});

test("the nightly detail reads the DTO and keeps missing values null", () => {
  const record = emptyRecord("2025-01-15");
  applySleepDetail(record, SLEEP_DETAIL);
  assert.equal(record.sleep?.needS, 500 * 60);
  assert.equal(record.sleep?.awakeCount, 2);
  assert.deepEqual(record.spo2, { sleepAvg: 94, sleepLow: 88, dayAvg: null, dayLow: null });
  assert.equal(record.respiration?.sleepHigh, 17);
  assert.equal(record.skinTempDeviationC, 0.4);
  assert.equal(record.stress, null);
});

test("a day without sleep stays null, not zero", () => {
  const record = emptyRecord("2025-01-15");
  applySleepDetail(record, { dailySleepDTO: { sleepTimeSeconds: null, userProfilePK: 1 } });
  applyUserSummary(record, { restingHeartRate: -1, averageStressLevel: -1, totalSteps: 0 });
  assert.equal(record.sleep, null);
  assert.equal(record.restingHr, null);
  assert.equal(record.stress, null);
  assert.equal(record.activity?.steps, 0);
});

test("a Fahrenheit deviation converts without the 32 degree offset", () => {
  const record = emptyRecord("2025-01-15");
  applySleepStatsRow(record, { values: { skinTempF: 0.9, totalSleepTimeInSeconds: 1 } });
  assert.equal(record.skinTempDeviationC, 0.5);
});

test("the HRV service overrides the sleep copy and adds the baseline", () => {
  const record = emptyRecord("2025-01-15");
  applySleepStatsRow(record, STATS_ROW);
  applyHrvSummary(record, { lastNightAvg: 64, lastNight5MinHigh: 90, weeklyAvg: 61, status: "BALANCED", baseline: { lowUpper: 50, balancedLow: 55, balancedUpper: 70 } });
  assert.equal(record.hrv?.lastNightAvgMs, 64);
  assert.equal(record.hrv?.baselineBalancedLowMs, 55);
});

test("key paths never contain values", () => {
  assert.deepEqual(keyPaths({ a: { b: 61, c: [{ d: "secret" }] }, e: [] }), ["a.b", "a.c[].d", "e[]"]);
});

function fakeSource(overrides: Partial<DailySource> = {}): DailySource & { calls: string[] } {
  const calls: string[] = [];
  const source: DailySource & { calls: string[] } = {
    calls,
    sleepStats: async () => (calls.push("sleepStats"), [STATS_ROW]),
    hrvRange: async () => (calls.push("hrvRange"), { hrvSummaries: [{ calendarDate: "2025-01-15", lastNightAvg: 64, status: "BALANCED" }] }),
    restingHrRange: async () => (calls.push("restingHrRange"), Promise.reject(new GarminRateLimitError("slow down"))),
    sleepDay: async () => (calls.push("sleep"), SLEEP_DETAIL),
    hrvDay: async () => (calls.push("hrv"), null),
    summaryDay: async () => (calls.push("summary"), { averageStressLevel: 31, bodyBatteryHighestValue: 88, averageSpo2: 96 }),
    ...overrides,
  };
  return source;
}

test("a range isolates a failing signal", async () => {
  const source = fakeSource();
  const data = await collectDaily(source, "2025-01-14", "2025-01-15", false);
  assert.deepEqual(source.calls, ["sleepStats", "hrvRange", "restingHrRange"]);
  assert.deepEqual(data.errors, { restingHrRange: "rate_limited" });
  assert.deepEqual(data.days.map((d) => d.date), ["2025-01-14", "2025-01-15"]);
  assert.equal(data.days[0]?.sleep, null);
  assert.equal(data.days[1]?.hrv?.lastNightAvgMs, 64);
  assert.equal(data.days[1]?.restingHr, 47);
});

test("detail adds the daily summary", async () => {
  const data = await collectDaily(fakeSource(), "2025-01-15", "2025-01-15", true);
  const day = data.days[0];
  assert.equal(day?.stress?.avg, 31);
  assert.deepEqual(day?.bodyBattery, { high: 88, low: null, charged: null, drained: null, sleepChange: 61 });
  assert.equal(day?.spo2?.dayAvg, 96);
  assert.equal(day?.spo2?.sleepLow, 88);
  assert.ok(day?.sources.includes("summary"));
});

test("detail is refused on a long range, and a bad range is rejected", async () => {
  await assert.rejects(daily(fakeSource(), { start: "2025-01-01", end: "2025-03-01", detail: true }), /limited to 14 days/);
  await assert.rejects(daily(fakeSource(), { start: "2025-01-05", end: "2025-01-01" }), /before/);
  await assert.rejects(daily(fakeSource(), { start: "2025-02-30" }), /Invalid date/);
  const data = await daily(fakeSource(), { start: "2025-01-15" });
  assert.equal(data.detail, true, "detail defaults on for a short range");
});

test("an authentication failure stops the collection", async () => {
  const source = fakeSource({ sleepStats: async () => Promise.reject(new GarminAuthError("expired")) });
  await assert.rejects(collectDaily(source, "2025-01-15", "2025-01-15", false), GarminAuthError);
});

test("the probe keeps raw payloads for key listing", async () => {
  const probe: Record<string, unknown> = {};
  await collectDaily(fakeSource(), "2025-01-15", "2025-01-15", false, probe);
  assert.ok(keyPaths(probe.sleepStats).includes("[].values.avgOvernightHrv"));
});
