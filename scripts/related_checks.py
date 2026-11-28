#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PR 快检查（时候 ②）：按这次改了哪些文件，只跑相关的检查。

为什么不用模板里的 related_tests.py：
  那个脚本是按 Python 的 import 关系把改动映射到 pytest 用例的。本仓库没有
  pytest 用例——只有一套不依赖 pytest 的回归脚本 tools/test_billing.py（31 项，
  需要读本机会话日志的那几项在没有日志时会自动跳过）。所以这里改成按目录规则
  决定跑什么，判断依据同样是「改动影响面」，不是「全量重跑」。

用法：
    python scripts/related_checks.py "origin/main"   # CI 里传 PR 的 base 分支
    python scripts/related_checks.py                  # 本地：默认对比 origin/main
退出码 0 = 全过；非 0 = 有检查失败（CI 直接红）。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import _proc  # noqa: E402  （统一 UTF-8 子进程契约，见 tools/_proc.py）

# 这些文件一动，计费口径就可能漂移，必须跑 31 项回归
BILLING_FILES = {
    "tools/billing.json",
    "tools/query.py",
    "tools/sync_billing.py",
    "tools/test_billing.py",
    "ui/billing_core.js",
    "ui/main_addon.js",
}
# 这些文件一动，说明 CI 自身可能有问题，按全量跑
CI_FILES = (".github/", "scripts/", "pyproject.toml", ".pre-commit-config.yaml")


def sh(cmd):
    """跑一条命令，失败立即返回 False 并打印原文（不吞错误）。"""
    print("[run] " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        print("[x] 失败：%s（退出码 %d）" % (" ".join(cmd), r.returncode), flush=True)
        return False
    return True


def changed_files(base):
    for ref in (base, "origin/HEAD", "HEAD~1"):
        if not ref:
            continue
        r = _proc.run(["git", "diff", "--name-only", "%s...HEAD" % ref], cwd=ROOT)
        if r.returncode == 0:
            files = [ln.strip().replace("\\", "/") for ln in r.stdout.splitlines() if ln.strip()]
            print("[info] 基线 %s，改动 %d 个文件" % (ref, len(files)), flush=True)
            return files
    print("[!] 算不出改动范围（浅克隆或没有基线），按全量跑", flush=True)
    return None


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    files = changed_files(base)
    if files is None:
        files = []          # 全量分支：下面用 full=True 触发
        full = True
    else:
        full = False

    ok = True
    # ① 计费规则必须与内联代码同步。这条永远跑：它防的是"改了 billing.json
    #    却忘了 sync，界面还按旧规则算钱"——本仓库就是为这类静默错误而改造的。
    ok &= sh([sys.executable, "tools/sync_billing.py", "--check"])

    if full or any(f.startswith(CI_FILES) for f in files):
        print("[info] 改动涉及 CI 或全量模式 → 跑全部检查", flush=True)
        ok &= sh([sys.executable, "-m", "py_compile"] + sorted(
            os.path.join("tools", f) for f in os.listdir(os.path.join(ROOT, "tools")) if f.endswith(".py"))
            + [os.path.join("ui", "patch.py")])
        for f in sorted(os.listdir(os.path.join(ROOT, "ui"))):
            if f.endswith(".js"):
                ok &= sh(["node", "--check", os.path.join("ui", f)])
        ok &= sh(["node", os.path.join("scripts", "test_hist_scan.js")])
        ok &= sh([sys.executable, os.path.join("tools", "test_billing.py")])
        return 0 if ok else 1

    js = [f for f in files if f.startswith("ui/") and f.endswith(".js")]
    py = [f for f in files if f.endswith(".py")]
    need_billing = any(f in BILLING_FILES for f in files)

    if not (js or py or need_billing):
        print("[ok] 只改了文档/配置，不需要跑测试", flush=True)
        return 0 if ok else 1

    for f in py:
        ok &= sh([sys.executable, "-m", "py_compile", f])
    for f in js:
        ok &= sh(["node", "--check", f])
    if need_billing:
        ok &= sh([sys.executable, os.path.join("tools", "test_billing.py")])
    # 主进程的扫描逻辑改了就必跑它的单测（子代理汇总/截断重建都在里面）
    if "ui/main_addon.js" in files or "scripts/test_hist_scan.js" in files:
        ok &= sh(["node", os.path.join("scripts", "test_hist_scan.js")])

    print("[ok] 相关检查完成" if ok else "[x] 有检查未通过", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
