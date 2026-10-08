import { RoduError } from "@rodu/core";
import { describe, expect, it } from "vitest";
import { parseQuery, toSql } from "./index.ts";

const ctx = { me: "user-1", now: new Date("2026-10-08T00:00:00.000Z") };

function errorOf(fn: () => unknown): RoduError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RoduError) return e;
    throw e;
  }
  throw new Error("expected a RoduError");
}

describe("parseQuery", () => {
  it("parses an empty query", () => {
    expect(parseQuery("")).toEqual({ where: null, orderBy: [] });
  });

  it("binds AND tighter than OR, case-insensitively", () => {
    const q = parseQuery("type = bug or type = story and priority = high");
    expect(q.where?.kind).toBe("or");
    if (q.where?.kind !== "or") return;
    expect(q.where.right.kind).toBe("and");
  });

  it("parses IN, NOT IN, IS EMPTY, functions, durations and ORDER BY", () => {
    const q = parseQuery(
      'status NOT IN ("Done", Canceled) AND assignee = me() AND parent IS NOT EMPTY ' +
        "AND created > -7d ORDER BY priority, updated desc",
    );
    expect(q.orderBy).toEqual([
      { field: "priority", direction: "asc", pos: expect.any(Number) },
      { field: "updated", direction: "desc", pos: expect.any(Number) },
    ]);
    expect(JSON.stringify(q.where)).toContain('"kind":"duration"');
    expect(JSON.stringify(q.where)).toContain('"name":"me"');
  });

  it("points at the error position", () => {
    const err = errorOf(() => parseQuery("status = "));
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("expected a value");
    expect(err.hint).toContain("^");
  });

  it("rejects unterminated strings and stray characters", () => {
    expect(errorOf(() => parseQuery('title ~ "abc')).message).toContain("unterminated");
    expect(errorOf(() => parseQuery("title ; drop")).message).toContain("unexpected character");
  });
});

describe("toSql", () => {
  it("compiles an empty query to match everything", () => {
    expect(toSql("", ctx)).toEqual({ where: "1 = 1", params: [], orderBy: "i.rank ASC, i.id ASC" });
  });

  it("binds every value as a parameter", () => {
    const sql = toSql("title ~ \"x' OR 1=1 --\" AND status = 'In Progress'", ctx);
    expect(sql.where).not.toContain("1=1");
    expect(sql.params).toEqual(["%x' OR 1=1 --%", "In Progress"]);
  });

  it("resolves me() and relative dates", () => {
    const sql = toSql("assignee = me() AND updated >= -1d", ctx);
    expect(sql.params).toEqual(["user-1", "2026-10-07T00:00:00.000Z"]);
  });

  it("treats != as including empty fields", () => {
    expect(toSql("assignee != me()", ctx).where).toBe("i.assignee_id IS NOT ?");
  });

  it("validates enum values with a hint", () => {
    const err = errorOf(() => toSql("priority = critical", ctx));
    expect(err.hint).toContain("urgent");
  });

  it("rejects unknown fields and functions in the wrong place", () => {
    expect(errorOf(() => toSql("password = x", ctx)).message).toContain('unknown field "password"');
    expect(errorOf(() => toSql("title = me()", ctx)).message).toContain("me() cannot be used here");
  });

  it("quotes full-text terms so FTS operators are literal", () => {
    const sql = toSql('text ~ "login NEAR crash"', ctx);
    expect(sql.params).toEqual(['"login" "NEAR" "crash"']);
  });

  it("escapes LIKE wildcards", () => {
    expect(toSql('title ~ "100%_"', ctx).params).toEqual(["%100\\%\\_%"]);
  });

  it("orders by priority with a stable tie-breaker", () => {
    const sql = toSql("ORDER BY priority", ctx);
    expect(sql.orderBy).toMatch(/^CASE i\.priority .* END ASC, i\.rank ASC, i\.id ASC$/);
    expect(errorOf(() => toSql("ORDER BY body", ctx)).message).toContain("cannot order by");
  });

  it("requires a principal for me()", () => {
    expect(errorOf(() => toSql("assignee = me()", { ...ctx, me: null })).message).toContain(
      "signed-in",
    );
  });
});
