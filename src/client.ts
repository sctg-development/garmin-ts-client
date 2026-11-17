/**
 * Garmin Connect API client. After login, Garmin's API answers plain HTTPS requests that carry the
 * mobile-app headers and a Bearer token, so no TLS impersonation is needed here. Logging in is not
 * done by this package: run `gc login` (or any garminconnect-based login) and share the token file.
 */
import { GarminAuthError, GarminError, GarminRateLimitError } from "./errors.ts";
import { FileTokenStore, MemoryTokenStore, parseTokens, tokenClientId, tokenExpiry, type TokenStore, type Tokens } from "./tokens.ts";

export const CONNECT_API = "https://connectapi.garmin.com";
export const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

const NATIVE_HEADERS: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent": "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

const REFRESH_MARGIN_S = 900;

export type Query = Record<string, string | number | boolean | undefined>;
export type RequestOptions = { params?: Query; json?: unknown; timeoutMs?: number };

export type GarminClientOptions = {
  store?: TokenStore;
  fetch?: typeof fetch;
  baseUrl?: string;
  authUrl?: string;
  /** Concurrent requests (Garmin rate-limits bursts). Default 3. */
  maxConcurrent?: number;
  /** Retries on 5xx and network errors, with backoff. Default 2. */
  retries?: number;
  timeoutMs?: number;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
};

export class GarminClient {
  private readonly store: TokenStore;
  private readonly doFetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly maxConcurrent: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private tokens: Tokens | null = null;
  private refreshing: Promise<Tokens> | null = null;
  private active = 0;
  private waiting: Array<() => void> = [];
  private profileName: Promise<string> | null = null;

  constructor(options: GarminClientOptions = {}) {
    this.store = options.store ?? new FileTokenStore();
    this.doFetch = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? CONNECT_API;
    this.authUrl = options.authUrl ?? DI_TOKEN_URL;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  /** From a token file (default: the one `gc login` writes). */
  static fromFile(file?: string, options: Omit<GarminClientOptions, "store"> = {}): GarminClient {
    return new GarminClient({ ...options, store: new FileTokenStore(file) });
  }

  /** From a token blob (`gc export-token`), kept in memory only. */
  static fromBlob(blob: string, options: Omit<GarminClientOptions, "store"> = {}): GarminClient {
    return new GarminClient({ ...options, store: new MemoryTokenStore(parseTokens(blob)) });
  }

  /** Seconds before the access token expires (negative when expired), or null when unknown. Never returns a token. */
  async tokenInfo(): Promise<{ expiresInS: number | null; canRefresh: boolean }> {
    const tokens = await this.current();
    const exp = tokenExpiry(tokens.di_token);
    return { expiresInS: exp === null ? null : Math.round(exp - this.now() / 1000), canRefresh: Boolean(tokens.di_refresh_token && (tokens.di_client_id || tokenClientId(tokens.di_token))) };
  }

  private async current(): Promise<Tokens> {
    if (!this.tokens) this.tokens = await this.store.load();
    return this.tokens;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  /** Refresh the access token; concurrent callers share one refresh. */
  async refresh(): Promise<Tokens> {
    if (!this.refreshing) {
      const stale = await this.current();
      this.refreshing = this.store
        .refreshLocked(stale, (latest) => this.exchange(latest))
        .then((tokens) => {
          this.tokens = tokens;
          return tokens;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async exchange(tokens: Tokens): Promise<Tokens> {
    const clientId = tokens.di_client_id ?? tokenClientId(tokens.di_token);
    if (!tokens.di_refresh_token || !clientId) throw new GarminAuthError("No refresh token: run `gc login` again.");
    const response = await this.doFetch(this.authUrl, {
      method: "POST",
      headers: {
        ...NATIVE_HEADERS,
        Authorization: `Basic ${Buffer.from(`${clientId}:`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.di_refresh_token }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      throw new GarminError("connection", `Could not reach Garmin auth: ${error instanceof Error ? error.message : "network error"}`);
    });
    if (response.status === 429) throw new GarminRateLimitError("Garmin rate limited the token refresh.");
    if (!response.ok) throw new GarminAuthError(`Token refresh refused (HTTP ${response.status}): run \`gc login\` again.`, response.status);
    const data = (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown } | null;
    if (!data || typeof data.access_token !== "string") throw new GarminAuthError("Token refresh returned no access token.");
    return {
      di_token: data.access_token,
      di_refresh_token: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : tokens.di_refresh_token,
      di_client_id: tokenClientId(data.access_token) ?? clientId,
    };
  }

  private url(path: string, params?: Query): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /** One request with refresh-on-expiry, retry on 5xx and error classification. Returns the parsed JSON (null for 204). */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    await this.acquire();
    try {
      let tokens = await this.current();
      const exp = tokenExpiry(tokens.di_token);
      if (exp !== null && exp - this.now() / 1000 < REFRESH_MARGIN_S) tokens = await this.refresh().catch(() => tokens);
      let refreshed = false;
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await this.doFetch(this.url(path, options.params), {
            method,
            headers: {
              ...NATIVE_HEADERS,
              Authorization: `Bearer ${tokens.di_token}`,
              Accept: "application/json",
              ...(options.json !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
            signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
          });
        } catch (error) {
          if (attempt < this.retries) {
            await backoff(attempt);
            continue;
          }
          throw new GarminError("connection", `Connection error: ${error instanceof Error ? error.message : "network error"}`);
        }
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          tokens = await this.refresh();
          continue;
        }
        if (response.status === 401 || response.status === 403) throw new GarminAuthError(`Authentication failed (HTTP ${response.status}): run \`gc login\` again.`, response.status);
        if (response.status === 429) throw new GarminRateLimitError("Garmin Connect is rate limiting requests: wait before retrying.");
        if (response.status >= 500 && attempt < this.retries) {
          await backoff(attempt);
          continue;
        }
        if (response.status === 204) return null as T;
        if (response.status === 404) throw new GarminError("not_found", "Garmin has no such resource (HTTP 404).", 404);
        if (!response.ok) throw new GarminError(response.status >= 500 ? "connection" : "error", `Garmin API error (HTTP ${response.status}).`, response.status);
        const text = await response.text();
        if (!text) return null as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new GarminError("error", "Garmin returned a response that is not JSON.", response.status);
        }
      }
    } finally {
      this.release();
    }
  }

  get<T = unknown>(path: string, params?: Query): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  /** The profile's display name, which several endpoints put in the path. Cached. */
  displayName(): Promise<string> {
    if (!this.profileName) {
      this.profileName = this.get<{ displayName?: unknown }>("/userprofile-service/socialProfile").then((profile) => {
        if (typeof profile?.displayName !== "string" || !profile.displayName) throw new GarminError("error", "Garmin profile name unavailable.");
        return profile.displayName;
      });
      this.profileName.catch(() => {
        this.profileName = null;
      });
    }
    return this.profileName;
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 100));
}
