/** Downloads an activity's FIT file from Garmin Connect and analyses its descent. */
import type { GarminClient } from "./client.ts";
import { analyzeDescent, type DescentAnalysis } from "./descent.ts";
import { GarminError } from "./errors.ts";
import { decodeFit, type FitFile } from "./fit.ts";
import { readZipEntry } from "./zip.ts";

/** Garmin ids are plain integers: refuse anything else before it reaches a URL. */
function activityPath(id: string | number): string {
  if (!/^\d{1,20}$/.test(String(id))) throw new GarminError("error", "Activity id must be a number.");
  return `/download-service/files/activity/${id}`;
}

/** The original .fit of an activity, unzipped. Uses one request. */
export async function downloadActivityFit(client: GarminClient, id: string | number): Promise<Uint8Array> {
  const archive = await client.request<Uint8Array>("GET", activityPath(id), { raw: true, timeoutMs: 60_000 });
  return readZipEntry(archive);
}

/** Decodes the FIT file of an activity. */
export async function activityFitFile(client: GarminClient, id: string | number): Promise<FitFile> {
  return decodeFit(await downloadActivityFit(client, id));
}

/** Descent analysis of an activity (null when the file carries too little altitude data). */
export async function activityDescent(client: GarminClient, id: string | number): Promise<DescentAnalysis | null> {
  return analyzeDescent(await activityFitFile(client, id));
}
