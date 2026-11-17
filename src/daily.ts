/**
 * Compact per-day physiological records built from Garmin Connect payloads: a port of `gc daily`
 * with the same schema (version 1), so the output can replace the CLI's.
 *
 * Rules: Garmin field names differ between endpoints, devices and firmware, so every field is looked
 * up through a list of candidate names; a missing field is null, never 0; units are fixed (seconds,
 * ms, bpm, breaths/min, %, deg C); no intraday series, only nightly or daily aggregates.
 */
import { GarminClient } from "./client.ts";
import { addDays, dateRange, daysBetween, parseDate } from "./dates.ts";
import { GarminAuthError, GarminError } from "./errors.ts";

export const SCHEMA_VERSION = 1;
export const MAX_RANGE_DAYS = 400;
/** Above this many days per-day detail calls are refused: they cost 3 requests per day. */
export const MAX_DETAIL_DAYS = 14;

type Obj = Record<string, unknown>;
type Section = Record<string, number | string | null>;

export type DailyRecord = {
  date: string;
  sleep: Section | null;
  hrv: Section | null;
  restingHr: number | null;
  respiration: Section | null;
  spo2: Section | null;
  skinTempDeviationC: number | null;
  stress: Section | null;
  bodyBattery: Section | null;
  activity: Section | null;
  heartRate: Section | null;
  sources: string[];
  errors: Record<string, string>;
};

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A dict view of a payload row, lifting a nested `values` object. */
function flat(row: unknown): Obj {
  if (!isObj(row)) return {};
  return isObj(row.values) ? { ...row, ...row.values } : row;
}

