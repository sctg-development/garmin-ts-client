/** Training metrics endpoints. Each returns Garmin's payload unchanged, as `gc metrics ...` does. */
import { GarminClient } from "./client.ts";
import { localToday, parseDate } from "./dates.ts";

const day = (value: string) => {
  parseDate(value);
  return value;
};

export const trainingReadiness = (client: GarminClient, date: string) => client.get(`/metrics-service/metrics/trainingreadiness/${day(date)}`);
export const trainingStatus = (client: GarminClient, date: string) => client.get(`/metrics-service/metrics/trainingstatus/aggregated/${day(date)}`);

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
