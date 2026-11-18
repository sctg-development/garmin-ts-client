#!/usr/bin/env node
/**
 * Generate the endpoint catalog from the OpenAPI description of the Garmin Connect web API.
 *
 *     node tools/build_catalog.ts docs/garmin-connect.openapi.json \
 *         --ts src/catalog.ts --py ../garmin-cli/src/garmincli/catalog.py
 *
 * Why a catalog: the discovery produced ~100 read-only endpoints. Hand-writing one command per endpoint
 * in two code bases would drift, so both the TypeScript client (`garmin-ts connect <name>`) and the Python
 * CLI (`gc connect <name>`) are driven by the same generated table. Re-run this script after the OpenAPI
 * file changes; the tests of both repositories fail when the generated files are out of date.
 *
 * What is kept: GET operations of the `/gc-api/` web API that are not tagged `x-category: ui-noise`.
 * The golf and campaign gateways (`/golf-api/`, `/omt-api/`) are not part of the Connect API proper and
 * are skipped. The path used at runtime is `x-gc-api-path` (the form `connectapi.garmin.com` takes) when
 * the capture recorded it, otherwise the web path without its `/gc-api` prefix.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

/** One entry of the catalog. Kept deliberately small: it is embedded in both code bases. */
export type CatalogEntry = {
  /** Stable kebab-case command name, unique across the catalog. */
  name: string;
  /** Connect API path with `{param}` placeholders. */
  path: string;
  /** Path placeholders in order of appearance. */
  params: string[];
  /** Query parameters seen in the web app (names only: their value domain is unknown). */
  query: string[];
  /** Service the endpoint belongs to (OpenAPI tag). */
  service: string;
  /** Where the endpoint comes from: seen in the web app capture, or known from the garminconnect library. */
  source: "web" | "library";
};

type Operation = { tags?: string[]; parameters?: { name: string; in: string }[]; "x-category"?: string; "x-gc-api-path"?: string };
type Spec = { paths: Record<string, Record<string, Operation>> };

/**
 * Endpoints the web-app capture has not (yet) shown but that the `garminconnect` library, the engine behind
 * `gc`, calls on connectapi.garmin.com: they are known to exist, with the query parameters its methods send.
 * An endpoint also present in the capture keeps its captured entry (same path), so this list can only add.
 */
const LIBRARY_ENDPOINTS: { path: string; query?: string[] }[] = [
  { path: "/usersummary-service/stats/steps/daily/{startDate}/{endDate}" },
  { path: "/usersummary-service/stats/stress/weekly/{date}/{weeks}" },
  { path: "/usersummary-service/usersummary/hydration/daily/{date}" },
  { path: "/wellness-service/wellness/bodyBattery/reports/daily", query: ["startDate", "endDate"] },
  { path: "/bloodpressure-service/bloodpressure/range/{startDate}/{endDate}", query: ["includeAll"] },
  { path: "/metrics-service/metrics/endurancescore", query: ["calendarDate"] },
  { path: "/metrics-service/metrics/endurancescore/stats", query: ["startDate", "endDate", "aggregation"] },
  { path: "/metrics-service/metrics/hillscore", query: ["calendarDate"] },
  { path: "/metrics-service/metrics/hillscore/stats", query: ["startDate", "endDate", "aggregation"] },
  { path: "/metrics-service/metrics/runningtolerance/stats", query: ["startDate", "endDate", "aggregation"] },
  { path: "/metrics-service/metrics/trainingreadiness/{date}" },
  { path: "/metrics-service/metrics/trainingstatus/aggregated/{date}" },
  { path: "/wellness-service/wellness/daily/spo2/{date}" },
  { path: "/lifestylelogging-service/dailyLog/{date}" },
  { path: "/activitylist-service/activities/count" },
];

/** `dailySleepData` -> `daily-sleep-data`. */
const kebab = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** Static (non-placeholder) segments of a path, without the service prefix. */
function staticSegments(path: string): string[] {
  return path.split("/").filter((s) => s && !s.startsWith("{")).slice(1);
}

/**
 * Build the catalog from a parsed OpenAPI document.
 *
 * See the naming rule below; the result never depends on iteration order.
 */
