/**
 * Experimental: Garmin mobile (iOS) sign-in with plain `fetch`, then exchange of the service ticket for
 * the DI token pair. Garmin's WAF may refuse a client whose TLS fingerprint is not a browser's; this is
 * the same flow garminconnect runs first, minus the fingerprint impersonation. When the account asks for a
 * multi-factor code, `login` returns `needs_mfa` with a `complete(code)` closure that finishes the same session.
 */
import { GarminAuthError, GarminError, GarminRateLimitError } from "./errors.ts";
import { DI_TOKEN_URL } from "./client.ts";
import { tokenClientId, type Tokens } from "./tokens.ts";

const SSO = "https://sso.garmin.com";
const IOS_CLIENT_ID = "GCM_IOS_DARK";
const IOS_SERVICE_URL = "https://mobile.integration.garmin.com/gcm/ios";
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const DI_GRANT_TYPE = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
const DI_CLIENT_IDS = ["GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4", "GARMIN_CONNECT_MOBILE_ANDROID_DI", "GARMIN_CONNECT_MOBILE_IOS_DI"];
const NATIVE_UA = "GCM-Android-5.23";
// The MFA code can be verified on the mobile or the portal endpoint: they share the SSO session cookies but
// may sit in different rate-limit buckets, so (like garminconnect) the second one is the fallback.
const PORTAL_CLIENT_ID = "GarminConnect";
const PORTAL_SERVICE_URL = "https://connect.garmin.com/app";

/**
 * `needs_mfa` carries what is needed to finish the sign-in: `method` is how Garmin delivers the code
 * (`email`, `sms`...), and `complete(code)` verifies it and returns the tokens.
 */
export type LoginResult = { status: "ok"; tokens: Tokens } | { status: "needs_mfa"; method: string; complete: (code: string) => Promise<Tokens> };
export type LoginOptions = { fetch?: typeof fetch; delayMs?: () => number };

