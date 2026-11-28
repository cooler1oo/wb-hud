# 工作台：每个字段是什么（完整版）

插件位置：`~/.workbuddy/plugins/marketplaces/workbench-local/workbench-hud/`
界面由插件 `install.cmd` 注入到客户端原生位置；数据由同一插件的 `main_addon.js` 在主进程读取。

---

## 状态条（输入框上方）

### 第 1 行 · 会话概况

```
deepseek-v4.1-flash │ workbuddy git:(main*) │ 1.24M in · 88k out · 900k cache
```

| 段 | 含义 | 来源 |
|---|---|---|
| `deepseek-v4.1-flash` | 当前模型 | 会话日志 `providerData.model` |
| `workbuddy` | 会话工作目录名 | `sessions.cwd` 的末级目录 |
| `git:(main*)` | 分支；`*` = 有未提交改动 | 主进程在该目录跑 `git rev-parse` + `git status --porcelain` |
| `1.24M in · 88k out · 900k cache` | 本会话 token 累计：输入 / 输出 / 命中缓存 | 日志 `providerData.usage` 的 `inputTokens` / `outputTokens` / `cache_read_input_tokens` |

模型、目录、git 任一项取不到时该段自动隐藏，**不填占位词**。

### 第 2 行 · 上下文与积分

```
Context ████░░░░░░ 46% (459k/1.00M) │ 积分 275.08              ×
```

| 段 | 含义 | 来源 |
|---|---|---|
| `████░░░░░░` | 上下文占用，10 格；≥75% 黄、≥92% 红 | 同下 |
| `46%` | 已用 / 窗口 | `session_usage.used ÷ size` |
| `(459k/1.00M)` | 已用 token / 模型窗口 | 同上，两值都直接读库 |
| `积分 275.08` | **本会话累计积分** | `credit_json` 求和；服务端按请求写入，不是 token×单价 |
| `×` | 隐藏工作台 | 写 localStorage；`Ctrl+Alt+H` 恢复 |

### 第 3 行 · 工具活动（有工具时出现）

```
◐ Bash: python patch.py │ ✓ Read ×12 │ ✓ Grep ×5
```

| 符号 | 含义 |
|---|---|
| `◐` | 该工具有调用正在进行 |
| `✓` | 已完成的调用 |
| `×12` | 本会话累计调用次数 |
| `: 参数摘要` | 文件名 / 搜索词 / 命令前两段 |

来源：日志里 `function_call` 的 `name` 与 `arguments`，用 `callId` 与 `function_call_result` 配对判断"进行中/已完成"。

### 第 4 行 · 子代理（有运行时出现）

```
◐ explore: 查找鉴权代码 (42s)
```

来源：`Agent` 调用的 `description`，括号内是已运行时长。

### 第 5 行 · 待办（任务列表非空时出现）

```
▸ 修复登录问题 (2/5)
```

来源：`TaskCreate` 的 `subject` + `TaskUpdate` 的 `status`。

---

## 侧边栏账本

| 区块 | 内容 | 精确度 |
|---|---|---|
| 本会话 / 今日 / 全部累计 | 积分 | 本会话与累计精确；今日近似 |
| Token · 本会话 | 输入 / 输出 / 命中缓存 / 请求数 | 精确（来自日志） |
| 按模型 | 每个模型的请求次数与 token | 精确 |
| 按会话 · 前 8 | 每个会话的积分 | 精确 |
| 按日 · 近 7 | 每天的积分 | 近似 |

"今日/按日"为什么是近似：`credit_json` 的键是请求 ID，**没有时间戳**，只能按会话的 `updated_at` 归到某一天。这是源数据的限制，不是实现偷懒。

---

## 与原版对照

| claude-hud | 本插件 | 说明 |
|---|---|---|
| 模型 + provider 标签 | ✅ | provider 取自日志，没有就只显示模型名 |
| 项目路径 + git 分支 | ✅ | 含 `*` 脏标记 |
| Context 方块条 + 百分比 | ✅ | 三级配色 |
| 订阅额度 + 重置倒计时 | ➖ | WorkBuddy 无订阅额度概念，该位置用积分 |
| 工具活动行 `✓ Read ×3` | ✅ | 含进行中标记 |
| 子代理行 + 耗时 | ✅ | — |
| 待办行 `(2/5)` | ✅ | — |
| 关闭开关 | ✅ | `×` 按钮 + `Ctrl+Alt+H` |

| ccusage | 本插件 | 说明 |
|---|---|---|
| daily / session | ✅ | 侧边栏"按日""按会话" |
| monthly / weekly | ➖ | 同一份数据按日聚合，换时间窗即可，未做独立视图 |
| blocks（5 小时窗口） | ❌ | 需要逐条请求时间戳，源数据没有 |
| 输入/输出/缓存 token 分列 | ✅ | 侧边栏 Token 区 |
| 按模型拆分 | ✅ | 侧边栏"按模型" |
| 成本（USD） | ➖ | 本机是积分制，不做美元换算 |

