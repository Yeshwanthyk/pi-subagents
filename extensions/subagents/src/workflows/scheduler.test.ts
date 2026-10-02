/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- These fixtures intentionally forge runtime inputs to prove fail-closed validation. */
import assert from "node:assert/strict";
import { test } from "node:test";
type FixtureValue = string | string[] | boolean | undefined;
type FixtureExtras = Readonly<Record<string, FixtureValue>>;
type HandoffFixtureOutput =
  | string
  | Date
  | string[]
  | MutableFixtureRecord
  | DeepFixture
  | { readonly value: string };
type DeepFixture = string | { child: DeepFixture };
type MutableFixtureRecord = { [key: string]: string | number };
import { buildWorkflowGraph } from "./graph.ts";
import {
  buildTaskHandoff,
  estimateHandoffTokens,
  MAX_HANDOFF_SANITIZE_ARRAY_ITEMS,
  MAX_HANDOFF_SANITIZE_DEPTH,
  MAX_HANDOFF_SANITIZE_PROPERTIES,
  WORKFLOW_HANDOFF_BEGIN,
  WORKFLOW_HANDOFF_END,
  WorkflowHandoffError,
} from "./handoff.ts";
import { WorkflowManager } from "./manager.ts";
import {
  computeSchedule,
  getReadyTaskIds,
  selectReadyTasks,
  scheduleReadyTasks,
  WorkflowSchedulingError,
} from "./scheduler.ts";

function readOnlyTask(id: string, extra: FixtureExtras = {}) {
  return {
    id,
    label: id,
    kind: "scout",
    prompt: `inspect ${id}`,
    readOnly: true,
    ...extra,
  };
}

function writerTask(id: string, owns: string[], extra: FixtureExtras = {}) {
  return {
    id,
    label: id,
    kind: "writer",
    prompt: `write ${id}`,
    owns,
    ...extra,
  };
}

test("scheduler selects independent roots together in declaration order", () => {
  const graph = buildWorkflowGraph({
    tasks: [
      readOnlyTask("inspect"),
      writerTask("write-a", ["src/a.ts"]),
      writerTask("write-b", ["src/b.ts"]),
      readOnlyTask("report", { needs: ["write-a", "write-b"] }),
    ],
  });

  const schedule = computeSchedule(graph);
  assert.deepEqual(schedule.readyTaskIds, ["inspect", "write-a", "write-b"]);
  assert.deepEqual(selectReadyTasks(graph), schedule.readyTaskIds);
  assert.deepEqual(selectReadyTasks(graph), schedule.readyTaskIds);
  assert.deepEqual(
    selectReadyTasks(graph, new Set<string>()),
    schedule.readyTaskIds,
  );
  assert.deepEqual(scheduleReadyTasks(graph), schedule.readyTaskIds);
  assert.deepEqual(getReadyTaskIds(graph), schedule.readyTaskIds);
  assert.deepEqual(schedule.blockedTaskIds, []);
  assert.equal("capacity" in schedule, false);
});

test("scheduler derives dependency readiness and skips queued, running, and terminal tasks", () => {
  const graph = buildWorkflowGraph({
    tasks: [
      readOnlyTask("scout"),
      writerTask("writer", ["src/out"], { needs: ["scout"] }),
      readOnlyTask("done", { needs: ["scout"] }),
    ],
  });
  assert.deepEqual(
    selectReadyTasks(graph, {
      statuses: { scout: "completed", writer: "ready", done: "ready" },
    }),
    ["writer", "done"],
  );
  assert.deepEqual(
    selectReadyTasks(graph, {
      statuses: {
        scout: "completed",
        writer: "queued",
        done: "completed",
      },
    }),
    [],
  );
});

test("active and selected overlapping writers block later work without a capacity pool", () => {
  const graph = buildWorkflowGraph({
    tasks: [
      writerTask("base", ["src/app"]),
      writerTask("child", ["src/app/file.ts"], {
        needs: ["base"],
      }),
      writerTask("other", ["src/other.ts"]),
    ],
  });

  const active = computeSchedule(graph, {
    completedTaskIds: ["base"],
    activeTaskIds: ["base"],
  });
  assert.deepEqual(active.readyTaskIds, ["other"]);
  assert.deepEqual(active.blockedTaskIds, ["child"]);
  assert.deepEqual(active.blockedByScope.get("child"), ["base"]);

  const selected = computeSchedule(graph, {
    completedTaskIds: ["base"],
    selectedTaskIds: ["base"],
  });
  assert.deepEqual(selected.readyTaskIds, ["other"]);
  assert.deepEqual(selected.blockedByScope.get("child"), ["base"]);
});

