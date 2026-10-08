import { describe, expect, it } from "vitest";
import { ShoalError } from "./errors.ts";
import type { Link } from "./model.ts";
import { DEV_WORKFLOW } from "./presets.ts";
import { checkTransition, validateWorkflow } from "./workflow.ts";

const base = { key: "DEMO-1", status: "Todo", assigneeId: null, estimate: null };
const pr: Link = {
  id: "l1",
  fromItemId: "i1",
  kind: "implements_pr",
  target: "https://github.com/acme/app/pull/1",
  createdAt: "2026-10-08T00:00:00.000Z",
};

function errorOf(fn: () => unknown): ShoalError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ShoalError) return e;
    throw e;
  }
  throw new Error("expected a ShoalError");
}

describe("DEV_WORKFLOW", () => {
  it("is valid", () => {
    expect(() => validateWorkflow(DEV_WORKFLOW)).not.toThrow();
  });

  it("requires an assignee to start work, with a fix hint", () => {
    const err = errorOf(() => checkTransition(DEV_WORKFLOW, base, "in progress", []));
    expect(err.code).toBe("rule_violation");
    expect(err.hint).toContain('"assignee": "me"');
    const ok = checkTransition(DEV_WORKFLOW, { ...base, assigneeId: "u1" }, "In Progress", []);
    expect(ok).toEqual({ name: "In Progress", category: "active" });
  });

  it("requires a pull request link for review", () => {
    const item = { ...base, status: "In Progress", assigneeId: "u1" };
    expect(errorOf(() => checkTransition(DEV_WORKFLOW, item, "In Review", [])).hint).toContain(
      "implements_pr",
    );
    expect(checkTransition(DEV_WORKFLOW, item, "In Review", [pr]).name).toBe("In Review");
  });

  it("lists allowed targets when no transition exists", () => {
    const err = errorOf(() => checkTransition(DEV_WORKFLOW, base, "In Review", []));
    expect(err.code).toBe("rule_violation");
    expect(err.hint).toContain("Canceled");
  });

  it("rejects unknown and unchanged statuses", () => {
    expect(errorOf(() => checkTransition(DEV_WORKFLOW, base, "Shipped", [])).hint).toContain(
      "Backlog",
    );
    expect(errorOf(() => checkTransition(DEV_WORKFLOW, base, "todo", [])).code).toBe("invalid");
  });
});

describe("validateWorkflow", () => {
  it("rejects transitions to undefined states", () => {
    const broken = { ...DEV_WORKFLOW, transitions: [{ from: "*", to: "Nope", rules: [] }] };
    expect(() => validateWorkflow(broken)).toThrow(/unknown state/);
  });
});
