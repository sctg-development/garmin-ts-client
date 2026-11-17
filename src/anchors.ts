/**
 * Athlete anchors from Garmin's current biometric profile: lactate threshold, FTP, VO2 max.
 * Same record as `gc metrics anchors` (schemaVersion 1). Missing, zero or implausible values are null.
 */
import { GarminClient } from "./client.ts";
import { GarminError } from "./errors.ts";

export const ANCHORS_SCHEMA_VERSION = 1;
const LTHR_RANGE: [number, number] = [80, 230];
const FTP_RANGE: [number, number] = [30, 700];
const VO2_RANGE: [number, number] = [10, 100];

export type Anchors = {
  schemaVersion: 1;
  lactateThreshold: { heartRateBpm: number | null; date: string | null; speedRaw: number | null; speedDate: string | null };
  functionalThresholdPowerW: number | null;
  vo2MaxRunning: number | null;
  vo2MaxCycling: number | null;
  source: string;
  errors: Record<string, string>;
};

type Obj = Record<string, unknown>;

/** A sample object `{ value, bioDate }` (or a bare number) as [value, ISO date]. */
function entry(payload: unknown, name: string): [number | null, string | null] {
  let item = payload && typeof payload === "object" ? (payload as Obj)[name] : undefined;
  let day: string | null = null;
  if (item && typeof item === "object") {
    const raw = (item as Obj).bioDate;
    day = typeof raw === "string" && raw.length >= 10 ? raw.slice(0, 10) : null;
    item = (item as Obj).value;
  }
  return typeof item === "number" && Number.isFinite(item) ? [item, day] : [null, day];
}

const within = (value: number | null, [low, high]: [number, number]) => (value !== null && value >= low && value <= high ? value : null);

export function anchorsFromBiometric(payload: unknown): Anchors {
  const [lthrRaw, lthrDay] = entry(payload, "lactateThresholdHeartRate");
  const [speed, speedDay] = entry(payload, "lactateThresholdSpeed");
  const lthr = within(lthrRaw, LTHR_RANGE);
  const validSpeed = speed !== null && speed > 0 ? speed : null;
  return {
    schemaVersion: 1,
    lactateThreshold: {
      heartRateBpm: lthr === null ? null : Math.round(lthr),
      date: lthr === null ? null : lthrDay,
      // Garmin's unit for this field is not documented: passed through unconverted.
      speedRaw: validSpeed,
      speedDate: validSpeed === null ? null : speedDay,
    },
    functionalThresholdPowerW: within(entry(payload, "functionalThresholdPower")[0], FTP_RANGE),
    vo2MaxRunning: within(entry(payload, "vo2Max")[0], VO2_RANGE),
    vo2MaxCycling: within(entry(payload, "vo2MaxCycling")[0], VO2_RANGE),
    source: "userprofile-service/biometric/current",
    errors: {},
  };
}

export async function anchors(client: GarminClient): Promise<Anchors> {
  const name = await client.displayName();
  if (!name) throw new GarminError("error", "Garmin profile name unavailable.");
  return anchorsFromBiometric(await client.get(`/userprofile-service/biometric/current/${encodeURIComponent(name)}`));
}
