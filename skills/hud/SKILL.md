---
name: workbench-hud
description: "查看当前会话的上下文占用、积分消耗、模型与项目 git 状态时使用。触发词：上下文占多少、还剩多少上下文、花了多少积分、当前模型、git 分支、状态栏。"
---

# 工作台状态查询

用户问"上下文用了多少 / 还剩多少 / 花了多少积分 / 在哪个分支"时，运行：

```bash
python "<plugin>/tools/query.py"
```

可选参数：

| 参数 | 用途 |
|---|---|
| `--session <会话ID>` | 明确指定会话；不给时按当前工作目录匹配，其次取最近更新的会话 |
| `--cwd <目录>` | 指定工作目录（默认当前进程目录） |

输出：

```json
{
  "session": {"id": "...", "used": 460096, "size": 1000000, "percent": 46.0,
              "credit": 269.6, "fee": 16.6, "unit": "credit", "mixed": true,
              "latestModel": "deepseek-v4.1-flash"},
  "today": 0, "total": 1234.5, "fee_total": 116.76,
  "days": [{"day": "2026-11-20", "credit": 12.3}],
  "sessions": [{"id": "5e2254bd", "credit": 269.6, "fee": 16.6}],
  "git": {"root": "workbuddy", "branch": "main", "dirty": false, "available": true},
  "counts": {"sessions": 21, "aggregated": 21},
  "note": "..."
}
```

回答规则：

- **上下文**：直接用 `session.percent`，并给出 `used / size` 两个绝对值，例如「46 万 / 100 万（46%）」。`percent` 为 `null` 表示窗口大小未知，这时只报绝对值。
- **先看单位，再报数字**：`session.unit` 是**最近一次请求**的计费单位。
  - `credit` → 报 `session.credit`（积分）。积分由服务端按请求写入，不要换算成金额、不要用 token 乘单价。
  - `fee` → 报 `session.fee`（人民币 ¥，按 token × 分时段单价算）。
  - `mixed=true` 表示这个会话两种模型都用过：主数字只报当前单位，**同时**补一句另一种单位的消耗（`credit` 与 `fee` 两个字段都在），不要说"只有一种"。
  - 会话中途换过模型时，单位以最后一次为准；不要用"这个会话以前用过付费模型"来推断现在。
- **今日 / 按日**：`today` / `days` 按请求时间精确归日（`credit_json` 键前 12 位即请求毫秒时间戳）；费用侧看 `fee_days`。
- **git**：`available=false` 表示本机没有 git 或目录不是仓库，此时只说"取不到分支"，不要编。
- 数据缺失就说取不到，不要编。脚本报错时会返回 `{"error": "..."}`，把原文转达即可。

## 体检

怀疑工作台本身出问题（数据不更新、界面空白、补丁失效）时，先跑：

```bash
python "<plugin>/tools/selftest.py"
```

逐项输出 PASS/WARN/FAIL，退出码非 0 表示有失败项。它只读，不会改动客户端。