test("scheduler rejects forged getters on graph and status inputs without invoking them", () => {
  const graph = buildWorkflowGraph({ tasks: [readOnlyTask("read")] });
  let graphGetterCalled = false;
  const forgedGraph = { ...graph } as Record<string, unknown>;
  Object.defineProperty(forgedGraph, "tasksById", {
    get() {
      graphGetterCalled = true;
      throw new Error("forged graph getter");
    },
  });
  assert.throws(
    () => selectReadyTasks(forgedGraph as never),
    WorkflowSchedulingError,
  );
  assert.equal(graphGetterCalled, false);
  let statusGetterCalled = false;
  const statuses = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(statuses, "read", {
    get() {
      statusGetterCalled = true;
      throw new Error("forged status getter");
    },
  });
  assert.throws(
    () => selectReadyTasks(graph, { statuses: statuses as never }),
    WorkflowSchedulingError,
  );
  assert.equal(statusGetterCalled, false);
  let inheritedGetCalled = false;
  const inheritedStatuses = Object.create({
    get() {
      inheritedGetCalled = true;
      throw new Error("inherited get");
    },
  }) as Record<string, unknown>;
  inheritedStatuses.read = "ready";
  assert.throws(
    () => selectReadyTasks(graph, { statuses: inheritedStatuses as never }),
    WorkflowSchedulingError,
  );
  assert.equal(inheritedGetCalled, false);
});
test("read-only tasks never conflict with writers and status records are fail-closed", () => {
  const graph = buildWorkflowGraph({
    tasks: [readOnlyTask("read"), writerTask("write", ["src/out"])],
  });
  assert.deepEqual(
    selectReadyTasks(graph, {
      activeTaskIds: ["write"],
    }),
    ["read"],
  );
  assert.throws(
    () => selectReadyTasks(graph, { activeTaskIds: ["unknown"] }),
    /unknown task/,
  );
  assert.throws(
    () =>
      selectReadyTasks(graph, { statuses: new Map([["unknown", "ready"]]) }),
    /unknown task/,
  );
  assert.throws(
    () =>
      selectReadyTasks(graph, {
        // SAFETY: intentionally violates the static status union to exercise runtime validation.
        statuses: { read: "not-a-status" as never },
      }),
    /invalid workflow status/,
  );
});

test("handoffs include only explicit completed consumes and are delimited, labeled, and transcript-free", () => {
  const handoff = buildTaskHandoff(
    { id: "writer", label: "Writer", consumes: ["scout"] },
    new Map([
      [
        "scout",
        {
          status: "completed",
          label: "Scout report",
          output: {
            summary: "Found two files.",
            transcript: "SECRET nested transcript should never appear",
          },
          transcript: "SECRET transcript should never appear",
          sessionFilePath: "/Users/example/.pi/session.jsonl",
        },
      ],
    ]),
  );

  assert.match(handoff.text, new RegExp(`^${WORKFLOW_HANDOFF_BEGIN}`));
  assert.match(handoff.text, new RegExp(`${WORKFLOW_HANDOFF_END}$`));
  assert.match(handoff.text, /"taskId":"scout"/);
  assert.match(handoff.text, /Scout report/);
  assert.match(handoff.text, /Found two files/);
  assert.doesNotMatch(handoff.text, /SECRET transcript/);
  assert.doesNotMatch(handoff.text, /SECRET transcript/);
  assert.doesNotMatch(handoff.text, /SECRET nested/);
  assert.doesNotMatch(handoff.text, /Users\/example/);
  assert.equal(handoff.entries.length, 1);
  assert.equal(handoff.entries[0]?.truncated, false);

  const empty = buildTaskHandoff(
    { id: "writer", consumes: [] },
    new Map([["scout", { status: "completed", output: "not selected" }]]),
  );
  assert.doesNotMatch(empty.text, /not selected/);
});

