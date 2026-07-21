import assert from "node:assert/strict";
import test from "node:test";
import { currentExternalHost } from "./src/external-shell.ts";

test("external host follows the current terminal environment", () => {
  assert.equal(
    currentExternalHost({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "1" }),
    "herdr",
  );
  assert.equal(currentExternalHost({ CMUX_WORKSPACE_ID: "workspace" }), "cmux");
  assert.equal(currentExternalHost({ TMUX: "/tmp/tmux" }), "tmux");
  assert.equal(currentExternalHost({}), undefined);
});

test("nested host markers prefer Herdr, then cmux, then tmux", () => {
  assert.equal(
    currentExternalHost({
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "1",
      CMUX_WORKSPACE_ID: "workspace",
      TMUX: "/tmp/tmux",
    }),
    "herdr",
  );
});
