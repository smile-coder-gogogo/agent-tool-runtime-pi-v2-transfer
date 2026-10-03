import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionContext } from "./domain.js";
import type { TransferAccountConfig } from "./config.js";

export interface TransferRequest {
  idempotencyKey: string;
  tenantId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountCents: number;
}

export interface TransferExecutionRequest extends TransferRequest {
  toolCallId: string;
  context: ExecutionContext;
}

interface TransferRow {
  id: string;
  idempotency_key: string;
  tenant_id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_cents: number;
  currency: string;
  source_balance_before_cents: number;
  source_balance_after_cents: number;
  destination_balance_before_cents: number;
  destination_balance_after_cents: number;
  created_at: string;
}

interface TransferAttemptRow {
  idempotency_key: string;
  tenant_id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_cents: number;
  source_balance_before_cents: number;
  destination_balance_before_cents: number;
  created_at: string;
}

interface TransferAccountRow {
  tenant_id: string;
  account_id: string;
  currency: string;
  balance_cents: number;
}

export type TransferReconciliation =
  | { status: "committed"; result: Record<string, unknown> }
  | { status: "not_committed"; balances: Record<string, unknown> }
  | { status: "unknown"; reason: string; balances?: Record<string, unknown> };

export class TransferStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransferStoreError";
  }
}

export interface ApprovalRecord {
  id: string;
  trace_id: string;
  tool_call_id: string;
  tool_name: string;
  context_json: string;
  args_json: string;
  args_digest: string;
  status: string;
  expires_at: string;
  decided_by: string | null;
  created_at: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function approvalDigest(input: {
  traceId: string;
  toolCallId: string;
  toolName: string;
  context: ExecutionContext;
  args: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        trace_id: input.traceId,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        user_id: input.context.userId,
        tenant_id: input.context.tenantId,
        args: input.args,
      }),
    )
    .digest("hex");
}

