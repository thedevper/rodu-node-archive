import { describe, expect, it } from "vitest";
import type { ItemView, State } from "./api.ts";
import { dropNeighbours, groupByState, insertionIndex } from "./board.ts";

const states: State[] = [
  { name: "Todo", category: "backlog" },
  { name: "In Progress", category: "active" },
];

function card(key: string, status: string): ItemView {
  return {
    key,
    title: key,
    body: "",
    type: "task",
    status,
    category: "backlog",
    priority: "none",
    assignee: null,
    estimate: null,
    due: null,
    rank: key,
    version: 1,
  };
}

describe("groupByState", () => {
  it("keeps API order within each column and matches status case-insensitively", () => {
    const columns = groupByState(states, [
      card("A", "Todo"),
      card("B", "in progress"),
      card("C", "Todo"),
    ]);
    expect(columns.get("Todo")?.map((i) => i.key)).toEqual(["A", "C"]);
    expect(columns.get("In Progress")?.map((i) => i.key)).toEqual(["B"]);
  });
});

describe("dropNeighbours", () => {
  const column = [card("A", "Todo"), card("B", "Todo"), card("C", "Todo")];

  it("gives the cards around the drop position", () => {
    expect(dropNeighbours(column, "C", 0)).toEqual({ after: null, before: "A" });
    expect(dropNeighbours(column, "A", 1)).toEqual({ after: "B", before: "C" });
    expect(dropNeighbours(column, "A", 2)).toEqual({ after: "C", before: null });
  });

  it("returns null when nothing would change", () => {
    expect(dropNeighbours(column, "B", 1)).toBeNull();
    expect(dropNeighbours([], "X", 0)).toBeNull();
  });

  it("handles a card coming from another column", () => {
    expect(dropNeighbours(column, "X", 3)).toEqual({ after: "C", before: null });
    expect(dropNeighbours(column, "X", 9)).toEqual({ after: "C", before: null });
  });
});

describe("insertionIndex", () => {
  it("finds the first card whose midpoint is below the pointer", () => {
    expect(insertionIndex([10, 30, 50], 5)).toBe(0);
    expect(insertionIndex([10, 30, 50], 40)).toBe(2);
    expect(insertionIndex([10, 30, 50], 60)).toBe(3);
  });
});
