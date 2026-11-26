#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 tools/billing.json（数据真源）与 ui/billing_core.js（逻辑真源）同步到运行时代码。

为什么需要这个脚本（2026-11-26）：
  计费规则原先在三个地方各写一份——tools/query.py、ui/main_addon.js、
  ui/round_meter.js。改一处另外两处不动，就会出现「CLI 说费用、界面说积分」。
  现在规则只有两份真源（billing.json 数据、billing_core.js 逻辑），
  由本脚本把它们烙进 main_addon.js 的标记块；query.py 直接读 billing.json。

  另有一个硬约束：main_addon.js 是被整段字符串追加进 app.asar 里的
  main/index.js 的，不能用 require 引外部模块，所以只能"内联"，不能"引用"。

用法：
    python tools/sync_billing.py           # 同步
    python tools/sync_billing.py --check   # 只校验是否已同步（CI/自检用），不改文件
退出码：0 成功/已同步，1 不一致或数据非法。
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
UI = os.path.join(PLUGIN, "ui")
BILLING_JSON = os.path.join(HERE, "billing.json")
CORE_JS = os.path.join(UI, "billing_core.js")
MAIN_ADDON = os.path.join(UI, "main_addon.js")

JSON_START = "/* @@BILLING_JSON@@ */"
JSON_END = "/* @@END_BILLING_JSON@@ */"
CORE_START = "/* @@BILLING_CORE@@ */"
CORE_END = "/* @@END_BILLING_CORE@@ */"


def fail(msg):
    print("[x] " + msg)
    sys.exit(1)


def load_billing():
    try:
        with open(BILLING_JSON, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception as e:
        fail("billing.json 无法解析：%s: %s" % (type(e).__name__, e))
    # 只校验会直接导致误判的字段：宁可安装前报错，也不要装出一个"看起来有数但是错的"界面
    if not isinstance(d.get("feePrefixes"), list) or not d["feePrefixes"]:
        fail("billing.json 缺少 feePrefixes（计费来源前缀，如 custom-local:）")
    price = d.get("pricing") or {}
    if not isinstance(price.get("default"), dict):
        fail("billing.json 缺少 pricing.default")
    for slot in ("idle", "busy"):
        s = price["default"].get(slot)
        if not isinstance(s, dict) or not {"input", "output", "cacheRead"} <= set(s):
            fail("billing.json pricing.default.%s 需要 input/output/cacheRead" % slot)
    if not isinstance(d.get("idleHours"), list) or len(d["idleHours"]) != 2:
        fail("billing.json idleHours 需要 [起, 止]，如 [22, 8]")
    for k, v in (price.get("models") or {}).items():
        if not isinstance(v, dict):
            fail("billing.json pricing.models.%s 应为对象" % k)
    return d


def replace_block(text, start_mark, end_mark, body, path):
    rx = re.compile(re.escape(start_mark) + r"[\s\S]*?" + re.escape(end_mark))
    if not rx.search(text):
        fail("%s 里找不到标记块：%s … %s" % (os.path.basename(path), start_mark, end_mark))
    new = start_mark + "\n" + body.rstrip() + "\n" + end_mark
    return rx.sub(lambda _m: new, text, count=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    args = ap.parse_args()

    data = load_billing()
    try:
        core = open(CORE_JS, encoding="utf-8").read()
    except OSError as e:
        fail("读不到 %s：%s" % (CORE_JS, e))
    try:
        main_src = open(MAIN_ADDON, encoding="utf-8").read()
    except OSError as e:
        fail("读不到 %s：%s" % (MAIN_ADDON, e))

    # 1) 数据 → billing_core.js 的 JSON 块
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    payload = "\n".join("    " + ln if ln.strip() else ln for ln in payload.splitlines())
    core_new = replace_block(core, JSON_START, JSON_END, payload, CORE_JS)

    # 2) billing_core.js 全文 → main_addon.js 的块
    #    缩进对齐 main_addon 的风格（4 空格），只是可读性，不影响语义
    inlined = "\n".join(("    " + ln if ln.strip() else ln) for ln in core_new.splitlines())
    main_new = replace_block(main_src, CORE_START, CORE_END, inlined, MAIN_ADDON)

    changed_core = core_new != core
    changed_main = main_new != main_src
    if args.check:
        if changed_core or changed_main:
            print("[x] 不同步：billing_core.js=%s main_addon.js=%s（运行 python tools/sync_billing.py）"
                  % ("需更新" if changed_core else "已最新", "需更新" if changed_main else "已最新"))
            sys.exit(1)
        print("[ok] 计费规则已同步（feePrefixes=%s，%d 条按模型价）"
              % (",".join(data["feePrefixes"]), len(data.get("pricing", {}).get("models") or {})))
        return

    if changed_core:
        open(CORE_JS, "w", encoding="utf-8", newline="\n").write(core_new)
    if changed_main:
        open(MAIN_ADDON, "w", encoding="utf-8", newline="\n").write(main_new)
    print("[ok] 已同步：billing.json → billing_core.js（%s）→ main_addon.js（%s）"
          % ("已更新" if changed_core else "无变化", "已更新" if changed_main else "无变化"))

    # 3) 用 Node 跑一次真实分类，确认内联后的逻辑真的能加载（语法错/对象写坏会立刻暴露）
    try:
        r = subprocess.run(
            ["node", "-e",
             "const fs=require('fs');const src=fs.readFileSync(process.argv[1],'utf8');"
             "const B=new Function(src+';return WBBilling;')();"
             "const c=B.defaults();"
             "const cases=[['custom-local:deepseek-v4.1-flash-1017','fee'],"
             "['deepseek-v4.1-flash','credit'],['custom-local:glm-5.3-flash','fee'],"
             "['glm-5.3-flash','credit']];"
             "for(const [m,want] of cases){const got=B.unitOf(m,c);"
             "if(got!==want){console.error('分类错误 '+m+' => '+got+' 期望 '+want);process.exit(1);}}"
             "console.log('[ok] Node 加载校验通过：'+cases.length+' 个分类用例全部正确');",
             CORE_JS],
            capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            fail("Node 校验失败（billing_core.js 语法或规则有问题）")
    except FileNotFoundError:
        print("[!] 未找到 node，跳过运行时校验（不影响安装）")


if __name__ == "__main__":
    main()
