/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Rendering tests use deliberately partial TUI, Theme, keybinding, and child snapshot doubles. */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../domain.ts";
import type { ValidatedWorkflowDefinition } from "../workflows/domain.ts";
import type { WorkflowEvent } from "../workflows/events.ts";
import { projectWorkflowRun } from "../workflows/projection.ts";
import { foldWorkflowEvents } from "../workflows/reducer.ts";
import {
  renderWorkflowRunRow,
  renderWorkflowTaskRows,
  workflowStatusLabel,
  WorkflowDashboard,
  openWorkflowDashboard,
  type WorkflowDashboardResult,
  type WorkflowDashboardSelection,
  type WorkflowDashboardSource,
} from "./workflow-dashboard.ts";

type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

const definition: ValidatedWorkflowDefinition = {
  name: "responsive workflow",
  tasks: [
    {
      id: "inspect",
      label: "Inspect repository boundaries",
      kind: "scout",
      prompt: "inspect",
      readOnly: true,
    },
    {
      id: "review",
      label: "Review the bounded result",
      kind: "review",
      prompt: "review",
      needs: ["inspect"],
      consumes: ["inspect"],
      owns: ["src/workflows"],
    },
  ],
};

function event(at: number, value: WorkflowEventInput): WorkflowEvent {
  return { ...value, runId: "wf-responsive", at } as WorkflowEvent;
}

function run(failed = false) {
  const events = [
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, {
      _tag: "TaskQueued",
      taskId: "inspect",
      childId: "sa-inspect",
      attemptId: "attempt-1",
    }),
    event(4, {
      _tag: "TaskStarted",
      taskId: "inspect",
      attemptId: "attempt-1",
    }),
    event(5, {
      _tag: "TaskCompleted",
      taskId: "inspect",
      attemptId: "attempt-1",
      resultPreview: "ok",
    }),
    event(6, {
      _tag: "TaskQueued",
      taskId: "review",
      childId: "sa-review",
      attemptId: "attempt-1",
    }),
    event(7, {
      _tag: "TaskStarted",
      taskId: "review",
      attemptId: "attempt-1",
    }),
  ];
  if (failed)
    events.push(
      event(8, {
        _tag: "TaskFailed",
        taskId: "review",
        attemptId: "attempt-1",
        error: "review failed",
      }),
    );
  return foldWorkflowEvents(events);
}

function blockedRun() {
  return foldWorkflowEvents([
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, {
      _tag: "TaskQueued",
      taskId: "inspect",
      childId: "sa-inspect",
      attemptId: "attempt-1",
    }),
    event(4, {
      _tag: "TaskStarted",
      taskId: "inspect",
      attemptId: "attempt-1",
    }),
  ]);
}

const child = {
  id: "sa-review",
  backend: "pi",
  owner: "workflow:wf-responsive",
  workflow: {
    runId: "wf-responsive",
    taskId: "review",
    attemptId: "attempt-1",
  },
  resultDelivery: "workflow",
  title: "Review",
  prompt: "review",
  cwd: "/repo",
  status: "running",
  createdAt: 6,
  startedAt: 7,
  lastActivityAt: 8,
  meta: { backend: "pi", modelLabel: "luna", reasoningEffort: "high" },
  usage: {},
  transcript: [],
  liveTools: [{ toolId: "tool-1", name: "read", startedAt: 8, updatedAt: 8 }],
  completedOperations: 2,
  processTelemetry: "unavailable",
  queued: [],
  turns: 1,
} as unknown as SubagentSnapshot;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
  matches: (data: string, action: string) => {
    if (action === "tui.select.confirm") return data === "enter";
    if (action === "tui.select.cancel") return data === "escape";
    if (action === "tui.select.up") return data === "up";
    if (action === "tui.select.down") return data === "down";
    return false;
  },
} as unknown as KeybindingsManager;

