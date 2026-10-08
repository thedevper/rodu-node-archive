import { type CompileContext, type CompiledQuery, compileQuery } from "./compile.ts";
import { parseQuery } from "./parse.ts";

export * from "./compile.ts";
export * from "./parse.ts";

/** Parses and compiles a JQL-lite query in one step. */
export function toSql(source: string, ctx: CompileContext): CompiledQuery {
  return compileQuery(parseQuery(source), ctx, source);
}
