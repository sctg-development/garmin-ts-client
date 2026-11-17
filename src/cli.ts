#!/usr/bin/env node
/** Small CLI for checks and exploration. JSON on stdout, errors as `{ "error": code }` on stderr with exit 1. */
import { parseArgs } from "node:util";
import { activityExerciseSets, activityHrZones, activitySplits, activityWeather, getActivity, listActivities } from "./activities.ts";
import { GarminClient } from "./client.ts";
import { daily } from "./daily.ts";
import { resolveShortcut } from "./dates.ts";
import { GarminAuthError, GarminError } from "./errors.ts";
import { login } from "./login.ts";
import { FileTokenStore } from "./tokens.ts";
import { lactateThreshold, trainingReadiness, trainingStatus } from "./metrics.ts";

const USAGE = `garmin-ts <command> [options]

  daily [date|today|yesterday|week|month] [--start D --end D] [--detail|--no-detail]
  activities [--start D --end D] [--type T]
  activity <id> [splits|hr-zones|weather|exercise-sets]
  metrics <training-readiness|training-status> [date] | metrics lactate-threshold
  api <path> [--param key=value ...]     GET any Garmin Connect path (exploration)
  login                                   sign in with $GARMIN_LOGIN (or $GARMIN_EMAIL) and $GARMIN_PASSWORD, save the tokens
  token-info                              expiry and refresh ability, never the token itself

Options: --tokenstore FILE   token file (default: $GARMINTOKENS or ~/.config/garmin-cli/tokens/garmin_tokens.json)`;

async function main(): Promise<unknown> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tokenstore: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      detail: { type: "boolean" },
      "no-detail": { type: "boolean" },
      type: { type: "string" },
      param: { type: "string", multiple: true },
      format: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return undefined;
  }
  if (command === "login") {
    // Credentials come from the environment only: a password on the command line ends up in shell history.
    const email = process.env.GARMIN_LOGIN ?? process.env.GARMIN_EMAIL;
    const password = process.env.GARMIN_PASSWORD;
    if (!email || !password) throw new GarminError("error", "Set GARMIN_LOGIN (or GARMIN_EMAIL) and GARMIN_PASSWORD.");
    const result = await login(email, password);
    if (result.status === "needs_mfa") throw new GarminAuthError("This account asks for a multi-factor code, which this login does not handle yet: use `gc login --wait-mfa`.");
    const store = new FileTokenStore(values.tokenstore);
    await store.save(result.tokens);
    return { loggedIn: true, tokenFile: store.file };
  }
  const client = GarminClient.fromFile(values.tokenstore);
  switch (command) {
    case "daily": {
      let start = values.start;
      let end = values.end;
      if (!(start && end)) [start, end] = (rest[0] ? resolveShortcut(rest[0]) : resolveShortcut("today")).map((v) => v ?? undefined) as [string, string | undefined];
      return daily(client, { start: start as string, end, detail: values["no-detail"] ? false : values.detail });
    }
    case "activities": {
      const [start] = resolveShortcut("today");
      return listActivities(client, { start: values.start ?? start, end: values.end, type: values.type });
    }
    case "activity": {
      const [id, what] = rest;
      if (!id) throw new GarminError("error", "activity needs an id.");
      const calls = { splits: activitySplits, "hr-zones": activityHrZones, weather: activityWeather, "exercise-sets": activityExerciseSets };
      if (!what) return getActivity(client, id);
      const call = calls[what as keyof typeof calls];
      if (!call) throw new GarminError("error", `Unknown activity view '${what}'.`);
      return call(client, id);
    }
    case "metrics": {
      const [what, date] = rest;
      const [today] = resolveShortcut(date ?? "today");
      if (what === "training-readiness") return trainingReadiness(client, today);
      if (what === "training-status") return trainingStatus(client, today);
      if (what === "lactate-threshold") return lactateThreshold(client);
      throw new GarminError("error", "metrics needs training-readiness, training-status or lactate-threshold.");
    }
    case "api": {
      const [path] = rest;
      if (!path) throw new GarminError("error", "api needs a path.");
      const params = Object.fromEntries((values.param ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
      return client.get(path, params);
    }
    case "token-info":
      return client.tokenInfo();
    default:
      throw new GarminError("error", `Unknown command '${command}'.\n${USAGE}`);
  }
}

main().then(
  (result) => {
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  },
  (error: unknown) => {
    const code = error instanceof GarminError ? error.code : "error";
    console.error(JSON.stringify({ error: code, message: error instanceof Error ? error.message : "failed" }));
    process.exit(1);
  },
);
