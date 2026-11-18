/*
 * Discover the Garmin Connect web API from your own, already logged-in browser (no Playwright, no
 * login automation: Cloudflare Turnstile blocks automated browsers, not you).
 *
 * How to use
 *   1. Open https://connect.garmin.com/modern/ and log in as usual.
 *   2. Open DevTools (Cmd+Option+I) > Console, paste this whole file, press Enter.
 *      (Chrome may ask you to type "allow pasting" first.)
 *   3. Browse the pages you want to explore *inside the app* (click, don't reload: a reload removes the
 *      hook; if that happens, paste the file again, what was captured so far is kept for the tab).
 *      Suggestions: Sleep, HRV status, Health Status, Training Readiness, Training Status,
 *      Endurance Score, Stress, Body Battery, Respiration, Pulse Ox, an activity, Reports > Health.
 *   4. In the console run:   copy(garminDiscoveryReport())
 *      and paste the clipboard into a file (e.g. ~/discovery.json).
 *
 * What it records, and what it never records
 *   Records: method, status, URL path (dates, ids, GUIDs, e-mails replaced by placeholders), the NAMES
 *   of query parameters, and the SHAPE of the JSON response (key paths and value types).
 *   Never records: any value, header, cookie, token, request body or response body.
 *   It only reads; it sends nothing anywhere. Remove it with a page reload.
 *   Read the report before you share it: a path may still contain something personal.
 *
 * How it works (design notes)
 *   This file is meant to be pasted as-is in a DevTools console, so it must stay a single self-contained
 *   IIFE with no build step, no import and no dependency. It has two jobs:
 *
 *   1. Capture. It wraps `window.fetch` and `XMLHttpRequest.prototype.open` so that every response the
 *      Garmin Connect web app receives is inspected on the fly. The wrapping is idempotent: a guard flag
 *      (`window.__garminDiscoveryHooked`) prevents double-wrapping when the file is pasted twice, because
 *      stacking two wrappers would otherwise record every request twice and slow the page down.
 *
 *   2. Summarise. The report contains only the *shape* of the payloads ("what keys exist and what types
 *      do they hold"), never the values, so it can be shared and versioned safely. `tools/build_openapi.ts`
 *      consumes that shape to generate docs/garmin-connect.openapi.json.
 *
 *   The capture state lives in `sessionStorage` under a versioned key so that an accidental reload of the
 *   tab does not throw away what was recorded (sessionStorage survives reloads, unlike the page's JS
 *   state). A full or unavailable sessionStorage must never break the page: writes are best-effort.
 *
 *   The output is deliberately format-tolerant rather than exhaustive: depth and breadth are capped, and
 *   only the first elements of an array are inspected, so a huge response cannot freeze the console or
 *   produce a report too big to paste.
 */