function dashboard(
  width: number,
  done: (result: WorkflowDashboardResult) => void,
  sourceRuns: ReadonlyArray<ReturnType<typeof run>> = [run()],
  selection: WorkflowDashboardSelection = {},
  terminalRows = 24,
  sourceChildren: ReadonlyArray<SubagentSnapshot> = [child],
) {
  const tui = {
    terminal: { rows: terminalRows },
    requestRender() {},
  } as unknown as TUI;
  const source: WorkflowDashboardSource = {
    list: () => sourceRuns,
    subscribe: () => () => {},
    children: () => sourceChildren,
    subscribeChildren: () => () => {},
  };
  const view = new WorkflowDashboard(
    tui,
    theme,
    keybindings,
    source,
    selection,
    done,
  );
  const lines = view.render(width);
  return { view, lines };
}

test("workflow rows preserve status and task wiring within fixed widths", () => {
  const projection = projectWorkflowRun(run(), [child]);
  const runRow = renderWorkflowRunRow(projection, 90, true, theme, 10);
  assert.ok(visibleWidth(runRow) <= 90);
  assert.match(runRow, /responsive workflow/);
  assert.match(runRow, /1\/2 done/);
  assert.doesNotMatch(runRow, /terminal/);

  const tasks = renderWorkflowTaskRows(projection, 60, "review", theme);
  assert.ok(tasks.every((line) => visibleWidth(line) <= 60));
  assert.match(tasks.join("\n"), /needs:inspect/);
  assert.match(tasks.join("\n"), /read only/);
  assert.match(tasks.join("\n"), /owns src\/workflows/);
  assert.match(tasks.join("\n"), /read/);
});

test("workflow dashboard uses two panes on wide terminals", () => {
  const { view, lines } = dashboard(120, () => {});
  try {
    assert.ok(lines.every((line) => visibleWidth(line) <= 120));
    assert.match(lines.join("\n"), /Workflows/);
    assert.match(lines.join("\n"), /Runs/);
    assert.match(lines.join("\n"), /Overview/);
    assert.doesNotMatch(lines.join("\n"), /Run · tasks/);
    assert.match(lines.join("\n"), /Inspect repository boundaries/);
  } finally {
    view.dispose();
  }
});

test("workflow inspector keeps the selected task detail visible", () => {
  const selection: WorkflowDashboardSelection = {
    runId: "wf-responsive",
    taskId: "review",
  };
  const { view } = dashboard(120, () => {}, [run()], selection);
  try {
    view.handleInput("enter");
    const rendered = view.render(120).join("\n");
    assert.match(rendered, /Tasks/);
    assert.match(rendered, /Task/);
    assert.match(rendered, /RUNNING/);
    assert.match(rendered, /attempt 1/);
    assert.match(rendered, /pi\/luna\/high/);
    assert.match(rendered, /owns src\/workflows/);
  } finally {
    view.dispose();
  }
});

test("workflow dashboard switches layout at the 92-column boundary", () => {
  for (const [width, expected] of [
    [91, "narrow"],
    [92, "Overview"],
  ] as const) {
    const { view, lines } = dashboard(width, () => {});
    try {
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /Runs/);
      if (expected === "narrow")
        assert.match(lines.join("\n"), /narrow overview/);
      else assert.match(lines.join("\n"), /Overview/);
    } finally {
      view.dispose();
    }
  }
});

test("workflow dashboard keeps drill-down coherent when width changes", () => {
  const { view } = dashboard(120, () => {});
  try {
    assert.match(view.render(48).join("\n"), /narrow overview/);
    view.handleInput("enter");
    assert.match(view.render(48).join("\n"), /narrow tasks/);
    assert.match(view.render(120).join("\n"), /Tasks/);
    assert.match(view.render(120).join("\n"), /Task/);
    view.handleInput("escape");
    assert.match(view.render(48).join("\n"), /narrow overview/);

    view.handleInput("enter");
    assert.match(view.render(48).join("\n"), /narrow tasks/);
    assert.match(view.render(120).join("\n"), /Tasks/);
    view.handleInput("escape");
    assert.match(view.render(48).join("\n"), /narrow overview/);
  } finally {
    view.dispose();
  }
});

