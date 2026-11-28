---
name: workbench-ledger
description: "统计积分消耗、按会话或按日归集、对比历史花费时使用。触发词：账本、花了多少、这个会话多少积分、按天统计、累计消耗、成本分析。"
---

# 积分账本

唯一数据源：`~/.workbuddy/workbuddy.db` 的 `session_usage` 表。

| 列 | 含义 |
|---|---|
| `session_id` | 会话 ID |
| `used` / `size` | 已用上下文 / 模型窗口 |
| `credit_json` | `{"请求ID": 积分}`，服务端按请求写入 |
| `updated_at` | 会话最后更新时间（毫秒） |

## 口径

1. **积分 = `credit_json` 里"非付费模型"条目的数值之和**。不要用 token 乘单价。
2. **付费模型（自定义模型）不走积分**：`requestModelId` 带 `custom-local:` 前缀的请求
   是用户自带密钥，按 token 计费（¥）。`session.fee` / `fee_total` 就是这部分，
   由 usage × 分时段单价算出，与积分**互不混算**。
3. **单位看 `session.unit`（最近一次请求）**：`credit` 报积分，`fee` 报 ¥。
   `mixed=true` 表示会话里两种都用过——两个字段都在，都要提。
4. **「累计(total)」是全表求和**，覆盖所有会话；费用侧对应 `fee_total`。
5. **「今日/按日」是精确的**：`credit_json` 的键前 12 位十六进制就是该请求的
   Unix 毫秒时间戳（ULID），脚本按请求时间归日，跨天会话会拆开。
   （早期文档说"只能近似"，那是因为当时还没解码时间戳，已不成立。）
6. **不做 5 小时窗口**：源数据没有可用的窗口边界定义。（界面里的 5 小时窗口只按主线程分桶。）
7. **两个"次数"不是一回事**：`tokens.requests` = 模型调用条数（每条 usage 一条，含子代理）；
   `tokens.turns` = 发言轮次（唯一 `conversationRequestId`）。报价时用 requests 说"调用"，用 turns 说"发言"。
8. **子代理**：`tokens.sub` 是其中子代理那部分（日志在 `<会话ID>/subagents/*.jsonl`），
   已并入总数。2026-11-28 之前完全没统计，会少 50%+。

## 查询

```bash
python "<plugin>/tools/query.py"
python "<plugin>/tools/query.py" --session <会话ID>   # 指定会话
```

## 报告

- 问「这个会话多少」→ 先看 `session.unit`：积分报 `session.credit`，付费报 `session.fee`（¥）
- 混合会话 → 主单位 + 一句另一种单位的数（两个字段都有）
- 问「今天」→ `today`（积分）/ `fee_today`（¥），按请求时间精确归日
- 问「按天」→ `days`（积分）/ `fee_days`（¥）
- 问「累计」→ `total`（积分）/ `fee_total`（¥），全表求和，精确

## 改规则

计费规则不是散落在代码里的字符串，唯一真源是：

| 文件 | 内容 |
|---|---|
| `tools/billing.json` | 计费前缀、分时段单价、按模型价格表 |
| `ui/billing_core.js` | 判定与计价逻辑（被内联进主进程） |

改完必须 `python tools/sync_billing.py`，再 `python tools/test_billing.py` 验证。
