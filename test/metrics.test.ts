import assert from "node:assert/strict";
import { test } from "node:test";
import { maxMet, trainingLoadBalance } from "../src/metrics.ts";

const recorder = () => {
  const paths: string[] = [];
  return { paths, client: { get: async (path: string) => (paths.push(path), { ok: true }) } as never };
};

test("load balance and VO2 max history use the endpoints verified on a live account", async () => {
  const { paths, client } = recorder();
  await trainingLoadBalance(client, "2026-11-17");
  await maxMet(client, "2026-09-18", "2026-11-17");
  assert.deepEqual(paths, ["/metrics-service/metrics/trainingloadbalance/latest/2026-11-17", "/metrics-service/metrics/maxmet/daily/2026-09-18/2026-11-17"]);
});

test("dates are validated before any request is made", async () => {
  const { paths, client } = recorder();
  assert.throws(() => trainingLoadBalance(client, "yesterday"));
  assert.throws(() => maxMet(client, "2026-13-01", "2026-11-17"));
  assert.deepEqual(paths, []);
});
