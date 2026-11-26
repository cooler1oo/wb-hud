#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 round_meter.js / round_meter.css 合并进 inject.js / inject.css。
幂等：用标记包裹，重复运行会先移除旧块再插入。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(os.path.dirname(HERE), "ui")
JS_MARK = "/* @@ROUND_METER@@ */"
CSS_MARK = "/* @@ROUND_METER_CSS@@ */"

def merge(src_name, dst_name, mark, wrap):
    src = open(os.path.join(UI, src_name), encoding="utf-8").read()
    dst_path = os.path.join(UI, dst_name)
    dst = open(dst_path, encoding="utf-8").read()
    # 移除旧块
    dst = re.sub(re.escape(mark) + r"[\s\S]*?/\* @@END@@ \*/", "", dst)
    block = mark + "\n" + wrap(src) + "\n/* @@END@@ */\n"
    open(dst_path, "w", encoding="utf-8").write(dst.rstrip() + "\n\n" + block)
    print("已合并 %s → %s (%d 字节)" % (src_name, dst_name, len(src)))

merge("round_meter.js", "inject.js", JS_MARK, lambda s: s)
merge("round_meter.css", "inject.css", CSS_MARK, lambda s: s)
