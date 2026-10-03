import { Type } from "typebox";
import type { ManagedTool, ToolPreflightInput } from "../domain.js";
import { ToolRuntimeError } from "../domain.js";
import { PlatformStore, TransferStoreError, type TransferExecutionRequest, type TransferRequest } from "../store.js";

const MAX_AMOUNT_CNY = 1_000;

export function createTransferTool(store: PlatformStore): ManagedTool {
  return {
    metadata: {
      internalName: "transfer.execute",
      description: `在当前租户内执行人民币模拟转账，单笔不超过 ${MAX_AMOUNT_CNY.toFixed(2)} 元。仅修改本地模拟账本，不触碰真实资金；每笔都必须人工审批。`,
      version: "1.0.0",
      parameters: Type.Object(
        {
          source_account_id: Type.String({ minLength: 1, maxLength: 64 }),
          destination_account_id: Type.String({ minLength: 1, maxLength: 64 }),
          amount_cny: Type.Number({ minimum: 0.01, maximum: MAX_AMOUNT_CNY, multipleOf: 0.01 }),
        },
        { additionalProperties: false },
      ),
      risk: "high",
      permissions: ["transfer:execute"],
      requiresConfirmation: true,
      timeoutMs: 1_500,
      maxRetries: 1,
      idempotent: true,
      source: "local",
      executionMode: "sequential",
      auditMode: "transactional",
    },
    preflight(input) {
      try {
        store.preflightTransfer(transferRequest(input));
      } catch (error) {
        if (error instanceof TransferStoreError) {
          throw new ToolRuntimeError(error.code, error.message, false);
        }
        throw error;
      }
    },
    async handler(input) {
      try {
        return store.executeTransfer(transferRequest(input));
      } catch (error) {
        if (error instanceof TransferStoreError) {
          throw new ToolRuntimeError(error.code, error.message, false);
        }
        throw error;
      }
    },
    async timeoutRecoveryHandler(input) {
      const reconciliation = store.reconcileTransfer(transferRequest(input));
      if (reconciliation.status === "committed") {
        return { status: "committed", output: reconciliation.result };
      }
      if (reconciliation.status === "not_committed") return { status: "not_committed" };
      return { status: "unknown", reason: reconciliation.reason };
    },
  };
}

function transferRequest(input: ToolPreflightInput): TransferExecutionRequest {
  const amountCny = input.args.amount_cny;
  if (typeof amountCny !== "number" || !Number.isFinite(amountCny)) {
    throw new ToolRuntimeError("INVALID_TRANSFER_AMOUNT", "转账金额必须是有效数字", false);
  }
  const amountCents = Math.round(amountCny * 100);
  if (!Number.isSafeInteger(amountCents) || Math.abs(amountCny * 100 - amountCents) > 1e-7) {
    throw new ToolRuntimeError("INVALID_TRANSFER_AMOUNT", "转账金额必须精确到分", false);
  }
  return {
    idempotencyKey: `${input.context.traceId}:${input.toolCallId}:transfer.execute`,
    tenantId: input.context.tenantId,
    sourceAccountId: String(input.args.source_account_id),
    destinationAccountId: String(input.args.destination_account_id),
    amountCents,
    toolCallId: input.toolCallId,
    context: input.context,
  };
}
