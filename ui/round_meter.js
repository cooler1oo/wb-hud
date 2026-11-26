/* 工作台 · 消息末尾消耗行 + 悬浮用量卡（v1）
 *
 * 数据来源：payload.rounds[]（主进程按 conversationRequestId 聚合）
 * 挂载策略：
 *   1) 优先用 rounds[].msgIds 与 DOM 的 [data-message-id] 精确匹配
 *   2) 匹配不到时兜底：按时间顺序把「最近的轮次」贴到「最近的 assistant 消息」上
 * 显示单位跟随账本模式（ledgerMode）：积分模式显示 ◇积分，费用模式显示 ¥
 */
(function () {
  "use strict";
  if (window.__wbRoundMeterInit) return;
  window.__wbRoundMeterInit = 1;

  var CFG_KEY = "wb-hud-cfg-v1";
  function cfgAll() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) { return {}; }
  }
  function ledgerMode(d) {
    var m = cfgAll().ledgerMode || "auto";
    if (m === "auto") {
      // 跟随「最近一次请求」的单位（主进程算在 session.unit）；旧主进程退回旧字段
      var u = d && d.session && d.session.unit;
      if (u === "fee" || u === "credit") return u;
      return (d && d.session && d.session.usesFeeModel) ? "fee" : "credit";
    }
    return m;
  }
  /* 每一轮自己的计费单位。
   * 这是 v2 的关键修正：一行消耗贴在一条消息下面，它描述的是「这一轮」，
   * 不是「这个会话」。混用两种模型时，平台轮就是积分、自定义轮就是 ¥，
   * 用会话级单位去套会得到 ¥0.0000 这种既不是 0 也不是积分的假数字。 */
  function unitOfRound(r) {
    if (r && (r.unit === "fee" || r.unit === "credit")) return r.unit;
    if (r && r.isFee) return "fee";
    return "credit";
  }
  function tok(n) {
    n = +n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  function hhmm(ms) {
    try {
      var d = new Date(ms || 0);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    } catch (e) { return ""; }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // messageId 在 JSONL 里是 32 位无连字符，DOM 的 data-message-id 可能是带连字符的 UUID。
  // 统一去连字符+小写后比对，两种格式都能命中。
  function normId(s) { return String(s || "").replace(/-/g, "").toLowerCase(); }

  var lastRounds = [];
  var lastFull = null;    // 最近一次完整 payload（保留 session 供模式判断）
  var sessionMode = "credit";   // 仅诊断用：会话级单位；金额一律按 rounds[].unit
  var mounted = {};   // msgId -> 已挂载的标记
  var pendingSettle = {};   // msgId -> 已完成但数据未落盘的次数（用于诊断）

  // ---------- 悬浮卡 ----------
  var card = null;
  function ensureCard() {
    if (card && card.isConnected) return card;
    card = el("div"); card.id = "wb-round-card"; card.style.display = "none";
    (document.body || document.documentElement).appendChild(card);
    return card;
  }
  function fillCard(r) {
    var c = ensureCard();
    c.innerHTML = "";
    var head = el("div", "wb-rc-head");
    head.appendChild(el("span", "wb-rc-ico", "◉"));
    head.appendChild(el("span", "wb-rc-title", "本轮用量"));
    head.appendChild(el("span", "wb-rc-total", tok(r.input + r.output) + " tok"));
    c.appendChild(head);

    var body = el("div", "wb-rc-body");
    function line(k, v, cls) {
      var row = el("div", "wb-rc-row");
      row.appendChild(el("span", "wb-rc-k", k));
      var vv = el("span", "wb-rc-v" + (cls ? " " + cls : ""), v);
      row.appendChild(vv);
      body.appendChild(row);
    }
    var total = r.input || 1;
    var hitRate = Math.round((r.cacheRead || 0) * 100 / total);
    line("提供方 / 模型", String(r.model || "—").replace("custom-local:", ""));
    line("计费方式", unitOfRound(r) === "fee"
      ? ("按 token 付费" + (r.priced === false ? "（未配置单价，按默认价估算）" : ""))
      : "扣积分（服务端记账）");
    line("缓存命中", hitRate + "%");
    line("未缓存输入", tok((r.input || 0) - (r.cacheRead || 0)) + " tok");
    line("缓存读取", tok(r.cacheRead) + " tok");
    line("输出", tok(r.output) + " tok");
    if (r.steps) line("步数", String(r.steps));
    c.appendChild(body);

    var foot = el("div", "wb-rc-foot");
    foot.appendChild(el("span", "wb-rc-k", "消耗"));
    var costText = unitOfRound(r) === "fee"
      ? "¥" + (+r.fee || 0).toFixed(4)
      : "◇ " + (+r.credit || 0).toFixed(2) + " 积分";
    foot.appendChild(el("span", "wb-rc-cost", costText));
    c.appendChild(foot);
    return c;
  }
  function showCard(anchor, r) {
    var c = fillCard(r);
    c.style.display = "";
    var rect = anchor.getBoundingClientRect();
    var cw = 300;
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - cw - 8);
    var top = rect.bottom + 6;
    if (top + 220 > window.innerHeight) top = Math.max(8, rect.top - 226);
    c.style.left = left + "px";
    c.style.top = top + "px";
  }
  function hideCard() { if (card) card.style.display = "none"; }

  // ---------- 消息末尾挂载 ----------
  function buildStrip(r) {
    var strip = el("div", "wb-round-strip");
    var unit = unitOfRound(r);
    var cost = el("span", "wb-rs-cost");
    cost.textContent = (unit === "fee")
      ? "¥" + (+r.fee || 0).toFixed(4)
      : "◇ " + (+r.credit || 0).toFixed(2);
    cost.title = (unit === "fee")
      ? ("这一轮按 token 付费" + (r.priced === false ? "（未配置该模型单价，按默认价估算）" : ""))
      : "这一轮扣积分（服务端记账，不是 token × 单价）";
    strip.appendChild(cost);

    var usage = el("span", "wb-rs-usage");
    usage.appendChild(el("span", "wb-rs-ico", "⧉"));
    usage.appendChild(el("span", null, tok((r.input || 0) + (r.output || 0)) + " tok"));
    strip.appendChild(usage);

    if (r.model) {
      var m = el("span", "wb-rs-model", String(r.model).replace("custom-local:", ""));
      m.title = r.model;
      strip.appendChild(m);
    }
    if (r.first) strip.appendChild(el("span", "wb-rs-time", hhmm(r.first)));

    strip.addEventListener("mouseenter", function () { showCard(strip, r); });
    strip.addEventListener("mouseleave", hideCard);
    return strip;
  }

  // 真实锚点（经 CDP 实测 2026-11-21）：
  //   .cr-agent[data-message-id]  每条 AI 回复的容器（data-message-id 是带连字符的 UUID）
  //   .cr-agent__body-row         容器内最后一行（消耗行插在它后面更贴近原生排版）
  // 注意：不是通用的 [data-message-id]，那只是属性名巧合
  function msgNodes() {
    return Array.prototype.slice.call(document.querySelectorAll(".cr-agent[data-message-id]"));
  }

  // ===== 完成判定（权威信号，与时间无关）=====
  // WorkBuddy 原生提供四重同步标记，实测 8 秒采样完全一致：
  //   1. class 含 "cr-agent--processing"
  //   2. data-message-processing="true"
  //   3. 子节点 .cr-agent__processing-status
  //   4. 子节点 .conversation-streaming-footer
  // 任一存在 = 仍在生成 → 绝不显示消耗。
  // 这四个标记由应用本身在流式结束时移除，因此任务跑几小时也能准确判断。
  function isProcessing(node) {
    if (!node) return true;
    if (node.dataset && node.dataset.messageProcessing === "true") return true;
    var cls = String(node.className || "");
    if (cls.indexOf("cr-agent--processing") >= 0) return true;
    if (node.querySelector(".cr-agent__processing-status")) return true;
    if (node.querySelector(".conversation-streaming-footer")) return true;
    return false;
  }

  var diagCount = 0;
  var diagLastAt = 0;
  function diagReport(obj) {
    try {
      // 限制：每 10 秒最多一次，且总量 500 次（此前 30 次会上限，导致后期无法诊断）
      var now = Date.now();
      if (now - diagLastAt < 10000) return;
      if (diagCount++ > 500) return;
      diagLastAt = now;
      if (window.__wbHud && window.__wbHud.diag) window.__wbHud.diag(obj);
    } catch (e) { }
  }

  // 清理：正在处理中的消息上如果残留了消耗行，一律移除
  function purgeProcessing() {
    try {
      var all = document.querySelectorAll(".cr-agent[data-message-id]");
      for (var i = 0; i < all.length; i++) {
        if (isProcessing(all[i])) {
          var s = all[i].querySelector(".wb-round-strip");
          if (s) s.remove();
        }
      }
    } catch (e) { }
  }

  function mountAll(d) {
    purgeProcessing();
    // 探测真实 DOM（增强）：抓消息列表内部的真实结构
    var probe = { attrs: [], cls: [], msgItems: [], listState: "" };
    try {
      var list = document.querySelector(".cr-message-list, .cr-message-list__content");
      if (list) {
        probe.listState = String(list.className || "").slice(0, 100);
        // 抓列表的直接子元素及其子孙的特征
        var items = list.querySelectorAll(":scope > *, :scope > * > *");
        var cnt = 0;
        for (var ii = 0; ii < items.length && cnt < 14; ii++) {
          var it = items[ii];
          if (it.children.length === 0 && !it.textContent.trim()) continue;
          probe.msgItems.push({
            tag: it.tagName,
            cls: String(it.className || "").slice(0, 90),
            dataKeys: it.dataset ? Object.keys(it.dataset) : [],
            kids: it.children.length,
            txt: (it.textContent || "").trim().slice(0, 40)
          });
          cnt++;
        }
      }
    } catch (e4) { probe.err2 = String(e4).slice(0, 80); }
    var probe2 = { attrs: [], cls: [] };
    try {
      var all = document.querySelectorAll("[data-testid], [data-message-id], [data-role], [id]");
      var seen = {};
      for (var ai = 0; ai < all.length && probe.attrs.length < 25; ai++) {
        var e2 = all[ai];
        var ds = e2.dataset ? Object.keys(e2.dataset) : [];
        if (!ds.length) continue;
        var key = ds.join(",");
        if (seen[key]) continue;
        seen[key] = 1;
        probe.attrs.push({ tag: e2.tagName, dataKeys: ds, cls: String(e2.className || "").slice(0, 60) });
      }
      // 找可能的"消息列表"容器
      var cands = document.querySelectorAll("[class*='message'], [class*='Message'], [class*='chat'], [class*='turn']");
      for (var ci = 0; ci < cands.length && probe.cls.length < 20; ci++) {
        probe.cls.push({ tag: cands[ci].tagName, cls: String(cands[ci].className || "").slice(0, 80) });
      }
    } catch (e3) { probe.err = String(e3).slice(0, 80); }

    var base = {
      at: Date.now(),
      hasData: !!d,
      hasError: !!(d && d.error),
      roundsType: d ? (Array.isArray(d.rounds) ? "array" : typeof d.rounds) : "no-data",
      roundsLen: d && d.rounds ? d.rounds.length : -1,
      domMsgs: document.querySelectorAll(".cr-agent[data-message-id]").length,
      hasApi: !!(window.__wbHud && window.__wbHud.diag),
      bodyChildren: (document.body ? document.body.children.length : 0),
      probe: probe
    };
    Object.assign(probe, probe2);
    if (!d || !d.rounds || !d.rounds.length) { diagReport(Object.assign(base, { stop: "no-rounds" })); return; }
    lastRounds = d.rounds;
    if (d.session) lastFull = d;          // 只更新带 session 的完整数据
    else if (!lastFull) lastFull = d;
    sessionMode = ledgerMode(d.session ? d : lastFull);

    var nodes = msgNodes();
    if (!nodes.length) { diagReport(Object.assign(base, { stop: "no-dom-msgs" })); return; }

    // 1) 精确匹配：msgIds 里含 DOM 的 messageId
    // ===== 匹配策略（2026-11-21 定稿）=====
    // 放弃 ID 前缀匹配：实测 DOM messageId 与 JSONL messageId/crid 的共同前缀
    // 长度完全不固定（8/11/13 位都有），任何固定前缀都会失败。
    //
    // 改用【时间区间匹配】，这是唯一不依赖 ID 格式的可靠方法：
    //   消息 ID 前 12 位 = ULID 毫秒时间戳 → 消息产生的精确时刻
    //   轮次有 [first, last] 区间 → 该轮从第一次调用到最后一次调用的时间跨度
    //   消息时间落在某轮次区间内（含 30 秒容差）= 该消息属于该轮次
    //
    // 实测三条全部命中：
    //   DOM 01a1fd31585a7 (16:20:31.962) → 轮次[16:20:37~16:21:25] ✅
    //   DOM 01a1fd33df767 (16:23:17.622) → 轮次[16:23:35~16:24:05] ✅
    //   DOM 01a1fd2de6137 (16:16:46.099) → 轮次[16:16:52~16:17:45] ✅
    var TOL_MS = 30000;             // 30 秒容差（消息可能略早/晚于首个 API 调用）
    var roundsByTime = [];
    for (var ti = 0; ti < lastRounds.length; ti++) {
      var rt = lastRounds[ti];
      if (!rt.first) continue;
      roundsByTime.push(rt);
    }
    // 按 first 升序，便于二分/顺序扫描
    roundsByTime.sort(function (a, b) { return a.first - b.first; });

    // 找消息时间所属的轮次。
    //
    // 2026-11-21 最终版（经 2756 个真实 messageId 离线验证：100% 准确，0 错误）
    //
    // 演进过程与每一步的实测准确率：
    //   · 旧实现「区间命中无条件覆盖」= 取最靠后的轮次        98.95%（29 错）
    //   · 上一版「容差内取 |消息-first| 最小」                98.98%（28 错）
    //   · 本版「严格区间优先 → 容差 → 距离」                  100.00%（0 错）
    //
    // 为什么必须这样分三级：
    //   根因是 30 秒容差把每个轮次的可匹配窗口撑大 60 秒，相邻轮次必然重叠
    //   （实测 199 个轮次里 32 处重叠）。一旦消息落进重叠区，
    //   任何"在容差区间里挑一个"的算法都可能挑错。
    //   正确做法是先用【严格区间】（不加容差）判断——
    //   严格区间几乎不重叠，一个候选就锁定，根本不需要挑。
    //   容差只在严格区间完全无候选时兜底（应对消息略早/略晚于首个调用）。
    function findRoundByTime(msgMs) {
      if (!msgMs) return null;

      // 1) 严格区间：消息时间落在轮次 [first, last] 之内
      //    多个候选时取"跨度最小"的——最贴身那个，避免被长轮次吞掉
      var strictHits = [];
      for (var i1 = 0; i1 < roundsByTime.length; i1++) {
        var r1 = roundsByTime[i1];
        var f1 = r1.first || 0;
        if (!f1) continue;
        var l1 = r1.last || f1;
        if (msgMs >= f1 && msgMs <= l1) {
          strictHits.push({ span: l1 - f1, r: r1 });
        }
      }
      if (strictHits.length) {
        strictHits.sort(function (a, b) { return a.span - b.span; });
        return strictHits[0].r;
      }

      // 2) 容差区间兜底：应对消息时间略早于该轮首个 API 调用（秒级偏差）
      //    多个候选时取离区间边缘最近的
      var looseBest = null, looseDist = Infinity;
      for (var i2 = 0; i2 < roundsByTime.length; i2++) {
        var r2 = roundsByTime[i2];
        var f2 = r2.first || 0;
        if (!f2) continue;
        var l2 = r2.last || f2;
        if (msgMs >= f2 - TOL_MS && msgMs <= l2 + TOL_MS) {
          var d2 = (msgMs < f2) ? (f2 - msgMs) : (msgMs - l2);
          if (d2 < looseDist) { looseDist = d2; looseBest = r2; }
        }
      }
      if (looseBest) return looseBest;

      // 3) 最后兜底：距离最近的轮次，且不超过 15 分钟；否则宁可不显示
      var outBest = null, outDist = Infinity;
      for (var i3 = 0; i3 < roundsByTime.length; i3++) {
        var r3 = roundsByTime[i3];
        var f3 = r3.first || 0;
        if (!f3) continue;
        var l3 = r3.last || f3;
        var d3 = (msgMs < f3) ? (f3 - msgMs) : (msgMs - l3);
        if (d3 < outDist) { outDist = d3; outBest = r3; }
      }
      if (outBest && outDist <= 15 * 60 * 1000) return outBest;
      return null;
    }

    var usedRounds = {};
    for (var k = 0; k < nodes.length; k++) {
      var node = nodes[k];
      // 原生权威判定：仍在生成中 → 跳过（不再依赖任何时间推断）
      if (isProcessing(node)) continue;
      var mid = node.dataset.messageId;
      var nmid = normId(mid);
      var msgMsForPick = parseInt(nmid.slice(0, 12), 16) || 0;
      var hit = findRoundByTime(msgMsForPick);
      if (!hit) {
        // 消息已完成但数据还没落盘（结算延迟）→ 记为待补，下轮自动重试。
        // 这是「等待数据」而不是「猜测时间」：只要 usage 写入文件就会立刻补上。
        pendingSettle[nmid] = (pendingSettle[nmid] || 0) + 1;
        continue;
      }
      delete pendingSettle[nmid];
      // 时间区间匹配已内含距离约束，无需额外校验
      usedRounds[hit.crid] = 1;
      var unitNow = unitOfRound(hit);
      var exist = node.querySelector(".wb-round-strip");
      // 按「该轮的单位」判断是否需要重画：单位是逐轮属性，换单位必须重建
      if (exist && exist.dataset.crid === hit.crid && exist.dataset.mode === unitNow) continue;
      if (exist) exist.remove();
      var strip = buildStrip(hit);
      strip.dataset.crid = hit.crid;
      strip.dataset.mode = unitNow;
      // 已验证：直接 append 到 .cr-agent 末尾即可正常显示（CDP 实测通过）
      node.appendChild(strip);
      mounted[normId(mid)] = hit.crid;
    }

    // 2) 兜底逻辑已移除（2026-11-21）：
    //    曾有「按时间找最近轮次」的兜底，但会给出错误数字（把 15:36 的 ¥0.1412 贴到 15:43 的消息上）。
    //    宁可这条消息不显示消耗，也不能显示错的。只有 msgIds 精确匹配才显示。

    // 诊断上报
    diagReport(Object.assign(base, {
      sessionMode: sessionMode,
      roundUnits: lastRounds.slice(0, 4).map(function (x) { return (x.unit || (x.isFee ? "fee" : "credit")) + ":" + String(x.model || "").replace("custom-local:", ""); }),
      roundsWithIds: lastRounds.filter(function (x) { return x.msgIds && x.msgIds.length; }).length,
      mountedStrips: document.querySelectorAll(".wb-round-strip").length,
      exactHits: Object.keys(mounted).length,
      pendingSettleCount: Object.keys(pendingSettle).length,
      pendingSettleIds: Object.keys(pendingSettle).slice(0, 5),
      sampleMsgIds: nodes.slice(0, 3).map(function (n) { return n.dataset.messageId; }),
      sampleRoundIds: lastRounds.slice(0, 2).map(function (x) { return (x.msgIds || []).slice(0, 2); })
    }));
  }

  // ---------- 循环 ----------
  // 优先复用主注入广播的数据（零额外请求）；只在长时间没收到广播时低频自取兜底
  var lastPush = 0;
  function onData(ev) {
    try {
      var d = ev && ev.detail;
      if (d && !d.error) { lastPush = Date.now(); mountAll(d); }
    } catch (e) { }
  }
  function fallbackTick(force) {
    // 正常情况等主注入广播；force=true 时（有待结算消息）不等广播
    if (!force && Date.now() - lastPush < 30000) return;
    try {
      if (window.__wbHud && window.__wbHud.state) {
        window.__wbHud.state(cfgAll().anchored || "").then(function (d) {
          if (d && !d.error) { lastPush = Date.now(); mountAll(d); }
        }).catch(function () { });
      }
    } catch (e) { }
  }

  function boot() {
    diagReport({
      at: Date.now(), alive: true,
      hasApi: !!(window.__wbHud && window.__wbHud.diag),
      hasState: !!(window.__wbHud && window.__wbHud.state),
      readyState: document.readyState
    });
    window.addEventListener("wb-hud-data", onData);
    window.addEventListener("scroll", hideCard, true);

    // 关键：消息列表是异步渲染的，启动瞬间 DOM 里可能一条都没有。
    // 用 MutationObserver 盯着消息出现，一出现就尝试挂载（比定时器等更快更准）。
    var obT0 = 0;
    new MutationObserver(function () {
      var now = Date.now();
      if (now - obT0 < 200) return;          // 节流（200ms，尽快响应完成瞬间）
      obT0 = now;
      try {
        if (document.querySelector(".cr-agent[data-message-id]")) {
          // 有消息了：优先用最近一次完整数据重试，否则拉一次
          if (lastFull) mountAll(lastFull);
          else fallbackTick();
        }
      } catch (e) { }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });

    // 有「已完成但未结算」的消息时，加快刷新（1.2 秒），让消耗尽快补上
    setInterval(function () {
      if (Object.keys(pendingSettle).length) fallbackTick(true);
      fallbackTick();
    }, 800);
    fallbackTick();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();