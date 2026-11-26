# wb-hud · WorkBuddy 工作台

在 WorkBuddy 客户端里加一条状态条和一本账本：**上下文占用、积分/费用消耗、当前模型、git 分支、工具与子代理活动**。

> ⚠️ **它会修改本机客户端文件（`app.asar`）**。这是本机个人用的工具，不是给所有人装的通用软件。
> 安装脚本会先备份原版、失败自动还原；`uninstall.cmd` 可完全回退。
> 请只在你自己的机器上使用，并自行评估风险。

## 装 / 卸

```bash
# 装（会关闭并重启 WorkBuddy，约 40 秒）
install.cmd

# 卸（还原客户端原版并重启）
uninstall.cmd
```

前置：Python 3.10+ 在 PATH 里；客户端默认装在 `D:\workbuddy`（路径写死在 `ui/patch.py` 的 `APP`，装在别处要改）。

## 显示什么

| 位置 | 内容 |
|---|---|
| 状态条第 1 行 | `模型 │ 项目 git:(分支*) │ 输入/输出/缓存 token` |
| 状态条第 2 行 | `Context 46% (459k/1.00M) │ 积分 275.08 │ 费用 ¥16.60` |
| 侧栏账本 | 本会话 / 今日 / 本周 / 累计、按模型、按会话、按日 |
| 消息底部 | 这一轮消耗（`◇ 5.54` 积分 或 `¥3.5000`），悬浮看 token 明细 |
| 设置面板 | 开关各段显示、自定义单价、账本模式（自动/积分/费用） |

## 计费口径（本项目最容易搞错的地方）

同一台机器上可能同时存在两种计费方式，**它们不是一回事，不能相加**：

| 计费来源 | 判定依据 | 记录方式 |
|---|---|---|
| 平台模型 | `requestModelId` **无前缀**（如 `deepseek-v4.1-flash`） | 扣**积分**，由服务端按请求写入 `credit_json` |
| 自定义模型 | `requestModelId` 以 **`custom-local:`** 开头 | 按 **token × 分时段单价** 算**人民币**，不占积分 |

判断依据是**请求走的是谁的密钥**（前缀），不是模型名——模型名会随版本变，前缀不会。

同一个会话里可以在两者之间来回切，所以单位是**逐请求**的属性：

- 每一轮的消耗行按**这一轮自己**的单位显示；
- 状态条/账本的 `自动` 模式跟随**最近一次请求**的单位；
- 一个会话两种都用过时，主数字显示当前单位，另一种单位用暗色小字并列，不会丢。

规则与单价只有两份真源：

| 文件 | 作用 |
|---|---|
| `tools/billing.json` | 计费前缀、分时段单价、按模型价格表 |
| `ui/billing_core.js` | 判定与计价逻辑 |

改完必须同步（`main_addon.js` 里是内联副本，因为 asar 里不能 `require` 外部文件）：

```bash
python tools/sync_billing.py     # 数据 + 逻辑 → 内联进主进程
python tools/test_billing.py     # 31 项回归，全过才算改对
```

## 目录

```
ui/            注入到客户端前端/主进程的代码
  inject.js          状态条 + 侧栏 + 抽屉（构建产物：由 round_meter.js 合并而来）
  round_meter.js     消息末尾「本轮消耗」行（源文件）
  main_addon.js      主进程：读库、扫日志、算账（构建产物：由 billing_core.js 内联而来）
  billing_core.js    计费规则与计价（源文件）
  patch.py           asar 注入 / 备份 / 校验 / 反推干净版
tools/         CLI 与安装
  query.py           输出当前会话状态 JSON（技能用）
  install.py / uninstall.py
  _proc.py           统一的子进程调用（强制 UTF-8，见下方「编码约定」）
  sync_billing.py    计费规则同步
  test_billing.py    计费回归测试（34 项）
  selftest.py        一键体检
  repair_backup.py   备份丢失时从已注入的 asar 反推干净版
skills/        agent 技能（hud / ledger）
scripts/       CI 用：按改动范围决定跑哪些检查
```

两个「构建产物」改完源文件后要重新生成：

```bash
python tools/merge_round_meter.py   # round_meter.js → inject.js
python tools/sync_billing.py        # billing_core.js → main_addon.js
```

## CI：检查拆成三个时候

| | 什么时候 | 跑什么 | 在哪 |
|---|---|---|---|
| ① | `git commit` 前 | ruff、计费规则是否同步、JS 语法 | `.pre-commit-config.yaml` |
| ② | 开 PR 时 | 按改动范围只跑相关的（限时 5 分钟） | `.github/workflows/pr-fast.yml` |
| ③ | 合进 `main` 后 | 全部：ruff + 语法 + 同步检查 + 31 项回归 | `.github/workflows/main-full.yml` |

为什么要这么拆：AI 写代码时一天能出几十个 PR，每个都跑全量，CI 就排队、烧额度。
② 只跑「这次改到的部分」，③ 才做全量兜底。这套做法来自 [ai-era-ci](https://github.com/cooler1oo/ai-era-ci-template) 技能。

## 本地怎么验（不用装客户端）

改完代码先跑这四条，和 CI 跑的是同一套：

```bash
python -m py_compile tools/*.py ui/*.py      # Python 语法
for f in ui/*.js; do node --check "$f"; done   # 前端脚本语法（没有构建步骤，只有这一步）
python tools/sync_billing.py --check           # 计费规则是否已同步（改过规则没 sync 会红）
python tools/test_billing.py                   # 31 项回归
```

`python tools/selftest.py` 是「体检」：插件文件齐不齐、库能不能读、客户端补丁状态是否一致、备份在不在。
它只读，不改任何东西。

## 编码约定（踩过坑，别改回去）

Windows 默认代码页是 936（GBK），但 node 永远输出 UTF-8。用
`subprocess.run(..., text=True)` 不加 `encoding` 时，父进程会按 GBK 解码 node 的中文输出，
读线程直接抛 `UnicodeDecodeError`——**子进程被判失败，哪怕它已经成功**。

所以：**所有捕获输出的子进程调用一律走 `tools/_proc.py`**，它同时钉住两端：

- 子进程：`PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`
- 父进程：`encoding="utf-8", errors="replace"`

`test_billing.py` 里有一条 AST 检查会扫描全仓库，发现裸 `text=True` 就红。

## 已知限制

- **只在 Windows 上验证过**：注入逻辑基于 asar 结构与 exe 内哈希，macOS/Linux 版本没试。
- 客户端升级后需要重跑 `install.cmd`（升级会覆盖 `app.asar`）。备份丢失时安装脚本会按注入标记反推干净版，不依赖历史备份。
- 「今日/按日」按请求时间精确归日（`credit_json` 的键前 12 位是 ULID 时间戳）；一条请求 ID 若不是 ULID（库里有极少数普通 UUID），该条不计入按日统计。
- 费用按 `tools/billing.json` 的单价估算；模型没配价格时按默认价算，悬浮卡会标「未配置单价，按默认价估算」。
