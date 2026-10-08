import type { Workflow } from "./model.ts";

/** Workflow for software teams: review needs a linked pull request, work needs an owner. */
export const DEV_WORKFLOW: Workflow = {
  states: [
    { name: "Backlog", category: "backlog" },
    { name: "Todo", category: "backlog" },
    { name: "In Progress", category: "active" },
    { name: "In Review", category: "review" },
    { name: "Done", category: "done" },
    { name: "Canceled", category: "done" },
  ],
  initial: "Backlog",
  transitions: [
    { from: "*", to: "Backlog", rules: [] },
    { from: "*", to: "Todo", rules: [] },
    { from: "*", to: "In Progress", rules: [{ kind: "requireAssignee" }] },
    {
      from: "In Progress",
      to: "In Review",
      rules: [{ kind: "requireAssignee" }, { kind: "requireLink", link: "implements_pr" }],
    },
    { from: "In Progress", to: "Done", rules: [] },
    { from: "In Review", to: "Done", rules: [] },
    { from: "*", to: "Canceled", rules: [] },
  ],
};
