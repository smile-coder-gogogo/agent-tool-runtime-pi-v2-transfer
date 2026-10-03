import type { TSchema } from "typebox";

export type RiskLevel = "read" | "write" | "high";
export type ExecutionMode = "plan" | "execute";
export type ToolSource = "local" | "python" | "mcp";

export interface ExecutionContext {
  traceId: string;
  requestId: string;
  userId: string;
  tenantId: string;
  roles: string[];
  agentName: string;
  mode: ExecutionMode;
}

export interface ToolMetadata {
  internalName: string;
  description: string;
  version: string;
  parameters: TSchema;
  risk: RiskLevel;
  permissions: string[];
  requiresConfirmation: boolean;
  timeoutMs: number;
  maxRetries: number;
  idempotent: boolean;
  source: ToolSource;
  sensitiveFields?: string[];
  executionMode?: "parallel" | "sequential";
  auditMode?: "runtime" | "transactional";
}

export interface ToolHandlerInput {
  toolCallId: string;
  args: Record<string, unknown>;
  context: ExecutionContext;
  signal: AbortSignal;
}

export type ToolPreflightInput = Pick<ToolHandlerInput, "toolCallId" | "args" | "context">;

export type ToolHandler = (input: ToolHandlerInput) => Promise<unknown>;

export type TimeoutRecoveryHandler = (
  input: ToolHandlerInput,
) => Promise<
  | { status: "committed"; output: unknown }
  | { status: "not_committed" }
  | { status: "unknown"; reason: string }
>;

export interface ManagedTool {
  metadata: ToolMetadata;
  handler: ToolHandler;
  preflight?: (input: ToolPreflightInput) => void;
  fallbackHandler?: ToolHandler;
  timeoutRecoveryHandler?: TimeoutRecoveryHandler;
}

export interface RegisteredTool extends ManagedTool {
  modelName: string;
}

export interface PolicyConfig {
  rolePermissions: Record<string, string[]>;
  agentToolAllowlist: Record<string, string[]>;
  resourceTenantPrefixes: Record<string, string[]>;
}

export type DecisionAction = "allow" | "deny" | "confirm";

export interface PolicyDecision {
  action: DecisionAction;
  code: string;
  reason: string;
}

export class ToolRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}
