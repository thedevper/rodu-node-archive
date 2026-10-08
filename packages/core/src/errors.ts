export type ShoalErrorCode = "not_found" | "invalid" | "conflict" | "rule_violation" | "limit";

/**
 * A domain error that callers (CLI, MCP) can show as-is. `hint` tells a person or an agent
 * how to fix the request, so an agent can retry without guessing.
 */
export class ShoalError extends Error {
  readonly code: ShoalErrorCode;
  readonly hint: string | null;

  constructor(code: ShoalErrorCode, message: string, hint: string | null = null) {
    super(message);
    this.name = "ShoalError";
    this.code = code;
    this.hint = hint;
  }
}