---

## 数据来源汇总

| 数据 | 位置 |
|---|---|
| 上下文、积分、会话列表 | `~/.workbuddy/workbuddy.db` → `session_usage` |
| 工作目录 | 同库 → `sessions.cwd` |
| 模型、token、工具、子代理、待办、标题 | `~/.workbuddy/projects/<目录>/<会话ID>.jsonl` |
| git 分支与脏标记 | 在 cwd 执行 `git` |

日志采用**增量读取**：记录已读字节偏移，只解析新增行，不重复扫全文件。

---

## 2026-11-21 改动（复盘后）

| 改动 | 位置 | 原因 |
|---|---|---|
| `total` 改为全表求和 | `tools/query.py` | 原实现 `limit 200` 截断，与本文"全部累计精确"矛盾 |
| 新增 `--session` / `--cwd` | `tools/query.py` | 原实现取"最近更新的会话"当作当前会话，可能报错对象 |
| 输出 `session.percent` | `tools/query.py` | 原来要调用方自己手算百分比，易除零 |
| `git.available` 字段 | `tools/query.py` | 原来 git 不存在时静默留空，无法区分"没有分支"和"没有 git" |
| 数据库缺失/锁定不再抛栈 | `tools/query.py` | 原来会直接抛异常栈，调用方无法优雅处理 |
| 备份带指纹、客户端升级后自动刷新 | `ui/patch.py` | 原来备份永不更新，升级后 install 会把旧版打回去 |
| 安装失败自动还原 | `ui/patch.py` `tools/install.py` | 原来 asar 已改、exe 改失败会留下半状态，客户端起不来 |
| 安装后强制校验 | `ui/patch.py::verify()` + `tools/install.py` | 原来只等窗口出现，不验证补丁是否真的生效 |
| 日志轮转（上限 500 行） | `tools/install.py` | install.log 无限增长 |
| 控制台错误线索 | `ui/inject.js` | 读取失败只在界面显示文字，没有可查的堆栈 |
| 「数据延迟」提示 | `ui/inject.js` | 快照过期时界面仍显示旧数，没有提示 |
| 新增 `tools/selftest.py` | 新文件 | 没有一键判断"能不能用"的入口 |

> **生效方式**：改动写在插件目录，需要重新执行一次安装（`install.cmd` / `tools/install.py`）才会注入到客户端——该操作会重启 WorkBuddy，故不代劳。

| 2026-11-21 13:55 | 积分按请求时间精确归日（credit_json 键内嵌毫秒时间戳） | tools/query.py, ui/main_addon.js | 修复"昨日算进今日" |
| 2026-11-21 13:55 | 会话锚定 + 切换器（标题点击弹列表） | ui/inject.js, ui/main_addon.js | 修复"另一会话抢占显示" |
| 2026-11-21 13:55 | 费用模型并存计价（¥，分时段单价） | 同上 + 设置面板 | bailian 模型按 token 计费，不占积分 |

---

## 2026-11-26 重构：计费单位从「会话级猜测」改为「请求级事实」

### 故障现象

同一会话里在自定义模型（按 token 付费）和平台模型（扣积分）之间切换时：

| 现象 | 实际 |
|---|---|
| 切回平台模型后，账本仍显示「费用 ¥」 | 会话级开关一旦变 true 就不回落 |
| 该轮消息下方显示 `¥0.0000` | 平台轮本来没有 ¥，却按会话单位渲染了 ¥ |
| 侧栏「本会话费用 ¥16.60」但同屏原生显示 ⚡5.54 | 两套单位各算各的，且汇总不区分"当前"与"历史" |

### 根因（三层，都是结构性的）

1. **判定依据错**：用「模型名包含某关键词」判断是否按 token 计费。
   真实依据是 `requestModelId` 的前缀——`custom-local:` = 用户自带密钥。
   模型名会随版本变（`…-1017` → 不带版本号），前缀不会。
   旧规则只是"碰巧命中"，用户换一个自定义模型（如 `custom-local:glm-5.3-flash`）
   就会静默失效，费用变 0 而不是报错。实测全库 29481 条请求只有两种前缀。
2. **粒度错**：单位被当成会话属性（`usesFeeModel` = 本会话出现过任一条费用请求）。
   它是**请求属性**。混合会话把两者压成一个布尔，必然丢信息。
3. **三处重复实现**：`query.py`、`main_addon.js`、`round_meter.js` 各写一份
   patterns 与计价公式。改一处另两处不动，于是 CLI 与界面给出不同答案。

### 改造