test("workflow dashboard preserves selected run and task ids across updates", () => {
  const older = run();
  const newer = {
    ...older,
    id: "wf-newer",
    definition: { ...older.definition, name: "newer workflow" },
    createdAt: 100,
    lastActivityAt: 100,
  };
  const runs = [older];
  const selection: WorkflowDashboardSelection = {};
  const { view } = dashboard(120, () => {}, runs, selection);
  try {
    view.render(120);
    assert.equal(selection.runId, older.id);
    assert.equal(selection.taskId, "inspect");

    view.handleInput("enter");
    view.handleInput("down");
    view.render(120);
    assert.equal(selection.taskId, "review");

    runs.unshift(newer);
    view.render(120);
    assert.equal(selection.runId, older.id);
    assert.equal(selection.taskId, "review");
  } finally {
    view.dispose();
  }
});

test("workflow dashboard drills down and back on small terminals", () => {
  const results: WorkflowDashboardResult[] = [];
  const { view, lines } = dashboard(48, (result) => results.push(result));
  try {
    assert.ok(lines.every((line) => visibleWidth(line) <= 48));
    assert.match(lines.join("\n"), /Runs/);
    assert.doesNotMatch(lines.join("\n"), /Run · tasks/);

    view.handleInput("enter");
    const taskLines = view.render(48);
    assert.ok(taskLines.every((line) => visibleWidth(line) <= 48));
    assert.match(taskLines.join("\n"), /Tasks/);
    assert.match(taskLines.join("\n"), /Task ·/);
    assert.match(taskLines.at(-1) ?? "", /narrow tasks/);
    assert.match(taskLines.at(-1) ?? "", /esc back/);

    view.handleInput("escape");
    assert.match(view.render(48).join("\n"), /Runs/);
    view.handleInput("\u001b[122;6u");
    assert.deepEqual(results, [{ kind: "toggle" }]);
  } finally {
    view.dispose();
  }
});

test("workflow dashboard stays within the terminal line budget", () => {
  for (const terminalRows of [5, 8, 24]) {
    const { view, lines } = dashboard(48, () => {}, [run()], {}, terminalRows);
    try {
      assert.ok(lines.length <= terminalRows - 1);
      assert.ok(lines.every((line) => visibleWidth(line) <= 48));
      if (terminalRows > 4) assert.match(lines.at(-1) ?? "", /narrow overview/);
    } finally {
      view.dispose();
    }
  }
});

test("wide panes independently keep selected run and task visible", () => {
  const runs = Array.from({ length: 20 }, (_, index) => {
    const item = run(index === 19);
    return {
      ...item,
      id: `wf-${index}`,
      definition: { ...item.definition, name: `run-${index}` },
    };
  });
  const selection: WorkflowDashboardSelection = {
    runId: "wf-19",
    taskId: "review",
  };
  const { view, lines } = dashboard(120, () => {}, runs, selection, 8);
  try {
    const rendered = lines.join("\n");
    assert.ok(lines.length <= 7);
    assert.match(rendered, /run-19/);
    assert.match(rendered, /Overview/);
    view.handleInput("enter");
    const taskRendered = view.render(120).join("\n");
    assert.match(taskRendered, /Review the bounded result/);
    assert.match(taskRendered, /Task/);
  } finally {
    view.dispose();
  }
});

test("workflow status labels keep progress semantic", () => {
  for (const [status, label] of [
    ["completed", "DONE"],
    ["running", "RUNNING"],
    ["blocked", "BLOCKED"],
    ["ready", "READY"],
    ["queued", "QUEUED"],
    ["failed", "FAILED"],
    ["cancelled", "CANCELLED"],
    ["skipped", "SKIPPED"],
  ] as const) {
    assert.equal(workflowStatusLabel(status), label);
  }
  const rendered = renderWorkflowRunRow(
    projectWorkflowRun(run(true)),
    100,
    false,
    theme,
    10,
  );
  assert.match(rendered, /1\/2 done · 0 running · 0 blocked/);
  assert.doesNotMatch(rendered, /terminal/);
});

