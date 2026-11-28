#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""输出当前工作台状态（JSON）。只读数据库，不写任何东西。

改动记录（2026-11-21 下午）：
  · 今日/本周/按日改为「按请求时间」精确归日：credit_json 每个键前 12 位
    十六进制是该请求的 Unix 毫秒时间戳（ULID），实测全库 313 条全部可解码。
    跨天会话的积分会拆到各自的日期，不再出现"昨日消耗算进今日"。
  · 新增按模型拆分（by_model）：扫会话 JSONL 建 conversationRequestId →
    requestModelId 映射（实测覆盖率 100%），映射结果缓存到 .modelmap.json，
    按 JSONL 的 mtime+size 失效。
  · 新增费用模型计价（¥）：计费来源由 requestModelId 的前缀判定
    （custom-local: = 用户自带密钥，按 token 付费），规则与价格表读
    tools/billing.json，与 UI 侧 ui/billing_core.js 同源。
    默认价以用户服务商控制台为准：闲时 输入1/输出4/缓存命中0.02，忙时×2。
  · --session 语义不变；--cwd 语义不变。

更早改动（2026-11-21 上午）：
  · total 对全表求和；新增 --session；DB 缺失返回 error 而不是抛栈；
    percent 直接输出；git available=false；清理 import
"""
import argparse
import datetime
import glob
import json
import os
import shutil
import sqlite3
import sys

DB = os.path.join(os.path.expanduser("~"), ".workbuddy", "workbuddy.db")
PROJECTS = os.path.join(os.path.expanduser("~"), ".workbuddy", "projects")
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".modelmap.json")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _proc  # noqa: E402
BILLING_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "billing.json")
TOP_SESSIONS = 8

# 兜底规则：与 tools/billing.json 同构。正常情况读文件；文件缺失/损坏时才用这里，
# 目的是"宁可少功能，不要算出错误金额"。
_FALLBACK_BILLING = {
    "feePrefixes": ["custom-local:"],
    "feePatterns": [],
    "idleHours": [22, 8],
    "tzOffset": 8,
    "pricing": {
        "default": {
            "idle": {"input": 1.0, "output": 4.0, "cacheRead": 0.02},
            "busy": {"input": 2.0, "output": 8.0, "cacheRead": 0.04},
        },
        "models": {},
    },
}


def load_billing():
    """读 tools/billing.json —— 与 UI 侧 ui/billing_core.js 用的是同一份数据。
    2026-11-26 重构：旧版这里单独写了一份 patterns，主进程另写一份，
    改一处另一处不动就会出现「CLI 说费用、界面说积分」的分裂。"""
    cfg = json.loads(json.dumps(_FALLBACK_BILLING))
    try:
        with open(BILLING_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return cfg
    if isinstance(data.get("feePrefixes"), list) and data["feePrefixes"]:
        cfg["feePrefixes"] = data["feePrefixes"]
    if isinstance(data.get("feePatterns"), list):
        cfg["feePatterns"] = data["feePatterns"]
    if isinstance(data.get("idleHours"), list) and len(data["idleHours"]) == 2:
        cfg["idleHours"] = data["idleHours"]
    if isinstance(data.get("tzOffset"), (int, float)):
        cfg["tzOffset"] = data["tzOffset"]
    price = data.get("pricing") or {}
    if isinstance(price.get("default"), dict):
        for slot in ("idle", "busy"):
            if isinstance(price["default"].get(slot), dict):
                cfg["pricing"]["default"][slot].update(price["default"][slot])
    if isinstance(price.get("models"), dict):
        cfg["pricing"]["models"] = price["models"]
    return cfg


BILLING = load_billing()


def billing_unit(model):
    """计费单位：'fee'（按 token 付费，¥）或 'credit'（扣积分）。
    判定依据是模型 ID 的前缀（计费来源），不是模型名——后者会随版本变。"""
    if not model:
        return "credit"
    s = str(model).lower()
    for p in BILLING["feePrefixes"]:
        if p and s.startswith(str(p).lower()):
            return "fee"
    for p in BILLING["feePatterns"]:
        if p and str(p).lower() in s:
            return "fee"
    return "credit"


def is_fee_model(model):
    return billing_unit(model) == "fee"


def bare_name(model):
    s = str(model or "")
    i = s.find(":")
    return (s[i + 1:] if i >= 0 else s).lower()


def price_of(model):
    """返回 (idle, busy, known)。未配置的模型回落默认价并标 known=False。"""
    d = BILLING["pricing"]["default"]
    models = BILLING["pricing"]["models"] or {}
    name, best, best_len = bare_name(model), None, -1
    for k, v in models.items():
        kk = str(k).lower()
        if kk and kk in name and len(kk) > best_len:
            best, best_len = v, len(kk)
    if not best:
        return d["idle"], d["busy"], False
    idle = dict(d["idle"])
    idle.update({k: v for k, v in (best.get("idle") or {}).items() if v is not None})
    busy = dict(d["busy"])
    busy.update({k: v for k, v in (best.get("busy") or {}).items() if v is not None})
    return idle, busy, True


def calc_fee(usage, ms, model=""):
    """计费：((输入-缓存命中)×输入价 + 缓存命中×缓存价 + 输出×输出价) ÷ 1e6。
    闲时/忙时按请求时间在 tzOffset 时区里的小时判断，默认北京时间 22:00–08:00 闲时。"""
    if ms:
        tz = datetime.timezone(datetime.timedelta(hours=BILLING.get("tzOffset", 8)))
        hour = datetime.datetime.fromtimestamp(ms / 1000, tz).hour
    else:
        hour = datetime.datetime.now().hour
    lo, hi = BILLING["idleHours"]
    p = price_of(model)[0] if (hour >= lo or hour < hi) else price_of(model)[1]
    input_tok = (usage[0] or 0) if usage else 0
    output_tok = (usage[1] or 0) if usage else 0
    cache_tok = (usage[2] or 0) if usage else 0
    paid = max(0.0, input_tok - cache_tok)
    return (paid * p["input"] + cache_tok * p["cacheRead"] + output_tok * p["output"]) / 1e6


def path_sid(path):
    """从一个 jsonl 路径推出它属于哪个会话，以及是不是子代理文件。

    客户端两种布局（实测）：
      <projects>/<项目>/<会话ID>.jsonl                    → 主会话
      <projects>/<项目>/<会话ID>/subagents/agent-x.jsonl  → 子代理，属于 <会话ID>

    旧实现只把文件名当会话 ID，子代理请求于是被记成 "agent-x" 这种假会话：
    它的费用进了全局合计却掉不进任何会话，token 更是完全没被统计
    （实测某会话主文件 7.98M + 子代理 25.06M，账本只显示 8M）。
    """
    parts = str(path).replace(chr(92), "/").split("/")
    if len(parts) >= 3 and parts[-2] == "subagents":
        return parts[-3], True
    return os.path.splitext(parts[-1])[0], False


def scan_model_map():
    """扫 projects/**/*.jsonl，建 conversationRequestId → [model, usage] 映射，
    同时建 crid → 会话 ID（主会话文件按文件名，子代理文件归到父目录名）。

    第二个映射是 2026-11-26 新增的：判断"这个会话最近一次请求用的是什么单位"
    必须知道请求属于哪个会话，而 credit_json 只覆盖有积分条目的请求
    （费用模型的请求大多没有积分条目），单靠它会把最新一轮看错。
    带磁盘缓存（.modelmap.json），按文件的 mtime+size 判断是否需要重扫。"""
    # 每次都全量重建：增量累加会因同一文件被重复扫而把 usage 累加成 N 倍
    # （实测曾出现 4 倍偏差，导致费用虚高）。全量扫描 106MB 仅约 1 秒，代价可接受。
    cache_files, maps, sid_of, sub_crids, agent_of = {}, {}, {}, set(), {}
    # 子代理运行时长：按"每个 agent-*.jsonl 文件自身的首尾跨度"求和。
    # 不能用该 agent 全部请求的首尾差——它会跨会话中断/隔天继续，报出 15 小时这种假时长。
    file_span, file_agent = {}, {}
    try:
        files = glob.glob(PROJECTS + "/**/*.jsonl", recursive=True)
    except Exception:
        files = []
    for f in files:
        key = f.replace("\\", "/")
        try:
            st = os.stat(f)
        except OSError:
            continue
        cache_files[key] = [st.st_mtime, st.st_size]
        sid, is_sub = path_sid(f)
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
                    crid = pd.get("conversationRequestId")
                    if not crid:
                        continue
                    if crid not in sid_of:
                        sid_of[crid] = sid
                    if is_sub:
                        sub_crids.add(crid)
                        # agent 先收集，等 maps[crid] 建好后回填（此刻可能还没建）
                        _ag = pd.get("agent")
                        if _ag:
                            agent_of.setdefault(crid, _ag)
                            file_agent[key] = _ag
                        _ts = d.get("timestamp") or 0
                        if _ts:
                            sp = file_span.get(key) or [0, 0]
                            if not sp[0]:
                                sp[0] = _ts
                            if _ts > sp[1]:
                                sp[1] = _ts
                            file_span[key] = sp
                    mdl = pd.get("requestModelId") or pd.get("model")
                    if mdl and crid not in maps:
                        maps[crid] = [mdl, None, 0, None]
                    elif mdl and isinstance(maps.get(crid), list) and not maps[crid][0]:
                        maps[crid][0] = mdl
                    u = pd.get("usage")
                    if not u and isinstance(d.get("message"), dict):
                        u = d["message"].get("usage")
                    if u and crid in maps:
                        cur = maps[crid][1] or [0, 0, 0, 0]
                        cur[0] += u.get("inputTokens") or u.get("input_tokens") or 0
                        cur[1] += u.get("outputTokens") or u.get("output_tokens") or 0
                        _cr = u.get("cache_read_input_tokens") or 0
                        if not _cr:
                            _d = u.get("inputTokensDetails") or [{}]
                            _cr = (_d[0].get("cached_tokens") or 0) if _d else 0
                        cur[2] += _cr
                        cur[3] += u.get("cache_creation_input_tokens") or 0
                        maps[crid][1] = cur
                        # 第三条：该请求的 usage 行数 = 模型调用次数。
                        # 一个 conversationRequestId 是多步流式（每行一条 usage、requests 恒为 1），
                        # 所以"请求数"必须按行数算，按 crid 算会得到"发言轮次"。
                        maps[crid][2] = (maps[crid][2] or 0) + 1
        except OSError:
            pass
    # 每个 agent 的运行时长 = 它名下各文件自身跨度之和（并行运行也不重复计时长）
    agent_ms = {}
    for _path, _ag in file_agent.items():
        _sp = file_span.get(_path) or [0, 0]
        if _sp[0] and _sp[1] > _sp[0]:
            _key = (path_sid(_path)[0], _ag)
            _files, _ms = agent_ms.get(_key) or (0, 0)
            agent_ms[_key] = (_files + 1, _ms + (_sp[1] - _sp[0]))
    # 回填 agent（此时 maps[crid] 一定已建好）
    for _c, _a in agent_of.items():
        if _c in maps and len(maps[_c]) > 3 and not maps[_c][3]:
            maps[_c][3] = _a
    try:
        json.dump({"files": cache_files, "map": maps, "sids": sid_of,
                   "subs": sorted(sub_crids), "agents": agent_of},
                  open(CACHE, "w", encoding="utf-8"))
    except Exception:
        pass
    return maps, sid_of, sub_crids, agent_ms


def session_tokens(model_map, sid_of, sid, sub_crids=(), agent_ms=None):
    """按会话汇总 token（含子代理），并把子代理部分单独列出来。

    为什么单独列：子代理是"隐藏的放大器"——一个看起来 8M 的会话可能真实
    是 33M。只给总数会让用户以为统计错了；只给主线程数则等于漏账。
    requests 按 usage 行计（一次模型调用一条），turns 按 crid 计（一次发言可能多步）。
    """
    sub = set(sub_crids)
    tot = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0,
           "requests": 0, "turns": 0}
    s = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0,
         "requests": 0, "turns": 0}
    agents = {}
    for crid, pair in model_map.items():
        if sid_of.get(crid) != sid:
            continue
        u = pair[1] or [0, 0, 0, 0]
        rows = pair[2] if len(pair) > 2 and pair[2] else 1
        tot["input"] += u[0]
        tot["output"] += u[1]
        tot["cacheRead"] += u[2]
        tot["cacheCreate"] += u[3]
        # requests = 模型调用次数（usage 行数）；turns = 发言轮次（唯一 conversationRequestId）
        tot["requests"] += rows
        tot["turns"] += 1
        if crid in sub:
            s["input"] += u[0]
            s["output"] += u[1]
            s["cacheRead"] += u[2]
            s["cacheCreate"] += u[3]
            s["requests"] += rows
            s["turns"] += 1
            # 按 agent 拆开：谁在干活、花了多少
            name = (pair[3] if len(pair) > 3 and pair[3] else "subagent")
            a = agents.get(name) or {"name": name, "input": 0, "output": 0,
                                     "requests": 0, "turns": 0, "first": 0, "last": 0,
                                     "files": 0, "ms": 0}
            a["input"] += u[0]
            a["output"] += u[1]
            a["requests"] += rows
            a["turns"] += 1
            ts = key_ts(crid) or 0
            if ts:
                if not a["first"] or ts < a["first"]:
                    a["first"] = ts
                if ts > a["last"]:
                    a["last"] = ts
            agents[name] = a
    tot["sub"] = s
    # 时长/文件数取自扫描阶段（各文件自身跨度之和），没有就退回首尾差
    for _n, _a in agents.items():
        _info = (agent_ms or {}).get((sid, _n))
        if _info:
            _a["files"], _a["ms"] = _info[0], _info[1]
        elif _a["first"] and _a["last"]:
            _a["ms"] = _a["last"] - _a["first"]
    tot["subAgents"] = sorted(agents.values(), key=lambda x: -x["input"])
    return tot


TS_MIN = 1420070400000   # 2015-01-01
TS_MAX = 4102444800000   # 2100-01-01


def key_ts(k):
    """credit_json 键 / conversationRequestId 前 12 位十六进制 = Unix 毫秒时间戳（ULID）。

    越界返回 None：实测库里有 20 条普通 UUID 请求 ID（如 6ead5a31…），把前 12 位
    当十六进制解析会得到公元 5000 年，Windows 上 fromtimestamp() 直接抛
    OSError [Errno 22]，整个查询失败——这类脏数据必须挡在入口。
    """
    try:
        ms = int(str(k)[:12], 16)
    except (ValueError, TypeError):
        return None
    return ms if TS_MIN <= ms <= TS_MAX else None


def credits(s):
    """credit_json = {"请求ID": 积分}；求和。坏数据按 0 计。"""
    if not s:
        return 0.0
    try:
        o = json.loads(s)
        return round(sum(v for v in o.values() if isinstance(v, (int, float))), 2)
    except Exception:
        return 0.0


def connect():
    return sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=3)


def pick_session(rows, want_id, cwd):
    """选当前会话：显式指定 > 同工作目录 > 最近更新。"""
    if want_id:
        for r in rows:
            if str(r["session_id"]) == want_id:
                return r
        return None
    if cwd:
        try:
            con = connect()
            con.row_factory = sqlite3.Row
            q = con.execute(
                "select session_id from sessions where cwd = ? order by rowid desc limit 1",
                (cwd,)).fetchone()
            con.close()
            if q:
                for r in rows:
                    if str(r["session_id"]) == str(q["session_id"]):
                        return r
        except Exception:
            pass
    return rows[0] if rows else None


def git_info(cwd):
    out = {"root": "", "branch": "", "dirty": False, "available": False}
    if not cwd:
        return out
    out["root"] = os.path.basename(cwd.rstrip("\\/")) or cwd
    if not shutil.which("git"):
        return out
    out["available"] = True
    try:
        out["branch"] = _proc.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                                  cwd=cwd, timeout=2).stdout.strip()
        out["dirty"] = bool(_proc.run(["git", "status", "--porcelain"],
                                      cwd=cwd, timeout=2).stdout.strip())
    except Exception:
        pass
    return out


def main():
    ap = argparse.ArgumentParser(description="输出工作台状态 JSON")
    ap.add_argument("--session", help="指定会话 ID；不给则按工作目录/最近更新推断")
    ap.add_argument("--cwd", help="指定工作目录；默认当前进程目录")
    ap.add_argument("--no-scan", action="store_true", help="跳过 JSONL 扫描（不输出 by_model/费用）")
    args = ap.parse_args()

    try:
        con = connect()
        con.row_factory = sqlite3.Row
    except Exception as e:
        print(json.dumps({"error": "无法读取数据库：%s" % e, "db": DB},
                         ensure_ascii=False, indent=1))
        return

    try:
        # 全部会话（不截断）：total 与按日聚合必须覆盖全表
        all_rows = con.execute(
            "select session_id, used, size, credit_json, updated_at from session_usage "
            "order by updated_at desc").fetchall()
        rows = all_rows[:TOP_SESSIONS]
        if not all_rows:
            print(json.dumps({"empty": True, "note": "session_usage 表为空"},
                             ensure_ascii=False, indent=1))
            return

        cwd = args.cwd or os.getcwd()
        cur = pick_session(all_rows, args.session, cwd)
        if cur is None:
            print(json.dumps({"error": "未找到会话：%s" % args.session},
                             ensure_ascii=False, indent=1))
            return

        titles = {}
        try:
            for t in con.execute("select id, title, custom_title from sessions"):
                titles[str(t["id"])] = (t["custom_title"] or t["title"] or "")
        except Exception:
            pass

        if args.no_scan:
            model_map, sid_of, sub_crids, agent_ms = {}, {}, set(), {}
        else:
            model_map, sid_of, sub_crids, agent_ms = scan_model_map()

        today = datetime.date.today()
        today_s = today.strftime("%Y-%m-%d")
        week_start = (today - datetime.timedelta(days=today.weekday())).strftime("%Y-%m-%d")

        total = 0.0
        fee_total = 0.0
        by_day, by_week, by_model, fee_by_model, fee_by_day, fee_by_week, fee_by_month = {}, {}, {}, {}, {}, {}, {}
        credit_by_sid, fee_by_sid, platform_by_sid = {}, {}, {}
        # 费用走 JSONL 全量请求（不依赖 credit_json）：实测 25 条费用请求仅 2 条有积分条目
        for crid, pair in model_map.items():
            mdl = pair[0]
            if not mdl or not is_fee_model(mdl):
                continue
            ms = key_ts(crid)
            u = pair[1]
            f = calc_fee(u, ms, mdl) if u else 0.0
            fee_total = round(fee_total + f, 4)
            fee_by_model[mdl] = round(fee_by_model.get(mdl, 0) + f, 4)
            # 会话级费用按「请求属于哪个会话」直接归集（crid→sid 来自文件名）。
            # 旧实现没有这个映射，只能按平台记账值比例分摊，本会话记账值为 0 时
            # 就会显示 ¥0，而界面显示 ¥16.60 —— 同一个数两个答案。
            _fsid = sid_of.get(crid)
            if _fsid:
                fee_by_sid[_fsid] = round(fee_by_sid.get(_fsid, 0) + f, 4)
            if ms:
                d = datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
                fee_by_day[d] = round(fee_by_day.get(d, 0) + f, 4)
                dtf = datetime.datetime.fromtimestamp(ms / 1000)
                wsf = (dtf.date() - datetime.timedelta(days=dtf.weekday())).strftime("%Y-%m-%d")
                fee_by_week[wsf] = round(fee_by_week.get(wsf, 0) + f, 4)
                fee_by_month[d[:7]] = round(fee_by_month.get(d[:7], 0) + f, 4)
        for r in all_rows:
            sid = str(r["session_id"])
            try:
                cj = json.loads(r["credit_json"]) if r["credit_json"] else {}
            except Exception:
                cj = {}
            c_only, plat_here = 0.0, 0.0
            for k, v in cj.items():
                if not isinstance(v, (int, float)):
                    continue
                ms = key_ts(k)
                mdl = (model_map.get(k) or [None])[0] if model_map else None
                if mdl and is_fee_model(mdl):
                    # 费用模型在 credit_json 里的条目是平台记账值：单列核对，不并入积分
                    plat_here = round(plat_here + v, 2)
                    continue
                total += v
                c_only = round(c_only + v, 2)
                by_model[mdl or "未知"] = round(by_model.get(mdl or "未知", 0) + v, 2)
                if ms:
                    dt = datetime.datetime.fromtimestamp(ms / 1000)
                    d = dt.strftime("%Y-%m-%d")
                    wk = (dt.date() - datetime.timedelta(days=dt.weekday())).strftime("%Y-%m-%d")
                    by_day[d] = round(by_day.get(d, 0) + v, 2)
                    by_week[wk] = round(by_week.get(wk, 0) + v, 2)
            credit_by_sid[sid] = c_only
            platform_by_sid[sid] = plat_here
        # fee_by_sid 已在上面的请求循环里按 crid→会话 精确累加，不再做比例分摊

        sessions = [{"id": str(r["session_id"])[:8],
                     "title": titles.get(str(r["session_id"]), ""),
                     "credit": credit_by_sid.get(str(r["session_id"]), 0),
                     "fee": fee_by_sid.get(str(r["session_id"]), 0),
                     "used": r["used"], "size": r["size"]} for r in rows[:TOP_SESSIONS]]

        size = cur["size"] or 0
        used = cur["used"] or 0
        percent = round(used * 100.0 / size, 1) if size else None
        cur_sid = str(cur["session_id"])
        # 本会话的全部请求（含没有积分条目的费用请求）→ 判断"最近一次用的什么单位"。
        # 旧实现只看 credit_json 的键，而费用请求大多不在 credit_json 里，
        # 于是刚切到自定义模型时会被判成"还在用积分"。
        mine = []
        mine_main = []          # 只含主线程请求：决定"当前单位"
        for k, pair in model_map.items():
            if sid_of.get(k) != cur_sid or not pair[0]:
                continue
            mine.append((key_ts(k) or 0, pair[0]))
            if k not in sub_crids:
                mine_main.append((key_ts(k) or 0, pair[0]))
        mine.sort()
        mine_main.sort()
        cur_models = sorted({m for _t, m in mine})
        # 单位跟主线程走：子代理可能用另一套模型，不该决定"下一条消息按什么计费"
        latest_src = mine_main or mine
        latest_model = latest_src[-1][1] if latest_src else ""
        unit = billing_unit(latest_model) if latest_model else "credit"
        has_fee = any(billing_unit(m) == "fee" for m in cur_models)
        has_credit = any(billing_unit(m) == "credit" for m in cur_models)
        uses_fee = has_fee
        toks = session_tokens(model_map, sid_of, cur_sid, sub_crids, agent_ms)

        print(json.dumps({
            "session": {"id": cur_sid, "title": titles.get(cur_sid, ""),
                        "used": used, "size": size, "percent": percent,
                        "credit": credit_by_sid.get(cur_sid, 0),
                        "fee": fee_by_sid.get(cur_sid, 0),
                        "platform": platform_by_sid.get(cur_sid, 0),
                        "modelList": cur_models,
                        # unit = 最近一次请求的单位（自动模式的依据）
                        "unit": unit,
                        "latestModel": latest_model,
                        "latestAt": latest_src[-1][0] if latest_src else 0,
                        "mixed": bool(has_fee and has_credit),
                        # 含子代理的 token 汇总；tokens.sub 是其中子代理那部分
                        "tokens": {k: v for k, v in toks.items() if k != "subAgents"},
                        # 子代理逐 agent 明细（与界面的「子代理」分区同源）
                        "subAgents": toks.get("subAgents", []),
                        # 兼容旧字段：语义收窄为"本会话曾用过费用模型"
                        "usesFeeModel": uses_fee},
            "today": by_day.get(today_s, 0),
            "fee_today": fee_by_day.get(today_s, 0),
            "week": by_week.get(week_start, 0),
            "week_start": week_start,
            "total": round(total, 2),
            "fee_total": round(fee_total, 2),
            "fee_week": round(fee_by_week.get(week_start, 0), 2),
            "fee_month": round(fee_by_month.get(today_s[:7], 0), 2),
            "fee_platform_total": round(sum(platform_by_sid.values()), 2),
            "days": [{"day": k, "credit": v} for k, v in sorted(by_day.items())[-7:]],
            "fee_days": [{"day": k, "fee": v} for k, v in sorted(fee_by_day.items())[-7:]],
            "by_model": by_model,
            "fee_by_model": fee_by_model,
            "sessions": sessions,
            "git": git_info(cwd),
            "counts": {"sessions": len(all_rows), "aggregated": len(all_rows)},
            "note": "today/week/day 按「请求时间」（credit_json 键内嵌毫秒时间戳）精确归日，"
                    "跨天会话已拆分；total/今日/本周 只含积分模型；费用模型（¥）从 JSONL 全量请求"
                    "按 usage×分时段单价计价（不依赖 credit_json）；credit_json 里费用模型的条目"
                    "是平台记账值（session.platform / fee_platform_total），供与百炼账单核对；"
                    "单价以百炼控制台为准（闲时 1/4/0.02，忙时×2，北京时间 22:00–08:00 为闲时）；"
                    "week 默认周一起算"
        }, ensure_ascii=False, indent=1))
    except Exception as e:
        print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False, indent=1))
    finally:
        try:
            con.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
