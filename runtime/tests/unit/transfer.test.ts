import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ExecutionContext, ManagedTool } from "../../src/domain.js";
import { loadConfig } from "../../src/config.js";
import { PolicyEngine } from "../../src/policy.js";
import { ToolRegistry } from "../../src/registry.js";
import { ToolRuntime } from "../../src/runtime.js";
import { PlatformStore } from "../../src/store.js";
import { createTransferTool } from "../../src/tools/transfer.js";

const accounts = {
  tenant_a: [
    { id: "a-source", balanceCny: 1_000 },
    { id: "a-destination", balanceCny: 250 },
    { id: "a-poor", balanceCny: 10 },
  ],
  tenant_b: [
    { id: "b-source", balanceCny: 500 },
    { id: "b-destination", balanceCny: 50 },
  ],
};

function createHarness(toolOverride?: (tool: ManagedTool, store: PlatformStore) => ManagedTool) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pi-transfer-test-")), "platform.db");
  const store = new PlatformStore(dbPath);
  store.configureTransferAccounts(accounts);
  const transferTool = createTransferTool(store);
  const registry = new ToolRegistry();
  registry.register(toolOverride ? toolOverride(transferTool, store) : transferTool);
  const policy = new PolicyEngine({
    rolePermissions: { support: [], supervisor: ["transfer:execute"] },
    agentToolAllowlist: { "support-agent": ["transfer.execute"] },
    resourceTenantPrefixes: { tenant_a: [], tenant_b: [] },
  });
  return { dbPath, store, runtime: new ToolRuntime(registry, policy, store), transferTool };
}

function context(roles = ["supervisor"], tenantId = "tenant_a"): ExecutionContext {
  return {
    traceId: `trace-${tenantId}`,
    requestId: "request-transfer",
    userId: "user-1",
    tenantId,
    roles,
    agentName: "support-agent",
    mode: "execute",
  };
}

function transferArgs(amountCny = 125.25) {
  return {
    source_account_id: "a-source",
    destination_account_id: "a-destination",
    amount_cny: amountCny,
  };
}

async function requestApproval(
  runtime: ToolRuntime,
  store: PlatformStore,
  args: Record<string, unknown>,
  callId: string,
  execContext = context(),
) {
  const pending = await runtime.invoke({
    context: execContext,
    toolCallId: callId,
    modelName: "transfer__execute",
    args,
  });
  if (!pending.approvalId) throw new Error(`Transfer did not create an approval: ${pending.code}`);
  store.decideApproval(pending.approvalId, "approve", "manager-1");
  return { pending, execute: () => runtime.executeApproval(pending.approvalId!) };
}

function reconciliation(
  store: PlatformStore,
  callId: string,
  amountCents: number,
  sourceAccountId = "a-source",
  destinationAccountId = "a-destination",
) {
  return store.reconcileTransfer({
    idempotencyKey: `trace-tenant_a:${callId}:transfer.execute`,
    tenantId: "tenant_a",
    sourceAccountId,
    destinationAccountId,
    amountCents,
  });
}

