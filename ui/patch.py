#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把工作台内联进 app.asar，并同步 exe 里的 header 哈希。

注入三处：
  renderer/index.html  ← 插入 <style> + <script>
  main/index.js        ← 追加 IPC 处理器（读 session_usage / git）
  preload/index.js     ← 追加 contextBridge 暴露

事实依据（均对原始文件验证过）：
  · asar = 16B 头 + header JSON + 数据区；offset 相对数据区起点
  · 每个文件条目带 integrity{hash=sha256(整文件), blockSize=4MiB, blocks=每块 hash}
  · WorkBuddy.exe 资源段里有明文清单，锁的是 header JSON 的 sha256，同一值出现两处
"""
import os
import re
import json
import struct
import shutil
import hashlib

APP = r"D:\workbuddy"
RES = os.path.join(APP, "resources")
ASAR = os.path.join(RES, "app.asar")
EXE = os.path.join(APP, "WorkBuddy.exe")
ASAR_BAK = os.path.join(RES, "app.asar.wbbackup")
EXE_BAK = EXE + ".wbbackup"

BLOCK = 4194304
MARK_HTML = "<!-- wb-workbench -->"
MARK_ADDON = "// __wb_workbench_addon__"
HASH_RX = re.compile(rb'"resources\\\\app\.asar"[^}]*?"value":"([0-9a-fA-F]{64})"')

HERE = os.path.dirname(os.path.abspath(__file__))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def integ(data):
    h = sha(data)
    blocks = [h] if not data else [sha(data[i:i + BLOCK]) for i in range(0, len(data), BLOCK)]
    return {"algorithm": "SHA256", "hash": h, "blockSize": BLOCK, "blocks": blocks}


def read_asar(path):
    with open(path, "rb") as f:
        w = struct.unpack("<IIII", f.read(16))
        f.seek(16)
        raw = f.read(w[3])
    return w, raw, json.loads(raw.decode("utf-8")), 16 + w[3]


def leaves(node, path=""):
    for k, v in node.get("files", {}).items():
        p = path + "/" + k
        if "files" in v:
            yield from leaves(v, p)
        else:
            yield p, v


def _entry(hdr, parts):
    cur = hdr
    for k in parts[:-1]:
        cur = cur["files"][k]
    cur["files"].setdefault(parts[-1], {})
    return cur["files"][parts[-1]]


def _read(src, base, entry):
    with open(src, "rb") as f:
        f.seek(base + int(entry["offset"]))
        return f.read(entry["size"])


def _write_asar(src, dst, jobs):
    """把 jobs=[(parts, data)] 这些条目替换后重写成 dst，返回新 header 的 sha256。"""
    w, raw, hdr, base = read_asar(src)
    data_len = os.path.getsize(src) - base
    h2 = json.loads(json.dumps(hdr))
    cursor = data_len
    placed = []
    for parts, data in jobs:
        pad = (4 - cursor % 4) % 4
        cursor += pad
        ent = _entry(h2, parts)
        ent["size"] = len(data)
        ent["offset"] = str(cursor)
        ent["integrity"] = integ(data)
        placed.append((cursor, data))
        cursor += len(data)

    j = json.dumps(h2, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)

    with open(dst, "wb") as out:
        out.write(struct.pack("<IIII", 4, len(j) + 8, len(j) + 4, len(j)))
        out.write(j)
        with open(src, "rb") as f:
            f.seek(base)
            left = data_len
            while left > 0:
                c = f.read(min(16 << 20, left))
                if not c:
                    break
                out.write(c)
                left -= len(c)
        written = data_len
        for off, data in placed:
            if off > written:
                out.write(b"\0" * (off - written))
                written = off
            out.write(data)
            written += len(data)
    return sha(j)


def build(src, dst):
    """生成打了工作台的版本。返回 (新 header sha256, [(路径, 旧大小, 新大小)])。"""
    css = open(os.path.join(HERE, "inject.css"), "rb").read()
    js = open(os.path.join(HERE, "inject.js"), "rb").read()
    main_add = open(os.path.join(HERE, "main_addon.js"), "rb").read()
    pre_add = open(os.path.join(HERE, "preload_addon.js"), "rb").read()

    w, raw, hdr, base = read_asar(src)
    L = dict(leaves(hdr))

    jobs = []
    report = []

    e = L["/renderer/index.html"]
    html = _read(src, base, e)
    old_html = len(html)
    if MARK_HTML.encode() not in html:
        pos = html.rfind(b"</body>")
        if pos < 0:
            raise ValueError("index.html 里没有 </body>")
        frag = (b"\n" + MARK_HTML.encode() + b"\n<style>\n" + css + b"\n</style>\n"
                b"<script>\n" + js + b"\n</script>\n")
        html = html[:pos] + frag + html[pos:]
    jobs.append((["renderer", "index.html"], html))
    report.append(("renderer/index.html", old_html, len(html)))

    for parts, addon in ((["main", "index.js"], main_add),
                         (["preload", "index.js"], pre_add)):
        ent = L.get("/" + "/".join(parts))
        if not ent:
            raise ValueError("asar 里找不到 %s" % "/".join(parts))
        body = _read(src, base, ent)
        old = len(body)
        if MARK_ADDON.encode() not in body:
            body = body + b"\n" + MARK_ADDON.encode() + b"\n" + addon
        jobs.append((parts, body))
        report.append(("/".join(parts), old, len(body)))

    return _write_asar(src, dst, jobs), report


def strip_asar(src, dst):
    """从「已注入」的 asar 反推出干净版，写到 dst。

    为什么需要它（2026-11-26）：backup() 原先要求「有干净备份才能安装」。
    备份一旦丢失（客户端升级、用户清理、迁移机器都会导致），即使当前 asar
    完好也无法重装——插件从此不能再升级。而注入本身是**纯插入/纯追加**：
    html 在 </body> 前插入固定块，main/preload 在末尾追加固定标记块。
    因此按标记精确移除即可逐字节还原，不需要原始文件。

    返回 (找到了哪些注入, {路径: (旧大小, 新大小)})。找不到任何标记时抛错——
    宁可拒绝，也不要把一个来路不明的 asar 当成"干净备份"。
    """
    w, raw, hdr, base = read_asar(src)
    L = dict(leaves(hdr))
    jobs, report, found = [], {}, []

    e = L["/renderer/index.html"]
    html = _read(src, base, e)
    mk = MARK_HTML.encode()
    if mk in html:
        i = html.find(mk)
        if i > 0 and html[i - 1:i] == b"\n":
            i -= 1
        jpos = html.find(b"</body>", i)
        if jpos < 0:
            raise ValueError("注入块之后找不到 </body>，拒绝猜测")
        html = html[:i] + html[jpos:]
        found.append("renderer/index.html")
        report["renderer/index.html"] = (len(_read(src, base, e)), len(html))
    jobs.append((["renderer", "index.html"], html))

    for parts in (["main", "index.js"], ["preload", "index.js"]):
        ent = L.get("/" + "/".join(parts))
        if not ent:
            raise ValueError("asar 里找不到 %s" % "/".join(parts))
        body = _read(src, base, ent)
        mk2 = MARK_ADDON.encode()
        if mk2 in body:
            i = body.rfind(mk2)
            if i <= 0:
                raise ValueError("%s 里标记在文件开头，结构异常" % "/".join(parts))
            if body[i - 1:i] == b"\n":
                i -= 1
            report["/".join(parts)] = (len(body), i)
            body = body[:i]
            found.append("/".join(parts))
        jobs.append((parts, body))

    if not found:
        raise ValueError("当前 asar 里没有任何工作台注入标记，不是「已注入」状态")

    _write_asar(src, dst, jobs)

    # 复核：反推结果里必须一个标记都不剩，否则宁可报错也不要产出"半干净"的备份
    w2, raw2, hdr2, base2 = read_asar(dst)
    L2 = dict(leaves(hdr2))
    if MARK_HTML.encode() in _read(dst, base2, L2["/renderer/index.html"]):
        raise ValueError("反推后 html 里仍有注入标记")
    for parts in (["main", "index.js"], ["preload", "index.js"]):
        if MARK_ADDON.encode() in _read(dst, base2, L2["/" + "/".join(parts)]):
            raise ValueError("反推后 %s 里仍有注入标记" % "/".join(parts))
    return found, report


def header_sha(path):
    """asar 头 JSON 的 sha256 —— 就是 exe 里记录的那个值。"""
    w, raw, hdr, base = read_asar(path)
    return sha(raw)


def derive_backup():
    """备份丢失但当前 asar 已注入时，反推一份干净备份 + 配套 exe 备份。

    为什么 exe 备份可以"造"出来：restore()/verify() 需要的不是某个特定的
    原始 exe 文件，而是「exe 内记录的哈希 == 备份 asar 头哈希」这一对关系。
    所以把当前 exe 复制一份、把哈希换成反推 asar 的哈希，功能上等价于原版。
    """
    ok, want, old, _cnt = check(EXE, ASAR)
    if not ok:
        raise RuntimeError(
            "当前 exe 记录的 asar 哈希与实际 asar 不一致（want=%s exe=%s），"
            "说明客户端已处于损坏状态，无法反推备份。请用安装包修复后再试。"
            % (want[:12], old[:12]))

    tmp = ASAR_BAK + ".derive.tmp"
    try:
        found, report = strip_asar(ASAR, tmp)
        if os.path.getsize(tmp) < os.path.getsize(ASAR) * 0.5:
            raise RuntimeError("反推结果大小异常（%d 字节），拒绝当作备份"
                               % os.path.getsize(tmp))
        shutil.move(tmp, ASAR_BAK)

        new_hash = header_sha(ASAR_BAK)
        shutil.copy2(EXE, EXE_BAK)
        swap_exe_hash(EXE_BAK, old, new_hash)

        ok2, want2, old2, _ = check(EXE_BAK, ASAR_BAK)
        if not ok2:
            raise RuntimeError("反推的备份对不齐（want=%s exe=%s）" % (want2[:12], old2[:12]))

        _write_stamp(ASAR_BAK + ".stamp", fingerprint(ASAR_BAK))
        try:
            with open(ASAR_BAK + ".derived", "w", encoding="utf-8") as fh:
                fh.write("derived %s from patched asar; removed: %s\n"
                         % (time_str(), ",".join(found)))
        except Exception:
            pass
        return found, report
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def time_str():
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S")


def old_hash_of_exe(exe_path):
    raw = open(exe_path, "rb").read()
    hits = HASH_RX.findall(raw)
    uniq = {h.decode().lower() for h in hits}
    if len(uniq) != 1:
        raise ValueError("exe 里 app.asar 的哈希不唯一或找不到：%s" % uniq)
    return uniq.pop(), len(hits)


def swap_exe_hash(exe_path, old, new):
    raw = open(exe_path, "rb").read()
    n = raw.count(old.encode())
    if n == 0:
        raise ValueError("exe 里找不到旧哈希")
    raw = raw.replace(old.encode(), new.encode())
    open(exe_path, "wb").write(raw)
    return n


def check(exe_path, asar_path):
    w, raw, hdr, base = read_asar(asar_path)
    want = sha(raw)
    old, cnt = old_hash_of_exe(exe_path)
    return want == old, want, old, cnt


def is_patched(path):
    """判断某个 asar 是否已被工作台注入过（renderer/index.html 里有没有标记）。"""
    try:
        w, raw, hdr, base = read_asar(path)
        L = dict(leaves(hdr))
        html = _read(path, base, L["/renderer/index.html"])
        return MARK_HTML.encode() in html
    except Exception:
        return False


def backup():
    """备份 exe 与 asar。

    语义（必须明确）：**ASAR_BAK 永远是「干净的客户端原版」**，因为
    build() 是从它出发的——若从打过补丁的版本出发，会因检测到注入标记而
    跳过注入，新版 UI 根本不会生效。

    stamp 记录的是「备份本身（干净原版）」的指纹，用途是判断客户端是否
    升级过：
      · 当前 asar 干净 且 指纹 != stamp → 客户端升级过 → 刷新备份；
      · 当前 asar 干净 且 指纹 == stamp → 备份仍然对应当前客户端；
      · 当前 asar 已注入 → 说明打过补丁后客户端没被重装（重装会替换
        asar 为干净版），备份继续有效，不刷新。

    改动（2026-11-21 修正）：旧实现只看 stamp 指纹，而 stamp 从未被写过，
    于是「当前 asar 已注入」时会被当成原版复制进 ASAR_BAK，污染备份。

    返回 True 表示刷新了备份。
    """
    if not os.path.exists(ASAR):
        raise FileNotFoundError("找不到 %s" % ASAR)
    if not os.path.exists(EXE):
        raise FileNotFoundError("找不到 %s" % EXE)

    cur = fingerprint(ASAR)
    cur_patched = is_patched(ASAR)
    bak_exists = os.path.exists(ASAR_BAK)
    bak_clean = bak_exists and not is_patched(ASAR_BAK)
    stamp = ASAR_BAK + ".stamp"

    if bak_exists and bak_clean:
        bak_fp = fingerprint(ASAR_BAK)
        if not cur_patched and cur != bak_fp:
            # 客户端升级过（当前是干净新版，与备份不是同一版）→ 刷新
            shutil.copy2(ASAR, ASAR_BAK)
            shutil.copy2(EXE, EXE_BAK)   # exe 也要一起刷新，否则 restore 会降级
            _write_stamp(stamp, bak_fp)
            return True
        # 备份有效
        _write_stamp(stamp, bak_fp)
        return False

    # 备份缺失或不干净
    if cur_patched:
        # 2026-11-26：旧实现在这里直接拒绝安装。问题是备份会因为客户端升级、
        # 用户清理、换机器而消失，而注入是纯插入/追加——完全可以从当前 asar
        # 反推出干净版。反推失败才拒绝（见 strip_asar 的复核）。
        derive_backup()
        return True

    shutil.copy2(ASAR, ASAR_BAK)
    shutil.copy2(EXE, EXE_BAK)
    _write_stamp(stamp, cur)
    return True


def _write_stamp(path, value):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(value)
    except Exception:
        pass


def fingerprint(path):
    """文件指纹：大小 + sha256（前 1MB + 末 1MB + 全文件 hash 太慢，用大小+块 hash）。"""
    try:
        st = os.stat(path)
    except Exception:
        return "missing"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(1 << 20))
        f.seek(max(0, st.st_size - (1 << 20)))
        h.update(f.read(1 << 20))
    return "%d-%s" % (st.st_size, h.hexdigest()[:16])


def verify():
    """校验当前安装状态：asar 头哈希是否与 exe 内记录一致 + 注入标记是否存在。

    返回 (ok: bool, detail: str)。ok=False 表示客户端会拒绝启动或 UI 没注入。
    """
    try:
        ok, want, old, cnt = check(EXE, ASAR)
    except Exception as e:
        return False, "校验异常：%s" % e
    if not ok:
        return False, "exe 内记录的 asar 哈希与实际不一致（want=%s exe=%s）" % (want[:12], old[:12])
    try:
        w, raw, hdr, base = read_asar(ASAR)
        L = dict(leaves(hdr))
        html = _read(ASAR, base, L["/renderer/index.html"])
        if MARK_HTML.encode() not in html:
            return False, "asar 已同步但没有注入标记，UI 未生效"
        return True, "已注入并通过哈希校验（exe 内 %d 处）" % cnt
    except Exception as e:
        return False, "读取 asar 失败：%s" % e


def install():
    """打补丁。任何一步失败都要还原，避免留下"asar 已改、exe 未改"的半状态。"""
    backup()
    tmp = ASAR + ".new"
    try:
        new_hash, report = build(ASAR_BAK, tmp)
        old, cnt = old_hash_of_exe(EXE)
        os.replace(tmp, ASAR)
        swap_exe_hash(EXE, old, new_hash)
        ok, detail = verify()
        if not ok:
            raise RuntimeError("安装后校验失败：%s" % detail)
        return new_hash, report, cnt
    except Exception:
        # 半状态回滚：先还原，再把异常抛给上层
        try:
            restore()
        except Exception:
            pass
        raise


def restore():
    if os.path.exists(ASAR_BAK):
        shutil.copy2(ASAR_BAK, ASAR)
    if os.path.exists(EXE_BAK):
        shutil.copy2(EXE_BAK, EXE)
