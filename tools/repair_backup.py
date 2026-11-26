#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重建安装所需的「干净备份」（asar + 配套 exe）。

背景：install 需要一份干净的 app.asar 作为基底（从它出发注入，才不会把旧 UI
当成新版打回去）。但备份会因为客户端升级、用户清理、换机器而消失。此时若
当前 asar 已注入，旧实现直接拒绝安装——插件从此不能升级。

本脚本的行为：
  默认（dry-run）：只读当前 asar，反推一份干净版到临时文件，校验三处注入都被
                   移除、文件结构可读，然后删掉临时文件。不动客户端。
  --apply       ：把反推结果写成正式备份（app.asar.wbbackup）+ 一份哈希对齐的
                   exe 备份。写入前会 reload 校验；失败不留半成品。

用法：
    python tools/repair_backup.py            # 看看能不能修（只读）
    python tools/repair_backup.py --apply    # 真正重建备份
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ui"))
import patch  # noqa: E402


def main():
    apply = "--apply" in sys.argv
    print("客户端目录：%s" % os.path.dirname(patch.ASAR))
    if not os.path.exists(patch.ASAR):
        print("[x] 找不到 %s" % patch.ASAR)
        return 1
    print("当前 asar：%.1f MB，已注入=%s" % (os.path.getsize(patch.ASAR) / 1048576.0,
                                          patch.is_patched(patch.ASAR)))
    print("备份现状：asar=%s exe=%s" % (os.path.exists(patch.ASAR_BAK),
                                     os.path.exists(patch.EXE_BAK)))

    if os.path.exists(patch.ASAR_BAK) and not patch.is_patched(patch.ASAR_BAK):
        print("[ok] 已有干净备份，无需重建。")
        return 0
    if not patch.is_patched(patch.ASAR):
        print("[!] 当前 asar 是干净的，直接复制即可成为备份。")
        if apply:
            shutil.copy2(patch.ASAR, patch.ASAR_BAK)
            shutil.copy2(patch.EXE, patch.EXE_BAK)
            patch._write_stamp(patch.ASAR_BAK + ".stamp", patch.fingerprint(patch.ASAR_BAK))
            print("[ok] 已写入备份。")
        return 0

    ok, want, old, cnt = patch.check(patch.EXE, patch.ASAR)
    if not ok:
        print("[x] exe 记录的哈希与 asar 不一致（want=%s exe=%s），客户端已损坏，先修复客户端。"
              % (want[:12], old[:12]))
        return 1

    # 先试跑一遍，确认反推可行（绝大多数问题在这一步就能暴露）
    tmp = os.path.join(tempfile.gettempdir(), "wb-hud-clean-dryrun.asar")
    try:
        found, report = patch.strip_asar(patch.ASAR, tmp)
        print("[ok] 反推成功，移除注入：%s" % "、".join(found))
        for k, v in report.items():
            print("     %-22s %9d → %d" % (k, v[0], v[1]))
        print("     干净版大小：%.1f MB" % (os.path.getsize(tmp) / 1048576.0))
        print("     反推后仍已注入：%s" % patch.is_patched(tmp))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    if not apply:
        print("\n[dry-run] 未写入任何文件。确认无误后加 --apply 执行。")
        return 0

    found, report = patch.derive_backup()
    ok2, want2, old2, _ = patch.check(patch.EXE_BAK, patch.ASAR_BAK)
    if not ok2:
        print("[x] 备份校验失败：want=%s exe=%s" % (want2[:12], old2[:12]))
        return 1
    print("[ok] 已重建备份并通过哈希校验：%s" % patch.ASAR_BAK)
    return 0


if __name__ == "__main__":
    sys.exit(main())
