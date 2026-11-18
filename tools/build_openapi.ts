#!/usr/bin/env node
/**
 * Build an OpenAPI 3.0.3 description of the Garmin Connect web API from discovery reports.
 *
 * Input : one or more reports written by tools/discover_console.js (or discover_api.py).
 * Output: an OpenAPI 3.0.3 JSON document.
 *
 *     node tools/build_openapi.ts tools/run1.json -o docs/garmin-connect.openapi.json
 *
 * The reports contain only shapes (key paths and types), so the schemas are *observed* shapes for one
 * account: every property is optional and nullable, enums and formats are not known, and a property that
 * was never non-empty in the capture is missing. This is a reference for exploration, not a contract.
 *
 * This file is a faithful TypeScript port of tools/build_openapi.py; the output must stay byte-identical
 * to the Python version so that both tools can be compared on the same reports.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

/** Date path segments (and date-like object keys) are collapsed into a single dynamic node. */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}/;

/** Query parameters whose observed values were always integers, so the schema can say so. */
const INT_QUERY = new Set([
  "limit", "start", "maxChartSize", "maxPolylineSize", "numberOfBests", "numDaysForward",
  "nonSleepBufferMinutes", "metricId", "userId", "per-page", "pid", "likerLimit",
]);

/** Query parameters whose observed values were always booleans. */
const BOOL_QUERY = new Set([
  "includeOverlaps", "includeHistory", "includeAll", "populateMealsV2", "ignorePriority", "groupByActivityType",
  "groupByParentActivityType", "groupByEventType", "standardizedUnits", "includeBiometric", "includeVO2Max",
  "ByParentType", "userFirstDay",
]);

/** Query parameters whose observed values were always calendar dates. */
const DATE_QUERY = new Set([
  "date", "startDate", "endDate", "calendarDate", "fromDate", "untilDate", "fromCalendarDate", "toCalendarDate",
  "currentDate",
]);

/** Services that only serve the web UI chrome (menus, consents, social feed); flagged as ui-noise. */
const NOISE_SERVICES = new Set([
  "userpreference-service", "gdprconsent-service", "consentTextServices", "myfitnesspal-service", "partner-service",
  "badge-service", "follower-service", "conversation-service", "omt-api", "golf-api", "gcs-api", "worker",
  "site-status", "web-api", "web-data", "system-service", "preference", "inbox", "snapshot",
]);

/** Path segment prefixes that host the real services but are not part of the service name. */
const API_PREFIXES = new Set(["gc-api", "golf-api", "web-api", "omt-api"]);

/** A field map from a discovery report: key path -> observed JSON types ("bool" means boolean). */
type FieldMap = Record<string, string[]>;

/** One captured request in a discovery report. */
interface Endpoint {
  method: string;
  host?: string;
  path: string;
  statuses: number[];
  queryParams: string[];
  seenOn: string[];
  fields: FieldMap;
}

/** Top-level shape of a discovery report. */
interface Report {
  endpoints: Endpoint[];
}

/** OpenAPI path parameter generated from a placeholder or a numeric segment. */
interface PathParam {
  name: string;
  in: "path";
  required: true;
  schema: Record<string, unknown>;
}

/** Accumulated knowledge about one (method, templated path) pair across reports. */
interface MergedEndpoint {
  method: string;
  template: string;
  params: PathParam[];
  query: Set<string>;
  statuses: Set<number>;
  pages: Set<string>;
  root: ShapeNode;
  paths: Set<string>;
}

/** Map discovery type names to JSON Schema type names. */
const JSON_TYPE: Record<string, string> = {
  number: "number",
  string: "string",
  bool: "boolean",
  object: "object",
  array: "array",
};

/** Turn a path segment ("activity-service") into an operation id fragment ("ActivityService"). */
function camel(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Shape tree: one node per JSON path. A node remembers every type seen at that path, its properties,
 * the schema of array elements, and the schema of dynamic keys (device ids, dates).
 */
class ShapeNode {
  readonly types = new Set<string>();
  readonly props = new Map<string, ShapeNode>();
  items: ShapeNode | undefined;
  wild: ShapeNode | undefined;

  /** Return (creating if needed) the child node for a named property, or the wildcard child for "*". */
  child(name: string): ShapeNode {
    if (name === "*") {
      this.wild ??= new ShapeNode();
      return this.wild;
    }
    let node = this.props.get(name);
    if (!node) {
      node = new ShapeNode();
      this.props.set(name, node);
    }
    return node;
  }

  /** Return (creating if needed) the node describing array elements. */
  element(): ShapeNode {
    this.items ??= new ShapeNode();
    return this.items;
  }
}

/**
 * Merge one endpoint's observed field map into its shape tree.
 *
 * Key paths use "." for properties and "[]" for arrays, for example "items[].metrics[]" or
 * "summaryDTO.distance". Numeric segments and dates become dynamic keys ("additionalProperties").
 */
function addFields(root: ShapeNode, fields: FieldMap): void {
  for (const [path, types] of Object.entries(fields)) {
    let node = root;
    for (const token of path.split(".")) {
      let name = token;
      let arrays = 0;
      while (name.endsWith("[]")) {
        name = name.slice(0, -2);
        arrays += 1;
      }
      if (name) {
        if (/^\d+$/.test(name) || DATE_KEY.test(name)) name = "*";
        node = node.child(name);
      }
      for (let i = 0; i < arrays; i += 1) {
        node.types.add("array");
        node = node.element();
      }
    }
    for (const type of types) node.types.add(type);
  }

  // Any node that holds properties is an object, even if the report never recorded "object" for it.
  const stack: ShapeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.props.size > 0 || node.wild) node.types.add("object");
    for (const child of [...node.props.values(), node.wild, node.items]) {
      if (child) stack.push(child);
    }
  }
}