export class PlatformStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        status TEXT NOT NULL,
        code TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_records(trace_id, created_at);

      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_events ON trace_events(trace_id, created_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        context_json TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_by TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        consumed_at TEXT,
        error_code TEXT
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transfer_accounts (
        tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
        PRIMARY KEY (tenant_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        source_account_id TEXT NOT NULL,
        destination_account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        source_balance_before_cents INTEGER NOT NULL,
        source_balance_after_cents INTEGER NOT NULL,
        destination_balance_before_cents INTEGER NOT NULL,
        destination_balance_after_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, source_account_id) REFERENCES transfer_accounts(tenant_id, account_id),
        FOREIGN KEY (tenant_id, destination_account_id) REFERENCES transfer_accounts(tenant_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS transfer_attempts (
        idempotency_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_account_id TEXT NOT NULL,
        destination_account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        source_balance_before_cents INTEGER NOT NULL,
        destination_balance_before_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  configureTransferAccounts(accountsByTenant: Record<string, TransferAccountConfig[]>): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO transfer_accounts (tenant_id, account_id, currency, balance_cents)
      VALUES (?, ?, 'CNY', ?)
    `);
    for (const [tenantId, accounts] of Object.entries(accountsByTenant)) {
      for (const account of accounts) {
        if (!tenantId || !account.id || !Number.isFinite(account.balanceCny) || account.balanceCny < 0) {
          throw new Error(`Invalid simulated transfer account configuration: ${tenantId}/${account.id}`);
        }
        const balanceCents = Math.round(account.balanceCny * 100);
        if (!Number.isSafeInteger(balanceCents) || Math.abs(account.balanceCny * 100 - balanceCents) > 1e-7) {
          throw new Error(`Transfer account balance must be a safe CNY amount with at most two decimals: ${tenantId}/${account.id}`);
        }
        insert.run(tenantId, account.id, balanceCents);
      }
    }
  }

  executeTransfer(input: TransferExecutionRequest): Record<string, unknown> {
    this.prepareTransfer(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.findTransfer(input.idempotencyKey);
      if (prior) {
        this.assertSameTransfer(prior, input);
        this.db.exec("COMMIT");
        return this.transferResult(prior);
      }

      const source = this.getTransferAccount(input.tenantId, input.sourceAccountId);
      const destination = this.getTransferAccount(input.tenantId, input.destinationAccountId);
      const attempt = this.findTransferAttempt(input.idempotencyKey);
      if (!source || !destination) {
        throw new TransferStoreError("TRANSFER_ACCOUNT_UNAVAILABLE", "一个或多个模拟账户不属于当前租户或不存在");
      }
      if (!attempt) throw new Error("Transfer attempt snapshot disappeared before execution");
      this.assertSameTransfer(attempt, input);
      if (
        source.balance_cents !== attempt.source_balance_before_cents ||
        destination.balance_cents !== attempt.destination_balance_before_cents
      ) {
        throw new TransferStoreError("TRANSFER_BALANCE_CHANGED", "模拟账户余额已变化，转账需重新核对");
      }
      if (input.sourceAccountId === input.destinationAccountId) {
        throw new TransferStoreError("TRANSFER_SAME_ACCOUNT", "转出与转入账户必须不同");
      }
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
        throw new TransferStoreError("INVALID_TRANSFER_AMOUNT", "转账金额必须是正整数分");
      }
      if (source.balance_cents < input.amountCents) {
        throw new TransferStoreError("INSUFFICIENT_FUNDS", "模拟转出账户余额不足");
      }
      if (!Number.isSafeInteger(destination.balance_cents + input.amountCents)) {
        throw new TransferStoreError("BALANCE_LIMIT_EXCEEDED", "模拟收款账户余额超过安全范围");
      }

      const sourceAfter = source.balance_cents - input.amountCents;
      const destinationAfter = destination.balance_cents + input.amountCents;
      this.db
        .prepare("UPDATE transfer_accounts SET balance_cents = ? WHERE tenant_id = ? AND account_id = ?")
        .run(sourceAfter, input.tenantId, input.sourceAccountId);
      this.db
        .prepare("UPDATE transfer_accounts SET balance_cents = ? WHERE tenant_id = ? AND account_id = ?")
        .run(destinationAfter, input.tenantId, input.destinationAccountId);

      const id = `SIM-${randomUUID().slice(0, 12)}`;
      const createdAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO transfers (
          id, idempotency_key, tenant_id, source_account_id, destination_account_id,
          amount_cents, currency, source_balance_before_cents, source_balance_after_cents,
          destination_balance_before_cents, destination_balance_after_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?)
      `).run(
        id,
        input.idempotencyKey,
        input.tenantId,
        input.sourceAccountId,
        input.destinationAccountId,
        input.amountCents,
        source.balance_cents,
        sourceAfter,
        destination.balance_cents,
        destinationAfter,
        createdAt,
      );
      const record = this.findTransfer(input.idempotencyKey);
      if (!record) throw new Error("Transfer ledger insert did not produce a record");
      const result = this.transferResult(record);
      this.db.prepare(`
        INSERT INTO audit_records (
          id, event_type, trace_id, tool_call_id, tool_name, user_id, tenant_id,
          status, code, input_json, output_json, latency_ms, created_at
        ) VALUES (?, 'tool_execution', ?, ?, 'transfer.execute', ?, ?, 'success', 'OK', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.context.traceId,
        input.toolCallId,
        input.context.userId,
        input.context.tenantId,
        JSON.stringify({
          source_account_id: input.sourceAccountId,
          destination_account_id: input.destinationAccountId,
          amount_cny: centsToCny(input.amountCents),
        }),
        JSON.stringify(result),
        0,
        createdAt,
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  preflightTransfer(input: TransferRequest): void {
    this.readTransferBalances(input);
  }

  prepareTransfer(input: TransferRequest): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.findTransfer(input.idempotencyKey);
      if (prior) {
        this.assertSameTransfer(prior, input);
        this.db.exec("COMMIT");
        return;
      }
      const existingAttempt = this.findTransferAttempt(input.idempotencyKey);
      if (existingAttempt) {
        this.assertSameTransfer(existingAttempt, input);
        this.db.exec("COMMIT");
        return;
      }
      const { source, destination } = this.readTransferBalances(input);
      this.db.prepare(`
        INSERT INTO transfer_attempts (
          idempotency_key, tenant_id, source_account_id, destination_account_id, amount_cents,
          source_balance_before_cents, destination_balance_before_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        input.tenantId,
        input.sourceAccountId,
        input.destinationAccountId,
        input.amountCents,
        source.balance_cents,
        destination.balance_cents,
        new Date().toISOString(),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private readTransferBalances(input: TransferRequest): {
    source: TransferAccountRow;
    destination: TransferAccountRow;
  } {
    if (input.sourceAccountId === input.destinationAccountId) {
      throw new TransferStoreError("TRANSFER_SAME_ACCOUNT", "转出与转入账户必须不同");
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new TransferStoreError("INVALID_TRANSFER_AMOUNT", "转账金额必须是正整数分");
    }
    const source = this.getTransferAccount(input.tenantId, input.sourceAccountId);
    const destination = this.getTransferAccount(input.tenantId, input.destinationAccountId);
    if (!source || !destination) {
      throw new TransferStoreError("TRANSFER_ACCOUNT_UNAVAILABLE", "一个或多个模拟账户不属于当前租户或不存在");
    }
    if (source.balance_cents < input.amountCents) {
      throw new TransferStoreError("INSUFFICIENT_FUNDS", "模拟转出账户余额不足");
    }
    if (!Number.isSafeInteger(destination.balance_cents + input.amountCents)) {
      throw new TransferStoreError("BALANCE_LIMIT_EXCEEDED", "模拟收款账户余额超过安全范围");
    }
    return { source, destination };
  }

  reconcileTransfer(input: TransferRequest): TransferReconciliation {
    const record = this.findTransfer(input.idempotencyKey);
    if (record) {
      try {
        this.assertSameTransfer(record, input);
      } catch (error) {
        return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
      }
      const source = this.getTransferAccount(input.tenantId, input.sourceAccountId);
      const destination = this.getTransferAccount(input.tenantId, input.destinationAccountId);
      if (!source || !destination) {
        return { status: "unknown", reason: "模拟账户余额无法读取，转账状态需要人工核实" };
      }
      return {
        status: "committed",
        result: {
          ...this.transferResult(record),
          current_source_balance_cny: centsToCny(source.balance_cents),
          current_destination_balance_cny: centsToCny(destination.balance_cents),
        },
      };
    }

    const source = this.getTransferAccount(input.tenantId, input.sourceAccountId);
    const destination = this.getTransferAccount(input.tenantId, input.destinationAccountId);
    if (!source || !destination) {
      return { status: "unknown", reason: "模拟账户余额无法读取，转账状态需要人工核实" };
    }
    const balances = {
      source_account_id: input.sourceAccountId,
      source_balance_cny: centsToCny(source.balance_cents),
      destination_account_id: input.destinationAccountId,
      destination_balance_cny: centsToCny(destination.balance_cents),
    };
    const attempt = this.findTransferAttempt(input.idempotencyKey);
    if (!attempt) {
      return {
        status: "unknown",
        reason: "缺少转账前余额快照，无法确认是否发生账变",
        balances,
      };
    }
    try {
      this.assertSameTransfer(attempt, input);
    } catch (error) {
      return { status: "unknown", reason: error instanceof Error ? error.message : String(error), balances };
    }
    if (
      source.balance_cents !== attempt.source_balance_before_cents ||
      destination.balance_cents !== attempt.destination_balance_before_cents
    ) {
      return {
        status: "unknown",
        reason: "账户余额与转账前快照不一致，但未找到对应流水；需要人工核实",
        balances,
      };
    }
    // The unchanged balance snapshot and missing ledger prove this attempt has not
    // committed. Retrying with the same idempotency key remains safe if its handler is
    // still finishing concurrently.
    return {
      status: "not_committed",
      balances,
    };
  }

  private findTransfer(idempotencyKey: string): TransferRow | undefined {
    return this.db.prepare("SELECT * FROM transfers WHERE idempotency_key = ?").get(idempotencyKey) as
      | TransferRow
      | undefined;
  }

  private getTransferAccount(tenantId: string, accountId: string): TransferAccountRow | undefined {
    return this.db.prepare(`
      SELECT tenant_id, account_id, currency, balance_cents
      FROM transfer_accounts WHERE tenant_id = ? AND account_id = ?
    `).get(tenantId, accountId) as TransferAccountRow | undefined;
  }

  private findTransferAttempt(idempotencyKey: string): TransferAttemptRow | undefined {
    return this.db.prepare("SELECT * FROM transfer_attempts WHERE idempotency_key = ?").get(idempotencyKey) as
      | TransferAttemptRow
      | undefined;
  }

  private assertSameTransfer(record: TransferRow | TransferAttemptRow, input: TransferRequest): void {
    if (
      record.tenant_id !== input.tenantId ||
      record.source_account_id !== input.sourceAccountId ||
      record.destination_account_id !== input.destinationAccountId ||
      record.amount_cents !== input.amountCents
    ) {
      throw new TransferStoreError("TRANSFER_IDEMPOTENCY_MISMATCH", "幂等键已绑定到不同的转账参数");
    }
  }

  private transferResult(record: TransferRow): Record<string, unknown> {
    return {
      transfer_id: record.id,
      status: "completed",
      simulated: true,
      currency: record.currency,
      amount_cny: centsToCny(record.amount_cents),
      source_account_id: record.source_account_id,
      destination_account_id: record.destination_account_id,
      source_balance_after_cny: centsToCny(record.source_balance_after_cents),
      destination_balance_after_cny: centsToCny(record.destination_balance_after_cents),
      created_at: record.created_at,
    };
  }

  addAudit(record: {
    eventType: string;
    context: ExecutionContext;
    toolCallId: string;
    toolName: string;
    status: string;
    code: string;
    input: unknown;
    output?: unknown;
    latencyMs?: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO audit_records (
          id, event_type, trace_id, tool_call_id, tool_name, user_id, tenant_id,
          status, code, input_json, output_json, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        record.eventType,
        record.context.traceId,
        record.toolCallId,
        record.toolName,
        record.context.userId,
        record.context.tenantId,
        record.status,
        record.code,
        JSON.stringify(record.input),
        record.output === undefined ? null : JSON.stringify(record.output),
        record.latencyMs ?? 0,
        new Date().toISOString(),
      );
  }

  listAudit(traceId?: string): Record<string, unknown>[] {
    const statement = traceId
      ? this.db.prepare("SELECT * FROM audit_records WHERE trace_id = ? ORDER BY created_at, rowid")
      : this.db.prepare("SELECT * FROM audit_records ORDER BY created_at DESC, rowid DESC LIMIT 100");
    return (traceId ? statement.all(traceId) : statement.all()) as Record<string, unknown>[];
  }

  addTrace(input: {
    traceId: string;
    spanId?: string;
    parentSpanId?: string;
    eventType: string;
    payload?: unknown;
  }): void {
    this.db
      .prepare(`
        INSERT INTO trace_events (id, trace_id, span_id, parent_span_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.traceId,
        input.spanId ?? randomUUID(),
        input.parentSpanId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        new Date().toISOString(),
      );
  }

  getTrace(traceId: string): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY created_at, rowid")
      .all(traceId) as Record<string, unknown>[];
  }

  createApproval(input: {
    context: ExecutionContext;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    ttlSeconds?: number;
  }): ApprovalRecord {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? 900) * 1_000);
    const digest = approvalDigest({
      traceId: input.context.traceId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      context: input.context,
      args: input.args,
    });
    this.db
      .prepare(`
        INSERT INTO approvals (
          id, trace_id, tool_call_id, tool_name, context_json, args_json,
          args_digest, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `)
      .run(
        id,
        input.context.traceId,
        input.toolCallId,
        input.toolName,
        JSON.stringify(input.context),
        JSON.stringify(input.args),
        digest,
        expiresAt.toISOString(),
        now.toISOString(),
      );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRecord | undefined;
  }

  listApprovals(status?: string): ApprovalRecord[] {
    const statement = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC")
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100");
    return (status ? statement.all(status) : statement.all()) as unknown as ApprovalRecord[];
  }

  decideApproval(id: string, decision: "approve" | "reject", actor: string): ApprovalRecord {
    const status = decision === "approve" ? "approved" : "rejected";
    const result = this.db
      .prepare(`
        UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?
      `)
      .run(status, actor, new Date().toISOString(), id, new Date().toISOString());
    if (Number(result.changes) !== 1) throw new Error("Approval is missing, expired, or already decided");
    return this.getApproval(id)!;
  }

  claimApproval(id: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status = 'executing' WHERE id = ? AND status = 'approved' AND expires_at > ?")
      .run(id, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  finishApproval(id: string, status: "consumed" | "failed", errorCode?: string): void {
    this.db
      .prepare("UPDATE approvals SET status = ?, consumed_at = ?, error_code = ? WHERE id = ? AND status = 'executing'")
      .run(status, new Date().toISOString(), errorCode ?? null, id);
  }

  createTicket(input: {
    idempotencyKey: string;
    tenantId: string;
    orderId: string;
    title: string;
  }): Record<string, unknown> {
    const existing = this.db
      .prepare("SELECT * FROM tickets WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const id = `T-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO tickets (id, idempotency_key, tenant_id, order_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.idempotencyKey, input.tenantId, input.orderId, input.title, new Date().toISOString());
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown>;
  }
}

function centsToCny(cents: number): string {
  return (cents / 100).toFixed(2);
}
