import { CATEGORIES, ITEM_TYPES, PRIORITIES, RoduError } from "@rodu/core";
import type { CompareOp, Expr, OrderBy, Query, Value } from "./parse.ts";

// Compiles the AST to a parameterised SQLite WHERE / ORDER BY over `items i`.
// Only whitelisted fields are accepted and every value is bound as a parameter.

export type SqlParam = string | number | null;

export interface CompiledQuery {
  where: string;
  params: SqlParam[];
  orderBy: string;
}

export interface CompileContext {
  /** Principal id for me(); null when nobody is signed in. */
  me: string | null;
  now: Date;
}

interface Fragment {
  sql: string;
  params: SqlParam[];
}

type FieldKind = "key" | "text" | "status" | "enum" | "number" | "date" | "day" | "ref" | "fts";

interface FieldSpec {
  kind: FieldKind;
  column: string;
  /** Allowed values for enum fields. */
  values?: readonly string[];
  /** Resolves a value of a ref field to an id expression. */
  ref?: "principal" | "collection" | "cycle" | "item";
}

const FIELDS: Record<string, FieldSpec> = {
  key: { kind: "key", column: "i.key" },
  id: { kind: "key", column: "i.id" },
  title: { kind: "text", column: "i.title" },
  body: { kind: "text", column: "i.body" },
  text: { kind: "fts", column: "i.id" },
  type: { kind: "enum", column: "i.type", values: ITEM_TYPES },
  status: { kind: "status", column: "i.status" },
  category: { kind: "enum", column: "i.category", values: CATEGORIES },
  priority: { kind: "enum", column: "i.priority", values: PRIORITIES },
  estimate: { kind: "number", column: "i.estimate" },
  created: { kind: "date", column: "i.created_at" },
  updated: { kind: "date", column: "i.updated_at" },
  due: { kind: "day", column: "i.due_at" },
  assignee: { kind: "ref", column: "i.assignee_id", ref: "principal" },
  collection: { kind: "ref", column: "i.collection_id", ref: "collection" },
  cycle: { kind: "ref", column: "i.cycle_id", ref: "cycle" },
  parent: { kind: "ref", column: "i.parent_id", ref: "item" },
};
const ALIASES: Record<string, string> = {
  "status.category": "category",
  sprint: "cycle",
  project: "collection",
  createdat: "created",
  updatedat: "updated",
  dueat: "due",
};

const PRIORITY_ORDER =
  "CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 " +
  "WHEN 'low' THEN 3 ELSE 4 END";

const ORDER_FIELDS: Record<string, string> = {
  priority: PRIORITY_ORDER,
  created: "i.created_at",
  updated: "i.updated_at",
  due: "i.due_at",
  estimate: "i.estimate",
  key: "i.collection_id, i.number",
  rank: "i.rank",
  title: "i.title COLLATE NOCASE",
  status: "i.status COLLATE NOCASE",
};

const EQUALITY_OPS: CompareOp[] = ["=", "!="];
const ORDERING_OPS: CompareOp[] = ["=", "!=", "<", "<=", ">", ">="];

class Compiler {
  private readonly ctx: CompileContext;
  private readonly source: string;

  constructor(ctx: CompileContext, source: string) {
    this.ctx = ctx;
    this.source = source;
  }

  expr(e: Expr): Fragment {
    switch (e.kind) {
      case "and":
      case "or": {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        const joiner = e.kind === "and" ? "AND" : "OR";
        return {
          sql: `(${left.sql} ${joiner} ${right.sql})`,
          params: [...left.params, ...right.params],
        };
      }
      case "not": {
        const inner = this.expr(e.expr);
        return { sql: `(NOT ${inner.sql})`, params: inner.params };
      }
      case "empty":
        return this.empty(this.field(e.field, e.pos), e.negated, e.pos);
      case "in":
        return this.inList(this.field(e.field, e.pos), e.values, e.negated);
      case "compare":
        return this.compare(this.field(e.field, e.pos), e.field, e.op, e.value, e.pos);
    }
  }

