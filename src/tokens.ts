/**
 * Token storage compatible with garmin-cli / garminconnect: a JSON file with `di_token`,
 * `di_refresh_token` and `di_client_id` (default `~/.config/garmin-cli/tokens/garmin_tokens.json`).
 *
 * Garmin rotates the refresh token on every refresh, so two processes sharing the file must not both
 * refresh from the same old value. `refreshLocked` serialises refreshes with a lock file and, once it
 * holds the lock, adopts whatever another process already wrote instead of refreshing again.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { GarminAuthError } from "./errors.ts";

export type Tokens = { di_token: string; di_refresh_token: string | null; di_client_id: string | null };

const STALE_LOCK_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.GARMINTOKENS ? path.resolve(env.GARMINTOKENS.replace(/^~(?=$|\/)/, homedir())) : path.join(homedir(), ".config", "garmin-cli", "tokens");
  return base.endsWith(".json") ? base : path.join(base, "garmin_tokens.json");
}

export function parseTokens(text: string): Tokens {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GarminAuthError("The token blob is not valid JSON.");
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const access = record.di_token;
  if (typeof access !== "string" || !access) throw new GarminAuthError("No Garmin session in the token data: run `gc login` first.");
  const text_ = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { di_token: access, di_refresh_token: text_(record.di_refresh_token), di_client_id: text_(record.di_client_id) };
}

/** Expiry (epoch seconds) read from the JWT payload, or null. The signature is not checked: Garmin does that. */
export function tokenExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/** Client id embedded in an access token, which may differ from the one stored. */
export function tokenClientId(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { client_id?: unknown };
    return typeof claims.client_id === "string" && claims.client_id ? claims.client_id : null;
  } catch {
    return null;
  }
}

export interface TokenStore {
  load(): Promise<Tokens>;
  /** Refresh under mutual exclusion. `refresh` receives the freshest known tokens. */
  refreshLocked(current: Tokens, refresh: (latest: Tokens) => Promise<Tokens>): Promise<Tokens>;
}

/** In-memory store, for tokens that come from a secret manager and are not written anywhere. */
export class MemoryTokenStore implements TokenStore {
  private tokens: Tokens;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(tokens: Tokens) {
    this.tokens = tokens;
  }
  async load(): Promise<Tokens> {
    return this.tokens;
  }
  refreshLocked(current: Tokens, refresh: (latest: Tokens) => Promise<Tokens>): Promise<Tokens> {
    const run = this.queue.then(async () => {
      if (this.tokens.di_token !== current.di_token) return this.tokens;
      this.tokens = await refresh(this.tokens);
      return this.tokens;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export class FileTokenStore implements TokenStore {
  readonly file: string;
  constructor(file: string = defaultTokenFile()) {
    this.file = file;
  }

  async load(): Promise<Tokens> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      throw new GarminAuthError("Not logged in: no token file. Run `gc login` first.");
    }
    return parseTokens(text);
  }

  private async write(tokens: Tokens): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(tokens), { mode: 0o600 });
    await rename(temp, this.file);
  }

  private async lock(): Promise<() => Promise<void>> {
    const lockFile = `${this.file}.lock`;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lockFile, "wx", 0o600);
        await handle.close();
        return async () => {
          await rm(lockFile, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(lockFile).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > STALE_LOCK_MS) {
          await rm(lockFile, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new GarminAuthError("Timed out waiting for the token file lock.");
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
      }
    }
  }

  async refreshLocked(current: Tokens, refresh: (latest: Tokens) => Promise<Tokens>): Promise<Tokens> {
    const unlock = await this.lock();
    try {
      const onDisk = await this.load().catch(() => current);
      // Someone else refreshed while we waited: their tokens are newer than ours.
      if (onDisk.di_token !== current.di_token) return onDisk;
      const next = await refresh(onDisk);
      await this.write(next);
      return next;
    } finally {
      await unlock();
    }
  }
}
