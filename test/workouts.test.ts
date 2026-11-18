import assert from "node:assert/strict";
import { test } from "node:test";
import { GarminError } from "../src/errors.ts";
import {
  buildWorkoutPayload, createWorkout, deleteWorkout, downloadWorkout, estimateDuration, getAdaptiveTrainingPlan, getWorkout,
  mergeWorkoutPayload, normalizeSteps, parseSteps, resolveSportType, updateWorkout, type WorkoutClient,
} from "../src/workouts.ts";

// Golden strings below were produced by running the Python helpers of garmin-cli (commands/workouts.py)
// with json.dumps(..., separators=(",", ":")), so string equality also checks key order.
const STEPS_INPUT = String.raw`[{"type":"warmup","duration":600,"target":"hr_zone:2"},{"stepType":{"stepTypeKey":"repeat"},"type":"RepeatGroupDTO","numberOfIterations":5,"endCondition":"iterations","endConditionValue":5,"workoutSteps":[{"type":"ExecutableStepDTO","stepOrder":1,"stepType":{"stepTypeKey":"interval","stepTypeId":3},"endCondition":{"conditionTypeKey":"time"},"endConditionValue":240,"targetType":{"workoutTargetTypeKey":"pace.zone"},"targetValueOne":3.5,"targetValueTwo":3.2}]},{"type":"interval","endCondition":"distance","endConditionValue":1000.5,"target":"pace_zone:4"},{"type":"recovery","duration":90.5,"target":"power:230-210w"},{"type":"cooldown","duration":300,"target":"none"},{"type":"rest","duration":30.5,"target":"heart_rate:140-150"}]`;
const GOLDEN_PAYLOAD = String.raw`{"workoutName":"Tempo 5x4","estimatedDurationInSecs":1021,"sportType":{"sportTypeKey":"running","sportTypeId":1,"displayOrder":1},"workoutSegments":[{"segmentOrder":1,"sportType":{"sportTypeKey":"running","sportTypeId":1,"displayOrder":1},"workoutSteps":[{"stepType":{"stepTypeKey":"warmup","stepTypeId":1,"displayOrder":1},"stepOrder":1,"type":"ExecutableStepDTO","endCondition":{"conditionTypeKey":"time","conditionTypeId":2,"displayOrder":2,"displayable":true},"endConditionValue":600,"targetType":{"workoutTargetTypeKey":"heart.rate.zone","workoutTargetTypeId":2,"displayOrder":2},"zoneNumber":2},{"stepType":{"stepTypeKey":"repeat","stepTypeId":6,"displayOrder":6},"type":"RepeatGroupDTO","numberOfIterations":5,"endCondition":{"conditionTypeKey":"iterations","conditionTypeId":7,"displayOrder":7,"displayable":false},"endConditionValue":5,"workoutSteps":[{"type":"ExecutableStepDTO","stepOrder":1,"stepType":{"stepTypeKey":"interval","stepTypeId":3},"endCondition":{"conditionTypeKey":"time"},"endConditionValue":240,"targetType":{"workoutTargetTypeKey":"pace.zone"},"targetValueOne":3.5,"targetValueTwo":3.2}],"stepOrder":2,"targetType":{"workoutTargetTypeKey":"no.target","workoutTargetTypeId":1,"displayOrder":1}},{"endCondition":{"conditionTypeKey":"distance","conditionTypeId":1,"displayOrder":1,"displayable":true},"endConditionValue":1000.5,"stepType":{"stepTypeKey":"interval","stepTypeId":3,"displayOrder":3},"stepOrder":3,"type":"ExecutableStepDTO","targetType":{"workoutTargetTypeKey":"pace.zone","workoutTargetTypeId":4,"displayOrder":4},"zoneNumber":4},{"stepType":{"stepTypeKey":"recovery","stepTypeId":4,"displayOrder":4},"stepOrder":4,"type":"ExecutableStepDTO","endCondition":{"conditionTypeKey":"time","conditionTypeId":2,"displayOrder":2,"displayable":true},"endConditionValue":90.5,"targetType":{"workoutTargetTypeKey":"power.zone","workoutTargetTypeId":2,"displayOrder":2},"targetValueOne":210,"targetValueTwo":230},{"stepType":{"stepTypeKey":"cooldown","stepTypeId":2,"displayOrder":2},"stepOrder":5,"type":"ExecutableStepDTO","endCondition":{"conditionTypeKey":"time","conditionTypeId":2,"displayOrder":2,"displayable":true},"endConditionValue":300,"targetType":{"workoutTargetTypeKey":"no.target","workoutTargetTypeId":1,"displayOrder":1}},{"stepType":{"stepTypeKey":"rest","stepTypeId":5,"displayOrder":5},"stepOrder":6,"type":"ExecutableStepDTO","endCondition":{"conditionTypeKey":"time","conditionTypeId":2,"displayOrder":2,"displayable":true},"endConditionValue":30.5,"targetType":{"workoutTargetTypeKey":"heart.rate","workoutTargetTypeId":2,"displayOrder":2},"targetValue":140}]}]}`;
const GOLDEN_MERGED = String.raw`{"workoutId":"123","workoutName":"New","ownerId":7,"sportType":{"sportTypeKey":"running","sportTypeId":1,"displayOrder":1},"workoutSegments":[{"segmentOrder":1,"sportType":{"sportTypeKey":"running","sportTypeId":1,"displayOrder":1},"workoutSteps":[{"stepType":{"stepTypeKey":"warmup","stepTypeId":1,"displayOrder":1},"stepOrder":1,"type":"ExecutableStepDTO","endCondition":{"conditionTypeKey":"time","conditionTypeId":2,"displayOrder":2,"displayable":true},"endConditionValue":600,"targetType":{"workoutTargetTypeKey":"heart.rate.zone","workoutTargetTypeId":2,"displayOrder":2},"zoneNumber":2}]}],"estimatedDurationInSecs":600}`;

