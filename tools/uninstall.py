#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""还原：关客户端 -> 用备份覆盖 exe 与 asar -> 启动。"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ui"))
import patch


def kill():
    subprocess.run(["taskkill", "/IM", "WorkBuddy.exe", "/T", "/F"], capture_output=True)
    for _ in range(20):
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WorkBuddy.exe", "/NH"],
                             capture_output=True).stdout.decode("mbcs", "ignore")
        if "WorkBuddy.exe" not in out:
            return
        time.sleep(0.5)


def main():
    print("[1/3] 关闭客户端")
    kill()
    print("[2/3] 还原 exe 与 asar")
    patch.restore()
    print("[3/3] 启动原版")
    subprocess.Popen([patch.EXE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("完成")


if __name__ == "__main__":
    main()