function pick(source: unknown, names: string[]): unknown {
  if (!isObj(source)) return null;
  for (const name of names) {
    const value = source[name];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Numeric field or null. With `positive` (default), Garmin's <= 0 "no value" markers are dropped. */
function num(source: unknown, names: string[], positive = true): number | null {
  const value = pick(source, names);
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (positive && value <= 0) return null;
  return value;
}

const signed = (source: unknown, names: string[]) => num(source, names, false);

function text(source: unknown, names: string[]): string | null {
  const value = pick(source, names);
  return typeof value === "string" && value ? value : null;
}

/** Epoch ms to ISO 8601. Garmin's "local" timestamps are wall-clock time encoded as UTC: no zone suffix. */
function isoFromMs(value: unknown, asUtc: boolean): string | null {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return null;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return null;
  const iso = moment.toISOString().slice(0, 19);
  return asUtc ? `${iso}Z` : iso;
}

function dropEmpty(section: Section): Section | null {
  return Object.values(section).some((value) => value !== null) ? section : null;
}

export function emptyRecord(day: string): DailyRecord {
  return { date: day, sleep: null, hrv: null, restingHr: null, respiration: null, spo2: null, skinTempDeviationC: null, stress: null, bodyBattery: null, activity: null, heartRate: null, sources: [], errors: {} };
}

type SectionKey = "sleep" | "hrv" | "respiration" | "spo2" | "stress" | "bodyBattery" | "activity" | "heartRate";

/** Merge a section into the record; existing non-null fields win. */
function merge(record: DailyRecord, key: SectionKey, section: Section | null): void {
  if (section === null) return;
  const current = record[key];
  if (current === null) {
    record[key] = section;
    return;
  }
  for (const [name, value] of Object.entries(section)) if (current[name] === null || current[name] === undefined) current[name] = value;
}

function sleepNeedSeconds(source: Obj): number | null {
  const need = source.sleepNeed;
  const minutes = isObj(need) ? num(need, ["actual", "baseline"]) : num(source, ["sleepNeed"]);
  return minutes !== null ? minutes * 60 : null;
}

function sleepScore(source: Obj): number | null {
  const scores = source.sleepScores;
  if (isObj(scores)) {
    const value = isObj(scores.overall) ? num(scores.overall, ["value"]) : null;
    if (value !== null) return value;
  }
  return num(source, ["sleepScore", "overallSleepScore"]);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function skinTemp(source: Obj): number | null {
  const celsius = signed(source, ["avgSkinTempDeviationC", "skinTempDeviationC", "skinTempC"]);
  if (celsius !== null) return round2(celsius);
  const fahrenheit = signed(source, ["avgSkinTempDeviationF", "skinTempDeviationF", "skinTempF"]);
  // A deviation converts with the scale factor only (no 32 degree offset).
  return fahrenheit !== null ? round2((fahrenheit * 5) / 9) : null;
}

/** Merge one row of the sleep statistics range endpoint. */
export function applySleepStatsRow(record: DailyRecord, row: unknown): void {
  const src = flat(row);
  if (Object.keys(src).length === 0) return;
  merge(record, "sleep", dropEmpty({
    startGmt: isoFromMs(pick(src, ["gmtSleepStartTimeInMillis", "sleepStartTimestampGMT"]), true),
    endGmt: isoFromMs(pick(src, ["gmtSleepEndTimeInMillis", "sleepEndTimestampGMT"]), true),
    startLocal: isoFromMs(pick(src, ["localSleepStartTimeInMillis", "sleepStartTimestampLocal"]), false),
    endLocal: isoFromMs(pick(src, ["localSleepEndTimeInMillis", "sleepEndTimestampLocal"]), false),
    durationS: num(src, ["totalSleepTimeInSeconds", "sleepTimeSeconds"]),
    deepS: num(src, ["deepTime", "deepSleepSeconds"], false),
    lightS: num(src, ["lightTime", "lightSleepSeconds"], false),
    remS: num(src, ["remTime", "remSleepSeconds"], false),
    awakeS: num(src, ["awakeTime", "awakeSleepSeconds"], false),
    napS: num(src, ["napTimeSeconds"], false),
    awakeCount: num(src, ["awakeCount"], false),
    score: sleepScore(src),
    needS: sleepNeedSeconds(src),
    avgStress: num(src, ["avgSleepStress"]),
    avgHr: num(src, ["avgHeartRate"]),
  }));
  merge(record, "hrv", dropEmpty({
    lastNightAvgMs: num(src, ["avgOvernightHrv"]),
    lastNight5MinHighMs: null,
    weeklyAvgMs: num(src, ["hrv7dAverage"]),
    status: text(src, ["hrvStatus"]),
    baselineLowUpperMs: null,
    baselineBalancedLowMs: null,
    baselineBalancedUpperMs: null,
  }));
  if (record.restingHr === null) record.restingHr = num(src, ["restingHeartRate"]);
  merge(record, "respiration", dropEmpty({
    sleepAvg: num(src, ["respiration", "averageRespirationValue", "averageRespiration"]),
    sleepLow: num(src, ["lowestRespirationValue"]),
    sleepHigh: num(src, ["highestRespirationValue"]),
    wakingAvg: null,
  }));
  merge(record, "spo2", dropEmpty({
    sleepAvg: num(src, ["spO2", "averageSpO2Value", "averageSPO2"]),
    sleepLow: num(src, ["lowestSpO2Value", "lowestSPO2"]),
    dayAvg: null,
    dayLow: null,
  }));
  if (record.skinTempDeviationC === null) record.skinTempDeviationC = skinTemp(src);
  merge(record, "bodyBattery", dropEmpty({ high: null, low: null, charged: null, drained: null, sleepChange: signed(src, ["bodyBatteryChange"]) }));
}

/** Merge the single-night sleep payload. */
export function applySleepDetail(record: DailyRecord, payload: unknown): void {
  if (!isObj(payload)) return;
  const merged: Obj = isObj(payload.dailySleepDTO) ? { ...payload.dailySleepDTO } : {};
  for (const key of ["restingHeartRate", "avgOvernightHrv", "hrvStatus", "bodyBatteryChange", "avgSkinTempDeviationC", "avgSkinTempDeviationF"]) {
    if (payload[key] !== null && payload[key] !== undefined && (merged[key] === null || merged[key] === undefined)) merged[key] = payload[key];
  }
  // A day without recorded sleep still returns a DTO, with null timestamps.
  if (num(merged, ["sleepTimeSeconds"]) === null && (merged.sleepStartTimestampGMT === null || merged.sleepStartTimestampGMT === undefined)) return;
  applySleepStatsRow(record, merged);
}

/** Merge one HRV summary (the `hrvSummary` of a day, or a range row). The HRV service overrides the sleep copy. */
export function applyHrvSummary(record: DailyRecord, summary: unknown): void {
  if (!isObj(summary)) return;
  const baseline = isObj(summary.baseline) ? summary.baseline : {};
  const section = dropEmpty({
    lastNightAvgMs: num(summary, ["lastNightAvg"]),
    lastNight5MinHighMs: num(summary, ["lastNight5MinHigh"]),
    weeklyAvgMs: num(summary, ["weeklyAvg"]),
    status: text(summary, ["status"]),
    baselineLowUpperMs: num(baseline, ["lowUpper"]),
    baselineBalancedLowMs: num(baseline, ["balancedLow"]),
    baselineBalancedUpperMs: num(baseline, ["balancedUpper"]),
  });
  if (section === null) return;
  if (record.hrv !== null) {
    for (const [name, value] of Object.entries(section)) if (value !== null) record.hrv[name] = value;
  } else {
    record.hrv = section;
  }
}

/** Merge the daily user summary. */
export function applyUserSummary(record: DailyRecord, payload: unknown): void {
  if (!isObj(payload)) return;
  if (record.restingHr === null) record.restingHr = num(payload, ["restingHeartRate"]);
  merge(record, "stress", dropEmpty({
    avg: num(payload, ["averageStressLevel"]),
    max: num(payload, ["maxStressLevel"]),
    restS: num(payload, ["restStressDuration"], false),
    lowS: num(payload, ["lowStressDuration"], false),
    mediumS: num(payload, ["mediumStressDuration"], false),
    highS: num(payload, ["highStressDuration"], false),
  }));
  merge(record, "bodyBattery", dropEmpty({
    high: num(payload, ["bodyBatteryHighestValue"]),
    low: num(payload, ["bodyBatteryLowestValue"]),
    charged: num(payload, ["bodyBatteryChargedValue"], false),
    drained: num(payload, ["bodyBatteryDrainedValue"], false),
    sleepChange: null,
  }));
  merge(record, "respiration", dropEmpty({ sleepAvg: num(payload, ["avgSleepRespirationValue"]), sleepLow: null, sleepHigh: null, wakingAvg: num(payload, ["avgWakingRespirationValue"]) }));
  merge(record, "spo2", dropEmpty({ sleepAvg: null, sleepLow: null, dayAvg: num(payload, ["averageSpo2"]), dayLow: num(payload, ["lowestSpo2"]) }));
  merge(record, "activity", dropEmpty({
    steps: num(payload, ["totalSteps"], false),
    activeKcal: num(payload, ["activeKilocalories"], false),
    bmrKcal: num(payload, ["bmrKilocalories"]),
    moderateMin: num(payload, ["moderateIntensityMinutes"], false),
    vigorousMin: num(payload, ["vigorousIntensityMinutes"], false),
    floorsUp: num(payload, ["floorsAscended"], false),
  }));
  merge(record, "heartRate", dropEmpty({ min: num(payload, ["minHeartRate"]), max: num(payload, ["maxHeartRate"]) }));
}

/** Key paths of a payload, without any value: a privacy-safe contract probe. */
export function keyPaths(payload: unknown, prefix = "", depth = 4): string[] {
  if (depth === 0 && (Array.isArray(payload) || isObj(payload))) return prefix ? [`${prefix}…`] : [];
  if (isObj(payload)) {
    const paths: string[] = [];
    for (const key of Object.keys(payload).sort()) {
      const child = prefix ? `${prefix}.${key}` : key;
      const nested = keyPaths(payload[key], child, depth - 1);
      paths.push(...(nested.length ? nested : [child]));
    }
    return paths;
  }
  if (Array.isArray(payload)) return payload.length ? keyPaths(payload[0], `${prefix}[]`, depth - 1) : [`${prefix}[]`];
  return prefix ? [prefix] : [];
}

/** Where the raw payloads come from. The Garmin implementation is `garminSource`; tests use a fake. */
export interface DailySource {
  sleepStats(start: string, end: string): Promise<unknown[]>;
  hrvRange(start: string, end: string): Promise<unknown>;
  restingHrRange(start: string, end: string): Promise<unknown[]>;
  sleepDay(day: string): Promise<unknown>;
  hrvDay(day: string): Promise<unknown>;
  summaryDay(day: string): Promise<unknown>;
}

export function garminSource(client: GarminClient): DailySource {
  return {
    async sleepStats(start, end) {
      const rows: unknown[] = [];
      const seen = new Set<string>();
      for (let first = start; first <= end; first = addDays(first, 28)) {
        const last = addDays(first, 27) < end ? addDays(first, 27) : end;
        const data = await client.get<{ individualStats?: unknown[] } | null>(`/sleep-service/stats/sleep/daily/${first}/${last}`);
        for (const row of data?.individualStats ?? []) {
          const day = isObj(row) && typeof row.calendarDate === "string" ? row.calendarDate : null;
          if (day && !seen.has(day)) {
            seen.add(day);
            rows.push(row);
          }
        }
      }
      return rows;
    },
    hrvRange: (start, end) => client.get(`/hrv-service/hrv/daily/${start}/${end}`),
    async restingHrRange(start, end) {
      const name = await client.displayName();
      const data = await client.get<{ allMetrics?: { metricsMap?: Record<string, Array<{ calendarDate?: string; value?: number | null }>> } } | null>(
        `/userstats-service/wellness/daily/${encodeURIComponent(name)}`,
        { fromDate: start, untilDate: end, metricId: 60 },
      );
      const rows = data?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE ?? [];
      return rows.filter((row) => row.value !== null && row.value !== undefined).map((row) => ({ calendarDate: row.calendarDate, value: row.value }));
    },
    async sleepDay(day) {
      const name = await client.displayName();
      return client.get(`/wellness-service/wellness/dailySleepData/${encodeURIComponent(name)}`, { date: day, nonSleepBufferMinutes: 60 });
    },
    hrvDay: (day) => client.get(`/hrv-service/hrv/${day}`),
    async summaryDay(day) {
      const name = await client.displayName();
      return client.get(`/usersummary-service/usersummary/daily/${encodeURIComponent(name)}`, { calendarDate: day });
    },
  };
}

export type DailyResult = { schemaVersion: number; start: string; end: string; detail: boolean; days: DailyRecord[]; errors: Record<string, string> };

function errorCode(error: unknown): string {
  return error instanceof GarminError && error.code !== "not_found" ? error.code : "error";
}

/** Run one call: a failure is recorded under `name` and returns null. Authentication failures abort everything. */
async function attempt<T>(errors: Record<string, string>, name: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GarminAuthError) throw error;
    errors[name] = errorCode(error);
    return null;
  }
}

export async function collectDaily(source: DailySource, start: string, end: string, detail: boolean, probe?: Record<string, unknown>): Promise<DailyResult> {
  const days = dateRange(start, end);
  const records = new Map(days.map((day) => [day, emptyRecord(day)]));
  const errors: Record<string, string> = {};
  const remember = (name: string, payload: unknown) => {
    if (probe && !(name in probe) && payload) probe[name] = payload;
  };

  const sleepRows = await attempt(errors, "sleepStats", () => source.sleepStats(start, end));
  remember("sleepStats", sleepRows);
  for (const row of sleepRows ?? []) {
    const day = isObj(row) && typeof row.calendarDate === "string" ? row.calendarDate : null;
    const record = day ? records.get(day) : undefined;
    if (record) {
      applySleepStatsRow(record, row);
      record.sources.push("sleepStats");
    }
  }

  const hrvRange = await attempt(errors, "hrvRange", () => source.hrvRange(start, end));
  remember("hrvRange", hrvRange);
  const summaries = isObj(hrvRange) && Array.isArray(hrvRange.hrvSummaries) ? hrvRange.hrvSummaries : [];
  for (const summary of summaries) {
    const day = isObj(summary) && typeof summary.calendarDate === "string" ? summary.calendarDate : null;
    const record = day ? records.get(day) : undefined;
    if (record) {
      applyHrvSummary(record, summary);
      record.sources.push("hrvRange");
    }
  }

  const rhrRows = await attempt(errors, "restingHrRange", () => source.restingHrRange(start, end));
  remember("restingHrRange", rhrRows);
  for (const row of rhrRows ?? []) {
    const r = isObj(row) ? row : {};
    const record = typeof r.calendarDate === "string" ? records.get(r.calendarDate) : undefined;
    if (record && typeof r.value === "number" && r.value > 0) {
      // The wellness statistic is Garmin's reference resting heart rate.
      record.restingHr = r.value;
      record.sources.push("restingHrRange");
    }
  }

  if (detail) {
    for (const day of days) {
      const record = records.get(day) as DailyRecord;
      const sleep = await attempt(record.errors, "sleep", () => source.sleepDay(day));
      remember("sleep", sleep);
      if (sleep) {
        applySleepDetail(record, sleep);
        record.sources.push("sleep");
      }
      const hrv = await attempt(record.errors, "hrv", () => source.hrvDay(day));
      remember("hrv", hrv);
      if (isObj(hrv)) {
        applyHrvSummary(record, hrv.hrvSummary);
        record.sources.push("hrv");
      }
      const summary = await attempt(record.errors, "summary", () => source.summaryDay(day));
      remember("summary", summary);
      if (summary) {
        applyUserSummary(record, summary);
        record.sources.push("summary");
      }
    }
  }

  return { schemaVersion: SCHEMA_VERSION, start, end, detail, days: days.map((day) => records.get(day) as DailyRecord), errors };
}

export type DailyOptions = { start: string; end?: string; detail?: boolean };

/** `gc daily`: validates the range like the CLI, then collects the records. */
export async function daily(client: GarminClient | DailySource, options: DailyOptions): Promise<DailyResult> {
  const first = options.start;
  const last = options.end ?? first;
  parseDate(first);
  parseDate(last);
  const span = daysBetween(first, last) + 1;
  if (span < 1) throw new GarminError("error", "--end is before --start.");
  if (span > MAX_RANGE_DAYS) throw new GarminError("error", `Range too long: ${span} days (max ${MAX_RANGE_DAYS}).`);
  let detail = options.detail;
  if (detail === undefined) detail = span <= MAX_DETAIL_DAYS;
  else if (detail && span > MAX_DETAIL_DAYS) throw new GarminError("error", `--detail is limited to ${MAX_DETAIL_DAYS} days (3 requests per day); got ${span}.`);
  const source = client instanceof GarminClient ? garminSource(client) : client;
  return collectDaily(source, first, last, detail);
}
