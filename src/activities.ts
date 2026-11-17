/** Activities: list by date range, and the per-activity detail endpoints the coach reads. */
import { GarminClient } from "./client.ts";
import { parseDate } from "./dates.ts";
import { GarminError } from "./errors.ts";

const PAGE = 20;

export type ListOptions = { start: string; end?: string; type?: string; sortOrder?: "asc" | "desc" };

/** Activities between two dates, fetched 20 at a time like the web app. */
export async function listActivities(client: GarminClient, options: ListOptions): Promise<unknown[]> {
  parseDate(options.start);
  if (options.end) parseDate(options.end);
  const all: unknown[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.get<unknown[] | null>("/activitylist-service/activities/search/activities", {
      startDate: options.start,
      endDate: options.end,
      activityType: options.type,
      sortOrder: options.sortOrder,
      start: offset,
      limit: PAGE,
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
  }
  return all;
}

function activityPath(id: string | number, suffix = ""): string {
  const text = String(id);
  if (!/^\d{1,20}$/.test(text)) throw new GarminError("error", "Activity ids are numbers.");
  return `/activity-service/activity/${text}${suffix}`;
}

export const getActivity = (client: GarminClient, id: string | number) => client.get(activityPath(id));
export const activitySplits = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/splits"));
export const activityTypedSplits = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/typedsplits"));
export const activityHrZones = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/hrTimeInZones"));
export const activityPowerZones = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/powerTimeInZones"));
export const activityWeather = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/weather"));
export const activityExerciseSets = (client: GarminClient, id: string | number) => client.get(activityPath(id, "/exerciseSets"));
