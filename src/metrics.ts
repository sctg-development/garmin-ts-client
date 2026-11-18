/** Training metrics endpoints. Each returns Garmin's payload unchanged, as `gc metrics ...` does. */
import { GarminClient } from "./client.ts";
import { localToday, parseDate } from "./dates.ts";

const day = (value: string) => {
  parseDate(value);
  return value;
};

export const trainingReadiness = (client: GarminClient, date: string) => client.get(`/metrics-service/metrics/trainingreadiness/${day(date)}`);
export const trainingStatus = (client: GarminClient, date: string) => client.get(`/metrics-service/metrics/trainingstatus/aggregated/${day(date)}`);

/**
 * Training load balance as of `date`: the rolling 30-day load split into aerobic low, aerobic high and
 * anaerobic, with Garmin's target range for each and a feedback phrase. There is no weekly or monthly
 * endpoint (404): the monthly figures are already a 30-day window, and a longer series comes from calling
 * this for several past dates (checked: each date returns its own values).
 */
export const trainingLoadBalance = (client: GarminClient, date: string) => client.get(`/metrics-service/metrics/trainingloadbalance/latest/${day(date)}`);

/**
 * VO2 max history, one entry per day Garmin updated it. Each entry also carries the heat and altitude
 * acclimation block, so no separate acclimation call is needed.
 */
export const maxMet = (client: GarminClient, start: string, end: string) => client.get(`/metrics-service/metrics/maxmet/daily/${day(start)}/${day(end)}`);

type Obj = Record<string, unknown>;

/** Latest lactate threshold (speed, heart rate) and running power, as one object like `gc metrics lactate-threshold`. */
export async function lactateThreshold(client: GarminClient, today: string = localToday()) {
  const power = await client.get<unknown>(`/biometric-service/biometric/powerToWeight/latest/${day(today)}`, { sport: "Running" });
  const entries = await client.get<unknown>("/biometric-service/biometric/latestLactateThreshold");
  const powerObject: Obj = Array.isArray(power) ? ((power[0] as Obj) ?? {}) : ((power as Obj | null) ?? {});
  const combined: Obj = { userProfilePK: null, version: null, calendarDate: null, sequence: null, speed: null, heartRate: null, heartRateCycling: null };
  for (const entry of Array.isArray(entries) ? (entries as Obj[]) : []) {
    if (entry.speed !== null && entry.speed !== undefined) {
      combined.userProfilePK = entry.userProfilePK;
      combined.version = entry.version;
      combined.calendarDate = entry.calendarDate;
      combined.sequence = entry.sequence;
      combined.speed = entry.speed;
    }
    // Garmin's historical typo: "hearRate".
    const heartRate = entry.heartRate || entry.hearRate;
    if (heartRate !== null && heartRate !== undefined && heartRate !== 0) combined.heartRate = heartRate;
    if (entry.heartRateCycling !== null && entry.heartRateCycling !== undefined) combined.heartRateCycling = entry.heartRateCycling;
  }
  return { speed_and_heart_rate: combined, power: powerObject };
}