test("handoff redacts every authorization scheme and credential key variant", () => {
  const secrets = [
    "digest-user",
    "digest-response",
    "aws-access-key",
    "aws-signature",
    "negotiate-token",
    "ntlm-token",
    "plural-credential",
    "client-secret-value",
    "client-key-value",
  ];
  const output = [
    'Authorization: Digest username=\\"digest-user\\", response=\\"digest-response\\"',
    "Authorization: AWS4-HMAC-SHA256 Credential=aws-access-key, Signature=aws-signature",
    "Proxy-Authorization: Negotiate negotiate-token",
    "Authorization: NTLM ntlm-token",
    "credentials: plural-credential",
    "client_secret: client-secret-value",
    "clientKey: client-key-value",
    "visible=ok",
  ].join("\n");
  const handoff = buildTaskHandoff(
    { id: "writer", consumes: ["scout"] },
    new Map([
      ["scout", { status: "completed", output, artifactRef: "artifact:safe" }],
    ]),
  );
  for (const secret of secrets)
    assert.doesNotMatch(handoff.text, new RegExp(secret));
  assert.match(handoff.text, /visible=ok/);
  assert.match(handoff.text, /redacted/);
});

test("invalid artifact and session references are replaced with a safe opaque reference", () => {
  const handoff = buildTaskHandoff(
    { id: "writer", consumes: ["scout"] },
    new Map([
      [
        "scout",
        {
          status: "completed",
          output: "x".repeat(10_000),
          artifactRef: "/private/session-secret",
          sessionRef: "session:../secret",
          artifactId: "../../secret",
          sessionId: "session secret",
        },
      ],
    ]),
    { maxBytes: 1_024, maxTokens: 256 },
  );
  assert.equal(handoff.entries[0]?.reference, "artifact:unavailable");
  assert.match(
    handoff.entries[0]?.text ?? "",
    /opaque reference: artifact:unavailable/,
  );
  assert.doesNotMatch(
    handoff.text,
    /session-secret|\.\.\/secret|session secret/,
  );
});

test("handoff redaction removes complete structured secret values", () => {
  const quoted = "quoted-secret with spaces";
  const basic = "basic-secret with spaces";
  const bearer = "bearer-secret with spaces";
  const cookie = "session-secret";
  const csrf = "csrf-secret after semicolon";
  const nested = "nested-secret with spaces";
  const authWithSemicolon = "auth-secret; with spaces";
  const output = [
    `apiKey="${quoted}"`,
    `Authorization: Basic ${basic}`,
    `Authorization: Bearer ${bearer}`,
    `Authorization: Basic ${authWithSemicolon}`,
    `Cookie: session=${cookie}; csrf=${csrf}; theme=dark`,
    `secret: {"outer":{"inner":"${nested}"}}; visible=ok`,
    "visible=ok",
  ].join("\n");
  const handoff = buildTaskHandoff(
    { id: "writer", consumes: ["scout"] },
    new Map([
      ["scout", { status: "completed", output, artifactRef: "artifact:scout" }],
    ]),
  );

  for (const secret of [
    quoted,
    basic,
    bearer,
    authWithSemicolon,
    cookie,
    csrf,
    nested,
  ]) {
    assert.doesNotMatch(handoff.text, new RegExp(secret));
  }
  assert.match(handoff.text, /visible=ok/);
  assert.match(handoff.text, /redacted-cookie/);
});