describe("transfer.execute governance", () => {
  it("loads tenant-isolated demo accounts without exposing the internal transfer cap", () => {
    const config = loadConfig(resolve(process.cwd(), "../config/platform.yaml"));

    expect(config.tools.transfer.demoAccounts).toEqual({
      tenant_a: [
        { id: "demo-a-source", balanceCny: 5_000 },
        { id: "demo-a-destination", balanceCny: 250 },
      ],
      tenant_b: [
        { id: "demo-b-source", balanceCny: 3_000 },
        { id: "demo-b-destination", balanceCny: 100 },
      ],
    });
    const { transferTool } = createHarness();
    expect(Object.keys((transferTool.metadata.parameters as { properties: Record<string, unknown> }).properties))
      .toEqual(["source_account_id", "destination_account_id", "amount_cny"]);
    expect(transferTool.metadata.description).toContain("1000.00 元");
  });

  it("requires approval and atomically transfers only local simulated CNY", async () => {
    const { runtime, store } = createHarness();
    const { pending, execute } = await requestApproval(runtime, store, transferArgs(), "call-approved");

    expect(pending).toMatchObject({ ok: false, action: "confirm", code: "APPROVAL_REQUIRED" });
    expect(reconciliation(store, "call-approved", 12_525)).toMatchObject({
      status: "unknown",
      balances: { source_balance_cny: "1000.00", destination_balance_cny: "250.00" },
    });

    const completed = await execute();
    expect(completed).toMatchObject({
      ok: true,
      action: "allow",
      content: {
        status: "completed",
        simulated: true,
        currency: "CNY",
        amount_cny: "125.25",
        source_balance_after_cny: "874.75",
        destination_balance_after_cny: "375.25",
      },
    });
    expect(reconciliation(store, "call-approved", 12_525)).toMatchObject({
      status: "committed",
      result: { source_balance_after_cny: "874.75", destination_balance_after_cny: "375.25" },
    });
    const audit = store.listAudit(context().traceId).find(
      (record) => record.tool_name === "transfer.execute" && record.status === "success",
    );
    expect(audit).toMatchObject({
      event_type: "tool_execution",
      tool_call_id: "call-approved",
      user_id: "user-1",
      tenant_id: "tenant_a",
      status: "success",
      code: "OK",
    });
    expect(JSON.parse(String(audit?.input_json))).toEqual({
      source_account_id: "a-source",
      destination_account_id: "a-destination",
      amount_cny: "125.25",
    });
    expect(JSON.parse(String(audit?.output_json))).toMatchObject({
      transfer_id: expect.any(String),
      source_balance_after_cny: "874.75",
      destination_balance_after_cny: "375.25",
    });
  });

  it("denies missing permission and invalid amounts before any approval or ledger write", async () => {
    const { runtime, store } = createHarness();
    const denied = await runtime.invoke({
      context: context(["support"]),
      toolCallId: "call-rbac-denied",
      modelName: "transfer__execute",
      args: transferArgs(),
    });
    const overLimit = await runtime.invoke({
      context: context(),
      toolCallId: "call-over-limit",
      modelName: "transfer__execute",
      args: transferArgs(1_000.01),
    });
    const invalid = await runtime.invoke({
      context: context(),
      toolCallId: "call-invalid-schema",
      modelName: "transfer__execute",
      args: { ...transferArgs(), internal_token: "schema-error-secret" },
    });

    expect(denied).toMatchObject({ ok: false, code: "RBAC_DENIED" });
    expect(overLimit).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_ARGUMENT", content: "工具参数未通过校验" });
    expect(JSON.stringify(invalid)).not.toContain("schema-error-secret");
    expect(reconciliation(store, "call-rbac-denied", 12_525).status).toBe("unknown");
    expect(reconciliation(store, "call-over-limit", 100_001).status).toBe("unknown");
  });

  it("prevents cross-tenant accounts and insufficient-funds partial writes", async () => {
    const { runtime, store } = createHarness();
    const crossTenantResult = await runtime.invoke({
      context: context(),
      toolCallId: "call-cross-tenant",
      modelName: "transfer__execute",
      args: {
        source_account_id: "a-source",
        destination_account_id: "b-destination",
        amount_cny: 10,
      },
    });
    expect(crossTenantResult).toMatchObject({
      ok: false,
      code: "TRANSFER_ACCOUNT_UNAVAILABLE",
      action: "deny",
    });

    const insufficientResult = await runtime.invoke({
      context: context(),
      toolCallId: "call-insufficient",
      modelName: "transfer__execute",
      args: {
        source_account_id: "a-poor",
        destination_account_id: "a-destination",
        amount_cny: 20,
      },
    });
    expect(insufficientResult).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS", action: "deny" });
    expect(reconciliation(store, "call-insufficient", 2_000, "a-poor")).toMatchObject({
      status: "unknown",
      balances: { source_balance_cny: "10.00", destination_balance_cny: "250.00" },
    });
  });

  it("rechecks available balance when executing an approved transfer", async () => {
    const { runtime, store } = createHarness();
    const { pending, execute } = await requestApproval(
      runtime,
      store,
      transferArgs(100),
      "call-balance-race",
    );
    const concurrent = {
      idempotencyKey: "trace-tenant_a:call-concurrent:transfer.execute",
      tenantId: "tenant_a",
      sourceAccountId: "a-source",
      destinationAccountId: "a-destination",
      amountCents: 100_000,
      toolCallId: "call-concurrent",
      context: context(),
    };
    store.executeTransfer(concurrent);

    const result = await execute();

    expect(result).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS" });
    expect(store.getApproval(pending.approvalId!)?.status).toBe("failed");
    expect(reconciliation(store, "call-balance-race", 10_000)).toMatchObject({
      status: "unknown",
      balances: { source_balance_cny: "0.00", destination_balance_cny: "1250.00" },
    });
  });

  it("returns the committed transfer after timeout instead of retrying", async () => {
    const { runtime, store, transferTool } = createHarness((tool) => ({
      ...tool,
      metadata: { ...tool.metadata, timeoutMs: 5 },
      async handler(input) {
        const output = await transferTool.handler(input);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return output;
      },
    }));
    const { execute } = await requestApproval(runtime, store, transferArgs(), "call-committed-timeout");

    const result = await execute();

    expect(result).toMatchObject({
      ok: true,
      code: "RECOVERED_AFTER_TIMEOUT",
      attempts: 1,
      content: { amount_cny: "125.25" },
    });
    expect(reconciliation(store, "call-committed-timeout", 12_525).status).toBe("committed");
  });

  it("stops for manual reconciliation when balances changed without this transfer's ledger", async () => {
    const { store } = createHarness();
    const pendingTransfer = {
      idempotencyKey: "trace-tenant_a:call-uncertain:transfer.execute",
      tenantId: "tenant_a",
      sourceAccountId: "a-source",
      destinationAccountId: "a-destination",
      amountCents: 5_000,
      toolCallId: "call-uncertain",
      context: context(),
    };
    store.prepareTransfer(pendingTransfer);
    store.executeTransfer({
      ...pendingTransfer,
      idempotencyKey: "other-transfer-key",
      amountCents: 1_000,
      toolCallId: "other-call",
    });

    expect(store.reconcileTransfer(pendingTransfer)).toMatchObject({
      status: "unknown",
      reason: "账户余额与转账前快照不一致，但未找到对应流水；需要人工核实",
      balances: { source_balance_cny: "990.00", destination_balance_cny: "260.00" },
    });
  });

  it("rolls back account changes if the transactional transfer audit cannot be written", async () => {
    const { dbPath, runtime, store } = createHarness();
    const connection = new DatabaseSync(dbPath);
    connection.exec(`
      CREATE TRIGGER reject_transfer_audit
      BEFORE INSERT ON audit_records
      WHEN NEW.event_type = 'tool_execution'
        AND NEW.status = 'success'
        AND NEW.tool_name = 'transfer.execute'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);
    connection.close();
    const { pending, execute } = await requestApproval(runtime, store, transferArgs(), "call-audit-failure");

    const result = await execute();

    expect(result).toMatchObject({
      ok: false,
      code: "TOOL_EXECUTION_FAILED",
      content: "工具执行失败，错误代码：TOOL_EXECUTION_FAILED",
    });
    expect(store.getApproval(pending.approvalId!)?.status).toBe("failed");
    expect(reconciliation(store, "call-audit-failure", 12_525)).toMatchObject({
      status: "not_committed",
      balances: { source_balance_cny: "1000.00", destination_balance_cny: "250.00" },
    });
  });

  it("checks balances after timeout and retries only when the keyed transfer did not commit", async () => {
    let handlerCalls = 0;
    const { runtime, store, transferTool } = createHarness((tool, transferStore) => ({
      ...tool,
      metadata: { ...tool.metadata, timeoutMs: 5 },
      async handler(input) {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          transferStore.prepareTransfer({
            idempotencyKey: `${input.context.traceId}:${input.toolCallId}:transfer.execute`,
            tenantId: input.context.tenantId,
            sourceAccountId: String(input.args.source_account_id),
            destinationAccountId: String(input.args.destination_account_id),
            amountCents: Math.round(Number(input.args.amount_cny) * 100),
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return transferTool.handler(input);
      },
    }));
    const { execute } = await requestApproval(runtime, store, transferArgs(), "call-uncommitted-timeout");

    const result = await execute();
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(result).toMatchObject({ ok: true, attempts: 2, content: { amount_cny: "125.25" } });
    expect(handlerCalls).toBe(2);
    expect(reconciliation(store, "call-uncommitted-timeout", 12_525)).toMatchObject({
      status: "committed",
      result: { source_balance_after_cny: "874.75", destination_balance_after_cny: "375.25" },
    });
  });
});