(() => {
  // Versioned storage key: bump the version if the persisted structure ever changes, so an old capture
  // cannot be silently merged with a new one and produce a report with two incompatible shapes.
  const STORE = "garminDiscovery.v1";

  // Safety limits, applied to the *shape* walk, not to the payload itself:
  // - MAX_DEPTH stops recursion on deeply nested objects (some payloads contain long linked structures);
  // - MAX_PATHS caps the number of distinct key paths per response, so pathological payloads stay cheap.
  // Both trade completeness for responsiveness: they are high enough for the documented endpoints.
  const MAX_DEPTH = 7, MAX_PATHS = 500;

  // `data` is the whole capture, keyed by "METHOD /normalised/path". It is restored from sessionStorage
  // (if any) so a reload does not lose earlier browsing; a corrupt or foreign value is ignored rather
  // than crashing the console, hence the try/catch and the empty-object fallback.
  let data = {};
  try { data = JSON.parse(sessionStorage.getItem(STORE) || "{}"); } catch (_) { data = {}; }

  /**
   * Replace personal identifiers in a URL path with stable placeholders.
   *
   * Applied to both request paths and the page path (`seenOn`), so the same resource maps to the same
   * template wherever it appears. Order matters: e-mail first (it contains digits that the id rule would
   * otherwise eat), then GUID (it contains digits too), then dates, then long numeric ids. The id rule only
   * fires on 5+ digit runs that are not glued to letters, to avoid mangling names such as `5k` or
   * `vo2max`. Placeholders are the same `{email}`/`{guid}`/`{date}`/`{id}` tokens understood by
   * tools/build_openapi.ts.
   *
   * @param {string} p Raw pathname coming from the browser.
   * @returns {string} Path with placeholders, safe to write to disk and share.
   */
  const norm = (p) => p
    .replace(/[^/]+@[^/]+/g, "{email}")
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, "{guid}")
    .replace(/\d{4}-\d{2}-\d{2}/g, "{date}")
    .replace(/(?<![A-Za-z])\d{5,}(?![A-Za-z])/g, "{id}");

  /**
   * Name the JSON type of a value the way the discovery report stores it.
   *
   * Distinct type names matter because the report records *sets* of types per key path: an optional field
   * seen as both a number and null must be reported as `["number", "null"]`, which build_openapi.ts turns
   * into `nullable`. "bool" (not "boolean") is the historical name used by the report format; keep it.
   *
   * @param {unknown} v Any JSON value.
   * @returns {string} One of "null" | "array" | "object" | "number" | "bool" | "string".
   */
  const typeOf = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object"
    : typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "string";

  /**
   * Walk a JSON value and record the shape of every key path it contains.
   *
   * Paths use "." for object properties and "[]" for array elements, e.g. `summaryDTO.distance` or
   * `activityDetailMetrics[].metrics[]`. Only keys and types are kept; values are read to determine their
   * type and then discarded immediately, so no personal data leaks into the report.
   *
   * The walk is capped on purpose (see MAX_DEPTH / MAX_PATHS):
   * - for arrays, only the first 20 elements are inspected: real payloads repeat the same shape, and
   *   scanning thousands of points would be wasteful;
   * - the depth guard cuts recursion into nested containers once deep enough, and the size guard stops
   *   growing the result for exceptionally wide payloads. Both limits are checked *before* working, so a
   *   pathological payload costs nothing once the cap is reached.
   *
   * Note that the same key can be reached through different parents; paths are therefore merged into the
   * shared `out` map and their type lists are unioned, never overwritten.
   *
   * @param {unknown} v Value being walked (object, array or scalar).
   * @param {string} prefix Key path accumulated so far ("" at the root).
   * @param {number} depth Current recursion depth, compared with MAX_DEPTH.
   * @param {Record<string, string[]>} out Accumulator: key path -> observed type names.
   * @returns {void}
   */
  const shape = (v, prefix, depth, out) => {
    if (Object.keys(out).length >= MAX_PATHS || depth >= MAX_DEPTH) return;
    if (Array.isArray(v)) { v.slice(0, 20).forEach((c) => shape(c, prefix + "[]", depth + 1, out)); }
    else if (v && typeof v === "object") {
      for (const [k, c] of Object.entries(v)) {
        const name = prefix ? prefix + "." + k : k;
        // Create the entry first so that keys holding only `null`, empty objects or empty arrays still
        // appear in the report: their presence is meaningful even when their content is not.
        (out[name] = out[name] || []);
        const t = typeOf(c);
        if (!out[name].includes(t)) out[name].push(t);
        shape(c, name, depth + 1, out);
      }
    }
  };

  /**
   * Record one HTTP exchange into the capture, then persist it.
   *
   * Called for every Garmin response, from either the fetch or the XHR hook. It keeps the method, the
   * normalised path, the status codes seen, the *names* of the query parameters (not their values), and
   * the page from which the call was observed (`seenOn`). Responses to non-JSON payloads arrive here with
   * `json === undefined` and only contribute metadata, never a shape.
   *
   * Everything is merged rather than replaced: the same endpoint is often called from several pages, with
   * several statuses (403/404 when a date has no data), and each call exposes a different subset of the
   * optional fields. Unioning them gives a more complete shape than any single response.
   *
   * Non-Garmin hosts are ignored, and any malformed URL is dropped: the hook must never throw into the
   * page's request path.
   *
   * @param {string} method HTTP method, already upper-cased by the caller.
   * @param {string} rawUrl Absolute or relative URL given to fetch/XHR.
   * @param {number} status HTTP status of the response.
   * @param {unknown} [json] Parsed JSON body when the response was JSON, otherwise undefined.
   * @returns {void}
   */
  const record = (method, rawUrl, status, json) => {
    let u;
    // Resolve against the current page so relative URLs work; a broken URL simply ends the capture here.
    try { u = new URL(rawUrl, location.href); } catch (_) { return; }
    // The app also talks to other origins (analytics, CDNs); only Garmin's own API is interesting.
    if (!u.hostname.endsWith("garmin.com")) return;
    const path = norm(u.pathname), key = method + " " + path;
    // The "METHOD path" key collapses the query string and other per-call noise: the same endpoint is
    // captured once and enriched by every subsequent call.
    const e = (data[key] = data[key] || { method, host: u.hostname, path, statuses: [], queryParams: [], seenOn: [], fields: {} });
    if (!e.statuses.includes(status)) e.statuses.push(status);
    // Only parameter names are stored; values could be ids, dates or tokens and are never read.
    for (const q of u.searchParams.keys()) if (!e.queryParams.includes(q)) e.queryParams.push(q);
    // The page that triggered the call tells us where this endpoint is used in the UI, which is how
    // build_openapi.ts fills the `x-seen-on` documentation field.
    const page = norm(location.pathname);
    if (!e.seenOn.includes(page)) e.seenOn.push(page);
    if (json !== undefined) {
      const found = {};
      shape(json, "", 0, found);
      // Union the freshly found types into the endpoint's accumulated field map, key by key.
      for (const [name, types] of Object.entries(found)) {
        const have = (e.fields[name] = e.fields[name] || []);
        types.forEach((t) => { if (!have.includes(t)) have.push(t); });
      }
    }
    // Persisting on every call makes each response durable across a reload. If storage is full or
    // disabled, keep going in memory: losing durability is acceptable, breaking the page is not.
    try { sessionStorage.setItem(STORE, JSON.stringify(data)); } catch (_) { /* full: keep going in memory */ }
  };

  // Idempotence guard: pasting the file twice must not wrap fetch/XHR twice, or each response would be
  // recorded twice (and the wrappers would pile up). The flag is also what allows a second paste to be a
  // harmless no-op instead of an error.
  if (!window.__garminDiscoveryHooked) {
    window.__garminDiscoveryHooked = true;

    // ---- fetch hook -------------------------------------------------------------------------------
    // Wrapping fetch is the least intrusive way to observe the app's traffic: the original function is
    // kept and called with the same receiver and arguments, so page behaviour is unchanged. Only the
    // returned promise is augmented, to inspect the *clone* of the response: reading a clone leaves the
    // body that the app consumes intact.
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      // Be lenient about the many accepted call shapes (string, URL, Request, or init overrides).
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      return realFetch.apply(this, arguments).then((res) => {
        try {
          // Only JSON is parsed; anything else is recorded as metadata-only (no `json` argument). A parse
          // failure (truncated/streamed body, non-JSON despite the header) is treated the same way.
          if ((res.headers.get("content-type") || "").includes("json")) {
            res.clone().json().then((j) => record(method, url, res.status, j), () => record(method, url, res.status));
          }
        } catch (_) { /* never break the page */ }
        return res; // Return the original response untouched and synchronously resolved from the app's view.
      });
    };

    // ---- XMLHttpRequest hook ----------------------------------------------------------------------
    // Some parts of the app still use XHR. `open` is wrapped instead of `send` so that the method and URL
    // are captured at the earliest point, and a `load` listener reads the response once it is complete.
    // The original `open` is called last, with the original arguments, to keep the request identical.
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.addEventListener("load", () => {
        try {
          if ((this.getResponseHeader("content-type") || "").includes("json")) {
            // responseText is read but never stored; only its shape is derived below.
            let j; try { j = JSON.parse(this.responseText); } catch (_) { /* not JSON after all */ }
            record(String(method).toUpperCase(), url, this.status, j);
          }
        } catch (_) { /* never break the page */ }
      });
      return open.apply(this, arguments);
    };
  }

  // ---- Console API -------------------------------------------------------------------------------
  // Exposed on `window` because the user has to call them manually from the console. Kept as arrow
  // functions so they always see the current `data` binding (reset replaces it, see below).
  //
  // garminDiscoveryReport(): complete report as pretty JSON, ready for `copy(...)`. Endpoints are sorted by
  // path to make reports diffable between two captures; `capturedAt` records when the export was made (not
  // per endpoint, because the capture spans a whole browsing session).
  window.garminDiscoveryReport = () => JSON.stringify(
    { capturedAt: new Date().toISOString(), endpoints: Object.values(data).sort((a, b) => a.path.localeCompare(b.path)) }, null, 2);

  // garminDiscoveryReset(): throw away both the in-memory capture and its persisted copy, to start a clean
  // report (for example before a second browsing session dedicated to another area of the app).
  window.garminDiscoveryReset = () => { data = {}; sessionStorage.removeItem(STORE); };

  // Pasting the file should be self-explanatory: say whether the hook was already active, how much was
  // restored from sessionStorage, and what to do next. `data` may be non-empty on a second paste, which is
  // useful feedback rather than a bug.
  console.log("Garmin discovery hook active. " + Object.keys(data).length + " endpoint(s) already captured. " +
    "Browse inside the app, then run: copy(garminDiscoveryReport())");
})();
