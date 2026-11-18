/**
 * Workouts and training plans: a port of `gc workouts` (garmin-cli/commands/workouts.py).
 *
 * The step shorthand expansion, lookup tables and payload shapes mirror the Python code on purpose:
 * the JSON sent to Garmin must stay byte-for-byte what `gc` would send (same key order included),
 * so keep the two implementations in sync when changing either.
 */
import { readFile } from "node:fs/promises";
import type { GarminClient } from "./client.ts";
import { GarminError } from "./errors.ts";

/** What these functions need from a client; tests inject a fake. */
export type WorkoutClient = Pick<GarminClient, "get" | "request">;

/** A JSON object whose shape Garmin owns; we only touch the keys we know. */
export type JsonObject = Record<string, unknown>;

/** Shortcut names accepted in a step's `target` string, mapped to Garmin's workoutTargetTypeKey. */
export const TARGET_TYPE_MAP: Record<string, string> = {
  hr_zone: "heart.rate.zone",
  heart_rate_zone: "heart.rate.zone",
  heartrate_zone: "heart.rate.zone",
  "heart.rate.zone": "heart.rate.zone",
  power_zone: "power.zone",
  power: "power.zone",
  "power.zone": "power.zone",
  pace_zone: "pace.zone",
  "pace.zone": "pace.zone",
  cadence: "cadence",
  heart_rate: "heart.rate",
  "heart.rate": "heart.rate",
  no_target: "no.target",
  "no.target": "no.target",
  none: "no.target",
};

export const SPORT_TYPE_DISPLAY_ORDER: Record<string, number> = {
  running: 1,
  cycling: 2,
  swimming: 3,
  walking: 4,
  multi_sport: 5,
  fitness_equipment: 6,
  hiking: 7,
};

export const STEP_TYPE_META: Record<string, { stepTypeId: number; displayOrder: number }> = {
  warmup: { stepTypeId: 1, displayOrder: 1 },
  cooldown: { stepTypeId: 2, displayOrder: 2 },
  interval: { stepTypeId: 3, displayOrder: 3 },
  recovery: { stepTypeId: 4, displayOrder: 4 },
  rest: { stepTypeId: 5, displayOrder: 5 },
  repeat: { stepTypeId: 6, displayOrder: 6 },
};

export const CONDITION_TYPE_META: Record<string, { conditionTypeId: number; displayOrder: number; displayable: boolean }> = {
  distance: { conditionTypeId: 1, displayOrder: 1, displayable: true },
  time: { conditionTypeId: 2, displayOrder: 2, displayable: true },
  heart_rate: { conditionTypeId: 3, displayOrder: 3, displayable: true },
  calories: { conditionTypeId: 4, displayOrder: 4, displayable: true },
  cadence: { conditionTypeId: 5, displayOrder: 5, displayable: true },
  power: { conditionTypeId: 6, displayOrder: 6, displayable: true },
  iterations: { conditionTypeId: 7, displayOrder: 7, displayable: false },
};

// Note: power.zone maps to id 2 (heart rate) exactly as the Python table does; kept for identical output.
export const TARGET_TYPE_META: Record<string, { workoutTargetTypeId: number; displayOrder: number }> = {
  "no.target": { workoutTargetTypeId: 1, displayOrder: 1 },
  "heart.rate": { workoutTargetTypeId: 2, displayOrder: 2 },
  cadence: { workoutTargetTypeId: 3, displayOrder: 3 },
  speed: { workoutTargetTypeId: 4, displayOrder: 4 },
  power: { workoutTargetTypeId: 5, displayOrder: 5 },
  open: { workoutTargetTypeId: 6, displayOrder: 6 },
  "heart.rate.zone": { workoutTargetTypeId: 2, displayOrder: 2 },
  "power.zone": { workoutTargetTypeId: 2, displayOrder: 2 },
  "pace.zone": { workoutTargetTypeId: 4, displayOrder: 4 },
};

const fail = (message: string): never => {
  throw new GarminError("error", message);
};

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (obj: object, key: string): boolean => Object.hasOwn(obj, key);

/** Python's dict.setdefault: only writes when the key is absent. */
function setDefault(obj: JsonObject, key: string, value: unknown): void {
  if (!has(obj, key)) obj[key] = value;
}

