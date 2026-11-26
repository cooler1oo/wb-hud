# -*- coding: utf-8 -*-
"""统一的子进程调用：子进程一律 UTF-8 输出，父进程一律 UTF-8 解码。

为什么必须有这个模块（2026-11-26 实测复现）：
  Windows 系统代码页是 936（GBK）时，`subprocess.run(text=True)` 会用 GBK 解码
  子进程输出。但 node 永远输出 UTF-8，install.cmd 又先执行了 chcp 65001，
  于是中文报错信息在 `_readerthread` 里炸掉：

      UnicodeDecodeError: 'gbk' codec can't decode byte 0x9a in position 30
      Exception in thread Thread-1 (_readerthread)

  后果不是"显示乱码"这么轻：读线程死掉后子进程被判定为失败——
  同步脚本明明打印了 [ok] 并成功写盘，安装却报"同步失败"并中止。

  反方向同样有坑：父进程按 UTF-8 解码时，子进程若按 GBK 输出也会崩。
  所以这里把契约钉死，两边都确定，不再看运行环境：
    · 子进程：PYTHONUTF8=1 + PYTHONIOENCODING=utf-8（对 node / git 无副作用）
    · 父进程：encoding="utf-8", errors="replace"（脏字节不炸线程）
"""
import os
import subprocess

# 子进程环境：强制 Python 子进程用 UTF-8 输出。node 本来就输出 UTF-8，加了也无害。
CHILD_ENV = dict(os.environ)
CHILD_ENV["PYTHONUTF8"] = "1"
CHILD_ENV["PYTHONIOENCODING"] = "utf-8"


def run(cmd, **kw):
    """subprocess.run 的替代品：默认捕获输出并按 UTF-8 解码。"""
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    kw.setdefault("env", CHILD_ENV)
    return subprocess.run(cmd, **kw)


def run_text(cmd, **kw):
    """返回 (退出码, stdout, stderr)，省得每个调用点都写一遍 or ''。"""
    r = run(cmd, **kw)
    return r.returncode, r.stdout or "", r.stderr or ""