type Call = { method: string; path: string; options?: { json?: unknown; params?: unknown; raw?: boolean } };

/** Fake client recording calls; GET answers come from `responses`, keyed by path. */
function fakeClient(responses: Record<string, unknown> = {}): { client: WorkoutClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: unknown) => {
      calls.push({ method: "GET", path, options: { params } });
      return responses[path] ?? null;
    },
    request: async (method: string, path: string, options?: Call["options"]) => {
      calls.push({ method, path, options });
      return responses[path] ?? null;
    },
  } as unknown as WorkoutClient;
  return { client, calls };
}

test("normalizing and building a running workout matches the Python payload exactly", () => {
  const steps = normalizeSteps(parseSteps(STEPS_INPUT));
  const payload = buildWorkoutPayload("Tempo 5x4", "running", 1, steps);
  assert.equal(JSON.stringify(payload), GOLDEN_PAYLOAD);
});

test("merging steps into an existing workout matches the Python payload exactly", async () => {
  const base = {
    workoutId: 99, workoutName: "Old", ownerId: 7,
    sportType: { sportTypeKey: "cycling", sportTypeId: 2, displayOrder: 2 },
    workoutSegments: [{ segmentOrder: 1, sportType: { sportTypeKey: "cycling", sportTypeId: 2 }, workoutSteps: [] }],
  };
  const steps = normalizeSteps(parseSteps(STEPS_INPUT)).slice(0, 1);
  const { client, calls } = fakeClient();
  const merged = await mergeWorkoutPayload(client, base, "123", "New", "running", 1, steps);
  assert.equal(JSON.stringify(merged), GOLDEN_MERGED);
  assert.equal(calls.length, 0, "key and id given: no lookup");
  assert.equal(base.workoutId, 99, "input untouched");
});

test("duration estimate rounds half to even like Python", () => {
  const time = (value: number) => ({ endCondition: { conditionTypeKey: "time" }, endConditionValue: value });
  assert.equal(estimateDuration([time(0.5), time(2)]), 2); // 2.5 -> 2
  assert.equal(estimateDuration([time(1.5)]), 2);
  assert.equal(estimateDuration([{ endCondition: { conditionTypeKey: "distance" }, endConditionValue: 1000 }]), 0);
});