/**
 * Parse the `--steps` JSON text.
 * @param stepsRaw JSON text of a non-empty array of step objects.
 * @returns the step objects, unchanged.
 * @throws GarminError when the text is not valid JSON, not a non-empty array, or holds a non-object.
 */
export function parseSteps(stepsRaw: string): JsonObject[] {
  let steps: unknown;
  try {
    steps = JSON.parse(stepsRaw);
  } catch (error) {
    return fail(`Invalid steps JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) return fail("Steps must be a non-empty JSON array.");
  return steps.map((step) => (isObject(step) ? step : fail("Each step must be a JSON object.")));
}

/** Parse "200", "3.5" or "200-220" (optional trailing "w"); integers stay integers, like Python's int()/float() split. */
function parseTargetValue(value: string): [number | null, number | null] {
  let raw = value.trim().toLowerCase();
  if (!raw) return [null, null];
  if (raw.endsWith("w")) raw = raw.slice(0, -1);
  const number = (text: string): number => {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) throw new RangeError("not numeric");
    return Number(text);
  };
  if (raw.includes("-")) {
    const at = raw.indexOf("-");
    const low = raw.slice(0, at).trim();
    const high = raw.slice(at + 1).trim();
    if (!low || !high) return fail("Target range must be two numbers like '200-220'.");
    return [number(low), number(high)];
  }
  return [number(raw), null];
}

/** Expand a target shortcut ("hr_zone:2", "power:200-220") into [workoutTargetTypeKey, value, value2]. */
function parseTarget(target: unknown): [string, number | null, number | null] {
  // Python treats a bare number as a "no.target" carrying that value.
  if (typeof target === "number") return ["no.target", target, null];
  if (typeof target !== "string") return fail("Target must be a string like 'hr_zone:2' or a Garmin targetType object.");
  const raw = target.trim();
  if (!raw) return fail("Target must not be empty.");
  let kind = raw.toLowerCase();
  let value = "";
  if (raw.includes(":")) {
    const at = raw.indexOf(":");
    kind = raw.slice(0, at).trim().toLowerCase();
    value = raw.slice(at + 1).trim();
  }
  const targetType = Object.hasOwn(TARGET_TYPE_MAP, kind) ? TARGET_TYPE_MAP[kind] : undefined;
  if (!targetType) return fail(`Unknown target '${target}'. Use Garmin-shaped steps or a supported shortcut like 'hr_zone:2'.`);
  if (!value) return [targetType, null, null];
  try {
    const [one, two] = parseTargetValue(value);
    return [targetType, one, two];
  } catch (error) {
    if (error instanceof RangeError) return fail(`Target value must be numeric (got '${value}').`);
    throw error;
  }
}

/** Fill id/displayOrder from the table when the key is known; unknown keys are passed through. */
function buildMeta(obj: JsonObject, keyName: string, table: Record<string, Record<string, unknown>>): JsonObject {
  const key = obj[keyName];
  if (typeof key === "string") {
    const lower = key.toLowerCase();
    obj[keyName] = lower;
    const meta = Object.hasOwn(table, lower) ? table[lower] : undefined;
    if (meta) for (const [name, value] of Object.entries(meta)) setDefault(obj, name, value);
  }
  return obj;
}

/**
 * Expand step shorthand into Garmin's step DTO shape (stepType/endCondition/targetType objects, ids, stepOrder).
 * Mirrors Python's `_normalize_steps`. Nested `workoutSteps` of a repeat group are NOT normalized (the Python does
 * not recurse either), so give those in full Garmin shape.
 * @param steps step objects, e.g. from {@link parseSteps}. Not mutated at the top level.
 * @returns new step objects with the same key order the Python would produce.
 * @throws GarminError when a step has no usable stepType or an invalid target shortcut.
 */
export function normalizeSteps(steps: JsonObject[]): JsonObject[] {
  return steps.map((step, index) => {
    if (!isObject(step)) return fail("Each step must be a JSON object.");
    const idx = index + 1;
    const current: JsonObject = { ...step };

    let stepType: unknown = current.stepType ?? undefined;
    if (stepType === undefined && has(current, "type")) {
      stepType = { stepTypeKey: current.type };
      delete current.type;
    }
    if (typeof stepType === "string") stepType = { stepTypeKey: stepType };
    if (!isObject(stepType) || !has(stepType, "stepTypeKey")) return fail(`Step ${idx} missing stepType. Provide stepType or shorthand 'type'.`);
    current.stepType = buildMeta({ ...stepType }, "stepTypeKey", STEP_TYPE_META);

    if (!has(current, "stepOrder")) current.stepOrder = idx;
    setDefault(current, "type", "ExecutableStepDTO");

    if (has(current, "duration")) {
      const duration = current.duration;
      delete current.duration;
      if (!has(current, "endCondition")) current.endCondition = { conditionTypeKey: "time" };
      if (!has(current, "endConditionValue")) current.endConditionValue = duration;
    }

    if (typeof current.endCondition === "string") current.endCondition = { conditionTypeKey: current.endCondition };
    if (isObject(current.endCondition)) current.endCondition = buildMeta({ ...current.endCondition }, "conditionTypeKey", CONDITION_TYPE_META);

    const targetType = current.targetType ?? undefined;
    if (targetType === undefined && has(current, "target")) {
      const shortcut = current.target;
      delete current.target;
      const [key, one, two] = parseTarget(shortcut);
      current.targetType = { workoutTargetTypeKey: key };
      if (one !== null) {
        if (key === "power.zone") {
          // A single power value means a zero-width range; the range is always sent low to high.
          let low = one;
          let high = two ?? one;
          if (high < low) [low, high] = [high, low];
          current.targetValueOne = low;
          current.targetValueTwo = high;
        } else if (key.endsWith(".zone")) {
          current.zoneNumber = Math.trunc(one);
        } else {
          current.targetValue = one;
        }
      }
    } else if (typeof targetType === "string") {
      current.targetType = { workoutTargetTypeKey: targetType };
    }
    if (!has(current, "targetType")) current.targetType = { workoutTargetTypeKey: "no.target" };
    if (isObject(current.targetType)) current.targetType = buildMeta({ ...current.targetType }, "workoutTargetTypeKey", TARGET_TYPE_META);
    return current;
  });
}

/** Round half to even, as Python's round() does, so estimates match exactly. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Sum of the time-based end conditions of the top-level steps, in seconds.
 * Distance/lap steps and nested repeat contents are ignored, like the Python.
 * @param steps normalized steps.
 */
export function estimateDuration(steps: JsonObject[]): number {
  let total = 0;
  for (const step of steps) {
    const end = step.endCondition;
    if (!isObject(end)) continue;
    const key = end.conditionTypeKey;
    if (typeof key === "string" && key.toLowerCase() === "time" && typeof step.endConditionValue === "number") total += step.endConditionValue;
  }
  return roundHalfEven(total);
}

/** The sportType object Garmin expects, with displayOrder only for well-known sports. */
function sportPayload(key: string, id: number): JsonObject {
  const sport: JsonObject = { sportTypeKey: key, sportTypeId: id };
  const order = Object.hasOwn(SPORT_TYPE_DISPLAY_ORDER, key.toLowerCase()) ? SPORT_TYPE_DISPLAY_ORDER[key.toLowerCase()] : undefined;
  if (order !== undefined) sport.displayOrder = order;
  return sport;
}

/**
 * Build the body of POST /workout-service/workout from already normalized steps.
 * @param name workout name.
 * @param sportKey sport type key, e.g. "running".
 * @param sportId sport type id (see {@link resolveSportType}).
 * @param steps normalized steps (see {@link normalizeSteps}).
 * @returns the payload, with one segment holding all steps.
 * @throws GarminError when any argument is missing or steps is empty.
 */
export function buildWorkoutPayload(name: string | undefined, sportKey: string | undefined, sportId: number | undefined, steps: JsonObject[] | undefined): JsonObject {
  if (!name || !sportKey || sportId === undefined || !steps || steps.length === 0) {
    return fail("Provide --file or --name, --sport, and --steps (--sport-id can be inferred from --sport).");
  }
  const sport = sportPayload(sportKey, sportId);
  return {
    workoutName: name,
    estimatedDurationInSecs: estimateDuration(steps),
    sportType: sport,
    workoutSegments: [{ segmentOrder: 1, sportType: sport, workoutSteps: steps }],
  };
}

/** Flatten the several shapes Garmin has used for the activity types listing. */
function activityTypeEntries(data: unknown): JsonObject[] {
  if (Array.isArray(data)) return data.filter(isObject);
  if (isObject(data)) {
    for (const key of ["activityTypes", "activityType", "types", "activityTypesV2"]) {
      const value = data[key];
      if (Array.isArray(value)) return value.filter(isObject);
    }
  }
  return [];
}

/** Pull (key, id) out of an activity type entry, looking through nested `activityType`/`type` wrappers. */
function extractTypeKeyId(entry: JsonObject): [string | null, unknown] {
  if ("typeKey" in entry && "typeId" in entry) return [entry.typeKey as string | null, entry.typeId];
  if ("sportTypeKey" in entry && "sportTypeId" in entry) return [entry.sportTypeKey as string | null, entry.sportTypeId];
  if (isObject(entry.activityType)) return extractTypeKeyId(entry.activityType);
  if (isObject(entry.type)) return extractTypeKeyId(entry.type);
  return [null, null];
}

/**
 * Resolve a sport key and/or id to a (key, id) pair. When both are given nothing is fetched; otherwise the
 * activity types listing is read to fill the missing half.
 * @throws GarminError when neither is given or the value is unknown.
 */
export async function resolveSportType(client: WorkoutClient, sportKey?: string, sportId?: number): Promise<[string, number]> {
  if (sportKey && sportId !== undefined) return [sportKey, sportId];
  if (!sportKey && sportId === undefined) return fail("Provide --sport or --sport-id.");

  const entries = activityTypeEntries(await client.get("/activity-service/activity/activityTypes"));
  const mapping = new Map<string, [string, number]>();
  for (const entry of entries) {
    const [key, rawId] = extractTypeKeyId(entry);
    if (!key || rawId === null || rawId === undefined || rawId === "") continue;
    const id = Number(rawId);
    if (!Number.isInteger(id)) continue;
    mapping.set(key.toLowerCase(), [key, id]);
  }
  if (sportKey) {
    return mapping.get(sportKey.toLowerCase()) ?? fail(`Unknown sport '${sportKey}'. Use 'gc activities types' to list available sports.`);
  }
  for (const [key, id] of mapping.values()) if (id === sportId) return [key, id];
  return fail(`Unknown sport id '${sportId}'. Provide --sport or use 'gc activities types' to list available sports.`);
}

/**
 * Apply name/sport/steps changes onto an existing workout (as returned by {@link getWorkout}).
 * Only single-segment workouts can have steps replaced; multi-segment ones must be updated from a full file.
 * @param client used only to resolve the sport when just one of key/id is given.
 * @param base the current workout JSON.
 * @param workoutId id forced into the payload (kept as the string the caller gave, like Python).
 * @returns a new payload; `base` is not mutated.
 * @throws GarminError for non-object payloads, non-list or multiple segments, or unknown sports.
 */
export async function mergeWorkoutPayload(
  client: WorkoutClient,
  base: unknown,
  workoutId: string,
  name?: string,
  sportKey?: string,
  sportId?: number,
  steps?: JsonObject[],
): Promise<JsonObject> {
  if (!isObject(base)) return fail("Workout payload must be a JSON object.");
  const payload: JsonObject = { ...base };
  payload.workoutId = workoutId;
  if (name) payload.workoutName = name;

  let sport: unknown = payload.sportType;
  if (sportKey || sportId !== undefined) {
    const [key, id] = await resolveSportType(client, sportKey, sportId);
    sport = sportPayload(key, id);
    payload.sportType = sport;
  }

  if (steps !== undefined) {
    const segments = payload.workoutSegments ?? [];
    if (!Array.isArray(segments)) return fail("Workout segments must be a list.");
    if (segments.length > 1) return fail("Workout has multiple segments; use --file to update it.");
    const segment: JsonObject = segments.length ? { ...(segments[0] as JsonObject) } : {};
    setDefault(segment, "segmentOrder", 1);
    // Python truthiness: an empty/absent sport leaves the segment's own sportType alone.
    if (isObject(sport) && Object.keys(sport).length > 0) segment.sportType = sport;
    segment.workoutSteps = steps;
    payload.workoutSegments = [segment];
    payload.estimatedDurationInSecs = estimateDuration(steps);
  }
  return payload;
}

/** Garmin ids are positive integers; checking them here keeps odd text out of URL paths. */
function idPath(id: string | number, what: string): string {
  const text = String(id).trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) return fail(`${what} must be a positive integer.`);
  return String(Number(text));
}

/** Read and validate a workout JSON file (the `--file` option). @throws GarminError when it is not a JSON object. */
export async function loadWorkoutFile(file: string): Promise<JsonObject> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return fail(`Invalid workout JSON file: ${error.message}`);
    throw error;
  }
  return isObject(payload) ? payload : fail("Workout JSON file must contain an object.");
}

/** List workouts (GET /workout-service/workouts). @param start offset, default 0. @param limit page size, default 20 (gc's default). */
export const listWorkouts = (client: WorkoutClient, start = 0, limit = 20) => client.get("/workout-service/workouts", { start, limit });

/** One workout by id. */
export const getWorkout = (client: WorkoutClient, id: string | number) => client.get(`/workout-service/workout/${idPath(id, "workout_id")}`);

/** A workout as FIT bytes (GET /workout-service/workout/FIT/{id}). @returns the raw file content. */
export const downloadWorkout = (client: WorkoutClient, id: string | number) =>
  client.request<Buffer>("GET", `/workout-service/workout/FIT/${idPath(id, "workout_id")}`, { raw: true });

/** One scheduled (calendar) workout by its schedule id. */
export const getScheduledWorkout = (client: WorkoutClient, id: string | number) => client.get(`/workout-service/schedule/${idPath(id, "scheduled_workout_id")}`);

/** Options for {@link createWorkout} and {@link updateWorkout}. Either `file` content (`payload`) or `steps` is required. */
export type WorkoutInput = {
  name?: string;
  sport?: string;
  sportId?: number;
  /** Steps as the `--steps` JSON text, or as already parsed objects. */
  steps?: string | JsonObject[];
  /** A full workout payload (the parsed `--file`); sent as is. */
  payload?: JsonObject;
};

function stepsOf(input: WorkoutInput): JsonObject[] | undefined {
  if (input.steps === undefined) return undefined;
  return normalizeSteps(typeof input.steps === "string" ? parseSteps(input.steps) : input.steps);
}

/**
 * Create a workout (POST /workout-service/workout).
 * @param input a full `payload`, or name + sport (key and/or id) + steps.
 * @returns Garmin's response (the created workout), or null when it answers with an empty body.
 * @throws GarminError for missing/invalid inputs.
 */
export async function createWorkout(client: WorkoutClient, input: WorkoutInput): Promise<unknown> {
  let payload = input.payload;
  if (!payload) {
    // Same order as Python: validate the steps before any network call.
    if (input.steps === undefined) return fail("Provide --file or --steps.");
    const steps = stepsOf(input);
    const [key, id] = await resolveSportType(client, input.sport, input.sportId);
    payload = buildWorkoutPayload(input.name, key, id, steps);
  }
  return client.request("POST", "/workout-service/workout", { json: payload });
}

/**
 * Update a workout in place (PUT /workout-service/workout/{id}).
 * With `payload` it is sent as is (workoutId defaulted); otherwise the current workout is fetched and name/sport/steps merged in.
 * @returns Garmin's response, or null for an empty body.
 */
export async function updateWorkout(client: WorkoutClient, id: string | number, input: WorkoutInput): Promise<unknown> {
  const workoutId = idPath(id, "workout_id");
  let payload = input.payload;
  if (!payload) {
    if (input.steps === undefined) return fail("Provide --file or --steps.");
    const steps = stepsOf(input);
    const base = await getWorkout(client, workoutId);
    payload = await mergeWorkoutPayload(client, base, workoutId, input.name, input.sport, input.sportId, steps);
  } else {
    payload = { ...payload };
    setDefault(payload, "workoutId", workoutId);
  }
  return client.request("PUT", `/workout-service/workout/${workoutId}`, { json: payload });
}

/** Delete a workout (DELETE /workout-service/workout/{id}). @returns Garmin's response, usually null. */
export const deleteWorkout = (client: WorkoutClient, id: string | number) => client.request("DELETE", `/workout-service/workout/${idPath(id, "workout_id")}`);

/** All available training plans. */
export const listTrainingPlans = (client: WorkoutClient) => client.get("/trainingplan-service/trainingplan/plans");

/** One (phased) training plan by id. */
export const getTrainingPlan = (client: WorkoutClient, id: string | number) => client.get(`/trainingplan-service/trainingplan/phased/${idPath(id, "plan_id")}`);

/** One adaptive training plan by id. */
export const getAdaptiveTrainingPlan = (client: WorkoutClient, id: string | number) => client.get(`/trainingplan-service/trainingplan/fbt-adaptive/${idPath(id, "plan_id")}`);
