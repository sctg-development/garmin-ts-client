import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildCatalog } from "../tools/build_catalog.ts";
import { CATALOG } from "../src/catalog.ts";
import { connect, findEndpoint, resolvePathValues, usage } from "../src/connect.ts";

const spec = JSON.parse(readFileSync(new URL("../docs/garmin-connect.openapi.json", import.meta.url), "utf8"));
const fakeClient = (calls: string[] = []) =>
  ({ displayName: async () => "me", get: async (path: string, params?: object) => (calls.push(path + (params && Object.keys(params).length ? `?${new URLSearchParams(params as Record<string, string>)}` : "")), { ok: true }) }) as never;

test("the committed catalog is up to date with the OpenAPI file", () => {
  assert.deepEqual(CATALOG, buildCatalog(spec), "run: node tools/build_catalog.ts docs/garmin-connect.openapi.json --ts src/catalog.ts --py ../garmin-cli/src/garmincli/catalog.py");
});

test("every discovered Connect API read endpoint is in the catalog", () => {
  const known = new Set(CATALOG.map((entry) => entry.path));
  const missing: string[] = [];
  for (const [webPath, item] of Object.entries<Record<string, { "x-category"?: string; "x-gc-api-path"?: string }>>(spec.paths)) {
    const op = item.get;
    if (!op || op["x-category"] === "ui-noise" || !webPath.startsWith("/gc-api/")) continue;
    const path = (op["x-gc-api-path"] ?? webPath.slice("/gc-api".length)).replace(/\/+$/, "");
    if (!known.has(path)) missing.push(path);
  }
  assert.deepEqual(missing, []);
});

test("catalog names are unique and placeholders are listed in path order", () => {
  assert.equal(new Set(CATALOG.map((entry) => entry.name)).size, CATALOG.length);
  const hrv = findEndpoint("hrv-daily");
  assert.deepEqual(hrv.params, ["startDate", "endDate"]);
});

test("unknown endpoint names suggest close matches", () => {
  assert.throws(() => findEndpoint("hrv-dail"), /Did you mean: hrv-daily/);
});

test("displayName is automatic, dates accept shortcuts and a lone start date ends today", async () => {
  const values = await resolvePathValues(fakeClient(), findEndpoint("hrv-daily"), ["2026-11-01"], "2026-11-17");
  assert.deepEqual(values, { startDate: "2026-11-01", endDate: "2026-11-17" });
  const week = await resolvePathValues(fakeClient(), findEndpoint("hrv-daily"), ["week"], "2026-11-17");
  assert.deepEqual(week, { startDate: "2026-11-10", endDate: "2026-11-17" });
  const named = await resolvePathValues(fakeClient(), findEndpoint("userprofile-biometric-current"), []);
  assert.deepEqual(named, { displayName: "me" });
});

test("missing placeholders produce a usage hint", async () => {
  await assert.rejects(resolvePathValues(fakeClient(), findEndpoint("userstats-statistics-chartconfig"), []), /Missing <chartId>.*Usage: connect/);
  assert.match(usage(findEndpoint("hrv-daily")), /<startDate> \[endDate\]/);
});

test("connect fills the path, encodes ids and forwards query parameters", async () => {
  const calls: string[] = [];
  await connect(fakeClient(calls), "userstats-statistics-chartconfig", ["a/b"]);
  await connect(fakeClient(calls), "wellness-daily-heart-rate", [], { date: "2026-11-17" });
  assert.deepEqual(calls, ["/userstats-service/statistics/chartconfig/a%2Fb", "/wellness-service/wellness/dailyHeartRate?date=2026-11-17"]);
});
