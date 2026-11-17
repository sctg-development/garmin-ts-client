import assert from "node:assert/strict";
import { test } from "node:test";
import { GarminAuthError, GarminRateLimitError } from "../src/errors.ts";
import { login } from "../src/login.ts";

const jwt = `h.${Buffer.from(JSON.stringify({ client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", exp: 9999999999 })).toString("base64url")}.s`;

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeGarmin(loginBody: unknown, options: { loginStatus?: number; failClients?: number } = {}) {
  const seen: Seen[] = [];
  let exchanges = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    if (url.includes("/mobile/sso/en_US/sign-in")) {
      const headers = new Headers();
      headers.append("set-cookie", "SESSION=abc; Path=/; HttpOnly");
      headers.append("set-cookie", "__cf_bm=xyz; Path=/");
      return new Response("<html></html>", { status: 200, headers });
    }
    if (url.includes("/mobile/api/login")) return new Response(JSON.stringify(loginBody), { status: options.loginStatus ?? 200 });
    exchanges += 1;
    if (exchanges <= (options.failClients ?? 0)) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ access_token: jwt, refresh_token: "R" }), { status: 200 });
  }) as typeof fetch;
  return { impl, seen };
}

test("sign-in loads the page, replays its cookies, posts the credentials and exchanges the ticket", async () => {
  const { impl, seen } = fakeGarmin({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-1" });
  const result = await login("me@example.org", "pw", { fetch: impl, delayMs: () => 0 });
  assert.equal(result.status, "ok");
  assert.deepEqual(seen.map((s) => s.method), ["GET", "POST", "POST"]);
  assert.equal(seen[1]?.headers.Cookie, "SESSION=abc; __cf_bm=xyz");
  assert.deepEqual(JSON.parse(seen[1]?.body ?? "{}"), { username: "me@example.org", password: "pw", rememberMe: true, captchaToken: "" });
  assert.match(seen[2]?.body ?? "", /service_ticket=ST-1/);
  if (result.status === "ok") {
    assert.equal(result.tokens.di_refresh_token, "R");
    assert.equal(result.tokens.di_client_id, "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2");
  }
});

test("the exchange tries the next client id when one is refused", async () => {
  const { impl, seen } = fakeGarmin({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-1" }, { failClients: 2 });
  assert.equal((await login("a", "b", { fetch: impl, delayMs: () => 0 })).status, "ok");
  assert.equal(seen.filter((s) => s.url.includes("diauth")).length, 3);
});

test("multi-factor, wrong password and rate limiting are reported distinctly", async () => {
  const mfa = fakeGarmin({ responseStatus: { type: "MFA_REQUIRED" } });
  assert.deepEqual(await login("a", "b", { fetch: mfa.impl, delayMs: () => 0 }), { status: "needs_mfa" });
  const wrong = fakeGarmin({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } });
  await assert.rejects(login("a", "b", { fetch: wrong.impl, delayMs: () => 0 }), GarminAuthError);
  const limited = fakeGarmin({}, { loginStatus: 429 });
  await assert.rejects(login("a", "b", { fetch: limited.impl, delayMs: () => 0 }), GarminRateLimitError);
});

test("an error never carries the password", async () => {
  const wrong = fakeGarmin({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } });
  await login("me@example.org", "s3cret-pw", { fetch: wrong.impl, delayMs: () => 0 }).catch((error: Error) => {
    assert.ok(!error.message.includes("s3cret-pw") && !error.message.includes("me@example.org"));
  });
});
