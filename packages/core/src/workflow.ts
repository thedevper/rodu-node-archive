import { ShoalError } from "./errors.ts";
import type { Item, Link, Rule, State, Workflow } from "./model.ts";

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findState(workflow: Workflow, name: string): State | undefined {
  return workflow.states.find((s) => same(s.name, name));
}

/** Throws when the workflow refers to states it does not define. */
export function validateWorkflow(workflow: Workflow): void {
  const names = workflow.states.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new ShoalError("invalid", "Workflow state names must be unique");
  }
  if (!findState(workflow, workflow.initial)) {
    throw new ShoalError("invalid", `Initial state "${workflow.initial}" is not a workflow state`);
  }
  for (const t of workflow.transitions) {
    for (const end of [t.from, t.to]) {
      if (end !== "*" && !findState(workflow, end)) {
        throw new ShoalError("invalid", `Transition refers to unknown state "${end}"`);
      }
    }
  }
}

function allowedTargets(workflow: Workflow, from: string): string[] {
  return workflow.transitions
    .filter((t) => t.from === "*" || same(t.from, from))
    .map((t) => t.to)
    .filter((to, i, all) => !same(to, from) && all.findIndex((x) => same(x, to)) === i);
}

function ruleHint(rule: Rule): string {
  switch (rule.kind) {
    case "requireAssignee":
      return 'assign it first (update_item with {"assignee": "me"})';
    case "requireEstimate":
      return 'estimate it first (update_item with {"estimate": <points>})';
    case "requireLink":
      return rule.link === "implements_pr"
        ? 'link the pull request first (link with {"kind": "implements_pr", "target": "<PR URL>"})'
        : `add a "${rule.link}" link first`;
  }
}

function ruleHolds(
  rule: Rule,
  item: Pick<Item, "assigneeId" | "estimate">,
  links: Link[],
): boolean {
  switch (rule.kind) {
    case "requireAssignee":
      return item.assigneeId !== null;
    case "requireEstimate":
      return item.estimate !== null;
    case "requireLink":
      return links.some((l) => l.kind === rule.link);
  }
}

/**
 * Checks that `item` may move to `to` and returns the target state. Rules are enforced here,
 * in the domain, so a person, the CLI and an agent all hit the same guardrails.
 */
export function checkTransition(
  workflow: Workflow,
  item: Pick<Item, "key" | "status" | "assigneeId" | "estimate">,
  to: string,
  links: Link[],
): State {
  const target = findState(workflow, to);
  if (!target) {
    throw new ShoalError(
      "invalid",
      `Unknown status "${to}"`,
      `Valid statuses: ${workflow.states.map((s) => s.name).join(", ")}`,
    );
  }
  if (same(item.status, target.name)) {
    throw new ShoalError("invalid", `${item.key} is already in "${target.name}"`);
  }
  const transitions = workflow.transitions.filter(
    (t) => (t.from === "*" || same(t.from, item.status)) && same(t.to, target.name),
  );
  if (transitions.length === 0) {
    const targets = allowedTargets(workflow, item.status);
    throw new ShoalError(
      "rule_violation",
      `${item.key} cannot move from "${item.status}" to "${target.name}"`,
      targets.length > 0 ? `From "${item.status}" it can move to: ${targets.join(", ")}` : null,
    );
  }
  // Several transitions may match ("*" and an exact one): any one whose rules all hold is enough.
  const failures = transitions.map((t) => t.rules.filter((r) => !ruleHolds(r, item, links)));
  if (failures.some((failed) => failed.length === 0)) return target;
  const failed = failures.reduce((a, b) => (b.length < a.length ? b : a));
  throw new ShoalError(
    "rule_violation",
    `${item.key} cannot move to "${target.name}" yet`,
    failed.map(ruleHint).join("; "),
  );
}
