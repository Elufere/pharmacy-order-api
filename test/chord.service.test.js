const test = require("node:test");
const assert = require("node:assert/strict");

const servicePath = require.resolve("../src/services/chord.service");

function captureLogs(run) {
  const original = { info: console.info, error: console.error };
  const logs = [];
  console.info = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  return Promise.resolve().then(run).finally(() => {
    console.info = original.info;
    console.error = original.error;
  }).then(result => ({ result, logs }));
}

test("Chord notification uses the established scheduled-task route and logs task result safely", async () => {
  process.env.CHORD_BASE_URL = "https://api.chordhq.xyz/";
  process.env.CHORD_API_KEY = "test-key-never-log";
  process.env.CHORD_WORKSPACE_ID = "test-workspace";
  process.env.CHORD_TEAMMATE_ID = "test-teammate";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 201, json: async () => ({ id: "task-123", status: "scheduled" }) };
  };
  delete require.cache[servicePath];
  const { result, logs } = await captureLogs(() => require(servicePath).sendNotification("payment_confirmed", "PH-1"));

  assert.equal(request.url, "https://api.chordhq.xyz/v1/scheduled-tasks");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-key-never-log");
  const body = JSON.parse(request.options.body);
  assert.equal(body.task_type, "MESSAGE");
  assert.equal(body.workspace_id, "test-workspace");
  assert.equal(body.teammate_id, "test-teammate");
  assert.equal(body.payload.conversation_id, "6ad9bfd74c772d0e6f520272");
  assert.match(body.payload.body, /PH-1/);
  assert.deepEqual(result, { sent: true, taskId: "task-123", status: "scheduled" });
  assert.ok(logs.some(([, detail]) => detail?.eventType === "payment_confirmed"));
  assert.ok(logs.some(([, detail]) => detail?.httpStatus === 201 && detail?.taskId === "task-123" && detail?.taskStatus === "scheduled"));
  assert.ok(!JSON.stringify(logs).includes("test-key-never-log"));
});

test("Chord API error logs sanitized response body and rejects dispatch", async () => {
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden", api_key: "must-not-log" }) });
  delete require.cache[servicePath];
  const { logs } = await captureLogs(() => assert.rejects(
    require(servicePath).sendNotification("ready_for_pickup", "PH-2"),
    /HTTP 403/
  ));
  const failure = logs.find(([, detail]) => detail?.httpStatus === 403);
  assert.ok(failure);
  assert.deepEqual(failure[1].errorBody, { error: "forbidden", api_key: "[REDACTED]" });
  assert.ok(!JSON.stringify(logs).includes("must-not-log"));
});
