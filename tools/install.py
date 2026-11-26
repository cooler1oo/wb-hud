#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""安装工作台 UI：关客户端 -> 备份 -> 内联 UI 并同步哈希 -> 启动 -> 等窗口；失败自动还原。"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ui"))
sys.path.insert(0, HERE)
import patch
import _proc

EXE = patch.EXE
LOG = os.path.join(HERE, "install.log")
LOG_MAX_LINES = 500


def log(msg):
    """同时写文件与 stdout；pythonw 下 stdout 可能为 None，不能让它崩。"""
    line = "[" + time.strftime("%H:%M:%S") + "] " + str(msg)
    try:
        print(line)
    except Exception:
        pass
    try:
        rotate_log()
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def rotate_log():
    """日志超过上限就只保留尾部，避免 install.log 无限增长。"""
    if not os.path.exists(LOG):
        return
    try:
        with open(LOG, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        if len(lines) <= LOG_MAX_LINES:
            return
        with open(LOG, "w", encoding="utf-8") as f:
            f.writelines(lines[-LOG_MAX_LINES:])
    except Exception:
        pass


def pids():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WorkBuddy.exe", "/NH", "/FO", "CSV"],
                         capture_output=True).stdout.decode("mbcs", "ignore")
    return [ln for ln in out.splitlines() if "WorkBuddy.exe" in ln]


def kill():
    """关闭客户端。

    刻意 **不加 /T**（不连带杀子进程树）：
      · /T 会按父子关系递归杀掉整棵子树，而本次运行的 agent 进程
        （sandbox-cli.exe）正是 WorkBuddy.exe 的后代——加了 /T 会把
        执行者自己一起杀掉，补丁只打一半，客户端处于损坏状态。
      · 不加 /T 时，只按镜像名杀掉全部 WorkBuddy.exe 实例（主进程 +
        渲染/GPU 进程都是同名），文件句柄随之释放，足够让 asar 与 exe
        被覆盖。

    配合 spawn_detached() 里的 CREATE_BREAKAWAY_FROM_JOB，安装脚本本身
    也能从应用的作业对象里独立出来，双重保险。
    """
    subprocess.run(["taskkill", "/IM", "WorkBuddy.exe", "/F"], capture_output=True)
    for _ in range(40):
        if not pids():
            return
        time.sleep(0.5)


def has_window():
    import ctypes
    import ctypes.wintypes as wt
    u = ctypes.windll.user32
    found = []
    ps = set()
    for line in pids():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            ps.add(int(parts[1]))

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(h, _):
        if u.IsWindowVisible(h) and u.GetWindowTextLengthW(h) > 0:
            pid = wt.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(pid))
            if pid.value in ps:
                found.append(h)
        return True

    u.EnumWindows(cb, 0)
    return bool(found)


def spawn_detached(argv=None):
    """派生一个脱离本进程树的安装进程，然后本进程立刻退出（仅 --detach 时使用）。

    说明：本机实测该方式不可靠——派生出的进程会随发起它的作业一起被回收，
    因此默认不使用。只有在明确需要「安装脚本独立于当前会话」时才用。

    返回 True 表示已成功派生。
    """
    if argv is None:
        argv = sys.argv[1:]
    env = dict(os.environ)
    env["WB_INSTALL_DETACHED"] = "1"
    flags = (subprocess.DETACHED_PROCESS
             | subprocess.CREATE_NEW_PROCESS_GROUP
             | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__)] + list(argv),
            env=env,
            creationflags=flags,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        return True
    except Exception as e:
        log("派生后台安装进程失败：%s" % e)
        return False


def sync_rules(log):
    """同步计费规则。返回 True 表示可以继续安装。

    这一步只读、不改客户端，所以放最前面：失败时客户端还活着，不会被关掉。
    子进程调用走 _proc（强制 UTF-8），否则 GBK 代码页下会把 node 的 UTF-8
    输出解码失败，让"已经成功"的同步被判成失败——2026-11-26 实际踩过。
    """
    try:
        rc, out, err = _proc.run_text(
            [sys.executable, os.path.join(HERE, "sync_billing.py")], timeout=90)
    except Exception as e:
        log("[!] 计费规则同步异常：%s，中止安装（客户端未改动）" % e)
        return False
    for ln in out.splitlines():
        if ln.strip():
            log("      " + ln.strip())
    if rc != 0:
        log("[!] 计费规则同步失败（退出码 %s），中止安装（客户端未改动）" % rc)
        for ln in err.splitlines()[:12]:
            if ln.strip():
                log("      " + ln.strip())
        return False
    return True


def main():
    # 2026-11-21 修正：不再自动派生脱离进程。
    # 原先派生后台进程，是因为 kill() 用了 /T（连带杀整棵子树）。现在 kill()
    # 只按镜像名杀 WorkBuddy.exe，而 agent 进程是 sandbox-cli.exe（不同镜像名），
    # 因此在进程内直接安装是安全的。
    # 反过来，自动派生的后台进程反而不可靠：它会随发起它的作业一起被回收
    # （实测两次都在倒计时期间被终止，日志停在「等待 N 秒」那一行）。
    # 如需脱离本进程树，用 --detach 显式指定。

    if "--detach" in sys.argv:
        log("派生后台安装进程（--detach）…")
        argv = [a for a in sys.argv if a != "--detach"]
        if spawn_detached(argv):
            log("已派生，本进程退出")
            return
        log("派生失败，回退为同进程安装")

    delay = 0
    if "--delay" in sys.argv:
        try:
            delay = int(sys.argv[sys.argv.index("--delay") + 1])
        except Exception:
            delay = 0
    if delay:
        log("等待 %d 秒后开始（让当前窗口把消息发完）…" % delay)
        time.sleep(delay)
    log("[1/5] 同步计费规则并关闭客户端")
    if not sync_rules(log):
        return
    kill()
    try:
        log("[2/5] 备份 exe 与 asar")
        reason = patch.backup()
        # 按真实原因写日志：之前用布尔值一律写成"检测到客户端升级过"，
        # 而 2026-11-26 实际是"备份丢失、从已注入的 asar 反推重建"，日志与事实不符。
        if reason == "upgraded":
            log("      备份已刷新（检测到客户端升级过）")
        elif reason == "derived":
            log("      备份缺失，已从当前 asar 反推重建干净版（移除三处注入）")
        elif reason == "copied":
            log("      备份缺失，当前 asar 本就干净，已直接复制为备份")
        else:
            log("      备份有效，无需刷新")
        log("[3/5] 生成补丁并同步 exe 哈希")
        h, report, cnt = patch.install()
        for p, o, n in report:
            log("      %-24s %8d -> %d" % (p, o, n))
        log("      header sha256 %s  替换 %d 处" % (h[:16], cnt))
        ok, detail = patch.verify()
        log("      校验：%s（%s）" % ("通过" if ok else "不通过", detail))
        if not ok:
            raise RuntimeError("补丁校验不通过：" + detail)
    except Exception as e:
        log("[!] 安装失败：%s" % e)
        log("    自动还原并重启原版")
        kill()
        patch.restore()
        subprocess.Popen([EXE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    log("[4/5] 启动并等待窗口（25 秒）")
    subprocess.Popen([EXE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    while time.time() - t0 < 25:
        if has_window():
            log("      窗口已出现（%.0fs）" % (time.time() - t0))
            log("[5/5] 完成")
            return
        time.sleep(0.6)
    log("[5/5] 未出现窗口，自动还原")
    kill()
    patch.restore()
    subprocess.Popen([EXE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("      已还原并重启原版")


if __name__ == "__main__":
    main()
