# 为治理框架增加“转账”工具

## 一、作业目标

在现有 Agent Tool Runtime 治理框架中增加 `transfer.execute` 工具，展示如何让一个具有资金副作用的工具纳入 Schema 校验、权限控制、人工审批、租户隔离、幂等执行、异常恢复和审计追踪。

本作业实现的是**本地模拟转账**：只修改项目 SQLite 数据库中的模拟账户余额，不连接银行、支付平台或其他真实资金渠道。

## 二、工具接口与运行边界

工具调用只接收三个业务参数：

| 参数 | 类型 | 含义 |
|---|---|---|
| `source_account_id` | 字符串 | 转出账户 |
| `destination_account_id` | 字符串 | 转入账户 |
| `amount_cny` | 数字 | 人民币转账金额 |

Schema 禁止额外字段。金额必须大于零、精确到分，且单笔上限为 **1000 元**。上限在工具实现中作为内部常量，不接受模型、调用者或平台配置覆盖。

配置文件中的 `demo_accounts` 不是工具参数，而是本地演示数据：它按租户提供账户 ID 和初始余额。账户首次写入 SQLite 后，应用重启不会覆盖已有账面余额。

## 三、主要改动文件

| 文件 | 主要职责与改动 |
|---|---|
| [`runtime/src/tools/transfer.ts`](../runtime/src/tools/transfer.ts) | 定义 `transfer.execute` 的三参数 Schema、内部金额上限、高风险标签、审批要求、权限名和顺序执行模式；提供业务预检查、模拟转账 handler 及超时后的对账恢复入口。 |
| [`runtime/src/platform.ts`](../runtime/src/platform.ts) | 初始化租户演示账户，并将转账工具注册到共享 Tool Registry，使 CLI、Agent Loop 等入口使用同一治理 Runtime。 |
| [`runtime/src/config.ts`](../runtime/src/config.ts) | 增加演示账户配置类型和 YAML 解析，将 `demo_accounts` 转换为运行时按租户索引的账户配置。 |
| [`runtime/src/domain.ts`](../runtime/src/domain.ts) | 为托管工具增加 `preflight`、`timeoutRecoveryHandler` 和事务化审计模式等类型约定。 |
| [`runtime/src/runtime.ts`](../runtime/src/runtime.ts) | 在统一调用链中执行 Schema、策略与业务检查；处理审批复核、超时后对账、安全重试、错误消息净化及审计/Trace 故障提示。 |
| [`runtime/src/store.ts`](../runtime/src/store.ts) | 使用 SQLite 保存模拟账户、转账前快照和幂等流水；以事务原子地检查余额、扣款、入账并写入成功审计。 |
| [`config/platform.yaml`](../config/platform.yaml) | 为 supervisor 配置 `transfer:execute` 权限和 `transfer.execute` Agent allowlist，并定义各租户演示账户及初始余额。 |
| [`runtime/tests/unit/transfer.test.ts`](../runtime/tests/unit/transfer.test.ts) | 覆盖参数接口、审批、租户边界、余额预检查、竞态复核、原子提交、幂等和超时恢复。 |
| [`runtime/tests/unit/runtime.test.ts`](../runtime/tests/unit/runtime.test.ts) | 验证失败工具的内部异常不会泄漏到 Agent 响应或审计。 |
| [`README.md`](../README.md) | 增加模拟转账和审批流程的运行说明，并明确本地模拟不代表真实支付集成。 |

## 四、工具治理设计

### 1. 工具发现与最小权限

- 工具以内部名 `transfer.execute` 注册；模型接口名由 Registry 映射。
- 只有 Agent allowlist 包含该工具的 Agent 才能看到它。
- 执行还要求上下文角色拥有 `transfer:execute` 权限；默认仅 supervisor 获得此权限。
- Tool Call 被视为不可信的候选动作，进入业务 handler 前必须通过 Runtime 校验。

### 2. Schema 校验与业务预检查

调用先按工具 Schema 校验参数，拒绝缺失字段、额外字段、类型错误、非正金额、超过单笔上限或不符合“精确到分”的金额。

业务预检查在创建审批前检查：

