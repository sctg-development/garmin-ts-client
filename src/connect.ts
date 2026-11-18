/**
 * Generic access to every read-only endpoint found by the web-app discovery (see src/catalog.ts).
 *
 * The hand-written helpers (daily, activities, metrics...) normalise data for the coach; this layer is the
 * complement: it returns the raw Garmin payload for any catalogued endpoint, so a new data source is one
 * `garmin-ts connect <name>` away and callers can inspect it before a typed helper is written.
 */
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import type { GarminClient, Query } from "./client.ts";
import { localToday, resolveShortcut } from "./dates.ts";
import { GarminError } from "./errors.ts";

export { CATALOG, type CatalogEntry };

/** Names of the catalogued endpoints, sorted. */
export const endpointNames = (): string[] => CATALOG.map((entry) => entry.name);

/** Look an endpoint up by name; throws a `GarminError` with a hint when it does not exist. */
export function findEndpoint(name: string): CatalogEntry {
  const entry = CATALOG.find((candidate) => candidate.name === name);
  if (!entry) {
    const near = CATALOG.filter((candidate) => candidate.name.includes(name)).slice(0, 5).map((candidate) => candidate.name);
    throw new GarminError("error", `Unknown endpoint '${name}'.${near.length ? ` Did you mean: ${near.join(", ")}?` : " Run `connect list`."}`);
  }
  return entry;
}

const isDateParam = (name: string): boolean => /date$/i.test(name);

/**
 * Turn the caller's positional arguments into path values.
 *
 * - `displayName` is never positional: it is fetched from the profile (cached by the client).
 * - Date placeholders accept the usual shortcuts (`today`, `yesterday`, `week`, `month`) or YYYY-MM-DD.
 * - For a `{startDate}/{endDate}` pair, a range shortcut (`week`, `month`) fills both; a single date
 *   fills `startDate` and `endDate` defaults to today.
 * - Every other placeholder (ids, counts) is taken verbatim and URL-encoded.
 */
export async function resolvePathValues(client: Pick<GarminClient, "displayName">, entry: CatalogEntry, positional: string[], today: string = localToday()): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const queue = [...positional];
  for (const name of entry.params) {
    if (name === "displayName") {
      values[name] = await client.displayName();
    } else if (isDateParam(name)) {
      const given = queue.shift();
      if (given === undefined && name === "endDate") {
        values[name] = today;
        continue;
      }
      if (given === undefined) throw new GarminError("error", `Missing <${name}>. ${usage(entry)}`);
      const [start, end] = resolveShortcut(given, new Date(`${today}T12:00:00`));
      values[name] = start;
      // A range shortcut (`week`, `month`) also supplies the end of the pair: hand it to the next placeholder.
      if (name === "startDate" && end) queue.unshift(end);
    } else {
      const given = queue.shift();
      if (given === undefined) throw new GarminError("error", `Missing <${name}>. ${usage(entry)}`);
      values[name] = given;
    }
  }
  return values;
}

/** One-line usage string for an endpoint, e.g. `hrv-daily <startDate> [endDate]`. */
export function usage(entry: CatalogEntry): string {
  const args = entry.params.filter((p) => p !== "displayName").map((p) => (p === "endDate" ? `[${p}]` : `<${p}>`));
  const query = entry.query.length ? ` [--param ${entry.query.join("=… | ")}=…]` : "";
  return `Usage: connect ${entry.name}${args.length ? ` ${args.join(" ")}` : ""}${query}`;
}

/**
 * GET one catalogued endpoint and return the raw payload.
 *
 * @param client     authenticated client
 * @param name       catalog name (see `endpointNames()`)
 * @param positional values for the path placeholders, in order (see `resolvePathValues`)
 * @param query      extra query parameters (the names seen in the web app are listed in the catalog)
 */
export async function connect(client: GarminClient, name: string, positional: string[] = [], query: Query = {}): Promise<unknown> {
  const entry = findEndpoint(name);
  const values = await resolvePathValues(client, entry, positional);
  const path = entry.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(values[key] as string));
  return client.get(path, query);
}