class CookieJar {
  private readonly cookies = new Map<string, string>();
  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (pair && index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export async function login(email: string, password: string, options: LoginOptions = {}): Promise<LoginResult> {
  const doFetch = options.fetch ?? fetch;
  const jar = new CookieJar();
  const signinUrl = `${SSO}/mobile/sso/en_US/sign-in`;
  const query = new URLSearchParams({ clientId: IOS_CLIENT_ID, service: IOS_SERVICE_URL });

  const page = await doFetch(`${signinUrl}?${query}`, {
    headers: { "User-Agent": IOS_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(30_000),
  });
  jar.absorb(page);
  if (page.status === 429 || page.status === 427) throw new GarminRateLimitError("Garmin sign-in page rate limited this client.");
  if (page.status === 403) throw new GarminError("connection", "Garmin sign-in page answered 403 (bot challenge).", 403);
  await page.arrayBuffer();

  await new Promise((resolve) => setTimeout(resolve, options.delayMs?.() ?? 2000 + Math.random() * 3000));

  const response = await doFetch(`${SSO}/mobile/api/login?${new URLSearchParams({ clientId: IOS_CLIENT_ID, locale: "en-US", service: IOS_SERVICE_URL })}`, {
    method: "POST",
    headers: {
      "User-Agent": IOS_UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: SSO,
      Referer: `${signinUrl}?${query}`,
      Cookie: jar.header(),
    },
    body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: "" }),
    signal: AbortSignal.timeout(30_000),
  });
  jar.absorb(response);
  if (response.status === 429 || response.status === 427) throw new GarminRateLimitError(`Garmin login refused this client (HTTP ${response.status}); it can depend on the client fingerprint, not only the IP.`);
  if (response.status === 403) throw new GarminError("connection", "Garmin login answered 403 (bot challenge).", 403);
  const body = (await response.json().catch(() => null)) as { responseStatus?: { type?: string }; serviceTicketId?: string; error?: { "status-code"?: string } } | null;
  const type = body?.responseStatus?.type;
  if (type === "MFA_REQUIRED") {
    const method = ((body as { customerMfaInfo?: { mfaLastMethodUsed?: string } } | null)?.customerMfaInfo?.mfaLastMethodUsed) ?? "email";
    // Everything the verification needs (cookies, headers, params) is captured here, so the caller only
    // has to collect the code from the user.
    const loginParams = { clientId: IOS_CLIENT_ID, locale: "en-US", service: IOS_SERVICE_URL };
    const portalParams = { clientId: PORTAL_CLIENT_ID, locale: "en-US", service: PORTAL_SERVICE_URL };
    const complete = async (code: string): Promise<Tokens> => {
      const failures: string[] = [];
      let rateLimited = 0;
      const attempts = [
        { url: `${SSO}/mobile/api/mfa/verifyCode`, params: loginParams, service: IOS_SERVICE_URL },
        { url: `${SSO}/portal/api/mfa/verifyCode`, params: portalParams, service: PORTAL_SERVICE_URL },
      ];
      for (const attempt of attempts) {
        let verify: Response;
        try {
          verify = await doFetch(`${attempt.url}?${new URLSearchParams(attempt.params)}`, {
            method: "POST",
            headers: { "User-Agent": IOS_UA, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", Origin: SSO, Cookie: jar.header() },
            body: JSON.stringify({ mfaMethod: method, mfaVerificationCode: code, rememberMyBrowser: true, reconsentList: [], mfaSetup: false }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          failures.push("connection error");
          continue;
        }
        jar.absorb(verify);
        if (verify.status === 429) {
          rateLimited += 1;
          failures.push("HTTP 429");
          continue;
        }
        const answer = (await verify.json().catch(() => null)) as { responseStatus?: { type?: string }; serviceTicketId?: string; error?: { "status-code"?: string } } | null;
        if (answer?.error?.["status-code"] === "429") {
          rateLimited += 1;
          failures.push("429 in the response body");
          continue;
        }
        if (answer?.responseStatus?.type === "SUCCESSFUL" && answer.serviceTicketId) return exchangeTicket(answer.serviceTicketId, doFetch);
        // Never echo the response body: it can carry the ticket or account identifiers.
        failures.push(answer ? (answer.responseStatus?.type ?? "rejected") : `HTTP ${verify.status} non-JSON`);
      }
      if (rateLimited === attempts.length) throw new GarminRateLimitError("Garmin MFA verification is rate limited on every endpoint: wait before retrying.");
      throw new GarminAuthError(`MFA verification failed (${failures.join(", ")}).`);
    };
    return { status: "needs_mfa", method, complete };
  }
  if (type === "INVALID_USERNAME_PASSWORD") throw new GarminAuthError("Invalid username or password.", 401);
  if (body?.error?.["status-code"] === "429") throw new GarminRateLimitError("Garmin login: 429 in the response body.");
  if (type !== "SUCCESSFUL" || !body?.serviceTicketId) throw new GarminError("connection", `Garmin login failed: HTTP ${response.status}, responseStatus=${type ?? "unknown"}.`, response.status);

  return { status: "ok", tokens: await exchangeTicket(body.serviceTicketId, doFetch) };
}


/** Exchange a CAS service ticket for the DI token pair, trying each known client id until one is accepted. */
async function exchangeTicket(ticket: string, doFetch: typeof fetch): Promise<Tokens> {
  for (const clientId of DI_CLIENT_IDS) {
    const exchange = await doFetch(DI_TOKEN_URL, {
      method: "POST",
      headers: {
        "User-Agent": NATIVE_UA,
        Authorization: `Basic ${Buffer.from(`${clientId}:`).toString("base64")}`,
        Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({ client_id: clientId, service_ticket: ticket, grant_type: DI_GRANT_TYPE, service_url: IOS_SERVICE_URL }),
      signal: AbortSignal.timeout(30_000),
    });
    if (exchange.status === 429) throw new GarminRateLimitError("Garmin rate limited the token exchange.");
    if (!exchange.ok) continue;
    const data = (await exchange.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
    if (typeof data?.access_token !== "string") continue;
    return { di_token: data.access_token, di_refresh_token: data.refresh_token ?? null, di_client_id: tokenClientId(data.access_token) ?? clientId };
  }
  throw new GarminAuthError("DI token exchange failed for all client ids.");
}
