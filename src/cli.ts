#!/usr/bin/env node
/** Small CLI for checks and exploration. JSON on stdout, errors as `{ "error": code }` on stderr with exit 1. */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { activityDescent } from "./activityFile.ts";
import { activityExerciseSets, activityHrZones, activitySplits, activityWeather, getActivity, listActivities } from "./activities.ts";
import { GarminClient } from "./client.ts";
import { daily } from "./daily.ts";
import { addDays, resolveShortcut } from "./dates.ts";
import { GarminAuthError, GarminError } from "./errors.ts";
import { login } from "./login.ts";
import { FileTokenStore } from "./tokens.ts";
import { anchors } from "./anchors.ts";
import { CATALOG, connect, usage } from "./connect.ts";
import { lactateThreshold, maxMet, trainingLoadBalance, trainingReadiness, trainingStatus } from "./metrics.ts";
import { createWorkout, deleteWorkout, downloadWorkout, getAdaptiveTrainingPlan, getScheduledWorkout, getTrainingPlan, getWorkout, listTrainingPlans, listWorkouts, loadWorkoutFile, updateWorkout, type WorkoutInput } from "./workouts.ts";
import { writeFile } from "node:fs/promises";

const USAGE = `garmin-ts <command> [options]

  daily [date|today|yesterday|week|month] [--start D --end D] [--detail|--no-detail]
  activities [--start D --end D] [--type T]
  activity <id> [splits|hr-zones|weather|exercise-sets|descent]
  metrics <training-readiness|training-status|load-balance> [date] | metrics maxmet [--start D --end D] | metrics lactate-threshold | metrics anchors
  workouts [--start N --limit N] | workouts <get|download|scheduled|delete> <id> [--output FILE]
  workouts <create|update <id>> [--name N --sport S --sport-id N --steps JSON | --file F]
  workouts training-plans [get|adaptive <id>]
  connect list | connect <name> [args...] [--param key=value ...]   any discovered read-only endpoint (see 'connect list')
  api <path> [--param key=value ...]     GET any Garmin Connect path (exploration)
  login [--mfa-code C]                    sign in with $GARMIN_LOGIN (or $GARMIN_EMAIL) and $GARMIN_PASSWORD, save the tokens
                                          (multi-factor: prompts for the code, or --mfa-code / $GARMIN_MFA_CODE)
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
      limit: { type: "string" },
      name: { type: "string" },
      sport: { type: "string" },
      "sport-id": { type: "string" },
      steps: { type: "string" },
      file: { type: "string" },
      output: { type: "string", short: "o" },
      "mfa-code": { type: "string" },
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
    let tokens;
    if (result.status === "ok") {
      tokens = result.tokens;
    } else {
      // The code arrives by email/SMS (or an authenticator app): --mfa-code / $GARMIN_MFA_CODE for scripts,
      // otherwise ask on the terminal. The prompt goes to stderr so stdout stays JSON.
      let code = values["mfa-code"] ?? process.env.GARMIN_MFA_CODE;
      if (!code) {
        if (!process.stdin.isTTY) throw new GarminAuthError(`This account needs a multi-factor code (sent by ${result.method}): pass --mfa-code or set GARMIN_MFA_CODE, or run this command in a terminal.`);
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        code = (await rl.question(`Enter MFA code (sent by ${result.method}): `)).trim();
        rl.close();
      }
      tokens = await result.complete(code);
    }
    const store = new FileTokenStore(values.tokenstore);
    await store.save(tokens);
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
      // Downloads the FIT file (one request) and analyses its altitude trace.
      if (what === "descent") return activityDescent(client, id);
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
      if (what === "anchors") return anchors(client);
      if (what === "load-balance") return trainingLoadBalance(client, today);
      if (what === "maxmet") {
        // Default window: the last 60 days, enough for a trend and for the acclimation baseline.
        const end = values.end ?? today;
        return maxMet(client, values.start ?? addDays(end, -60), end);
      }
      throw new GarminError("error", "metrics needs training-readiness, training-status, load-balance, maxmet, lactate-threshold or anchors.");
    }
    case "workouts": {
      const [sub, id] = rest;
      const need = (): string => id ?? ((): never => { throw new GarminError("error", `workouts ${sub} needs an id.`); })();
      const input = async (): Promise<WorkoutInput> => ({
        name: values.name,
        sport: values.sport,
        sportId: values["sport-id"] === undefined ? undefined : Number(values["sport-id"]),
        steps: values.steps,
        payload: values.file ? await loadWorkoutFile(values.file) : undefined,
      });
      switch (sub) {
        case undefined:
          return listWorkouts(client, values.start === undefined ? 0 : Number(values.start), values.limit === undefined ? 20 : Number(values.limit));
        case "get":
          return getWorkout(client, need());
        case "scheduled":
          return getScheduledWorkout(client, need());
        case "download": {
          const data = await downloadWorkout(client, need());
          const file = values.output ?? `workout_${id}.fit`;
          await writeFile(file, data);
          return { downloaded: file, bytes: data.length };
        }
        case "create":
          return (await createWorkout(client, await input())) ?? { created: true };
        case "update":
          return (await updateWorkout(client, need(), await input())) ?? { updated: id };
        case "delete":
          return (await deleteWorkout(client, need())) ?? { deleted: id };
        case "training-plans":
          if (!id) return listTrainingPlans(client);
          if (id === "get" || id === "adaptive") {
            const planId = rest[2];
            if (!planId) throw new GarminError("error", `workouts training-plans ${id} needs a plan id.`);
            return id === "get" ? getTrainingPlan(client, planId) : getAdaptiveTrainingPlan(client, planId);
          }
          throw new GarminError("error", "workouts training-plans needs get or adaptive.");
        default:
          throw new GarminError("error", `Unknown workouts command '${sub}'.`);
      }
    }
    case "connect": {
      const [name, ...args] = rest;
      if (!name) throw new GarminError("error", "connect needs an endpoint name or `list`.");
      if (name === "list") return CATALOG.map((entry) => ({ name: entry.name, usage: usage(entry), path: entry.path }));
      const query = Object.fromEntries((values.param ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
      return connect(client, name, args, query);
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