test("handoff sanitization bounds traversal and falls back to opaque references", () => {
  const reference = "artifact:bounded";
  const opaque = (output: HandoffFixtureOutput) =>
    buildTaskHandoff(
      { id: "writer", consumes: ["scout"] },
      new Map([
        ["scout", { status: "completed", output, artifactRef: reference }],
      ]),
    ).entries[0]!;

  const tooManyProperties: MutableFixtureRecord = Object.create(null);
  for (let index = 0; index <= MAX_HANDOFF_SANITIZE_PROPERTIES; index++) {
    tooManyProperties[`field-${index}`] = index;
  }
  let tooDeep: DeepFixture = "deep-secret";
  for (let index = 0; index <= MAX_HANDOFF_SANITIZE_DEPTH; index++) {
    tooDeep = { child: tooDeep };
  }
  let proxyTrapCalled = false;
  const proxy = new Proxy(
    { value: "proxy-secret" },
    {
      ownKeys() {
        proxyTrapCalled = true;
        throw new Error("proxy was walked");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalled = true;
        throw new Error("proxy was walked");
      },
    },
  );
  let getterCalled = false;
  const accessor = Object.defineProperty(Object.create(null), "value", {
    get() {
      getterCalled = true;
      return "getter-secret";
    },
  });

  const entries = [
    opaque("safe".repeat(MAX_HANDOFF_SANITIZE_PROPERTIES)),
    opaque(
      Array.from(
        { length: MAX_HANDOFF_SANITIZE_ARRAY_ITEMS + 1 },
        () => "array-item",
      ),
    ),
    opaque(tooManyProperties),
    opaque(tooDeep),
    opaque(new Date()),
    opaque(proxy),
    opaque(accessor),
  ];
  for (const entry of entries) {
    assert.equal(entry.truncated, true);
    assert.equal(entry.reference, reference);
    assert.match(entry.text, /opaque reference: artifact:bounded/);
  }
  assert.equal(proxyTrapCalled, false);
  assert.equal(getterCalled, false);
  for (const entry of entries) {
    assert.doesNotMatch(entry.text, /deep-secret|proxy-secret|getter-secret/);
  }
});

test("handoffs fail closed for missing or non-completed dependencies", () => {
  assert.throws(
    () => buildTaskHandoff({ id: "writer", consumes: ["scout"] }, new Map()),
    WorkflowHandoffError,
  );
  assert.throws(
    () =>
      buildTaskHandoff(
        { id: "writer", consumes: ["scout"] },
        new Map([["scout", { status: "running", output: "still working" }]]),
      ),
    /only completed dependency/,
  );
  assert.throws(
    () => buildTaskHandoff({ id: "writer", consumes: ["writer"] }, new Map()),
    /cannot consume itself/,
  );
});

test("oversized handoffs truncate deterministically within byte/token bounds and use opaque refs", () => {
  const result = {
    status: "completed" as const,
    output:
      "apiKey=do-not-leak path=/workspace/repo/native.json \\\\server\\share\\native.json " +
      "😀".repeat(20_000),
    artifactRef: "artifact:scout-report",
    sessionFilePath: "/private/var/folders/native-session.jsonl",
  };
  const task = { id: "writer", consumes: ["scout"] };
  const first = buildTaskHandoff(task, new Map([["scout", result]]), {
    maxBytes: 1_024,
    maxTokens: 256,
  });
  const second = buildTaskHandoff(task, new Map([["scout", result]]), {
    maxBytes: 1_024,
    maxTokens: 256,
  });

  assert.deepEqual(first, second);
  assert.equal(first.entries[0]?.truncated, true);
  assert.equal(first.entries[0]?.reference, "artifact:scout-report");
  assert.ok(first.entries[0]!.bytes <= 1_024);
  assert.ok(first.entries[0]!.tokens <= 256);
  assert.ok(first.bytes <= 1 * 1024 * 1024);
  assert.ok(first.tokens <= Math.ceil((1 * 1024 * 1024) / 4));
  assert.match(first.text, /opaque reference: artifact:scout-report/);
  assert.doesNotMatch(first.text, /do-not-leak/);
  assert.doesNotMatch(first.text, /native-session/);
  assert.doesNotMatch(first.text, /workspace\/repo\/native/);
  assert.doesNotMatch(first.text, /server\\share\\native/);
  assert.equal(estimateHandoffTokens(first.text), first.tokens);
});

test("scheduler requires complete authoritative status projections", () => {
  const graph = buildWorkflowGraph({
    tasks: [readOnlyTask("root"), readOnlyTask("child", { needs: ["root"] })],
  });
  assert.throws(
    () => selectReadyTasks(graph, { statuses: { root: "completed" } }),
    /missing status for task "child"/,
  );
  assert.throws(
    () =>
      selectReadyTasks(graph, {
        statuses: {
          root: "ready",
          child: "blocked",
          extra: "ready",
        } as never,
      }),
    /unknown task "extra"/,
  );

  const readModel = new WorkflowManager({
    createId: () => "authority",
  }).createRun({
    tasks: [readOnlyTask("root"), readOnlyTask("child", { needs: ["root"] })],
  });
  assert.deepEqual(selectReadyTasks(readModel), ["root"]);
  assert.throws(
    () =>
      selectReadyTasks({
        target: readModel,
        statuses: { root: "completed", child: "blocked" },
      }),
    /contradicts authoritative read model state/,
  );

  const missingTask = { ...readModel.tasks } as Record<string, unknown>;
  delete missingTask.child;
  assert.throws(
    () => selectReadyTasks({ ...readModel, tasks: missingTask } as never),
    /missing status for task "child"/,
  );
});