/** Build the JSON Schema for a shape tree node, sorted for stable output. */
function schemaOf(node: ShapeNode): Record<string, unknown> {
  const kinds = [...node.types]
    .filter((type) => type in JSON_TYPE)
    .map((type) => JSON_TYPE[type])
    .sort();

  const one = (kind: string): Record<string, unknown> => {
    const schema: Record<string, unknown> = { type: kind };
    if (kind === "object") {
      if (node.props.size > 0) {
        const properties: Record<string, unknown> = {};
        for (const key of [...node.props.keys()].sort()) properties[key] = schemaOf(node.props.get(key)!);
        schema.properties = properties;
      }
      if (node.wild) schema.additionalProperties = schemaOf(node.wild);
    }
    if (kind === "array") schema.items = node.items ? schemaOf(node.items) : {};
    return schema;
  };

  let schema: Record<string, unknown> = {};
  if (kinds.length === 1) schema = one(kinds[0]!);
  else if (kinds.length > 1) schema = { oneOf: kinds.map(one) };
  if (node.types.has("null")) schema.nullable = true;
  return schema;
}

/**
 * Find user names such as `Jane.D.` that appear as a path segment and must be redacted.
 *
 * A user name recurs in many service paths (profile, followers, ...), whereas a preference key or a
 * file name appears once; names given on the command line are always redacted.
 */
function findDisplayNames(paths: string[], explicit: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    for (const segment of new Set(path.split("/"))) {
      if (
        segment.includes(".") &&
        !segment.includes("{") &&
        /^[\w.-]+$/u.test(segment) &&
        !/\.[a-z]{2,5}$/.test(segment)
      ) {
        counts.set(segment, (counts.get(segment) ?? 0) + 1);
      }
    }
  }
  const names = new Set(explicit);
  for (const [segment, count] of counts) {
    if (count >= 5) names.add(segment);
  }
  return names;
}

/** Path parameter name inferred from the previous segment (the API is not self-describing). */
const PARAM_BY_PREV: Record<string, string> = {
  activity: "activityId",
  ACTIVITY: "activityId",
  chartconfig: "chartId",
  weekly: "weeks",
  im: "days",
  preference: "preferenceKey",
};

/**
 * Turn a concrete captured path into an OpenAPI template plus its path parameters.
 *
 * Dates, ids, GUIDs, e-mails and display names were normalised to placeholders by the discovery
 * script, but raw numeric segments and known user names may still be present.
 */
function parametrise(path: string, displayNames: Set<string>): { template: string; params: PathParam[] } {
  const segments = path.split("/");
  const dateCount = segments.filter((segment) => segment === "{date}").length;
  const out: string[] = [];
  const params: PathParam[] = [];
  let dateIndex = 0;

  segments.forEach((segment, i) => {
    const prev = i > 0 ? segments[i - 1]! : "";
    let name: string | undefined;
    let schema: Record<string, unknown> = {};

    if (displayNames.has(segment)) {
      name = "displayName";
      schema = { type: "string", description: "The account's Garmin display name (public profile name)." };
    } else if (segment === "{date}") {
      name = dateCount === 1 ? "date" : dateIndex === 0 ? "startDate" : "endDate";
      dateIndex += 1;
      schema = { type: "string", format: "date" };
    } else if (segment === "{id}") {
      name = prev === "daily" ? "userProfileId" : (PARAM_BY_PREV[prev] ?? "id");
      schema = { type: "integer", format: "int64" };
    } else if (segment === "{guid}") {
      name = "guid";
      schema = { type: "string", format: "uuid" };
    } else if (segment === "{email}") {
      name = "email";
      schema = { type: "string" };
    } else if (/^\d+$/.test(segment)) {
      // `daily/{date}/{id}` means a user profile; elsewhere the previous segment names the id.
      const before = prev === "{date}" && i > 1 ? segments[i - 2]! : prev;
      name = PARAM_BY_PREV[before] ?? "n";
      schema = { type: "integer" };
    }

    if (name === undefined) {
      out.push(segment);
      return;
    }
    while (params.some((param) => param.name === name)) name += "2";
    params.push({ name, in: "path", required: true, schema });
    out.push(`{${name}}`);
  });

  return { template: out.join("/"), params };
}

