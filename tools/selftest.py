#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工作台自检：一条命令看清"能不能用"。

只读：不打补丁、不改客户端、不写数据库。退出码 0 = 全过，1 = 有失败项。

用法：
    python tools/selftest.py            # 人读格式
    python tools/selftest.py --json     # 机器可读
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _proc  # noqa: E402
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PLUGIN, "ui"))
try:
    import patch  # noqa: E402
except Exception as _e:  # pragma: no cover
    patch = None

PY = sys.executable
checks = []


def add(name, ok, detail, level="error"):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail), "level": level})
    return ok


def check_manifest():
    p = os.path.join(PLUGIN, ".codebuddy-plugin", "plugin.json")
    try:
        d = json.load(open(p, encoding="utf-8"))
        sk = d.get("skills") or []
        miss = [s for s in sk if not os.path.isdir(os.path.join(PLUGIN, s))]
        add("插件清单可解析", True, "%s v%s，声明 %d 个技能" % (d.get("name"), d.get("version"), len(sk)))
        add("清单声明的技能目录都存在", not miss, "缺失：%s" % miss if miss else "全部存在")
    except Exception as e:
        add("插件清单可解析", False, "%s: %s" % (type(e).__name__, e))


def check_assets():
    need = ["ui/inject.js", "ui/inject.css", "ui/main_addon.js", "ui/preload_addon.js",
            "ui/patch.py", "ui/billing_core.js", "tools/billing.json",
            "tools/query.py", "tools/install.py", "tools/uninstall.py",
            "tools/_proc.py",
            "tools/sync_billing.py", "tools/test_billing.py", "tools/repair_backup.py"]
    miss = [n for n in need if not os.path.isfile(os.path.join(PLUGIN, n))]
    add("运行所需文件齐全", not miss, "缺失：%s" % miss if miss else "%d 个文件齐全" % len(need))
    junk = []
    for r, d, fs in os.walk(PLUGIN):
        if "__pycache__" in r:
            junk.append(os.path.relpath(r, PLUGIN))
    add("无 __pycache__ 残留", not junk, "存在：%s" % junk if junk else "干净", level="warn")


def check_db():
    db = os.path.join(os.path.expanduser("~"), ".workbuddy", "workbuddy.db")
    if not os.path.isfile(db):
        add("数据库存在", False, "缺少 %s" % db)
        return
    try:
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=3)
        n = con.execute("select count(*) from session_usage").fetchone()[0]
        con.close()
        add("数据库可读且有数据", n > 0, "session_usage 共 %d 行" % n)
    except Exception as e:
        add("数据库可读且有数据", False, "%s: %s" % (type(e).__name__, e))


def check_query():
    try:
        r = _proc.run([PY, os.path.join(HERE, "query.py")], timeout=30)
        d = json.loads(r.stdout)
        if d.get("error"):
            add("query.py 可运行", False, d["error"])
            return
        need = ["session", "today", "total", "days", "sessions", "git"]
        miss = [k for k in need if k not in d]
        add("query.py 可运行", not miss, "输出缺字段：%s" % miss if miss else
            "会话 %s / 上下文 %s%% / 积分 %s" % (str(d["session"]["id"])[:8],
                                          d["session"].get("percent"), d["session"]["credit"]))
        add("total 覆盖全表", d.get("counts", {}).get("aggregated") == d.get("counts", {}).get("sessions"),
            "聚合 %s / 会话 %s" % (d.get("counts", {}).get("aggregated"), d.get("counts", {}).get("sessions")))
    except Exception as e:
        add("query.py 可运行", False, "%s: %s" % (type(e).__name__, e))


def check_patch():
    if patch is None:
        add("客户端补丁状态", False, "无法导入 patch 模块")
        return
    try:
        ok, detail = patch.verify()
        add("客户端补丁状态一致", ok, detail)
    except Exception as e:
        add("客户端补丁状态一致", False, "%s: %s" % (type(e).__name__, e))
    try:
        add("客户端可执行文件存在", os.path.isfile(patch.EXE), patch.EXE)
        has_bak = os.path.isfile(patch.ASAR_BAK) and os.path.isfile(patch.EXE_BAK)
        if has_bak:
            add("原始备份存在", True, "asar/exe 备份都在")
        elif os.path.isfile(patch.ASAR) and patch.is_patched(patch.ASAR):
            # 备份缺失但当前 asar 已注入：不是死局。注入是纯插入，可按标记反推。
            # 安装时会自动重建（patch.derive_backup），这里给 warn + 明确入口。
            derived = os.path.isfile(patch.ASAR_BAK + ".derived")
            add("原始备份存在", False,
                "备份缺失，但当前 asar 已注入，安装时会自动反推重建"
                + ("（曾反推于 backup.derived）" if derived else "")
                + "；也可先运行 python tools/repair_backup.py --apply", level="warn")
        else:
            add("原始备份存在", False, "备份缺失且当前 asar 未注入，首次安装会直接复制当前版本作为备份")
    except Exception as e:
        add("客户端可执行文件存在", False, str(e))


def check_billing():
    """计费规则必须保持单一真源：billing.json / billing_core.js / main_addon.js 三者同步。
    漂移的后果不是报错，而是"界面说积分、CLI 说费用"这类静默错误。"""
    p = os.path.join(HERE, "sync_billing.py")
    try:
        r = _proc.run([PY, p, "--check"], timeout=60)
        add("计费规则已同步", r.returncode == 0,
            (r.stdout or r.stderr).strip().splitlines()[-1][:120] if (r.stdout or r.stderr) else "")
    except Exception as e:
        add("计费规则已同步", False, "%s: %s" % (type(e).__name__, e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    check_manifest()
    check_assets()
    check_db()
    check_query()
    check_billing()
    check_patch()

    errs = [c for c in checks if not c["ok"] and c["level"] == "error"]
    warns = [c for c in checks if not c["ok"] and c["level"] == "warn"]
    if args.json:
        print(json.dumps({"checks": checks, "errors": len(errs), "warnings": len(warns)},
                         ensure_ascii=False, indent=1))
    else:
        print("工作台自检")
        for c in checks:
            mark = "PASS" if c["ok"] else ("WARN" if c["level"] == "warn" else "FAIL")
            print("  [%s] %-22s %s" % (mark, c["name"], c["detail"]))
        print("\n失败 %d 项，警告 %d 项" % (len(errs), len(warns)))
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