| 项 | 变更 |
|---|---|
| 单一真源 | 新增 `tools/billing.json`（数据）+ `ui/billing_core.js`（逻辑）；`tools/sync_billing.py` 把逻辑内联进 `main_addon.js`（asar 里不能 require 外部模块，只能内联） |
| 判定 | 前缀优先（`feePrefixes`），关键词仅作手工兜底（默认留空） |
| 粒度 | `rounds[].unit` 逐轮成立；`session.unit` = **最近一次请求**的单位 |
| 混合会话 | `session.mixed` 为真时，主数字只显示当前单位，另一种单位用暗色小字并列（状态条 / 侧栏 / 抽屉三处都有） |
| 逐轮行 | 按该轮自己的单位渲染；`¥0.0000` 与「平台轮显示 ¥」由此消失 |
| 价格 | 按模型名最长匹配价格表，未配置回落默认价并标 `priced=false`（悬浮卡提示"按默认价估算"） |
| 归集 | `crid → 会话` 映射（来自 JSONL 文件名），会话级费用精确归集，不再按平台记账值比例分摊 |
| 脏数据 | `conversationRequestId` 不全是 ULID（库里有 20 条普通 UUID）。新增范围校验，越界一律视为"无时间"，避免 `fromtimestamp()` 抛错把整个查询打挂 |
| 安装 | 备份丢失时不再拒绝安装：注入是纯插入/追加，`patch.strip_asar()` 按标记反推干净版并重建配套 exe 备份（`tools/repair_backup.py` 可先 dry-run） |
| 自检 | `selftest.py` 增加「计费规则已同步」；备份缺失降级为 WARN 并给修复入口 |

### 验证

```bash
python tools/sync_billing.py          # 同步规则（幂等）
python tools/test_billing.py -v       # 31 项：分类/计价/会话规则/脏数据/三处一致性/真实日志
python tools/selftest.py              # 插件与客户端状态
```

关键回归用例：`custom-local:glm-5.3-flash` 必须判为付费、`glm-5.3-flash` 必须判为积分；
混合会话里切回平台模型后 `session.unit` 必须变回 `credit`。

### 改动文件

`tools/billing.json`、`ui/billing_core.js`、`tools/sync_billing.py`、`tools/test_billing.py`、
`tools/repair_backup.py`（新增）；`ui/main_addon.js`、`ui/round_meter.js`、`tools/query.py`、
`ui/patch.py`、`tools/install.py`、`tools/selftest.py`、`skills/hud/SKILL.md`、
`skills/ledger/SKILL.md`（修改）。

> **生效方式**：执行一次 `install.cmd`（会重启客户端）。安装脚本会先同步计费规则，
> 失败则中止且不改动客户端。

---

## 2026-11-28 修复：子代理（subagents）的 token 与费用被整段漏掉

### 现象

一个"数十 M token"的会话，账本只显示 8M；费用也明显偏低。

### 证据（会话 6403e986）

| 来源 | 文件 | usage 行 | input | output |
|---|---|---|---|---|
| 主线程 | `<会话ID>.jsonl` | 80 | 7,975,354 | 41,342 |
| 子代理 | `<会话ID>/subagents/agent-98dae98f.jsonl` | 172 | 25,062,650 | 463,049 |

- 主文件里 `isSubAgent=true` 的行数 = **0**，子代理请求从不在主文件里；
- 子代理请求在 `credit_json` 里命中 **0** 条（平台不把子代理记进会话积分）；
- 会话费用：修前 ¥0.76（只算主线程），实际 ¥3.53。

### 根因（架构级）

数据模型假设「一个会话 = 一个 .jsonl」，而客户端实际是「一主 + N 个子代理文件」：

| 位置 | 旧行为 | 后果 |
|---|---|---|
| `main_addon.js::fileMap()` | 只读 `<项目>/*.jsonl` 一层 | 子代理文件永远发现不了 |
| `main_addon.js::histOf()` | 单文件游标，会话级结构 | 无法把多文件并进同一会话 |
| `query.py` 的 crid→sid | 用文件 basename | 子代理请求被记成 `agent-x` 假会话：钱进了全局合计，却掉不进任何会话 |
| `query.py` 费用按会话 | 依赖上面的 sid | 会话费用少算，而 `fee_total` 是对的 → 总账 ≠ 各会话之和 |

### 改造

1. `subFiles(sid)` + `scanHistFile(h, sid, file, isSub)`：主文件与子代理文件同属一个会话，
   逐文件维护扫描游标；`h.sub` 单列子代理部分。
2. 截断/重写时**整会话重建**（旧实现只清一个文件，会把其它文件的贡献丢掉）。
3. `.hist.json` 缓存版本 3 → 4：旧缓存数字本就漏了子代理，继续用会"新代码 + 旧错数"。
4. 「当前单位」只跟**主线程**最近一次请求（`h.lastMainModel`）——子代理换了模型不该带偏账本。
5. `query.py::path_sid()` 把子代理请求归到父会话；新增 `session_tokens()`（含 `sub` 明细）。
6. 侧栏 Token 区新增「其中子代理」行，「按会话」悬浮显示每个会话的子代理消耗。
7. 顺带修：主进程读库 `limit 200` → 1000（累计是"对全部会话求和"，200 会静默少算），
   触顶时在账本里明确标注。

