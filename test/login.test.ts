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
  const pending = await login("a", "b", { fetch: mfa.impl, delayMs: () => 0 });
  assert.equal(pending.status, "needs_mfa");
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

/** A fake SSO that asks for a code, then answers each verifyCode endpoint with the given bodies. */
function fakeMfa(verify: { mobile: [number, unknown]; portal?: [number, unknown] }) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    if (url.includes("/mobile/sso/en_US/sign-in")) return new Response("<html></html>", { status: 200, headers: { "set-cookie": "SESSION=abc; Path=/" } });
    if (url.includes("/mobile/api/login")) return new Response(JSON.stringify({ responseStatus: { type: "MFA_REQUIRED" }, customerMfaInfo: { mfaLastMethodUsed: "sms" } }));
    if (url.includes("/mobile/api/mfa/verifyCode")) return new Response(JSON.stringify(verify.mobile[1]), { status: verify.mobile[0] });
    if (url.includes("/portal/api/mfa/verifyCode")) return new Response(JSON.stringify(verify.portal?.[1] ?? {}), { status: verify.portal?.[0] ?? 200 });
    return new Response(JSON.stringify({ access_token: jwt, refresh_token: "R" }), { status: 200 });
  }) as typeof fetch;
  return { impl, seen };
}

test("a multi-factor code is verified with the session cookies and yields tokens", async () => {
  const { impl, seen } = fakeMfa({ mobile: [200, { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-9" }] });
  const pending = await login("a", "b", { fetch: impl, delayMs: () => 0 });
  assert.equal(pending.status, "needs_mfa");
  if (pending.status !== "needs_mfa") return;
  assert.equal(pending.method, "sms");
  const tokens = await pending.complete("123456");
  assert.equal(tokens.di_refresh_token, "R");
  const verify = seen.find((s) => s.url.includes("/mobile/api/mfa/verifyCode"));
  assert.equal(verify?.headers.Cookie, "SESSION=abc");
  assert.deepEqual(JSON.parse(verify?.body ?? "{}"), { mfaMethod: "sms", mfaVerificationCode: "123456", rememberMyBrowser: true, reconsentList: [], mfaSetup: false });
  assert.match(seen.at(-1)?.body ?? "", /service_ticket=ST-9/);
});

test("the portal endpoint is the fallback when the mobile one refuses the code", async () => {
  const { impl, seen } = fakeMfa({ mobile: [200, { responseStatus: { type: "MFA_CODE_INVALID" } }], portal: [200, { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-2" }] });
  const pending = await login("a", "b", { fetch: impl, delayMs: () => 0 });
  if (pending.status !== "needs_mfa") throw new Error("expected needs_mfa");
  await pending.complete("111111");
  assert.ok(seen.some((s) => s.url.includes("/portal/api/mfa/verifyCode")));
});

test("a wrong code fails with the reasons but never the response body", async () => {
  const { impl } = fakeMfa({ mobile: [200, { responseStatus: { type: "MFA_CODE_INVALID" }, serviceTicketId: "SECRET-TICKET" }], portal: [200, { responseStatus: { type: "MFA_CODE_INVALID" } }] });
  const pending = await login("a", "b", { fetch: impl, delayMs: () => 0 });
  if (pending.status !== "needs_mfa") throw new Error("expected needs_mfa");
  await assert.rejects(pending.complete("000000"), (error: Error) => error instanceof GarminAuthError && /MFA_CODE_INVALID/.test(error.message) && !/SECRET/.test(error.message));
});

test("rate limiting on every verify endpoint is reported as such", async () => {
  const { impl } = fakeMfa({ mobile: [429, {}], portal: [429, {}] });
  const pending = await login("a", "b", { fetch: impl, delayMs: () => 0 });
  if (pending.status !== "needs_mfa") throw new Error("expected needs_mfa");
  await assert.rejects(pending.complete("1"), GarminRateLimitError);
});
