import { RoduError } from "@rodu/core";

// JQL-lite: `assignee = me() AND status IN ("Todo", "In Progress") ORDER BY priority`.
// The UI filter bar, the command bar and the MCP search tool all parse into this one AST.

export type CompareOp = "=" | "!=" | "~" | "!~" | "<" | "<=" | ">" | ">=";

export type Value =
  | { kind: "string"; value: string; pos: number }
  | { kind: "number"; value: number; pos: number }
  /** Offset from now, e.g. -7d. */
  | { kind: "duration"; ms: number; raw: string; pos: number }
  | { kind: "func"; name: string; pos: number };

export type Expr =
  | { kind: "and" | "or"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "compare"; field: string; op: CompareOp; value: Value; pos: number }
  | { kind: "in"; field: string; negated: boolean; values: Value[]; pos: number }
  | { kind: "empty"; field: string; negated: boolean; pos: number };

export interface OrderBy {
  field: string;
  direction: "asc" | "desc";
  pos: number;
}

export interface Query {
  where: Expr | null;
  orderBy: OrderBy[];
}

type Token =
  | { kind: "word"; text: string; pos: number }
  | { kind: "string"; text: string; pos: number }
  | { kind: "op"; text: string; pos: number }
  | { kind: "punct"; text: "(" | ")" | ","; pos: number }
  | { kind: "eof"; pos: number };

const MAX_QUERY_LENGTH = 2000;
const WORD = /[A-Za-z0-9_.:-]/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export function queryError(message: string, pos: number, source: string): RoduError {
  const caret = `${source}\n${" ".repeat(pos)}^`;
  return new RoduError("invalid", `Query error at ${pos}: ${message}`, caret);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      const start = i++;
      let text = "";
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        text += source[i];
        i++;
      }
      if (i >= source.length) throw queryError("unterminated string", start, source);
      i++;
      tokens.push({ kind: "string", text, pos: start });
    } else if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "punct", text: ch, pos: i++ });
    } else if ("=!~<>".includes(ch)) {
      const two = source.slice(i, i + 2);
      const op = ["!=", "!~", "<=", ">="].includes(two) ? two : ch;
      if (op === "!") throw queryError('expected "!=" or "!~"', i, source);
      tokens.push({ kind: "op", text: op, pos: i });
      i += op.length;
    } else if (WORD.test(ch)) {
      const start = i;
      while (i < source.length && WORD.test(source[i] as string)) i++;
      tokens.push({ kind: "word", text: source.slice(start, i), pos: start });
    } else {
      throw queryError(`unexpected character "${ch}"`, i, source);
    }
  }
  tokens.push({ kind: "eof", pos: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  parse(): Query {
    let where: Expr | null = null;
    if (!this.atKeyword("ORDER") && this.peek().kind !== "eof") where = this.parseOr();
    const orderBy: OrderBy[] = [];
    if (this.acceptKeyword("ORDER")) {
      this.expectKeyword("BY");
      do {
        const field = this.expectWord("a field to order by");
        let direction: "asc" | "desc" = "asc";
        if (this.acceptKeyword("DESC")) direction = "desc";
        else this.acceptKeyword("ASC");
        orderBy.push({ field: field.text.toLowerCase(), direction, pos: field.pos });
      } while (this.acceptPunct(","));
    }
    const rest = this.peek();
    if (rest.kind !== "eof") throw this.error("expected AND, OR, ORDER BY or end of query", rest);
    return { where, orderBy };
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptKeyword("OR")) left = { kind: "or", left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseUnary();
    while (this.acceptKeyword("AND")) left = { kind: "and", left, right: this.parseUnary() };
    return left;
  }

  private parseUnary(): Expr {
    if (this.acceptKeyword("NOT")) return { kind: "not", expr: this.parseUnary() };
    if (this.acceptPunct("(")) {
      const expr = this.parseOr();
      this.expectPunct(")");
      return expr;
    }
    return this.parseCondition();
  }

  private parseCondition(): Expr {
    const fieldToken = this.expectWord("a field name");
    const field = fieldToken.text.toLowerCase();
    const pos = fieldToken.pos;
    if (this.acceptKeyword("IS")) {
      const negated = this.acceptKeyword("NOT");
      this.expectKeyword("EMPTY");
      return { kind: "empty", field, negated, pos };
    }
    const negatedIn = this.acceptKeyword("NOT");
    if (negatedIn || this.atKeyword("IN")) {
      this.expectKeyword("IN");
      this.expectPunct("(");
      const values = [this.parseValue()];
      while (this.acceptPunct(",")) values.push(this.parseValue());
      this.expectPunct(")");
      return { kind: "in", field, negated: negatedIn, values, pos };
    }
    const op = this.peek();
    if (op.kind !== "op") throw this.error("expected an operator (=, !=, ~, <, >, IN, IS)", op);
    this.index++;
    return { kind: "compare", field, op: op.text as CompareOp, value: this.parseValue(), pos };
  }

  private parseValue(): Value {
    const token = this.peek();
    if (token.kind === "string") {
      this.index++;
      return { kind: "string", value: token.text, pos: token.pos };
    }
    if (token.kind !== "word") throw this.error("expected a value", token);
    this.index++;
    if (this.acceptPunct("(")) {
      this.expectPunct(")");
      return { kind: "func", name: token.text.toLowerCase(), pos: token.pos };
    }
    const duration = /^([+-]?)(\d{1,6})([mhdw])$/i.exec(token.text);
    if (duration) {
      const unit = (duration[3] as string).toLowerCase() as keyof typeof UNIT_MS;
      const ms = Number(duration[2]) * UNIT_MS[unit] * (duration[1] === "-" ? -1 : 1);
      return { kind: "duration", ms, raw: token.text, pos: token.pos };
    }
    if (/^-?\d+(\.\d+)?$/.test(token.text)) {
      return { kind: "number", value: Number(token.text), pos: token.pos };
    }
    return { kind: "string", value: token.text, pos: token.pos };
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private atKeyword(keyword: string): boolean {
    const token = this.peek();
    return token.kind === "word" && token.text.toUpperCase() === keyword;
  }

  private acceptKeyword(keyword: string): boolean {
    if (!this.atKeyword(keyword)) return false;
    this.index++;
    return true;
  }

  private expectKeyword(keyword: string): void {
    if (!this.acceptKeyword(keyword)) throw this.error(`expected ${keyword}`, this.peek());
  }

  private acceptPunct(text: "(" | ")" | ","): boolean {
    const token = this.peek();
    if (token.kind !== "punct" || token.text !== text) return false;
    this.index++;
    return true;
  }

  private expectPunct(text: "(" | ")" | ","): void {
    if (!this.acceptPunct(text)) throw this.error(`expected "${text}"`, this.peek());
  }

  private expectWord(what: string): { text: string; pos: number } {
    const token = this.peek();
    if (token.kind !== "word") throw this.error(`expected ${what}`, token);
    this.index++;
    return token;
  }

  private error(message: string, token: Token): RoduError {
    return queryError(message, token.pos, this.source);
  }
}

/** Parses a JQL-lite query; an empty string matches everything. */
export function parseQuery(source: string): Query {
  if (source.length > MAX_QUERY_LENGTH) {
    throw new RoduError("limit", `Query is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  return new Parser(source).parse();
}