  orderBy(order: OrderBy[]): string {
    const parts = order.map((o) => {
      const name = ALIASES[o.field] ?? o.field;
      const column = ORDER_FIELDS[name];
      if (!column) {
        throw this.error(
          `cannot order by "${o.field}"`,
          o.pos,
          `Order by one of: ${Object.keys(ORDER_FIELDS).join(", ")}`,
        );
      }
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      const nulls = name === "due" || name === "estimate" ? " NULLS LAST" : "";
      return column
        .split(", ")
        .map((c) => `${c} ${dir}${nulls}`)
        .join(", ");
    });
    parts.push("i.rank ASC", "i.id ASC");
    return parts.join(", ");
  }

  private field(name: string, pos: number): FieldSpec {
    const spec = FIELDS[ALIASES[name] ?? name];
    if (!spec) {
      throw this.error(`unknown field "${name}"`, pos, `Fields: ${Object.keys(FIELDS).join(", ")}`);
    }
    return spec;
  }

  private compare(
    spec: FieldSpec,
    name: string,
    op: CompareOp,
    value: Value,
    pos: number,
  ): Fragment {
    if (op === "~" || op === "!~") {
      if (spec.kind === "fts") {
        const match = this.fts(this.literal(value));
        return op === "~" ? match : { sql: `(NOT ${match.sql})`, params: match.params };
      }
      if (spec.kind !== "text" && spec.kind !== "key" && spec.kind !== "status") {
        throw this.error(`"${name}" does not support ~`, pos, "Use = or IN");
      }
      const pattern = `%${this.literal(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const not = op === "!~" ? "NOT " : "";
      return { sql: `${spec.column} ${not}LIKE ? ESCAPE '\\'`, params: [pattern] };
    }
    if (spec.kind === "fts") {
      if (op !== "=") throw this.error('"text" supports only = and ~', pos, 'e.g. text ~ "login"');
      return this.fts(this.literal(value));
    }
    const allowed =
      spec.kind === "number" || spec.kind === "date" || spec.kind === "day"
        ? ORDERING_OPS
        : EQUALITY_OPS;
    if (!allowed.includes(op)) {
      throw this.error(`"${name}" does not support ${op}`, pos, `Use ${allowed.join(", ")}`);
    }
    const rhs = this.value(spec, value);
    const column = spec.kind === "status" ? `${spec.column} COLLATE NOCASE` : spec.column;
    // `!=` keeps rows where the field is empty, which is what people expect from a filter.
    const sqlOp = op === "!=" ? "IS NOT" : op;
    return { sql: `${column} ${sqlOp} ${rhs.sql}`, params: rhs.params };
  }

  private inList(spec: FieldSpec, values: Value[], negated: boolean): Fragment {
    if (spec.kind === "fts") throw this.error('"text" does not support IN', values[0]?.pos ?? 0);
    const parts = values.map((v) => this.value(spec, v));
    const list = parts.map((p) => p.sql).join(", ");
    const params = parts.flatMap((p) => p.params);
    const column = spec.kind === "status" ? `${spec.column} COLLATE NOCASE` : spec.column;
    const sql = negated
      ? `(${spec.column} IS NULL OR ${column} NOT IN (${list}))`
      : `${column} IN (${list})`;
    return { sql, params };
  }

  private empty(spec: FieldSpec, negated: boolean, pos: number): Fragment {
    if (spec.kind === "text") {
      return { sql: negated ? `${spec.column} != ''` : `${spec.column} = ''`, params: [] };
    }
    const nullable = ["i.assignee_id", "i.parent_id", "i.cycle_id", "i.estimate", "i.due_at"];
    if (!nullable.includes(spec.column)) {
      throw this.error(
        "this field is never empty",
        pos,
        "IS EMPTY works on assignee, parent, cycle, estimate, due, body",
      );
    }
    return { sql: `${spec.column} IS ${negated ? "NOT " : ""}NULL`, params: [] };
  }

  /** A value as a SQL expression (usually a single `?`) for the given field. */
  private value(spec: FieldSpec, value: Value): Fragment {
    switch (spec.kind) {
      case "key":
        return {
          sql: "?",
          params: [
            spec.column === "i.key" ? this.literal(value).toUpperCase() : this.literal(value),
          ],
        };
      case "text":
      case "status":
        return { sql: "?", params: [this.literal(value)] };
      case "enum": {
        const text = this.literal(value).toLowerCase();
        if (!spec.values?.includes(text)) {
          throw this.error(
            `"${text}" is not a valid value`,
            value.pos,
            `Use one of: ${spec.values?.join(", ")}`,
          );
        }
        return { sql: "?", params: [text] };
      }
      case "number": {
        if (value.kind !== "number") throw this.error("expected a number", value.pos);
        return { sql: "?", params: [value.value] };
      }
      case "date":
      case "day": {
        const iso = this.timestamp(value);
        return { sql: "?", params: [spec.kind === "day" ? iso.slice(0, 10) : iso] };
      }
      case "ref":
        return this.reference(spec, value);
      case "fts":
        throw this.error('"text" needs ~', value.pos);
    }
  }

  private reference(spec: FieldSpec, value: Value): Fragment {
    if (value.kind === "func") {
      if (value.name === "me" && spec.ref === "principal") {
        if (!this.ctx.me) throw this.error("me() needs a signed-in principal", value.pos);
        return { sql: "?", params: [this.ctx.me] };
      }
      if ((value.name === "currentcycle" || value.name === "opencycle") && spec.ref === "cycle") {
        return {
          sql: "(SELECT c.id FROM cycles c WHERE c.collection_id = i.collection_id AND c.state = 'active')",
          params: [],
        };
      }
      throw this.error(`${value.name}() cannot be used here`, value.pos);
    }
    const text = this.literal(value);
    switch (spec.ref) {
      case "principal":
        return {
          sql: "(SELECT p.id FROM principals p WHERE p.id = ? OR p.name = ? COLLATE NOCASE)",
          params: [text, text],
        };
      case "collection":
        return {
          sql: "(SELECT c.id FROM collections c WHERE c.id = ? OR c.key = ? COLLATE NOCASE)",
          params: [text, text],
        };
      case "cycle":
        return {
          sql:
            "(SELECT c.id FROM cycles c WHERE c.collection_id = i.collection_id " +
            "AND (c.id = ? OR c.name = ? COLLATE NOCASE))",
          params: [text, text],
        };
      default:
        return {
          sql: "(SELECT p.id FROM items p WHERE p.id = ? OR p.key = ?)",
          params: [text, text.toUpperCase()],
        };
    }
  }

  private timestamp(value: Value): string {
    if (value.kind === "duration") return new Date(this.ctx.now.getTime() + value.ms).toISOString();
    if (value.kind === "func") {
      if (value.name === "now") return this.ctx.now.toISOString();
      if (value.name === "today") return this.ctx.now.toISOString().slice(0, 10);
      throw this.error(
        `${value.name}() is not a date`,
        value.pos,
        "Use now(), today(), -7d or 2026-01-31",
      );
    }
    const text = this.literal(value);
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(text)) {
      throw this.error(
        `"${text}" is not a date`,
        value.pos,
        "Use 2026-01-31, -7d, now() or today()",
      );
    }
    return text;
  }

  private fts(text: string): Fragment {
    const terms = text.split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new RoduError("invalid", "Search text is empty");
    // Quote every term so FTS5 operators typed by a person are treated as plain words.
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
    return {
      sql: "i.id IN (SELECT item_id FROM items_fts WHERE items_fts MATCH ?)",
      params: [match],
    };
  }

  private literal(value: Value): string {
    switch (value.kind) {
      case "string":
        return value.value;
      case "number":
        return String(value.value);
      case "duration":
        return value.raw;
      case "func":
        throw this.error(`${value.name}() cannot be used here`, value.pos);
    }
  }

  private error(message: string, pos: number, hint?: string): RoduError {
    const caret = `${this.source}\n${" ".repeat(pos)}^`;
    return new RoduError(
      "invalid",
      `Query error at ${pos}: ${message}`,
      hint ? `${hint}\n${caret}` : caret,
    );
  }
}

/** Compiles a parsed query; `source` is only used to point at errors. */
export function compileQuery(query: Query, ctx: CompileContext, source = ""): CompiledQuery {
  const compiler = new Compiler(ctx, source);
  const where = query.where ? compiler.expr(query.where) : { sql: "1 = 1", params: [] };
  return { where: where.sql, params: where.params, orderBy: compiler.orderBy(query.orderBy) };
}
