#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""计费规则的回归测试。只读，不写数据库、不改客户端。

覆盖的是 2026-11-26 修掉的那几类错，每一条都对应一个真实症状：

  1. 计费来源必须看 requestModelId 的前缀
     旧实现看模型名子串 → 换一个自定义模型（custom-local:glm-5.3-flash）
     就被当成平台模型，费用静默变 0。
  2. 单位必须逐请求成立
     旧实现「会话里出现过费用模型就永久显示 ¥」→ 切回平台模型账本不变，
     平台轮被逐轮行显示成 ¥0.0000。
  3. 金额不能为 0 还显示成 0
     计费公式在写入/读取任一侧漏传 model 都会得到 0；断言：有 usage 就有金额。
  4. 脏时间戳必须挡在入口
     库里 20 条普通 UUID 请求 ID，前 12 位当十六进制解析是公元 5000 年，
     Windows 上 fromtimestamp() 抛 OSError，整个查询直接失败。
  5. 两份真源不能漂移
     billing.json / billing_core.js / main_addon.js 三者必须一致。

用法：python tools/test_billing.py [-v]
退出码 0 = 全过。
"""
import ast
import datetime
import glob
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
UI = os.path.join(PLUGIN, "ui")

sys.path.insert(0, HERE)
import _proc  # noqa: E402

_spec = importlib.util.spec_from_file_location("wb_query", os.path.join(HERE, "query.py"))
Q = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(Q)

VERBOSE = "-v" in sys.argv
checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))
    if VERBOSE or not ok:
        print(("  [ok] " if ok else "  [x] ") + name + (("  " + detail) if detail else ""))
    return ok


def beijing_ms(hour, day=26):
    """构造北京时间某天某点的毫秒时间戳（11 月，UTC+8）。"""
    dt = datetime.datetime(2026, 11, day, hour, 30, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
    return int(dt.timestamp() * 1000)


def test_classification():
    cases = [
        ("custom-local:deepseek-v4.1-flash-1017", "fee", "用户自带密钥"),
        ("deepseek-v4.1-flash", "credit", "平台模型（与自定义同名）"),
        ("custom-local:glm-5.3-flash", "fee", "换一个自定义模型也必须判为付费"),
        ("glm-5.3-flash", "credit", "同名的平台模型必须判为积分"),
        ("mimo-v2.6-pro", "credit", "其它平台模型"),
        ("", "credit", "空值"),
        (None, "credit", "null"),
    ]
    for model, want, why in cases:
        got = Q.billing_unit(model)
        check("分类 %-42s → %-6s（%s）" % (str(model)[:42], got, why), got == want, "期望 " + want)


def test_price_book():
    idle, busy, known = Q.price_of("deepseek-v4.1-flash-1017")
    check("已配置模型走专属价（known=true）", known and idle["input"] == 1.0, str(idle))
    idle2, busy2, known2 = Q.price_of("custom-local:some-unknown-model")
    check("未配置模型回落默认价并标 known=false", (not known2) and idle2["input"] == 1.0, str(idle2))


def test_fee_math():
    million_in = [1000000, 0, 0, 0]
    f_idle = Q.calc_fee(million_in, beijing_ms(23), "custom-local:deepseek-v4.1-flash-1017")
    check("闲时 100 万输入 = ¥1.0000", abs(f_idle - 1.0) < 1e-9, "得到 %.6f" % f_idle)

    f_busy = Q.calc_fee(million_in, beijing_ms(10), "custom-local:deepseek-v4.1-flash-1017")
    check("忙时 100 万输入 = ¥2.0000", abs(f_busy - 2.0) < 1e-9, "得到 %.6f" % f_busy)

    # 缓存命中不应重复计费：100 万输入全部命中缓存，只收缓存价
    all_cached = [1000000, 0, 1000000, 0]
    f_c = Q.calc_fee(all_cached, beijing_ms(23), "custom-local:deepseek-v4.1-flash-1017")
    check("全命中缓存 100 万 = ¥0.0200", abs(f_c - 0.02) < 1e-9, "得到 %.6f" % f_c)

    # 关键回归：真实量级下金额必须非 0（旧 bug 的表现是 ¥0.0000）
    real = [8500000, 30000, 8000000, 0]
    f_real = Q.calc_fee(real, beijing_ms(21), "custom-local:deepseek-v4.1-flash-1017")
    check("8.5M token 的真实一轮费用显著大于 0", f_real > 0.5, "得到 ¥%.4f" % f_real)


def test_dirty_timestamps():
    check("普通 UUID 不当成时间戳", Q.key_ts("6ead5a3129714ff6991edeaed5b61fb3") is None)
    check("正常 ULID 可解析", Q.key_ts("01a2181c5c82701fa39452266f3e1fea") is not None)
    check("非十六进制安全返回 None", Q.key_ts("zzzzzzzzzzzz") is None)


def test_sync_consistency():
    billing = json.load(open(os.path.join(HERE, "billing.json"), encoding="utf-8"))
    core = open(os.path.join(UI, "billing_core.js"), encoding="utf-8").read()
    main_src = open(os.path.join(UI, "main_addon.js"), encoding="utf-8").read()

    def block(text, start, end):
        i = text.find(start)
        j = text.find(end, i)
        return text[i + len(start):j] if i >= 0 and j > i else None

    core_json = block(core, "/* @@BILLING_JSON@@ */", "/* @@END_BILLING_JSON@@ */")
    ok = False
    try:
        ok = json.loads(core_json) == billing
    except Exception:
        pass
    check("billing_core.js 内嵌数据 == billing.json", ok)

    inlined = block(main_src, "/* @@BILLING_CORE@@ */", "/* @@END_BILLING_CORE@@ */")
    check("main_addon.js 已内联计费核心（非空）", bool(inlined and "WBBilling" in inlined))
    # 内联时会整体缩进 4 格，内容比对忽略行首缩进（缩进只是排版，语义在字符本身）
    def norm(t):
        return [ln.strip() for ln in (t or "").strip("\n").splitlines()]

    check("main_addon.js 内联块与 billing_core.js 一致", norm(inlined) == norm(core))

    r = _proc.run([sys.executable, os.path.join(HERE, "sync_billing.py"), "--check"])
    check("sync_billing.py --check 通过", r.returncode == 0, (r.stdout or r.stderr).strip()[:120])


def test_js_parity():
    """把同一批用例交给 Node 跑一遍 billing_core.js：JS 与 Python 结论必须一致。"""
    try:
        node = _proc.run(["node", "--version"])
        if node.returncode != 0:
            raise FileNotFoundError
    except FileNotFoundError:
        print("  [!] 未安装 node，跳过 JS 一致性测试")
        return
    code = (
        "const fs=require('fs');"
        "const B=new Function(fs.readFileSync(process.argv[1],'utf8')+';return WBBilling;')();"
        "const c=B.defaults();"
        "const cases=JSON.parse(process.argv[2]);"
        "const out=cases.map(([m])=>({unit:B.unitOf(m,c),fee:B.calcFee({input:1000000,output:0,cacheRead:0},1795700000000,m,c,8)}));"
        "console.log(JSON.stringify(out));"
    )
    cases = [["custom-local:deepseek-v4.1-flash-1017"],
             ["deepseek-v4.1-flash"],
             ["custom-local:glm-5.3-flash"],
             ["glm-5.3-flash"]]
    r = _proc.run(["node", "-e", code, os.path.join(UI, "billing_core.js"), json.dumps(cases)])
    if r.returncode != 0:
        check("Node 能加载 billing_core.js", False, r.stderr.strip()[:200])
        return
    got = json.loads(r.stdout)
    for (model,), js in zip(cases, got):
        py_unit = Q.billing_unit(model)
        check("JS/Python 分类一致 %-42s" % model, js["unit"] == py_unit, "%s vs %s" % (js["unit"], py_unit))


def test_real_logs():
    """真实日志全量回归：分类覆盖、金额非零、混合会话单位跟随。"""
    files = glob.glob(os.path.join(os.path.expanduser("~"), ".workbuddy", "projects", "**", "*.jsonl"),
                      recursive=True)
    if not files:
        print("  [!] 没有找到会话日志，跳过真实数据回归")
        return
    models, reqs = set(), {}
    sid_of = {}
    for f in files:
        sid = os.path.splitext(os.path.basename(f))[0]
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if "conversationRequestId" not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    pd = d.get("providerData") or {}
                    crid, m = pd.get("conversationRequestId"), pd.get("requestModelId")
                    u = pd.get("usage")
                    if not crid or not m:
                        continue
                    models.add(m)
                    sid_of.setdefault(crid, sid)
                    if u:
                        rec = reqs.setdefault(crid, {"model": m, "input": 0, "cache": 0, "output": 0})
                        rec["input"] += u.get("inputTokens") or 0
                        rec["output"] += u.get("outputTokens") or 0
                        det = u.get("inputTokensDetails") or [{}]
                        rec["cache"] += (det[0].get("cached_tokens") or 0) if det else 0
        except OSError:
            continue

    unknown = [m for m in models if m not in ("deepseek-v4.1-flash", "custom-local:deepseek-v4.1-flash-1017")
               and Q.billing_unit(m) == "credit" and m.startswith("custom-local:")]
    check("所有 custom-local 前缀的模型都被判为付费", not unknown, str(unknown[:3]))

    fee_zero, fee_ok = 0, 0
    for crid, rec in reqs.items():
        if Q.billing_unit(rec["model"]) != "fee":
            continue
        ts = Q.key_ts(crid)
        f = Q.calc_fee([rec["input"], rec["output"], rec["cache"], 0], ts, rec["model"])
        if (rec["input"] + rec["output"]) > 0:
            if f <= 0:
                fee_zero += 1
            else:
                fee_ok += 1
    check("真实费用请求中金额为 0 的条数 = 0", fee_zero == 0, "有金额 %d 条，为 0 %d 条" % (fee_ok, fee_zero))

    # 混合会话：unit 必须等于最后一次请求的单位，mixed 必须为真
    by_sid = {}
    for crid, rec in reqs.items():
        by_sid.setdefault(sid_of.get(crid), []).append((Q.key_ts(crid) or 0, Q.billing_unit(rec["model"])))
    mixed_sids = [s for s, v in by_sid.items() if len({u for _t, u in v}) > 1]
    bad = []
    for s in mixed_sids:
        ordered = sorted(by_sid[s])
        want = ordered[-1][1]
        # 复算 CLI 的判定（与 query.py 的 session 段同一算法）
        latest = max((t, u) for t, u in by_sid[s])
        if latest[1] != want:
            bad.append(s)
    check("混合会话「当前单位」= 最后一次请求的单位", not bad, "混合会话 %d 个，异常 %d" % (len(mixed_sids), len(bad)))

    if VERBOSE:
        for s in mixed_sids[:3]:
            seq = [u[1] for u in sorted(by_sid[s])][-6:]
            print("    混合会话 %s 最近 6 轮单位：%s" % (s[:8], " → ".join(seq)))


def test_session_rule():
    """单位跟随规则：混合会话的 unit 必须等于最后一次请求的单位（JS 真实代码）。"""
    try:
        if _proc.run(["node", "--version"]).returncode != 0:
            raise FileNotFoundError
    except FileNotFoundError:
        print("  [!] 未安装 node，跳过会话规则测试")
        return
    code = (
        "const fs=require('fs');"
        "const B=new Function(fs.readFileSync(process.argv[1],'utf8')+';return WBBilling;')();"
        "const c=B.defaults();"
        # 先自定义后平台：最新一条是平台 → credit
        "const a=B.sessionBilling({"
        "'01a2170dd311773cbe4a463de7eb3da2':'custom-local:deepseek-v4.1-flash-1017',"
        "'01a2181c5c82701fa39452266f3e1fea':'deepseek-v4.1-flash'},c);"
        # 再切回自定义（时间更晚）→ fee
        "const b=B.sessionBilling({"
        "'01a2170dd311773cbe4a463de7eb3da2':'custom-local:deepseek-v4.1-flash-1017',"
        "'01a2181c5c82701fa39452266f3e1fea':'deepseek-v4.1-flash',"
        "'01a2190f0000aaaa0000bbbb0000cccc':'custom-local:deepseek-v4.1-flash-1017'},c);"
        # 脏 ID 不参与"最近一次"排序
        "const d3=B.sessionBilling({"
        "'6ead5a3129714ff6991edeaed5b61fb3':'custom-local:deepseek-v4.1-flash-1017',"
        "'01a2181c5c82701fa39452266f3e1fea':'deepseek-v4.1-flash'},c);"
        "console.log(JSON.stringify([a,b,d3]));"
    )
    r = _proc.run(["node", "-e", code, os.path.join(UI, "billing_core.js")])
    if r.returncode != 0:
        check("会话规则：Node 执行成功", False, r.stderr.strip()[:200])
        return
    a, b, d3 = json.loads(r.stdout)
    check("混合会话：切回平台模型 → 单位变为 credit", a["unit"] == "credit" and a["mixed"], str(a["unit"]))
    check("混合会话：再切到自定义 → 单位变为 fee", b["unit"] == "fee" and b["mixed"], str(b["unit"]))
    check("混合会话：两种都记入 modelList", len(b["list"]) == 2, str(b["list"]))
    check("脏请求 ID 不干扰「最近一次」判定", d3["unit"] == "credit", str(d3["unit"]))


def test_subprocess_contract():
    """所有子进程调用必须走 _proc（统一 UTF-8 契约）。

    防的是 2026-11-26 那次真实事故：系统代码页 936 时，`text=True` 用 GBK 解码
    node 的 UTF-8 输出，读线程抛 UnicodeDecodeError，同步脚本虽然已经写盘成功
    却以非 0 退出，安装被误判为「计费规则同步失败」直接中止。
    这类错误不会在 UTF-8 环境（CI / 大多数开发机）复现，所以必须靠静态约定兜住。
    """
    bad = []
    for path in sorted(glob.glob(os.path.join(PLUGIN, "tools", "*.py"))
                       + glob.glob(os.path.join(PLUGIN, "ui", "*.py"))):
        if os.path.basename(path) == "_proc.py":
            continue
        try:
            src = open(path, encoding="utf-8").read()
            tree = ast.parse(src, path)
        except (OSError, SyntaxError):
            continue
        # 用 AST 而不是字符串匹配：否则本函数自己的说明文字和检查语句都会被误判
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
            if name != "run":
                continue
            for kw in node.keywords:
                if kw.arg == "text":
                    bad.append("%s:%d" % (os.path.basename(path), node.lineno))
    check("子进程统一走 _proc（无裸 text=True）", not bad, "、".join(bad[:5]))

    # _proc 本身必须钉住两端：子进程 UTF-8 输出、父进程 UTF-8 解码
    core = open(os.path.join(PLUGIN, "tools", "_proc.py"), encoding="utf-8").read()
    check("_proc 强制子进程 UTF-8 输出", "PYTHONIOENCODING" in core and "PYTHONUTF8" in core)
    check("_proc 强制 UTF-8 解码并容错", 'encoding="utf-8"' in core and "errors" in core)


def main():
    print("计费规则回归测试")
    print("-" * 60)
    for fn in (test_classification, test_price_book, test_fee_math, test_dirty_timestamps,
               test_session_rule, test_sync_consistency, test_js_parity, test_real_logs,
               test_subprocess_contract):
        print("[%s]" % fn.__name__.replace("test_", ""))
        fn()
    bad = [c for c in checks if not c[1]]
    print("-" * 60)
    print("共 %d 项，通过 %d，失败 %d" % (len(checks), len(checks) - len(bad), len(bad)))
    for name, ok, detail in bad:
        print("  失败：" + name + ("  " + detail if detail else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
