export type RoduErrorCode = "not_found" | "invalid" | "conflict" | "rule_violation" | "limit";

/**
 * A domain error that callers (CLI, MCP) can show as-is. `hint` tells a person or an agent
 * how to fix the request, so an agent can retry without guessing.
 */
export class RoduError extends Error {
  readonly code: RoduErrorCode;
  readonly hint: string | null;

  constructor(code: RoduErrorCode, message: string, hint: string | null = null) {
    super(message);
    this.name = "RoduError";
    this.code = code;
    this.hint = hint;
  }
}