test("step validation errors", () => {
  assert.throws(() => parseSteps("nope"), /Invalid steps JSON/);
  assert.throws(() => parseSteps("[]"), /non-empty/);
  assert.throws(() => parseSteps("[1]"), /JSON object/);
  assert.throws(() => normalizeSteps([{ duration: 5 }]), /Step 1 missing stepType/);
  assert.throws(() => normalizeSteps([{ type: "interval", target: "bogus:1" }]), /Unknown target/);
  assert.throws(() => normalizeSteps([{ type: "interval", target: "hr_zone:abc" }]), /must be numeric/);
  assert.throws(() => buildWorkoutPayload("x", "running", 1, []), GarminError);
});

test("sport type resolution reads the activity types listing", async () => {
  const types = { "/activity-service/activity/activityTypes": [{ typeKey: "Running", typeId: 1 }, { typeKey: "cycling", typeId: 2 }] };
  const { client } = fakeClient(types);
  assert.deepEqual(await resolveSportType(client, "running"), ["Running", 1]);
  assert.deepEqual(await resolveSportType(client, undefined, 2), ["cycling", 2]);
  assert.deepEqual(await resolveSportType(client, "x", 9), ["x", 9]);
  await assert.rejects(resolveSportType(client, "swim"), /Unknown sport/);
  await assert.rejects(resolveSportType(client), /Provide --sport/);
});

test("create posts the built payload; update merges into the fetched workout", async () => {
  const types = { "/activity-service/activity/activityTypes": { activityTypes: [{ typeKey: "running", typeId: 1 }] } };
  const create = fakeClient(types);
  await createWorkout(create.client, { name: "Tempo 5x4", sport: "running", steps: STEPS_INPUT });
  const post = create.calls.at(-1)!;
  assert.equal([post.method, post.path].join(" "), "POST /workout-service/workout");
  assert.equal(JSON.stringify(post.options?.json), GOLDEN_PAYLOAD);

  const base = { workoutId: 5, workoutName: "A", sportType: { sportTypeKey: "running", sportTypeId: 1 }, workoutSegments: [{ segmentOrder: 1, workoutSteps: [] }] };
  const update = fakeClient({ "/workout-service/workout/5": base });
  await updateWorkout(update.client, "5", { name: "B", steps: [{ type: "warmup", duration: 60 }] as never });
  const put = update.calls.at(-1)!;
  assert.equal([put.method, put.path].join(" "), "PUT /workout-service/workout/5");
  const body = put.options?.json as { workoutName: string; workoutId: string; estimatedDurationInSecs: number };
  assert.equal(body.workoutName, "B");
  assert.equal(body.workoutId, "5");
  assert.equal(body.estimatedDurationInSecs, 60);

  const file = fakeClient();
  await updateWorkout(file.client, "7", { payload: { workoutName: "F" } });
  assert.deepEqual(file.calls[0]!.options?.json, { workoutName: "F", workoutId: "7" });
});

test("update and create need steps or a payload", async () => {
  const { client } = fakeClient();
  await assert.rejects(createWorkout(client, { name: "x", sport: "running", sportId: 1 }), /--file or --steps/);
  await assert.rejects(updateWorkout(client, "1", { name: "x" }), /--file or --steps/);
});

test("read, download, delete and plan endpoints use the same paths as gc", async () => {
  const { client, calls } = fakeClient();
  await getWorkout(client, "12");
  await downloadWorkout(client, 12);
  await deleteWorkout(client, "12");
  await getAdaptiveTrainingPlan(client, "3");
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.options?.raw ?? false]),
    [
      ["GET", "/workout-service/workout/12", false],
      ["GET", "/workout-service/workout/FIT/12", true],
      ["DELETE", "/workout-service/workout/12", false],
      ["GET", "/trainingplan-service/trainingplan/fbt-adaptive/3", false],
    ],
  );
  assert.throws(() => getWorkout(client, "../x"), /positive integer/);
});
