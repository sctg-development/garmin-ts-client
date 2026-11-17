# garmin-ts-client

A TypeScript client for Garmin Connect, **read-only and without runtime dependencies** (Node 22+, built-in `fetch`).
It reads and refreshes the token file that [`garmin-cli`](https://github.com/sctg-development/garmin-cli) (`gc login`)
writes, and returns the same JSON as `gc`, so it can replace the CLI inside a Node program.

- **Token store with safe refresh.** Garmin rotates the refresh token on every refresh. Refreshes are serialised across
  processes with a lock file, and a process that finds newer tokens on disk adopts them instead of refreshing again.
- **`daily`**: one compact record per day (sleep, HRV, resting heart rate, respiration, SpO2, skin temperature, stress,
  body battery, activity), identical to `gc daily` (schema version 1). Every field is nullable; a missing value is `null`, never 0.
- **Activities**: list by date range, and per-activity splits, heart-rate zones, weather, exercise sets.
- **Metrics**: training readiness, training status, lactate threshold.
- A raw `get(path, params)` for exploring endpoints.

## Not included: logging in

Garmin's login flows are protected by a WAF that checks the TLS fingerprint of the client, which Node's `fetch` cannot
imitate. Log in with `gc login` (Python) on a machine where it works, then share the token file, or import it with
`gc login --manual --token-blob` using the output of `gc export-token`. After that, API calls and token refreshes work with
plain HTTPS (checked against a real account: reads and refresh succeed without any impersonation).

## Use

```ts
import { GarminClient, daily, listActivities } from "@sctg/garmin-ts-client";

const client = GarminClient.fromFile(); // $GARMINTOKENS or ~/.config/garmin-cli/tokens/garmin_tokens.json
const { days, errors } = await daily(client, { start: "2026-11-01", end: "2026-11-16", detail: false });
const runs = await listActivities(client, { start: "2026-11-01", end: "2026-11-16" });
```

`GarminClient.fromBlob(blob)` keeps tokens in memory only (a secret manager, for example). Errors are `GarminError`s
with a stable `code`: `auth`, `rate_limited`, `connection`, `not_found`, `error`. An authentication failure aborts a `daily` call;
any other failure is recorded in `errors` (or `days[].errors`) and the other signals are still returned.

## CLI

```bash
garmin-ts daily yesterday
garmin-ts daily --start 2026-11-01 --end 2026-11-16 --no-detail
garmin-ts activities --start 2026-11-01 --end 2026-11-16
garmin-ts activity 12345678901 splits        # also: hr-zones, weather, exercise-sets
garmin-ts metrics training-readiness 2026-11-16
garmin-ts api /userprofile-service/socialProfile
garmin-ts token-info                          # expiry and refresh ability, never the token
```

## Notes

- Garmin's API is not public and can change without notice. Field lookups use lists of candidate names for that reason.
- `daily --detail` costs three requests per day and is limited to 14 days; ranges are limited to 400 days.
- Requests are limited to 3 at a time, and 5xx responses are retried with backoff. A 429 is reported, not retried.
- Tokens are health-account credentials: the token file is written with owner-only permissions.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT.