### 验证

```
python tools/test_billing.py     → 39 项（新增 subagent_rollup：子代理归父会话/费用/token）
node   scripts/test_hist_scan.js → 8 项（增量不重复、截断重建、sub 单列、主线程模型记录）
真实数据：会话 6403e986 费用 ¥0.7589 → ¥4.0035，token 8.0M → 38.5M（含子代理 25.7M）
```

---

## 2026-11-28 新增：子代理分区（动态/token/费用/时长）+ 状态条缓存命中

### 需求
账本只把子代理并进了总数，看不到"哪个子代理在干活、各自花了多少"。另外缓存命中率只在侧栏，状态条上没有。

### 数据来源（实测会话 6403e986，4 个子代理文件 / 2 类 agent）

| agent | 文件 | input | turns | 工具调用（Top） |
|---|---|---|---|---|
| software-architect | 2 | 106,825,848 | 13 | Bash×221 Read×44 Edit×39 |
| software-engineer | 2 | 76,861,231 | 3 | Bash×153 Edit×68 Read×38 |

### 实现
- `main_addon`：扫描子代理文件时按 `providerData.agent` 分组，累计 token、请求轮次、
  工具调用（`type=function_call` 的 `name`）、每个文件自身的首尾跨度；
  费用按请求归属回填到 agent（`h.subCridAgent`）。
- **时长口径**：`Σ(每个 agent-*.jsonl 自身跨度)`，不是"该 agent 全部请求的首尾差"——
  后者会跨会话中断/隔天继续，实测会报出 918 分钟（15 小时）的假时长。
- 界面：侧栏新增「子代理 · N 个 / 合计 X M / 每个 agent 一行（¥ · 时长）」；
  账本抽屉新增「子代理 · N 个」分区（token · 费用 · 时长，悬浮看工具动态）；
  状态条 Context 之后新增「缓存 83%」。
- CLI：`session.subAgents[]` 与界面同源（name/input/output/turns/files/ms）。
- `.hist.json` 缓存 v4 → v5（分组信息需要重扫才能建立）。

### 验证
```
node scripts/test_hist_scan.js  → 19 项（分组/文件数/工具数/时长=文件跨度之和）
python tools/test_billing.py    → 42 项（含 subAgents 分组）
Chromium 渲染验证 16/16：
  侧栏「子代理 · 2 个 / 合计 184.33M / software-architect ¥12.34 · 1 时 30 分」
  状态条「Context 14% │ 缓存 83% │ 积分 32.26 │ 费用 ¥16.60」
```

---

## 2026-11-28 修正：「压缩次数」在新版客户端恒为 0（检测口径不完整）

### 用户报告
技术设计6 的上下文明显变短过几次，但账本一直显示「压缩 0」。

### 根因（实测）
- 旧版客户端压缩时会写一条 `cmp_` 开头的摘要消息，我们按它计数；
- **新版客户端压缩是静默的**：技术设计6（ae81f8fd）全文 0 条 `cmp_`、0 段摘要文本，
  但 inputTokens 有 3 次下跌：414,874→360,334（-13%）、450,629→307,301（-32%）、346,280→309,106（-11%）；
- 旧会话的 26 次标记全部对应 ≥53% 的下跌，说明"有标记"与"大幅压缩"强相关，
  但**没有标记的下跌同样真实存在**（裁剪旧内容/重建上下文），旧口径完全看不见。

> 我上一轮只验证了"有标记的 6 个会话"就下结论说准确，漏掉了新客户端这个反例，属误判。

### 改造：两个口径分开显示
- `压缩 N`：生成过摘要的压缩次数（`cmp_` 标记，旧版才有）
- `重建 M`：上下文整体变短的次数 —— 下一次请求 inputTokens 比上一次少 ≥10%（前值 ≥20k），
  同一次重建分几步跌（5 分钟内）合并为一次，幅度按整段算；只看主线程，子代理不计
- 悬浮列出近 5 次的时刻与 `from → to（-x%）`
- `.hist.json` v5 → v6（需要重扫才能重建轨迹）

### 验证
```
node scripts/test_hist_scan.js  → 23 项（新增 4 项：聚类/整段幅度/子代理不参与）
python tools/test_billing.py    → 42 项
Chromium 渲染 18/18             → 侧栏「压缩 0 · 重建 2」
真实日志回放（技术设计6）        → 压缩 0 · 重建 3（-13% / -32% / -11%，与用户观察一致）
```
