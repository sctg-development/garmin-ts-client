import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GarminClient } from "../src/client.ts";
import { GarminAuthError, GarminError, GarminRateLimitError } from "../src/errors.ts";
import { FileTokenStore, defaultTokenFile, parseTokens, tokenExpiry } from "../src/tokens.ts";

const jwt = (exp: number, extra: Record<string, unknown> = {}) => `h.${Buffer.from(JSON.stringify({ exp, client_id: "CLIENT_X", ...extra })).toString("base64url")}.s`;
const NOW = 1_800_000_000_000;
const inSeconds = (s: number) => Math.floor(NOW / 1000) + s;

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? String(init.body) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isAuth = (call: Call) => call.url.includes("diauth");

async function tokenDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "garmin-ts-"));
  return { dir, file: path.join(dir, "garmin_tokens.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const blob = (access: string, refresh = "R1") => JSON.stringify({ di_token: access, di_refresh_token: refresh, di_client_id: "CLIENT_X" });

test("requests carry the mobile headers and a Bearer token, and the query string", async () => {
  const { impl, calls } = fakeFetch(() => json({ ok: 1 }));
  const client = GarminClient.fromBlob(blob(jwt(inSeconds(7200))), { fetch: impl, now: () => NOW });
  assert.deepEqual(await client.get("/x-service/y", { a: 1, b: "two", skip: undefined }), { ok: 1 });
  assert.equal(calls[0]?.url, "https://connectapi.garmin.com/x-service/y?a=1&b=two");
  assert.match(calls[0]?.headers.Authorization ?? "", /^Bearer h\./);
  assert.equal(calls[0]?.headers["User-Agent"], "GCM-Android-5.23");
  assert.equal(calls[0]?.headers["X-Garmin-Client-Platform"], "Android");
});

test("an expired token is refreshed before the request, and the file keeps private permissions", async () => {
  const t = await tokenDir();
  try {
    await writeFile(t.file, blob(jwt(inSeconds(60))), { mode: 0o600 });
    const fresh = jwt(inSeconds(80_000));
    const { impl, calls } = fakeFetch((call) => (isAuth(call) ? json({ access_token: fresh, refresh_token: "R2" }) : json([])));
    const client = GarminClient.fromFile(t.file, { fetch: impl, now: () => NOW });
    await client.get("/a");
    assert.deepEqual(calls.map((c) => (isAuth(c) ? "auth" : "api")), ["auth", "api"]);
    assert.match(calls[0]?.headers.Authorization ?? "", /^Basic /);
    assert.match(calls[0]?.body ?? "", /grant_type=refresh_token/);
    assert.equal(calls[1]?.headers.Authorization, `Bearer ${fresh}`);
    const saved = JSON.parse(await readFile(t.file, "utf8"));
    assert.equal(saved.di_token, fresh);
    assert.equal(saved.di_refresh_token, "R2");
    assert.equal((await stat(t.file)).mode & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
});

test("a 401 triggers one refresh and one retry; a second 401 is an authentication error", async () => {
  const fresh = jwt(inSeconds(80_000));
  let first = true;
  const ok = fakeFetch((call) => (isAuth(call) ? json({ access_token: fresh }) : first ? ((first = false), new Response("", { status: 401 })) : json({ fine: true })));
  const client = GarminClient.fromBlob(blob(jwt(inSeconds(7200))), { fetch: ok.impl, now: () => NOW });
  assert.deepEqual(await client.get("/a"), { fine: true });
  assert.equal(ok.calls.filter(isAuth).length, 1);

  const bad = fakeFetch((call) => (isAuth(call) ? json({ access_token: fresh }) : new Response("", { status: 401 })));
  const failing = GarminClient.fromBlob(blob(jwt(inSeconds(7200))), { fetch: bad.impl, now: () => NOW });
  await assert.rejects(failing.get("/a"), (error: unknown) => error instanceof GarminAuthError && error.code === "auth");
});

test("concurrent requests share a single refresh", async () => {
  const fresh = jwt(inSeconds(80_000));
  const { impl, calls } = fakeFetch(async (call) => {
    if (isAuth(call)) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ access_token: fresh, refresh_token: "R2" });
    }
    return json({});
  });
  const client = GarminClient.fromBlob(blob(jwt(inSeconds(10))), { fetch: impl, now: () => NOW });
  await Promise.all([client.get("/a"), client.get("/b"), client.get("/c"), client.get("/d")]);
  assert.equal(calls.filter(isAuth).length, 1);
});

test("two clients on the same file refresh once: the second adopts the first's tokens", async () => {
  const t = await tokenDir();
  try {
    await writeFile(t.file, blob(jwt(inSeconds(10))), { mode: 0o600 });
    const fresh = jwt(inSeconds(80_000));
    const { impl, calls } = fakeFetch(async (call) => {
      if (isAuth(call)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return json({ access_token: fresh, refresh_token: "R2" });
      }
      return json({});
    });
    const a = GarminClient.fromFile(t.file, { fetch: impl, now: () => NOW });
    const b = GarminClient.fromFile(t.file, { fetch: impl, now: () => NOW });
    await Promise.all([a.get("/a"), b.get("/b")]);
    assert.equal(calls.filter(isAuth).length, 1, "Garmin rotates the refresh token: a second refresh would burn it");
    assert.equal(JSON.parse(await readFile(t.file, "utf8")).di_refresh_token, "R2");
  } finally {
    await t.cleanup();
  }
});

test("errors are classified: 429, 404, 5xx with retry, network failure", async () => {
  const token = blob(jwt(inSeconds(7200)));
  const make = (handler: (call: Call) => Response) => GarminClient.fromBlob(token, { fetch: fakeFetch(handler).impl, now: () => NOW, retries: 2 });
  await assert.rejects(make(() => new Response("", { status: 429 })).get("/a"), GarminRateLimitError);
  await assert.rejects(make(() => new Response("", { status: 404 })).get("/a"), (e: unknown) => e instanceof GarminError && e.code === "not_found");
  let attempts = 0;
  const flaky = make(() => (++attempts < 3 ? new Response("", { status: 500 }) : json({ ok: true })));
  assert.deepEqual(await flaky.get("/a"), { ok: true });
  assert.equal(attempts, 3);
  const down = GarminClient.fromBlob(token, { fetch: (async () => { throw new Error("offline"); }) as typeof fetch, now: () => NOW, retries: 0 });
  await assert.rejects(down.get("/a"), (e: unknown) => e instanceof GarminError && e.code === "connection");
  assert.equal(await make(() => new Response(null, { status: 204 })).get("/a"), null);
});

test("token information never exposes a token", async () => {
  const client = GarminClient.fromBlob(blob(jwt(inSeconds(3600))), { fetch: fakeFetch(() => json({})).impl, now: () => NOW });
  const info = await client.tokenInfo();
  assert.deepEqual(Object.keys(info).sort(), ["canRefresh", "expiresInS"]);
  assert.equal(info.expiresInS, 3600);
  assert.equal(info.canRefresh, true);
});

test("the display name is fetched once and cached", async () => {
  const { impl, calls } = fakeFetch(() => json({ displayName: "someone" }));
  const client = GarminClient.fromBlob(blob(jwt(inSeconds(7200))), { fetch: impl, now: () => NOW });
  assert.equal(await client.displayName(), "someone");
  assert.equal(await client.displayName(), "someone");
  assert.equal(calls.length, 1);
});

test("token parsing and the default token file", async () => {
  assert.throws(() => parseTokens("nope"), GarminAuthError);
  assert.throws(() => parseTokens("{}"), GarminAuthError);
  assert.equal(parseTokens(blob("a.b.c")).di_client_id, "CLIENT_X");
  assert.equal(tokenExpiry(jwt(123)), 123);
  assert.equal(tokenExpiry("not-a-jwt"), null);
  assert.equal(defaultTokenFile({ GARMINTOKENS: "/tmp/x" } as NodeJS.ProcessEnv), "/tmp/x/garmin_tokens.json");
  assert.equal(defaultTokenFile({ GARMINTOKENS: "/tmp/x/t.json" } as NodeJS.ProcessEnv), "/tmp/x/t.json");
  await assert.rejects(new FileTokenStore("/nonexistent/dir/garmin_tokens.json").load(), GarminAuthError);
});