export function buildCatalog(spec: Spec): CatalogEntry[] {
  const raw: (Omit<CatalogEntry, "name"> & { segments: string[] })[] = [];
  const addLibrary = () => {
    for (const known of LIBRARY_ENDPOINTS) {
      if (raw.some((e) => e.path === known.path)) continue;
      raw.push({
        path: known.path,
        params: [...known.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
        query: known.query ?? [],
        service: known.path.split("/")[1] ?? "",
        segments: staticSegments(known.path),
        source: "library",
      });
    }
  };
  for (const [webPath, item] of Object.entries(spec.paths)) {
    const op = item.get;
    if (!op || op["x-category"] === "ui-noise" || !webPath.startsWith("/gc-api/")) continue;
    // The web app sometimes calls the same endpoint with and without a trailing slash: keep one entry.
    const path = (op["x-gc-api-path"] ?? webPath.slice("/gc-api".length)).replace(/\/+$/, "");
    if (raw.some((e) => e.path === path)) continue;
    raw.push({
      path,
      params: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
      query: (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name),
      service: op.tags?.[0] ?? path.split("/")[1] ?? "",
      segments: staticSegments(path),
      source: "web",
    });
  }
  addLibrary();
  // Name = service + static segments as kebab tokens, with consecutive repeats removed
  // (`hrv-service/hrv/daily` -> `hrv-daily`). Endpoints that differ only by their placeholders get a
  // `-by-<n>` suffix so the name stays unique without depending on iteration order.
  const base = (e: (typeof raw)[number]) => {
    const tokens = kebab([e.service.replace(/-service$/, ""), ...e.segments].join("-")).split("-").filter(Boolean);
    return tokens.filter((t, i) => t !== tokens[i - 1]).join("-");
  };
  const counts = new Map<string, number>();
  for (const e of raw) counts.set(base(e), (counts.get(base(e)) ?? 0) + 1);
  const named = raw.map((e) => ({
    name: (counts.get(base(e)) ?? 0) > 1 ? `${base(e)}-by-${e.params.length}` : base(e),
    path: e.path,
    params: e.params,
    query: e.query,
    service: e.service,
    source: e.source,
  }));
  const seen = new Set<string>();
  for (const e of named) {
    if (seen.has(e.name)) throw new Error(`Catalog name collision: ${e.name} (${e.path})`);
    seen.add(e.name);
  }
  return named.sort((a, b) => a.name.localeCompare(b.name));
}

const HEADER = "Generated by tools/build_catalog.ts from docs/garmin-connect.openapi.json. Do not edit by hand.";

/** Render the TypeScript module. */
export function renderTs(entries: CatalogEntry[]): string {
  return `// ${HEADER}\n/** One read-only Garmin Connect endpoint discovered from the web app. */\nexport type CatalogEntry = { name: string; path: string; params: string[]; query: string[]; service: string; source: \"web\" | \"library\" };\n\nexport const CATALOG: CatalogEntry[] = ${JSON.stringify(entries, null, 2)};\n`;
}

/**
 * Render the Python module. The entries are embedded as a JSON string and parsed at import: converting
 * JSON literals to Python ones with a regex would also rewrite a path segment that happens to be `null`.
 * A plain module (not a data file) keeps PyInstaller builds free of data-file handling.
 */
export function renderPy(entries: CatalogEntry[]): string {
  const json = JSON.stringify(entries, null, 2);
  if (json.includes('"""') || json.includes("\\")) throw new Error("catalog entries must not contain backslashes or triple quotes");
  return `"""${HEADER}"""\n\nimport json\nfrom typing import Any\n\nCATALOG: list[dict[str, Any]] = json.loads(\n    r"""${json}"""\n)\n`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ts: { type: "string" }, py: { type: "string" } } });
  const [input] = positionals;
  if (!input) throw new Error("usage: build_catalog.ts <openapi.json> [--ts file] [--py file]");
  const entries = buildCatalog(JSON.parse(await readFile(input, "utf8")) as Spec);
  if (values.ts) await writeFile(values.ts, renderTs(entries));
  if (values.py) await writeFile(values.py, renderPy(entries));
  console.log(`${entries.length} endpoints`);
}

// Run only when executed directly, so tests can import buildCatalog.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() as string)) await main();