test("blocked tasks expose only projected causal dependencies", () => {
  const blocked = projectWorkflowRun(blockedRun());
  const blockedRows = renderWorkflowTaskRows(blocked, 100, "review", theme);
  assert.match(blockedRows.join("\n"), /BLOCKED <- inspect/);
  assert.doesNotMatch(blockedRows.join("\n"), /will run|guarantee|scheduler/iu);

  const waiting = {
    ...blocked,
    tasks: blocked.tasks.map((task, index) =>
      index === 1
        ? { ...task, status: "blocked" as const, dependencies: [] }
        : task,
    ),
  };
  const waitingRows = renderWorkflowTaskRows(waiting, 100, "inspect", theme);
  assert.match(waitingRows.join("\n"), /BLOCKED · waiting for admission/);
});

test("selection has a non-color cue and child hints stay truthful", () => {
  const projection = projectWorkflowRun(run(), [child]);
  const rows = renderWorkflowTaskRows(projection, 80, "review", theme);
  assert.match(rows[2] ?? "", /❯/);

  const availableResults: WorkflowDashboardResult[] = [];
  const available = dashboard(48, (result) => availableResults.push(result));
  try {
    available.view.handleInput("enter");
    available.view.handleInput("j");
    assert.match(available.view.render(48).at(-1) ?? "", /enter child/);
    available.view.handleInput("enter");
    assert.deepEqual(availableResults, [
      { kind: "child", childId: "sa-review" },
    ]);
  } finally {
    available.view.dispose();
  }

  const missingResults: WorkflowDashboardResult[] = [];
  const missing = dashboard(
    48,
    (result) => missingResults.push(result),
    [run()],
    {},
    24,
    [],
  );
  try {
    missing.view.handleInput("enter");
    assert.doesNotMatch(missing.view.render(48).at(-1) ?? "", /enter child/);
    missing.view.handleInput("enter");
    assert.deepEqual(missingResults, []);
    missing.view.handleInput("q");
    assert.deepEqual(missingResults, [{ kind: "close" }]);
  } finally {
    missing.view.dispose();
  }
});

test("workflow renderer stays within width and 22-row budgets in both modes", () => {
  for (const width of [1, 48, 91, 92, 120]) {
    const { view } = dashboard(width, () => {}, [run()], {}, 40);
    try {
      let lines = view.render(width);
      assert.ok(lines.length <= 22);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      view.handleInput("enter");
      lines = view.render(width);
      assert.ok(lines.length <= 22);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    } finally {
      view.dispose();
    }
  }
});

test("nested workflow child toggle closes the child and dashboard", async () => {
  const toggleInput = "\x1b[122;6u";
  const tui = {
    terminal: { columns: 120, rows: 24 },
    requestRender() {},
  } as unknown as TUI;
  const manager = {
    list: () => [run()],
    subscribe: () => () => {},
  } as unknown as Parameters<typeof openWorkflowDashboard>[1];
  const viewFixture = {
    list: () => [child],
    get: (id: string) => (id === child.id ? child : undefined),
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestSend() {},
    requestAbort() {},
  };
  const view = viewFixture as unknown as Parameters<
    typeof openWorkflowDashboard
  >[2];
  const keybindings = {
    matches: (data: string, action: string) => {
      if (action === "tui.select.confirm") return data === "enter";
      return false;
    },
  } as unknown as KeybindingsManager;
  let opens = 0;
  const custom = async <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (value: T) => void,
    ) => { handleInput(data: string): void },
  ): Promise<T> =>
    new Promise((resolve) => {
      const component = factory(tui, theme, keybindings, resolve);
      opens += 1;
      if (opens === 1) {
        component.handleInput("enter");
        component.handleInput("j");
        component.handleInput("enter");
      } else {
        component.handleInput(toggleInput);
      }
    });
  const ctx = { mode: "tui", ui: { custom } } as unknown as Parameters<
    typeof openWorkflowDashboard
  >[0];

  assert.equal(await openWorkflowDashboard(ctx, manager, view), true);
  assert.equal(opens, 2);
});
