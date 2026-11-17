/**
 * Experimental: Garmin mobile (iOS) sign-in with plain `fetch`, then exchange of the service ticket for
 * the DI token pair. Garmin's WAF may refuse a client whose TLS fingerprint is not a browser's; this is
 * the same flow garminconnect runs first, minus the fingerprint impersonation. MFA is reported, not handled.
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

export type LoginResult = { status: "ok"; tokens: Tokens } | { status: "needs_mfa" };
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
  if (type === "MFA_REQUIRED") return { status: "needs_mfa" };
  if (type === "INVALID_USERNAME_PASSWORD") throw new GarminAuthError("Invalid username or password.", 401);
  if (body?.error?.["status-code"] === "429") throw new GarminRateLimitError("Garmin login: 429 in the response body.");
  if (type !== "SUCCESSFUL" || !body?.serviceTicketId) throw new GarminError("connection", `Garmin login failed: HTTP ${response.status}, responseStatus=${type ?? "unknown"}.`, response.status);

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
      body: new URLSearchParams({ client_id: clientId, service_ticket: body.serviceTicketId, grant_type: DI_GRANT_TYPE, service_url: IOS_SERVICE_URL }),
      signal: AbortSignal.timeout(30_000),
    });
    if (exchange.status === 429) throw new GarminRateLimitError("Garmin rate limited the token exchange.");
    if (!exchange.ok) continue;
    const data = (await exchange.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
    if (typeof data?.access_token !== "string") continue;
    return { status: "ok", tokens: { di_token: data.access_token, di_refresh_token: data.refresh_token ?? null, di_client_id: tokenClientId(data.access_token) ?? clientId } };
  }
  throw new GarminAuthError("DI token exchange failed for all client ids.");
}
