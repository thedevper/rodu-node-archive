import { describe, expect, it } from "vitest";
import { rankBetween } from "./rank.ts";

describe("rankBetween", () => {
  it("appends in sorted order", () => {
    const ranks: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 500; i++) {
      last = rankBetween(last, null);
      ranks.push(last);
    }
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("prepends in sorted order", () => {
    let first: string | null = null;
    const ranks: string[] = [];
    for (let i = 0; i < 200; i++) {
      first = rankBetween(null, first);
      ranks.unshift(first);
    }
    expect([...ranks].sort()).toEqual(ranks);
  });

  it("always fits a rank between two neighbours", () => {
    let low = rankBetween(null, null);
    const high = rankBetween(low, null);
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      low = mid;
    }
  });

  it("rejects ranks in the wrong order", () => {
    expect(() => rankBetween("b", "a")).toThrow();
    expect(() => rankBetween("a", "a")).toThrow();
  });

  it("keeps appended ranks short", () => {
    let last: string | null = null;
    for (let i = 0; i < 1000; i++) last = rankBetween(last, null);
    expect(last?.length).toBeLessThanOrEqual(20);
  });
});