test("scheduler never invokes hostile iterators at checked collection boundaries", () => {
  const graph = buildWorkflowGraph({ tasks: [readOnlyTask("root")] });
  let iteratorCalled = false;
  const hostile = {
    [Symbol.iterator]() {
      iteratorCalled = true;
      throw new Error("hostile iterator");
    },
  };
  assert.throws(
    () =>
      selectReadyTasks(graph, {
        completedTaskIds: hostile as never,
      }),
    WorkflowSchedulingError,
  );
  assert.equal(iteratorCalled, false);

  const completed = new Set(["root"]);
  Object.defineProperty(completed, Symbol.iterator, {
    get() {
      iteratorCalled = true;
      throw new Error("hostile set iterator");
    },
  });
  assert.deepEqual(selectReadyTasks(graph, { completedTaskIds: completed }), [
    "root",
  ]);
  assert.equal(iteratorCalled, false);

  const statuses = new Map([["root", "ready" as const]]);
  Object.defineProperty(statuses, Symbol.iterator, {
    get() {
      iteratorCalled = true;
      throw new Error("hostile map iterator");
    },
  });
  assert.deepEqual(selectReadyTasks(graph, { statuses }), ["root"]);
  assert.equal(iteratorCalled, false);
});

test("handoffs redact credential-shaped references and normalized assignment keys", () => {
  const secrets = {
    refresh: "refresh-secret",
    session: "session-secret",
    id: "id-secret",
    passwd: "passwd-secret",
    pwd: "pwd-secret",
  };
  const output = [
    `refresh_token=${secrets.refresh}`,
    `session-token: ${secrets.session}`,
    `idToken: ${secrets.id}`,
    `passwd=${secrets.passwd}`,
    `pwd: ${secrets.pwd}`,
  ].join("\n");
  const credentialReferences = [
    "artifact:sk-live-secret-value",
    "session:github_pat_live_secret_value",
    "artifact:AKIA1234567890AB",
    "artifact:password-supersecret",
    "artifact:token-supersecret",
    "artifact:client_secret_supersecret",
  ];
  for (const credentialReference of credentialReferences) {
    const handoff = buildTaskHandoff(
      { id: "writer", consumes: ["scout"] },
      new Map([
        [
          "scout",
          {
            status: "completed",
            output: `${output}\n${"x".repeat(10_000)}`,
            artifactRef: credentialReference,
          },
        ],
      ]),
      { maxBytes: 1_024, maxTokens: 256 },
    );
    assert.equal(handoff.entries[0]?.reference, "artifact:unavailable");
    assert.doesNotMatch(
      handoff.text,
      /sk-live-secret-value|github_pat_live_secret_value|AKIA1234567890AB|password-supersecret|token-supersecret|client_secret_supersecret/,
    );
    for (const secret of Object.values(secrets)) {
      assert.doesNotMatch(handoff.text, new RegExp(secret));
    }
  }
});

test("handoffs redact secrets embedded in result labels and object keys", () => {
  const handoff = buildTaskHandoff(
    { id: "writer", consumes: ["scout"] },
    new Map([
      [
        "scout",
        {
          status: "completed",
          label: "token-supersecret",
          output: {
            "token-supersecret": "hidden",
            client_secret_supersecret: "hidden",
            "password-supersecret": "hidden",
          },
        },
      ],
    ]),
  );
  assert.match(handoff.text, /\[redacted-label\]/);
  assert.match(handoff.text, /\[redacted-key\]/);
  assert.doesNotMatch(
    handoff.text,
    /token-supersecret|client_secret_supersecret|password-supersecret/,
  );
});