/** Describe a query parameter, using the known value domain when the name is recognised. */
function queryParam(name: string): Record<string, unknown> {
  let schema: Record<string, unknown>;
  if (DATE_QUERY.has(name)) schema = { type: "string", format: "date" };
  else if (BOOL_QUERY.has(name)) schema = { type: "boolean" };
  else if (INT_QUERY.has(name)) schema = { type: "integer" };
  else schema = { type: "string" };
  return {
    name,
    in: "query",
    required: false,
    schema,
    description: "Observed in the web app; the value domain is not known.",
  };
}

/** Read the CLI, build the document and write it. Returns the process exit code. */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "openapi.json" },
      "display-name": { type: "string", multiple: true, default: [] },
      version: { type: "string", default: "0.1.0" },
    },
  });

  const reports = positionals;
  if (reports.length === 0) {
    console.error("usage: node tools/build_openapi.ts <report.json>... [-o openapi.json] [--display-name NAME] [--version X.Y.Z]");
    return 2;
  }

  const raw: Endpoint[] = [];
  for (const report of reports) {
    const parsed = JSON.parse(await readFile(report, "utf8")) as Report;
    raw.push(...parsed.endpoints);
  }
  const names = findDisplayNames(raw.map((endpoint) => endpoint.path), values["display-name"]);

  const merged = new Map<string, MergedEndpoint>();
  for (const endpoint of raw) {
    const { template, params } = parametrise(endpoint.path, names);
    const method = endpoint.method.toLowerCase();
    const key = `${method} ${template}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = { method, template, params, query: new Set(), statuses: new Set(), pages: new Set(), root: new ShapeNode(), paths: new Set() };
      merged.set(key, entry);
    }
    for (const query of endpoint.queryParams) entry.query.add(query);
    for (const status of endpoint.statuses) entry.statuses.add(status);
    for (const page of endpoint.seenOn) entry.pages.add(parametrise(page, names).template);
    entry.paths.add(endpoint.path);
    addFields(entry.root, endpoint.fields);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>();
  const ordered = [...merged.values()].sort((a, b) => (
    a.template < b.template ? -1 : a.template > b.template ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0
  ));

  for (const entry of ordered) {
    const { method, template } = entry;
    const segments = template.split("/").filter((segment) => segment.length > 0);
    const skip = segments.length > 0 && API_PREFIXES.has(segments[0]!) ? 1 : 0;
    let service = segments.length > skip ? segments[skip]! : "root";
    if ((service === "web-gateway" || service === "modern") && segments.length > skip + 1) {
      service = segments[skip + 1]!;
    }

    const base = method + segments.slice(skip)
      .map((segment) => (segment.startsWith("{") ? "By" + camel(segment) : camel(segment)))
      .join("");
    let operationId = base;
    let suffix = 2;
    while (used.has(operationId)) {
      operationId = `${base}${suffix}`;
      suffix += 1;
    }
    used.add(operationId);

    const schema = schemaOf(entry.root);
    const responses: Record<string, unknown> = {
      "200": { description: "Observed response shape.", content: { "application/json": { schema } } },
    };
    for (const status of [...entry.statuses].filter((value) => value !== 200).sort((a, b) => a - b)) {
      responses[String(status)] = { description: "Observed at least once (for example, no data for that date)." };
    }

    const operation: Record<string, unknown> = {
      operationId,
      tags: [service],
      summary: `${method.toUpperCase()} ${template}`,
      parameters: [...entry.params, ...[...entry.query].sort().map(queryParam)],
      responses,
      "x-seen-on": [...entry.pages].filter((page) => page.length > 0).sort(),
    };
    if (template.startsWith("/gc-api/")) operation["x-gc-api-path"] = template.slice("/gc-api".length);
    if (NOISE_SERVICES.has(service)) operation["x-category"] = "ui-noise";

    (paths[template] ??= {})[method] = operation;
  }

  const tags = [...new Set(Object.values(paths).flatMap((item) => Object.values(item).map((op) => (op as { tags: string[] }).tags[0]!)))].sort();
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Garmin Connect web API (observed, unofficial)",
      version: values.version,
      description:
        "Reverse-engineered from the calls the Garmin Connect web app makes in a logged-in browser. " +
        "Not published or supported by Garmin and subject to change without notice. Shapes were captured as key paths " +
        "and types only (no values) for one account: all properties are optional, enums and units are unknown, and " +
        "fields that were always empty during the capture are absent. Authentication was not captured and is not " +
        "described here. The web app reaches these services under `/gc-api/`; `x-gc-api-path` gives the same path " +
        "without that prefix, which is the form `gc api` takes (to be confirmed per endpoint). Dynamic object keys " +
        "(device ids, dates) are shown as `additionalProperties`. Personal identifiers were replaced by placeholders.",
    },
    servers: [{ url: "https://connect.garmin.com", description: "Web app host (services live under /gc-api/)" }],
    tags: tags.map((name) => ({ name })),
    paths,
  };

  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(spec, null, 2) + "\n");
  const operations = Object.values(paths).reduce((total, item) => total + Object.keys(item).length, 0);
  console.error(`${operations} operations on ${Object.keys(paths).length} paths -> ${values.out}`);
  console.error(`redacted display name(s): ${names.size}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