- 转出账户与转入账户不同；
- 两个账户都属于当前租户；
- 转出账户余额充足；
- 金额使用整数分表达且不会造成超出安全整数范围的余额。

审批执行时重新运行权限、Schema 和业务检查，避免审批等待期间账户状态变化后仍按旧状态执行。SQLite 事务内部还会再次检查账户快照与当前余额，处理预检查之后发生的并发变更。

### 3. 高风险动作人工审批

工具标记为 `high` 风险，并设置 `requiresConfirmation: true`。未审批时只创建待审批记录，不修改余额。现有 Runtime 将审批绑定到调用用户、租户、Trace、Tool Call 和参数摘要；参数被修改、审批过期或重复消费时不能执行。审批通过后，Runtime 再执行策略与业务复核。

### 4. 原子记账与幂等

金额按整数分保存，避免浮点金额计算误差。转账流水使用唯一幂等键，账户余额、转账流水和成功审计在同一个 SQLite 事务中提交；扣款、入账或审计插入任一步失败，事务整体回滚，不留部分账变。

同一幂等键重复执行会返回既有结果，而不会再次扣款。幂等键关联 Trace ID 与 Tool Call ID，不由模型作为工具参数提供。

## 五、安全边界和失败恢复

### 超时与未知执行结果

超时意味着调用方可能收不到结果，不等于操作一定失败。因此 Runtime 不对转账使用通用盲重试策略：

1. 超时后按原幂等键查询转账流水；
2. 如果流水存在且参数相同，返回已提交的原转账结果；
3. 如果没有流水，则对照执行前记录的账户余额快照；
4. 只有流水不存在且相关余额与快照一致，才以同一幂等键重试；
5. 若流水缺失但余额已改变、账户不可查询或对账失败，停止自动重试并要求人工核对。

该工具目前是本地同步 SQLite 操作，没有远端 HTTP 下游，因此不涉及支付服务的 429 限流响应或网络断连。数据库锁定、存储错误等异常会中止事务，不按“可重试”一概重放。未来若接入真实支付 API，必须重新设计下游幂等键、限流退避、连接中断后的状态查询和人工对账流程，不能直接把本地模拟策略当作真实支付保障。

### 结果与内部异常

成功结果只包含模拟转账 ID、状态、币种、金额和转账前后相关余额。失败调用对外返回稳定错误代码及通用错误文本，不回传未经净化的底层异常消息；Schema 校验错误同样不把可能包含输入值的详细错误直接返回。

### 审计与可观测性

成功审计包含 Trace ID、Tool Call ID、工具名、用户、租户、状态、错误码、规范化输入、转账结果和时间信息，可关联审批、流水和 Trace 重建一次转账决策及执行过程。输入只记录三个业务参数，不记录内部调用上下文或幂等键；成功审计与余额和转账流水事务提交，防止出现已入账但缺少成功审计的状态。

失败审计只写稳定错误码和净化后的错误文本；异常的内部 message 不落入调用响应或审计 output。敏感字段继续由 Runtime 的通用脱敏函数处理。成功后若 Trace 写入失败，调用结果会明确标记“操作已完成但可观测性写入失败”，提示先核对流水、不要重放，而不会将已提交转账伪装成未执行。

## 六、测试与运行

在 `runtime` 目录执行：

```bash
npm run build
npm test
npm run test:mcp
```

当前验证结果：

- TypeScript 构建通过；
- Runtime 单元测试 21 项通过；
- MCP 集成测试 1 项通过。

可通过 CLI 查看工具：

```bash
npm run cli -- tools --without-mcp
```

发起转账由 Agent 使用 `transfer.execute`，提交后通过现有 `approvals list`、`approvals decide` 和 `approvals execute` 流程完成审批与执行。实际演示账户以当前平台数据库余额为准。

## 七、总结

本作业的重点不只是“增加一个能改余额的函数”，而是将转账完整纳入治理框架：模型只能提供三个必要业务参数；平台通过 Schema、RBAC、Agent allowlist、租户账户隔离和人工审批层层约束；Runtime 对业务状态复核；Store 以整数分和原子事务维护账本；超时后先对账再决定是否重试；最终通过脱敏审计与 Trace 支持事后解释与核对。所有资金行为均限定在本地模拟账本中。
