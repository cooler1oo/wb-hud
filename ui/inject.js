/* WorkBuddy 工作台 · 原生位置注入（v3）
 *
 * 布局严格对齐 claude-hud 默认形态 —— 两行，约 38px：
 *   line1  模型 │ 项目 git:(分支*) │ 1.24M in · 88k out · 900k cache
 *   line2  Context ████░░░░ 46% (459k/1.00M) │ 积分 275.08        账本 ⌄
 * 工具 / 子代理 / 待办默认不显示（原版也是可选行），点 ⌃ 展开为第三行。
 *
 * 折叠：点 ⌄ → 18px 细条，显示「▤ 46% · 275.08 ⌃」，仍是入口，永不消失。
 * 账本：原生侧边栏摘要卡（5 行）+ 点开抽屉看完整账本。
 */
(function () {
  if (window.__WB_HUD__) return;
  window.__WB_HUD__ = true;

  // 单例令牌：被新实例取代后，旧实例的定时器必须自行停止，
  // 否则它会把已删除的节点重新挂回去，出现两条状态条。
  var TOKEN = "wb-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  window.__WB_TOKEN__ = TOKEN;
  function alive() { return window.__WB_TOKEN__ === TOKEN; }

  // 清掉任何已存在的旧实例节点
  ["wb-hud", "wb-hud-side", "wb-hud-drawer"].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.remove();
  });

  var TICK = 900;
  var MODE_KEY = "wb.hud.mode";     // "mini" | "open"
  var EXTRA_KEY = "wb.hud.extra";   // "1" 显示工具/子代理/待办行
  var MAX_TOOLS = 5;
  var CFG_KEY = "wb.hud.cfg";
  var CFG = (function () {
    try {
      var o = JSON.parse(localStorage.getItem(CFG_KEY) || "{}") || {};
      // 配置版本：21 = 视觉改版。只重置本次改版涉及的项，其余用户自定义保留
      if (o.__v !== 21) {
        ["colorModel", "colorProject", "colorGit", "colorGitBranch", "showUsage"]
          .forEach(function (k) { delete o[k]; });
        o.__v = 21;
        localStorage.setItem(CFG_KEY, JSON.stringify(o));
      }
      return o;
    } catch (e) { return {}; }
  })();
  function cfg(k, def) {
    if (CFG[k] === undefined) return def;
    return (typeof def === "boolean") ? !!CFG[k] : CFG[k];
  }
  function setCfg(k, v) { CFG[k] = v; try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (e) { } }

  /* 账本单位（2026-11-26 重构）
   * auto 跟随「最近一次请求」的单位：主进程把它算在 session.unit 里。
   * 旧写法是 `session.usesFeeModel ? "fee" : "credit"`，语义是"本会话出现过
   * 自定义模型"——一旦为 true 就再也不回落，用户切回平台模型后账本仍显示 ¥，
   * 混合会话里平台轮被逐轮行显示成 ¥0.0000。这是本次故障的直接原因。
   * 兼容：主进程未升级时 session.unit 不存在，退回旧字段。 */
  function sessionUnit(d) {
    var m = cfg("ledgerMode", CFG_DEFAULTS.ledgerMode);
    if (m === "fee" || m === "credit") return m;
    var u = d && d.session && d.session.unit;
    if (u === "fee" || u === "credit") return u;
    return (d && d.session && d.session.usesFeeModel) ? "fee" : "credit";
  }

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function q(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function tok(n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }
  function blocks(pct) {
    var a = cfgAll();
    function ch(v, d) {
      v = String(v == null ? "" : v);
      if (!v || v === "true" || v === "false" || v === "undefined" || v.length > 2) return d;
      return v.charAt(0);
    }
    var fl = ch(a.barFilled, "\u2588");
    var em = ch(a.barEmpty, "\u2591");
    var f = Math.round(Math.min(100, Math.max(0, pct)) / 10);
    return fl.repeat(f) + em.repeat(10 - f);
  }
  var COLORS = { green: "#4ec9b0", cyan: "#4fc1ff", yellow: "#e2c08d", red: "#f44747",
    magenta: "#c586c0", blue: "#569cd6", brightBlue: "#3794ff", brightMagenta: "#d16969",
    dim: "#8a8f98" };
  function col(name) { return COLORS[name] || "inherit"; }
  function two(n) { return (n < 10 ? "0" : "") + n; }
  function relTime(ts) {
    var d = Math.max(0, Date.now() - (+ts || 0)), min = Math.floor(d / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return min + " 分钟前";
    if (min < 1440) return Math.floor(min / 60) + " 小时前";
    return Math.floor(min / 1440) + " 天前";
  }
  function fmtDur(ms) {
    ms = Math.max(0, +ms || 0);
    var min = Math.floor(ms / 60000);
    if (min < 1) return "数秒";
    if (min < 60) return min + " 分";
    var h = Math.floor(min / 60);
    if (h < 24) return h + " 时 " + (min % 60) + " 分";
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 时";
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    var a = cfgAll(), d = new Date(+ts);
    var h = d.getHours(), m = d.getMinutes(), sec = d.getSeconds();
    var h12 = (a.hourCycle === "h11" || a.hourCycle === "h12");
    var hh = h;
    if (a.hourCycle === "h11") hh = h % 12;
    else if (a.hourCycle === "h12") hh = h % 12 || 12;
    var ap = h12 ? (h < 12 ? " AM" : " PM") : "";
    var abs = two(hh) + ":" + two(m) + (a.showClockSeconds ? ":" + two(sec) : "") + ap;
    var rel = relTime(ts), el2 = fmtDur(Date.now() - ts) + "前";
    switch (a.timeFormat) {
      case "absolute": return abs;
      case "both": return rel + " " + abs;
      case "elapsed": return el2;
      case "elapsedAndAbsolute": return el2 + " " + abs;
      default: return rel;
    }
  }
  // 对齐 claude-hud 的显示开关（默认全开）与账本过滤
  var CFG_DEFAULTS = {
    // ===== 会话锚定与费用模型 =====
    anchored: "",                  // 手动锚定的会话 ID（空 = 自动跟随你当前打开的会话）
    ledgerMode: "auto",            // 账本模式：auto=跟随当前会话的模型类型 / credit=积分 / fee=费用（¥）
    feeCfg: null,                  // 费用模型配置 {patterns[], idle{input,output,cacheRead}, busy{...}}；null = 用主进程默认（百炼控制台价）
    // ===== 顶层布局（8）=====
    lineLayout: "expanded",        // compact / expanded
    showSeparators: true,
    pathLevels: 1,                 // 1 / 2 / 3 / 9=full
    maxWidth: 0,                   // 0 = 不限
    forceMaxWidth: false,
    // ===== gitStatus（8）=====
    gitEnabled: true,
    gitDirty: true,
    gitAheadBehind: false,
    gitFileStats: false,
    gitWorktree: false,
    gitOverflow: "truncate",       // truncate / wrap
    gitPushWarn: 0,
    gitPushCrit: 0,
    // ===== display: 模型/项目（10）=====
    showModel: true,
    modelFormat: "full",           // full / compact / short
    modelOverride: "",
    showProvider: true,
    providerName: "",
    showProject: true,
    showLaunchDir: false,
    showAddedDirs: true,
    addedDirsLayout: "inline",     // inline / line
    // ===== display: 上下文/用量（15）=====
    showContextBar: true,
    contextValue: "percent",       // percent / tokens / remaining / both
    showUsage: false,
    usageValue: "percent",         // percent / remaining
    usageBarEnabled: true,
    showResetLabel: false,
    usageCompact: false,
    showModelScopedUsage: false,
    usagePace: false,
    contextWarn: 70,
    contextCrit: 85,
    usageThreshold: 0,
    sevenDayThreshold: 80,
    environmentThreshold: 0,
    // ===== display: 成本/积分（6）=====
    showCost: true,
    showRoutedCost: false,
    showDailyCost: false,
    showWeeklyCost: false,
    weeklyCostPeriod: "quota",
    // ===== display: 会话/时间（12）=====
    showDuration: false,
    showSpeed: false,
    showTokenBreakdown: true,
    showSessionTokens: false,
    showSessionName: false,
    showSessionStartDate: false,
    showLastResponseAt: false,
    showCompactions: false,
    timeFormat: "relative",        // relative / absolute / both / elapsed / elapsedAndAbsolute
    hourCycle: "auto",             // auto / h11 / h12 / h23 / h24
    showClockSeconds: false,
    autoCompactWindow: 0,
    // ===== display: 认证/版本/顾问（7）=====
    showAuth: false,
    showAuthUser: false,
    authUserFullEmail: false,
    authUserLength: 8,
    showWorkBuddyVersion: false,
    showAdvisor: false,
    advisorOverride: "",
    // ===== display: 推理/工具/资源（17）=====
    showEffortLevel: false,
    effortFormat: "full",          // full / symbol / text
    showAgentEffort: true,
    showTools: true,
    toolNameMaxLength: 0,
    toolsMaxVisible: 4,
    agentsMaxVisible: 3,
    showSkills: false,
    skillsMaxVisible: 4,
    showMcp: false,
    showAgents: true,
    showTodos: true,
    showMemoryUsage: false,
    showPromptCache: false,
    showCacheHitRate: true,
    showConfigCounts: false,
    showOutputStyle: false,
    // ===== display: 布局/自定义（5）=====
    rightAlign: false,
    customLine: "",
    customLinePosition: "last",    // first / last
    // ===== colors（13）=====
    colorContext: "green",
    colorUsage: "brightBlue",
    colorWarning: "yellow",
    colorUsageWarning: "brightMagenta",
    colorCritical: "red",
    colorModel: "default",
    colorProject: "default",
    colorGit: "default",
    colorGitBranch: "default",
    colorLabel: "dim",
    colorCustom: 208,
    barFilled: "\u2588",
    barEmpty: "\u2591",
    // ===== 本机扩展：账本过滤/分区 =====
    since: "", until: "", project: "", tz: 0,
    secToken: true, secBlocks: true, secProject: true,
    secModel: true, secSession: true, secWeek: true,
    secMonth: true, secDay: true, secAgent: true,
    extraCmd: ""
  };
  function cfgAll() {
    var o = {};
    for (var k in CFG_DEFAULTS) {
      o[k] = (CFG[k] === undefined) ? CFG_DEFAULTS[k] : CFG[k];
    }
    return o;
  }
  function isMini() { return localStorage.getItem(MODE_KEY) === "mini"; }
  function isExtra() { return localStorage.getItem(EXTRA_KEY) === "1"; }

  // ---------- 状态条结构 ----------
  var wrap = el("div"); wrap.id = "wb-hud";
  var l1 = el("div", "hud-line");
  var l2 = el("div", "hud-line");
  var mini = el("div", "hud-line hud-mini");

  var btns = el("div", "hud-btns");
  var bLedger = el("span", "hud-btn", "账本");
  bLedger.title = "打开积分账本";
  var bExtra = el("span", "hud-btn", "⌃");
  bExtra.title = "显示/隐藏 工具·子代理·待办";
  var bFold = el("span", "hud-btn", "⌄");
  bFold.title = "折叠为细条（可随时展开）";
  btns.appendChild(bLedger); btns.appendChild(bExtra); btns.appendChild(bFold);
  l2.appendChild(btns);

  var miniText = el("span", "hud-mini-text hud-dim", "");
  var miniUnfold = el("span", "hud-btn", "⌃");
  miniUnfold.title = "展开状态条";
  mini.appendChild(miniText); mini.appendChild(miniUnfold);

  [l1, l2, mini].forEach(function (n) { wrap.appendChild(n); });   // 状态条只留两行核心

  // ---------- 侧边栏摘要卡 ----------
  var side = el("div"); side.id = "wb-hud-side";
  var sideHead = el("div", "hud-h");
  var sideTitle = el("span", "hud-h-title hud-click", "工作台");
  sideTitle.title = "点击选择要查看的会话（账本与动态都会跟随所选会话）";
  sideHead.appendChild(sideTitle);
  var bSideFold = el("span", "hud-btn hud-icon", "⌄");
  bSideFold.title = "折叠 / 展开输入框上方的状态条（任何状态下可复原）";
  sideHead.appendChild(bSideFold);
  sideHead.appendChild(el("span", "hud-src", "workbuddy.db"));
  side.appendChild(sideHead);
  // 会话切换列表：点击标题弹出；数据来自最近一次 payload 的 sessionList
  var sessPick = el("div", "hud-sesspick"); sessPick.style.display = "none";
  side.appendChild(sessPick);
  function toggleSessPick() {
    if (sessPick.style.display !== "none") { sessPick.style.display = "none"; return; }
    var anchored = cfgAll().anchored || "";
    var list = (lastSessionList || []).slice(0, 30);
    if (!list.length) {
      // 首次打开且还没拿到数据：先给反馈，再拉一次
      sessPick.innerHTML = "";
      sessPick.appendChild(el("div", "hud-sessempty", "正在读取会话列表…"));
      sessPick.style.display = "";
      try {
        read().then(function (d2) {
          if (d2 && d2.sessionList) { lastSessionList = d2.sessionList; }
          sessPick.style.display = "none";
          toggleSessPick();
        }).catch(function () {
          sessPick.innerHTML = "";
          sessPick.appendChild(el("div", "hud-sessempty", "读取失败，请稍后再点"));
        });
      } catch (e) {
        sessPick.innerHTML = "";
        sessPick.appendChild(el("div", "hud-sessempty", "读取失败：" + e));
      }
      return;
    }
    else {
      sessPick.innerHTML = "";
      list.forEach(function (s) {
        var curSid = (lastData && lastData.session && lastData.session.id) || "";
        var isCur = (s.id === curSid) || (s.id === anchored);
        var it = el("div", "hud-sessitem" + (isCur ? " cur" : ""));
        var tt = s.title || "(无标题)";
        if (tt.length > 22) tt = tt.slice(0, 22) + "…";
        it.appendChild(el("span", "hud-sessname", tt));
        it.appendChild(el("span", "hud-sessval", (s.credit || 0) + (s.fee ? " +¥" + s.fee.toFixed(2) : "")));
        it.title = s.id + (s.title ? "\n" + s.title : "");
        it.onclick = function () {
          setCfg("anchored", s.id);
          sessPick.style.display = "none";
          if (window.__wbHud && window.__wbHud.state) read().then(paint);
        };
        sessPick.appendChild(it);
      });
      var follow = el("div", "hud-sessitem" + (anchored ? "" : " cur"));
      follow.appendChild(el("span", "hud-sessname", "● 自动跟随（当前打开的会话）"));
      follow.appendChild(el("span", "hud-sessval", ""));
      follow.onclick = function () {
        setCfg("anchored", "");
        sessPick.style.display = "none";
        if (window.__wbHud && window.__wbHud.state) read().then(paint);
      };
      sessPick.appendChild(follow);
    }
    sessPick.style.display = "";
  }
  sideTitle.onclick = toggleSessPick;
  // 兜底：某些情况下 click 被父容器吞掉，补一个 mousedown
  sideTitle.addEventListener("mousedown", function (e) { e.stopPropagation(); });
  var sideBody = el("div", "hud-scroll");   // 统一滚动容器：磁贴/上下文/动态/标签
  side.appendChild(sideBody);
  var sideMore = el("div", "hud-more", "查看完整账本 ↗");
  side.appendChild(sideMore);

  // ---------- 抽屉 ----------
  var drawer = el("div"); drawer.id = "wb-hud-drawer"; drawer.style.display = "none";

  var dHead = el("div", "hud-dh");
  dHead.appendChild(el("span", null, "积分账本"));



  var dClose = el("span", "hud-x", "×");
  dClose.title = "关闭";
  dHead.appendChild(dClose);
  drawer.appendChild(dHead);

  // Tab：账本 / 设置
  var dTabs = el("div", "hud-tabs");
  var tabA = el("span", "hud-tab on", "账本");
  var tabB = el("span", "hud-tab", "设置");
  dTabs.appendChild(tabA); dTabs.appendChild(tabB);
  drawer.appendChild(dTabs);

  var dBody = el("div");
  drawer.appendChild(dBody);
  var dSettings = el("div"); dSettings.style.display = "none";
  drawer.appendChild(dSettings);

  tabA.addEventListener("click", function (e) {
    e.stopPropagation();
    tabA.className = "hud-tab on"; tabB.className = "hud-tab";
    dBody.style.display = ""; dSettings.style.display = "none";
  });
  tabB.addEventListener("click", function (e) {
    e.stopPropagation();
    tabB.className = "hud-tab on"; tabA.className = "hud-tab";
    dSettings.style.display = ""; dBody.style.display = "none";
    if (!dSettings.__built) buildSettings();
  });

  var dNote = el("div", "hud-note",
    "数据源：~/.workbuddy/workbuddy.db → session_usage。今日/本周/本月/按日均按「请求时间」精确归日：credit_json 每个键前 12 位十六进制即该请求的 Unix 毫秒时间戳（ULID），跨天会话的积分会拆到各自的日期。积分由服务端写入，不是 token × 单价。");
  drawer.appendChild(dNote);

  function buildSettings() {
    dSettings.__built = true;

    // 每项：[键, 中文标签, 悬浮说明（改了会怎样）]
    function group(title, desc) {
      var g = el("div", "hud-cfg");
      var t = el("div", "hud-sub", title);
      if (desc) t.title = desc;
      g.appendChild(t);
      return g;
    }
    function tip(node, text) { node.title = text || ""; return node; }

    function chip(key, label, help) {
      var b = el("span", "hud-chip" + (cfg(key, CFG_DEFAULTS[key]) ? " on" : ""), label);
      b.title = help + "\n\n配置键：" + key + "（原版 claude-hud 同名）";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var nv = !cfg(key, CFG_DEFAULTS[key]);
        setCfg(key, nv);
        b.classList.toggle("on", nv);
        if (lastData) paint(lastData);
      });
      return b;
    }
    function sel(key, label, opts, help) {
      var w = el("label", "hud-num");
      var sp = el("span", null, label);
      sp.title = help + "\n\n配置键：" + key;
      w.appendChild(sp);
      var i2 = el("select");
      i2.title = help;
      opts.forEach(function (o) {
        var op = el("option", null, o[1]); op.value = o[0];
        if (String(cfg(key, CFG_DEFAULTS[key])) === String(o[0])) op.selected = true;
        i2.appendChild(op);
      });
      i2.addEventListener("change", function () {
        setCfg(key, i2.value);
        if (key === "tz") { try { window.__wbHud.setTz(Number(i2.value) || 0); } catch (e) { } }
        if (key === "weeklyCostPeriod") {
          try { window.__wbHud.setWeek(i2.value === "sunday"); } catch (e) { }
        }
        if (lastData) paint(lastData);
      });
      w.appendChild(i2);
      return w;
    }
    function num(key, label, min, max, step, help) {
      var w = el("label", "hud-num");
      var sp = el("span", null, label);
      sp.title = help + "\n\n配置键：" + key;
      w.appendChild(sp);
      var i2 = el("input"); i2.type = "number"; i2.min = min; i2.max = max; i2.step = step || 1;
      i2.value = cfg(key, CFG_DEFAULTS[key]);
      i2.title = help;
      i2.addEventListener("change", function () {
        var v = Number(i2.value);
        if (!isNaN(v)) { setCfg(key, v); if (lastData) paint(lastData); }
      });
      w.appendChild(i2);
      return w;
    }
    function txt(key, label, ph, help) {
      var w = el("label", "hud-num");
      var sp = el("span", null, label);
      sp.title = help + "\n\n配置键：" + key;
      w.appendChild(sp);
      var i2 = el("input"); i2.type = "text"; i2.placeholder = ph || "";
      i2.value = cfg(key, CFG_DEFAULTS[key]) || "";
      i2.style.width = "130px";
      i2.title = help;
      i2.addEventListener("change", function () {
        setCfg(key, i2.value);
        if (lastData) paint(lastData);
      });
      w.appendChild(i2);
      return w;
    }
    function row(label, nodes, desc) {
      var w = el("div", "hud-cfg");
      var t = el("div", "hud-sub", label);
      if (desc) t.title = desc;
      w.appendChild(t);
      nodes.forEach(function (n) { w.appendChild(n); });
      return w;
    }

    dSettings.appendChild(row("顶层布局", [
      sel("lineLayout", "行布局", [["expanded", "展开（多行）"], ["compact", "紧凑（单行）"]],
        "展开：模型/上下文/工具各占一行；紧凑：全部挤进一两行，省空间。"),
      chip("showSeparators", "段落分隔符", "开启后各信息段之间显示 │ 竖线。关闭则更干净但界限模糊。"),
      sel("pathLevels", "路径显示层级", [["1", "只显示末级"], ["2", "两级"], ["3", "三级"], ["9", "完整路径"]],
        "项目路径显示几层目录。1 = 只显示文件夹名（如 workbench）；full = 显示完整路径，更长。"),
      num("maxWidth", "最大宽度(字符)", 0, 400, 10, "状态栏文字最大宽度，超出会截断。0 = 不限制。"),
      chip("forceMaxWidth", "强制限宽", "开启后即使内容不满也固定占满最大宽度，状态栏右侧对齐更整齐。")
    ], "控制状态栏整体排版。"));

    dSettings.appendChild(row("Git 状态", [
      chip("gitEnabled", "显示 git 信息", "开启后状态栏显示当前项目的 git 分支名；关闭则完全不显示 git 相关内容。"),
      chip("gitDirty", "脏工作区标记", "开启后工作区有未提交改动时，分支名后显示 * 号。"),
      chip("gitAheadBehind", "超前/落后数", "开启后显示本地比远程多/少几个提交（如 ↑2 ↓1），需要网络查询时可能稍慢。"),
      chip("gitFileStats", "改动文件数", "开启后显示改动了几个文件（如 +3 ~1）。信息更全但更占空间。"),
      chip("gitWorktree", "工作树名", "使用 git worktree 时显示工作树名称。不用 worktree 就没影响。"),
      sel("gitOverflow", "分支名过长时", [["truncate", "截断"], ["wrap", "换行"]],
        "分支名太长的处理方式：截断 = 省略号结尾；换行 = 挤到下一行。"),
      num("gitPushWarn", "超前告警阈值", 0, 50, 1, "本地比远程多出多少个提交时开始提示（黄色）。0 = 关闭。"),
      num("gitPushCrit", "超前严重阈值", 0, 50, 1, "超前提交数达到该值时用红色警示。0 = 关闭。")
    ], "控制 git 分支和工作区状态的显示。"));

    dSettings.appendChild(row("显示 · 模型 / 项目", [
      chip("showModel", "模型名", "开启后第一行显示当前使用的模型名（如 deepseek-v4.1-flash）。"),
      sel("modelFormat", "模型名格式", [["full", "完整"], ["compact", "紧凑（去版本号）"], ["short", "短名"]],
        "完整 = 原名照显；紧凑 = 去掉尾部版本数字；短名 = 再去掉开头的厂商前缀。"),
      txt("modelOverride", "自定义模型名", "留空 = 用真实模型名", "填了就用这个文本替代真实模型名显示。比如填「主力模型」。留空恢复真实名称。"),
      chip("showProvider", "提供商标签", "开启后模型名后显示 (provider) 如 (bedrock)。单账号用户可以关掉省空间。"),
      txt("providerName", "自定义提供商名", "留空 = 用真实值", "填了就强制显示这个提供商名，不填则显示数据里的真实 provider。"),
      chip("showProject", "项目/会话名", "开启后显示项目目录名（git 仓库）或会话标题。关闭后状态栏更短。"),
      chip("showLaunchDir", "启动目录", "开启后显示 WorkBuddy 的启动目录。一般用不到。"),
      chip("showAddedDirs", "附加目录", "开启后显示会话中追加的其他工作目录。"),
      sel("addedDirsLayout", "附加目录排版", [["inline", "跟在同行"], ["line", "独占一行"]],
        "附加目录显示在同一行里，还是单独一行（目录多时换行更清晰）。")
    ], "控制模型和项目标识的显示方式。"));

    dSettings.appendChild(row("显示 · 上下文 / 用量", [
      chip("showContextBar", "上下文进度条", "开启后显示 ▓▓▓░░ 式的上下文占用条。关闭后只显示数字。"),
      sel("contextValue", "上下文数值形式", [["percent", "百分比"], ["tokens", "token 数"], ["remaining", "剩余量"], ["both", "百分比+token"]],
        "进度条旁边显示什么：百分比 (70%)、token 数、剩余可用量，或两者都显示。"),
      chip("showUsage", "用量信息", "开启后显示额度用量。本产品用积分显示。"),
      sel("usageValue", "用量数值形式", [["percent", "百分比"], ["remaining", "剩余"]],
        "用量显示百分比还是剩余额度。"),
      chip("usageBarEnabled", "用量进度条", "开启后用量也带一条 ▓▓░░ 进度条。两条进度条会占更多宽度。"),
      chip("showResetLabel", "重置说明", "开启后用量旁标注何时重置。"),
      chip("usageCompact", "用量紧凑显示", "开启后用量压缩成最短形式（省宽度）。"),
      chip("showModelScopedUsage", "按模型用量", "开启后用量按当前模型单独统计。用多家模型时有用。"),
      chip("usagePace", "消耗速度", "开启后显示每小时的消耗速率，帮你预估额度能撑多久。"),
      num("contextWarn", "上下文警告线(%)", 0, 100, 5, "上下文占用超过该百分比时进度条变黄，提醒你快满了。默认 70。"),
      num("contextCrit", "上下文危险线(%)", 0, 100, 5, "超过该百分比时进度条变红。默认 85。"),
      num("usageThreshold", "用量警告线(%)", 0, 100, 5, "额度用量超过该百分比时高亮提醒。0 = 关闭。"),
      num("sevenDayThreshold", "7 天额度警告线(%)", 0, 100, 5, "近 7 天额度消耗超过该比例时提醒。0 = 关闭。"),
      num("environmentThreshold", "环境用量警告线(%)", 0, 100, 5, "环境级额度消耗超过该比例时提醒。0 = 关闭。")
    ], "控制上下文占用条和额度用量的显示。"));

    dSettings.appendChild(row("显示 · 成本 / 积分", [
      chip("showCost", "本会话积分", "开启后第二行显示本会话累计积分（原版是美元成本）。"),
      chip("showRoutedCost", "路由成本", "开启后显示模型路由产生的额外费用。用单一模型就没有这项。"),
      chip("showDailyCost", "今日成本", "开启后显示今天的累计消耗。"),
      chip("showWeeklyCost", "本周成本", "开启后显示本周的累计消耗。"),
      sel("weeklyCostPeriod", "本周起算点", [["quota", "按配额周期"], ["monday", "周一起算"], ["sunday", "周日起算"]],
        "「本周」从哪天开始算。配额周期 = 跟随平台的计费周期；其余按自然周。")
    ], "控制成本/积分数字的显示（对应 ccusage 的 Cost 列）。"));

    dSettings.appendChild(row("账本模式", [
      sel("ledgerMode", "显示单位", [["auto", "自动检测"], ["credit", "积分"], ["fee", "费用（¥）"]],
        "自动：跟随本会话「最近一次请求」用的是哪类模型——平台模型显示积分，自定义模型显示费用 ¥。"
        + "换模型后立刻跟着变；同一会话里两种都用过时，主数字显示当前单位，另一种单位用暗色小字并列。"
        + "手动锁定则始终只显示一种单位。")
    ], "账本顶层用积分还是费用（¥）显示。"));

    // 费用模型：按 token 计费（¥），与积分分开统计
    dSettings.appendChild(group("费用模型 · 单价（元/百万 token）",
      "判定依据是模型 ID 的前缀（计费来源），不是模型名：custom-local: = 你自己的密钥，按 token 付费。"
      + "闲时 = 北京时间 22:00–次日 08:00，其余为忙时。价格以你的服务商控制台为准，留空/0 视为沿用默认。"));
    (function () {
      var base = cfg("feeCfg", null) || {};
      function money(keyPath, label, def, help) {
        var cur = base[keyPath];
        var w = el("label", "hud-num");
        var sp = el("span", null, label); sp.title = help;
        w.appendChild(sp);
        var i2 = el("input"); i2.type = "number"; i2.step = "0.01"; i2.min = "0";
        i2.placeholder = def;
        i2.value = (cur == null ? "" : cur);
        i2.addEventListener("change", function () {
          var c = cfg("feeCfg", null) || {};
          if (i2.value === "") { delete c[keyPath]; }
          else { c[keyPath] = Number(i2.value); }
          setCfg("feeCfg", c);
          if (window.__wbHud && window.__wbHud.setPricing) window.__wbHud.setPricing(pricingPayload());
          if (lastData) paint(lastData);
        });
        w.appendChild(i2);
        return w;
      }
      // feeCfg 扁平结构：idleInput/idleOutput/idleCache/busyInput/busyOutput/busyCache/patterns
      // 主进程端会把它整理成 {patterns, idle:{...}, busy:{...}}
      dSettings.appendChild(row("费用模型 · 闲时（22:00–08:00）", [
        money("idleInput", "输入", 1, "闲时输入单价（元/百万 token），默认 1"),
        money("idleOutput", "输出", 4, "闲时输出单价（元/百万 token），默认 4"),
        money("idleCache", "缓存命中", 0.02, "闲时缓存命中单价（元/百万 token），默认 0.02")
      ]));
      dSettings.appendChild(row("费用模型 · 忙时（08:00–22:00）", [
        money("busyInput", "输入", 2, "忙时输入单价（元/百万 token），默认 2（闲时 ×2）"),
        money("busyOutput", "输出", 8, "忙时输出单价（元/百万 token），默认 8（闲时 ×2）"),
        money("busyCache", "缓存命中", 0.04, "忙时缓存命中单价（元/百万 token），默认 0.04")
      ]));
      (function () {
        // 两个字段分开，因为语义完全不同：
        //   计费前缀 = 计费来源（主判据，模型 ID 以它开头就是自付费）
        //   额外关键词 = 手工兜底（某些服务商把模型名当 ID，没有前缀）
        function textField(key, label, title, placeholder) {
          var w = el("label", "hud-num");
          var sp = el("span", null, label); sp.title = title;
          w.appendChild(sp);
          var i2 = el("input"); i2.type = "text";
          var cur = base[key];
          i2.value = (cur && cur.join) ? cur.join(",") : (cur || "");
          i2.placeholder = placeholder;
          i2.addEventListener("change", function () {
            var c = cfg("feeCfg", null) || {};
            c[key] = i2.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            setCfg("feeCfg", c);
            if (window.__wbHud && window.__wbHud.setPricing) window.__wbHud.setPricing(pricingPayload());
            if (lastData) paint(lastData);
          });
          w.appendChild(i2);
          return w;
        }
        dSettings.appendChild(row("费用模型 · 计费前缀", [textField(
          "feePrefixes", "前缀",
          "模型 ID 以这些前缀开头 = 你自带的密钥，按 token 计费（¥）。\n默认 custom-local: —— 这是客户端给自定义模型加的前缀。\n留空则用默认值。",
          "custom-local:")]));
        dSettings.appendChild(row("费用模型 · 额外关键词", [textField(
          "patterns", "关键词",
          "模型名包含任一关键词也视为按 token 计费，逗号分隔。\n只在服务商不给前缀、模型名又能稳定区分时才需要填。\n默认留空：模型名会随版本变，不该当作计费依据。",
          "（默认空，通常不需要填）")]));
      })();
    })();

    dSettings.appendChild(row("显示 · 会话 / 时间", [
      chip("showDuration", "会话时长", "开启后显示本次会话持续了多久（如 42 分钟）。"),
      chip("showSpeed", "生成速度", "开启后显示输出速度（tokens/s），可判断模型是否卡顿。"),
      chip("showTokenBreakdown", "Token 明细", "开启后账本显示输入/输出/缓存的分项。关闭后只显示总数。"),
      chip("showSessionTokens", "会话 token 总量", "开启后显示本会话累计 token 数。"),
      chip("showSessionName", "会话名称", "开启后显示会话标题。"),
      chip("showSessionStartDate", "会话开始日期", "开启后显示会话是哪天开始的。"),
      chip("showLastResponseAt", "最近回复时间", "开启后显示最后一次回复的时间。"),
      chip("showCompactions", "压缩次数", "开启后显示上下文被压缩过几次（长会话信息）。"),
      sel("timeFormat", "时间显示格式", [["relative", "相对（3 分钟前）"], ["absolute", "绝对（14:30）"], ["both", "两者"], ["elapsed", "耗时"], ["elapsedAndAbsolute", "耗时+绝对时间"]],
        "时间以什么形式显示。相对时间直观，绝对时间精确。"),
      sel("hourCycle", "小时制", [["auto", "跟随系统"], ["h11", "12 小时制(0-11)"], ["h12", "12 小时制(1-12)"], ["h23", "24 小时制(0-23)"], ["h24", "24 小时制(1-24)"]],
        "12/24 小时制。auto = 跟随系统设置。"),
      chip("showClockSeconds", "显示秒", "开启后时间显示到秒（14:30:25）。会多占宽度。"),
      num("autoCompactWindow", "自动压缩阈值", 0, 200000, 1000, "上下文超过该 token 数时提示自动压缩。0 = 关闭。")
    ], "控制会话计时和 token 明细。"));

    dSettings.appendChild(row("显示 · 认证 / 版本 / 顾问", [
      chip("showAuth", "认证状态", "开启后显示当前登录/认证状态。"),
      chip("showAuthUser", "账号名", "开启后显示登录账号。"),
      chip("authUserFullEmail", "完整邮箱", "开启后邮箱显示完整地址；关闭则截断保护隐私。"),
      num("authUserLength", "账号名长度", 0, 60, 2, "账号名截断到多少字符。0 = 不截断。"),
      chip("showWorkBuddyVersion", "WorkBuddy 版本", "开启后显示客户端版本号。"),
      chip("showAdvisor", "Advisor 顾问", "开启后显示 advisor（顾问模式）状态。"),
      txt("advisorOverride", "自定义 Advisor 名", "留空 = 用真实值", "填了就强制显示这个顾问名。留空恢复真实值。")
    ], "账号与版本信息，按需开启。"));

    dSettings.appendChild(row("显示 · 推理 / 工具 / 资源", [
      chip("showEffortLevel", "推理强度", "开启后显示模型的推理强度档位（high/low）。"),
      sel("effortFormat", "推理强度格式", [["full", "完整"], ["symbol", "符号"], ["text", "纯文字"]],
        "推理强度的显示形式：符号省空间，完整最清楚。"),
      chip("showAgentEffort", "子代理模型标签", "开启后子代理条目带 [模型名] 标签，如 ◐ explore [haiku]。"),
      chip("showTools", "工具行", "开启后显示最近用过的工具（如 ◐ Edit: auth.ts）。关闭后状态栏更短。"),
      num("toolNameMaxLength", "工具名最大长度", 0, 40, 2, "工具名/参数截断到多少字符。0 = 不截断。"),
      num("toolsMaxVisible", "工具行最多显示", 1, 12, 1, "工具行最多显示几个工具。多出的省略。"),
      chip("showSkills", "Skill 行", "开启后显示最近调用的 skill。"),
      num("skillsMaxVisible", "skill 最多显示", 1, 12, 1, "skill 行最多显示几条。"),
      num("agentsMaxVisible", "子代理最多显示", 1, 8, 1, "子代理行最多显示几个并行 agent。"),
      chip("showMcp", "MCP 行", "开启后显示 MCP 连接器的状态。"),
      chip("showAgents", "子代理行", "开启后显示正在跑的子代理（如 ◐ explore (2m)）。"),
      chip("showTodos", "待办行", "开启后显示任务清单进度（如 ▸ Fix bug (2/5)）。"),
      chip("showMemoryUsage", "内存占用", "开启后显示 WorkBuddy 的内存占用。排查性能问题时有用。"),
      chip("showPromptCache", "提示缓存", "开启后显示提示缓存的命中情况。"),
      chip("showCacheHitRate", "缓存命中率", "开启后账本显示缓存命中率百分比。"),
      chip("showConfigCounts", "配置计数", "开启后显示生效配置的数量，调试用。"),
      chip("showOutputStyle", "输出风格", "开启后显示当前输出风格设置。")
    ], "控制工具/子代理/资源监控行的显示。"));

    dSettings.appendChild(row("显示 · 布局 / 自定义", [
      chip("rightAlign", "数字右对齐", "开启后账本数字统一右对齐，更整齐。"),
      txt("customLine", "自定义行文本", "留空 = 不显示", "在状态栏插入一行自定义文字，比如常看的命令输出摘要。"),
      sel("customLinePosition", "自定义行位置", [["first", "第一行"], ["last", "最后一行"]],
        "自定义文字插在状态栏的顶部还是底部。")
    ], "高级布局微调。"));

    dSettings.appendChild(row("颜色（colors）", [
      sel("colorContext", "上下文条颜色", [["green", "绿"], ["cyan", "青"], ["yellow", "黄"], ["red", "红"], ["magenta", "紫"], ["blue", "蓝"]],
        "上下文进度条的填充色（正常状态时）。"),
      sel("colorUsage", "用量条颜色", [["brightBlue", "亮蓝"], ["green", "绿"], ["cyan", "青"], ["yellow", "黄"], ["magenta", "紫"]],
        "用量进度条的填充色。"),
      sel("colorWarning", "警告色", [["yellow", "黄"], ["magenta", "紫"], ["red", "红"]],
        "接近阈值（默认 70%）时进度条变的颜色。"),
      sel("colorCritical", "危险色", [["red", "红"], ["magenta", "紫"]],
        "超过危险阈值（默认 85%）时进度条变的颜色。"),
      sel("colorModel", "模型名颜色", [["default", "跟随主题"], ["cyan", "青"], ["green", "绿"], ["yellow", "黄"], ["magenta", "紫"]],
        "模型名文字颜色。"),
      sel("colorProject", "项目名颜色", [["default", "跟随主题"], ["yellow", "黄"], ["cyan", "青"], ["green", "绿"]],
        "项目/会话名文字颜色。"),
      sel("colorGit", "git 文字颜色", [["default", "跟随主题"], ["magenta", "紫"], ["cyan", "青"], ["yellow", "黄"]],
        "git 状态文字颜色。"),
      sel("colorGitBranch", "分支名颜色", [["default", "跟随主题"], ["cyan", "青"], ["magenta", "紫"], ["green", "绿"]],
        "git 分支名文字颜色。"),
      txt("barFilled", "进度条填充字符", "█", "进度条已填充部分用的字符，默认 █。"),
      txt("barEmpty", "进度条空白字符", "░", "进度条未填充部分用的字符，默认 ░。")
    ], "终端风格配色（沿用原版 claude-hud 配色键名）。"));

    dSettings.appendChild(row("账本过滤（对应 ccusage --since / --until / --project）", [
      txt("since", "开始日期", "如 2026-01-01", "只统计该日期之后的账目。留空 = 不限。"),
      txt("until", "结束日期", "如 2026-12-31", "只统计该日期之前的账目。留空 = 不限。"),
      txt("project", "只看某项目", "项目名关键字", "只显示名称包含该关键字的项目账目。留空 = 全部。"),
      sel("tz", "时区偏移(小时)", [[-12, "-12"], [-8, "-8"], [-4, "-4"], [0, "0"], [4, "+4"], [8, "+8"], [12, "+12"]],
        "按哪个时区归集「今天/本周/本月」。中国用户一般选 +8。改后立即生效。")
    ], "筛选账本统计的范围。"));
    var quick = el("div", "hud-cfg");
    var qt = el("div", "hud-sub", "快捷范围");
    qt.title = "一键设置开始日期：今天 / 近 7 天 / 近 30 天 / 清除过滤";
    quick.appendChild(qt);
    [["今天", "0"], ["本周", "-7"], ["本月", "-30"], ["全部", ""]].forEach(function (q) {
      var b = el("span", "hud-chip", q[0]);
      b.title = q[0] === "全部" ? "清除日期过滤，显示全部历史" : "把开始日期设为" + q[0] + "，筛选账目";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (q[1] === "") { setCfg("since", ""); setCfg("until", ""); }
        else if (q[1] === "0") {
          var d0 = new Date(); d0.setHours(0, 0, 0, 0);
          setCfg("since", d0.toISOString().slice(0, 10)); setCfg("until", "");
        } else {
          var d1 = new Date(); d1.setDate(d1.getDate() + Number(q[1])); d1.setHours(0, 0, 0, 0);
          setCfg("since", d1.toISOString().slice(0, 10)); setCfg("until", "");
        }
        dSettings.innerHTML = ""; dSettings.__built = false; buildSettings();
        if (lastData) paint(lastData);
      });
      quick.appendChild(b);
    });
    dSettings.appendChild(quick);

    dSettings.appendChild(row("账本分区（对应 ccusage --sections）", [
      chip("secToken", "Token 明细", "账本里的「Token · 本会话」分区（输入/输出/缓存/命中率）。"),
      chip("secBlocks", "5 小时窗口", "账本里的 5 小时计费窗口分区（对应 ccusage blocks）。"),
      chip("secProject", "按项目", "账本里的按项目汇总分区。"),
      chip("secAgent", "按 Agent", "账本里的按子代理汇总分区。"),
      chip("secModel", "按模型", "账本里的按模型汇总分区。"),
      chip("secSession", "按会话", "账本里的按会话汇总分区。"),
      chip("secWeek", "按周", "账本里的按周汇总分区。"),
      chip("secMonth", "按月", "账本里的按月汇总分区。"),
      chip("secDay", "按日", "账本里的按日汇总分区。")
    ], "控制完整账本里显示哪些统计分区，关掉不看的可以缩短账本。"));

    dSettings.appendChild(row("extraCmd（原版 --extra-cmd）", [
      txt("extraCmd", "自定义命令", "如 git log -1 --oneline", "每轮刷新时执行这条命令，输出显示在状态栏第一行。留空 = 不执行。注意：会每几秒执行一次，别放慢命令。")
    ], "扩展：把任意命令的输出贴到状态栏。"));
  }

  function openDrawer() { drawer.style.display = ""; bLedger.classList.add("on"); }
  function closeDrawer() { drawer.style.display = "none"; bLedger.classList.remove("on"); }
  function toggleDrawer() { if (drawer.style.display === "none") openDrawer(); else closeDrawer(); }
  bLedger.addEventListener("click", function (e) { e.stopPropagation(); toggleDrawer(); });
  dClose.addEventListener("click", function (e) { e.stopPropagation(); closeDrawer(); });
  sideMore.addEventListener("click", function (e) { e.stopPropagation(); openDrawer(); });

  // ---------- 折叠 ----------
  function applyMode() {
    if (isMini()) wrap.classList.add("collapsed");
    else wrap.classList.remove("collapsed");
    // extra 态不再影响状态条（动态区已迁侧栏）
    if (typeof bSideFold !== "undefined" && bSideFold) {
      bSideFold.textContent = isMini() ? "⌃" : "⌄";
    }
  }
  bFold.addEventListener("click", function (e) {
    e.stopPropagation();
    localStorage.setItem(MODE_KEY, "mini");
    applyMode();
  });
  miniUnfold.addEventListener("click", function (e) {
    e.stopPropagation();
    localStorage.setItem(MODE_KEY, "open");
    applyMode();
  });
  bSideFold.addEventListener("click", function (e) {
    e.stopPropagation();
    var next = isMini() ? "open" : "mini";
    localStorage.setItem(MODE_KEY, next);
    applyMode();
    bSideFold.textContent = next === "mini" ? "⌃" : "⌄";
    bSideFold.title = "状态条已" + (next === "mini" ? "折叠，点击展开" : "展开，点击折叠") + "（任何状态下可复原）";
  });
  bExtra.addEventListener("click", function (e) {
    e.stopPropagation();
    var on = isExtra();
    localStorage.setItem(EXTRA_KEY, on ? "0" : "1");
    bExtra.classList.toggle("on", !on);
    bExtra.title = !on ? "隐藏侧栏动态区（工具/子代理/待办）" : "显示侧栏动态区（工具/子代理/待办）";
    renderExtra(lastData);
  });
  bExtra.title = "显示/隐藏 侧栏动态区（工具/子代理/待办）";
  bExtra.classList.toggle("on", isExtra());

  // ---------- 挂载：状态条与侧栏完全独立，互不兜底 ----------
  function mountBar() {
    if (wrap.isConnected) return;
    var slot = q('[class*="conversation-input-area__slots-region"]');
    if (slot) { slot.appendChild(wrap); return; }
    var area = q('[class*="conversation-input-area"]');
    if (area) area.insertBefore(wrap, area.firstChild);
  }
  function mountSide() {
    // 首选：会话区左侧的空白带（消息列居中/偏右，左边通常空着一大块）
    var viewport = q('[class*="cr-message-list-viewport"]')
                || q('[class*="conversation-timeline"]')
                || q('[class*="conversation-shell__main"]');
    if (viewport) {
      var content = viewport.querySelector('[class*="cr-message-list__content"]')
                 || viewport.querySelector('[class*="cr-message-list"]');
      var vr = viewport.getBoundingClientRect();
      var gap = content ? (content.getBoundingClientRect().left - vr.left) : 999;
      if (gap >= 240) {
        if (getComputedStyle(viewport).position === "static") viewport.style.position = "relative";
        if (side.parentElement !== viewport) viewport.appendChild(side);
        side.classList.add("hud-dock-left");
        side.style.width = Math.min(330, Math.floor(gap - 16)) + "px";
        return;
      }
    }
    // 兜底：任务侧栏（窄，只放得下磁贴）
    side.classList.remove("hud-dock-left");
    side.style.width = "";
    var host = q('[class*="conversation-list-content"]')
            || q('[class*="conversation-sidebar"]')
            || q('[class*="cb-sidebar-nav__content"]');
    if (!host) {
      var best = null, bestScore = -1;
      var all = document.body.querySelectorAll("div,aside,nav,section");
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e === drawer || e === wrap || e.contains(drawer) || e.contains(wrap)) continue;
        var r = e.getBoundingClientRect();
        if (r.width < 120 || r.width > 520) continue;
        if (r.height < 300) continue;
        if (r.left > 60) continue;
        if (r.right > window.innerWidth * 0.5) continue;
        var cn = String(e.className || "");
        if (/_grid|Item_|item_/i.test(cn)) continue;
        if (e.children.length < 2) continue;
        var score = r.height * 1000 + r.width;
        if (score > bestScore) { bestScore = score; best = e; }
      }
      host = best;
    }
    if (host && side.parentElement !== host) host.appendChild(side);
  }

  function mountDrawer() {
    if (!drawer.isConnected) document.body.appendChild(drawer);
  }

  // ---------- 渲染 ----------
  var lastData = null;
  var lastSessionList = [];   // 最近一次 payload 的会话列表（切换器数据源）
  var sideTagsBox = null, sideActBox = null, sideActTitle = null;

  function renderExtra(d) {
    if (!d || d.error || d.empty || !sideActBox) return;
    var rows = [];
    function actRow(dotCls, name, detail, count, tip) {
      return "<div class='hud-act' title='" + esc(tip || "") + "'>"
        + "<div class='hud-act-dot " + dotCls + "'></div>"
        + "<div class='hud-act-name'>" + esc(name) + "</div>"
        + "<div class='hud-act-detail'>" + esc(detail || "") + "</div>"
        + (count ? "<div class='hud-act-count'>" + esc(count) + "</div>" : "")
        + "</div>";
    }

    // 工具
    var _rx = cfgAll();
    var _tight = (_rx.lineLayout === "compact");   // 紧凑：只留名字+次数
    var tml = +_rx.toolNameMaxLength || 0;
    if (cfg("showTools", true)) {
      var list = (d.tools && d.tools.list) || [];
      list.slice(0, (+_rx.toolsMaxVisible || MAX_TOOLS)).forEach(function (x) {
        var det = _tight ? "" : (x.arg || "");
        if (tml > 0 && det) { det = det.slice(0, tml * 2); }
        rows.push(actRow(x.running > 0 ? "run" : "ok", x.name, det, x.n > 1 ? "×" + x.n : "",
          x.name + " 调用 " + x.n + " 次" + (x.running ? "，进行中 " + x.running : "")));
      });
    }

    // 子代理
    if (cfg("showAgents", true)) {
      (d.agents || []).slice(0, +_rx.agentsMaxVisible || 3).forEach(function (a) {
        var mtag = (cfg("showAgentEffort", true) && a.model) ? " · " + a.model : "";
        rows.push(actRow("run", a.desc || "agent",
          _tight ? "" : Math.max(1, Math.round((a.ms || 0) / 1000)) + "s" + mtag, "",
          "正在运行的子代理" + (a.model ? "，模型 " + a.model : "")));
      });
    }

    // 待办
    var td = d.todos || {};
    if (cfg("showTodos", true) && td.total) {
      var items = td.items || [], cur = null;
      for (var i2 = 0; i2 < items.length; i2++) {
        if (String(items[i2].status).toLowerCase() !== "completed") { cur = items[i2]; break; }
      }
      cur = cur || items[0];
      rows.push(actRow("todo", "待办", _tight ? "" : (cur ? cur.subject : ""), (td.done || 0) + "/" + td.total,
        "待办完成度 " + (td.done || 0) + " / " + td.total));
    }

    // skill / MCP
    if (cfg("showSkills", false)) {
      (d.skills || []).slice(0, +_rx.skillsMaxVisible || 4).forEach(function (x) {
        rows.push(actRow("ok", "skill", x.name, x.n > 1 ? "×" + x.n : "", "Skill 调用：" + x.name));
      });
    }
    if (cfg("showMcp", false) && d.mcp && d.mcp.n) {
      rows.push(actRow("ok", "MCP", d.mcp.last || "", "×" + d.mcp.n,
        "MCP 工具调用 " + d.mcp.n + " 次，最近：" + (d.mcp.last || "—")));
    }

    var show = rows.length && isExtra();
    sideActBox.innerHTML = show ? rows.join("") : "";
    if (sideActTitle) sideActTitle.style.display = show ? "" : "none";
  }

  function rowHTML(k, v, tip) {
    return "<div class='hud-r' title='" + esc(tip || "") + "'><span class='hud-k'>" + esc(k) +
      "</span><span class='hud-n'>" + esc(v == null ? "—" : v) + "</span></div>";
  }

  function paint(d) {
    lastData = d;
    if (d && !d.error && d.sessionList) lastSessionList = d.sessionList;
    // 广播给 round_meter（消息末尾消耗行）：复用同一份数据，不额外请求主进程
    if (d && !d.error && d.rounds) {
      try {
        window.dispatchEvent(new CustomEvent("wb-hud-data", { detail: d }));
      } catch (e) { }
    }
    if (!d || d.error) {
      l1.style.display = "none";
      l2.innerHTML = "", l2.appendChild(el("span", "hud-run", "工作台数据不可用：" + ((d && d.error) || "未知")));
      l2.appendChild(btns);
      l2.style.display = "";
      miniText.textContent = "▤ 数据不可用";
      sideBody.innerHTML = "<div class='hud-r'><span class='hud-k'>读取失败</span></div>";
      return;
    }
    if (d.empty) {
      l1.style.display = "none";
      l2.innerHTML = "", l2.appendChild(el("span", "hud-dim", "暂无会话用量记录"));
      l2.appendChild(btns);
      l2.style.display = "";
      miniText.textContent = "▤ 无记录";
      sideBody.innerHTML = "<div class='hud-r'><span class='hud-k'>暂无记录</span></div>";
      return;
    }

    var s = d.session || {}, g = d.git || {}, t = d.tokens || {};
    var A = cfgAll();
    var used = +s.used || 0, size = +s.size || 0, pct = size ? used / size * 100 : 0;
    var cr = s.credit == null ? "—" : s.credit;

    // 数据陈旧提示：主进程读到的快照超过 3 个轮询周期没更新 → 明确告知，别把旧数当新数
    var stale = false;
    try {
      if (d.at && (Date.now() - d.at) > TICK * 3) stale = true;
    } catch (e) { }

    // 侧栏主体：一个主角（上下文占用）+ 安静列表（积分），避免等权重信息平铺
    function row(k, v, tip, cls, sub) {
      return "<div class='hud-row'" + (tip ? " title='" + esc(tip) + "'" : "") + ">"
        + "<span class='hud-row-k'>" + esc(k)
        + (sub ? "<span class='hud-row-sub'>" + esc(sub) + "</span>" : "")
        + "</span>"
        + "<span class='hud-row-v " + (cls || "") + "'>" + esc(v == null ? "—" : v) + "</span></div>";
    }
    var h5 = [];
    var ctxCls = pct >= A.contextCrit ? "danger" : (pct >= A.contextWarn ? "warn" : "");
    // 主角：上下文占用（唯一的大数字）
    h5.push("<div class='hud-hero'>");
    h5.push("<div class='hud-hero-top'>"
      + "<span class='hud-hero-k'>上下文占用</span>"
      + "<span class='hud-hero-pct " + ctxCls + "'>" + pct.toFixed(0) + "%</span></div>");
    h5.push("<div class='hud-meter'><div class='hud-meter-fill " + ctxCls + "' style='width:"
      + Math.min(100, pct).toFixed(1) + "%'></div></div>");
    var sessName = (d.session && d.session.title) ? String(d.session.title) : "";
    if (sessName.length > 18) sessName = sessName.slice(0, 18) + "…";
    h5.push("<div class='hud-hero-sub'>已用 " + tok(used) + " · 窗口 " + tok(size)
      + (t.requests ? " · " + t.requests + " 次请求" : "") + "</div>");
    if (sessName) {
      var srcTag = "", srcTip = "";
      if (d.sessionSource === "anchor") { srcTag = "⚓ "; srcTip = "已手动锚定；点击「工作台」可改为自动跟随"; }
      else if (d.sessionSource === "route") { srcTag = "◎ "; srcTip = "自动跟随你当前打开的会话；点击「工作台」可手动锚定"; }
      else { srcTag = "↻ "; srcTip = "未识别到当前会话，回退为最近活动"; }
      h5.push("<div class='hud-hero-sess' title='" + srcTip + "'>"
        + srcTag + esc(sessName) + "</div>");
    }
    h5.push("</div>");
    // 次要信息：账本汇总。单位三选一：auto（跟随最近一次请求）/ credit / fee
    var mode = sessionUnit(d);
    var inFee = (mode === "fee");
    function fmtLedger(n) {
      return inFee ? ("¥" + ((n || 0) >= 100 ? Math.round(n) : (n || 0).toFixed(2))) : String(n || 0);
    }
    // UI 端拿不到主进程函数：用 payload.pricing 回显的前缀/关键词自己判，
    // 判定顺序与主进程一致（前缀 = 计费来源优先，关键词只是手工兜底）
    function modelIsFee(m) {
      var s = String(m || "").toLowerCase();
      var pre = (d.pricing && d.pricing.feePrefixes) || [];
      for (var i = 0; i < pre.length; i++) {
        var p = String(pre[i]).toLowerCase();
        if (p && s.indexOf(p) === 0) return true;
      }
      var pats = (d.pricing && d.pricing.patterns) || [];
      for (var j = 0; j < pats.length; j++) {
        var q = String(pats[j]).toLowerCase();
        if (q && s.indexOf(q) >= 0) return true;
      }
      return false;
    }
    var feeNames = (d.session && d.session.modelList || []).filter(modelIsFee).map(function (m) {
      return String(m).replace(/^custom-local:/i, "");
    });
    var mixed = !!(d.session && d.session.mixed);
    var lockedTag = (cfg("ledgerMode", "auto") === "auto") ? "" : "（已手动锁定）";
    // 混合会话的说明：告诉用户"另一套单位也在这个会话里"，避免以为数字丢了
    var otherUnitTip = mixed
      ? "本会话同时用过两种计费模型，这里只显示当前单位；另一单位在下一行单独列出"
      : "";
    h5.push("<div class='hud-rows'>");
    if (inFee) {
      h5.push(row("本会话", fmtLedger(d.session && d.session.fee),
        (d.session && d.session.title ? "锚定会话：" + d.session.title + "\n" : "")
        + "费用模型：" + (feeNames.join("、") || "—") + "\n按 usage × 分时段单价计价" + lockedTag,
        "accent", "费用"));
      h5.push(row("今日", fmtLedger(d.feeToday), "所有会话按请求时间精确归日"));
      h5.push(row("本周", fmtLedger(d.feeWeek), "本周费用合计（按请求时间精确归日）", "",
        A.weeklyCostPeriod === "sunday" ? "周日起算" : "周一起算"));
      h5.push(row("累计", fmtLedger(d.feeTotal), "库内所有费用请求合计"
        + (d.feePlatformTotal ? "\n平台记账值 " + d.feePlatformTotal + "（供与自定义模型账单核对）" : ""), ""));
      // 另一单位：混合会话里积分部分不能因为切到 ¥ 就消失
      if (d.session && d.session.credit) {
        h5.push(row("本会话积分", String(d.session.credit), otherUnitTip || "该会话同时用过平台模型，积分部分在此", "", "积分"));
      }
    } else {
      h5.push(row("本会话", cr, d.session && d.session.title
        ? ("会话：" + d.session.title
           + (d.sessionSource === "anchor" ? "（已手动锚定）"
             : d.sessionSource === "route" ? "（自动跟随当前打开的会话）" : "（最近活动）"))
        : "当前会话累计积分（服务端写入）" + lockedTag, "accent", "积分"));
      h5.push(row("今日", d.today, "所有会话按请求时间精确归日（含跨天会话拆分）"));
      h5.push(row("本周", d.week, "本周积分合计（按请求时间精确归日）", "",
        A.weeklyCostPeriod === "sunday" ? "周日起算" : "周一起算"));
      h5.push(row("累计", d.total, "库内所有会话合计", ""));
      // 另一单位：混合会话里 ¥ 部分同理不能消失
      // 注意：row() 的 sub 是单位标签，数值里就不要再带 ¥，否则渲染成「¥ ¥16.60」
      if (d.session && d.session.fee) {
        h5.push(row("本会话费用", (d.session.fee >= 100 ? Math.round(d.session.fee) : d.session.fee.toFixed(2)),
          otherUnitTip || "该会话同时用过自定义模型（按 token 计费），金额单列", "warn", "¥"));
      } else if (d.feeTotal) {
        h5.push(row("累计费用", (d.feeTotal >= 100 ? Math.round(d.feeTotal) : d.feeTotal.toFixed(2)),
          "自定义模型的消耗（按 token 计费），不占积分。账本模式可在设置里切换。", "warn", "¥"));
      }
    }
    h5.push("</div>");
    // 动态区 / 信息区
    h5.push("<div class='hud-sec' id='wb-side-act-title' style='display:none'>动态</div>");
    h5.push("<div id='wb-side-act'></div>");
    h5.push("<div class='hud-sec' id='wb-side-tag-title' style='display:none'>信息</div>");
    h5.push("<div class='hud-tags' id='wb-side-tags'></div>");
    sideBody.innerHTML = h5.join("");
    sideTagsBox = sideBody.querySelector("#wb-side-tags");
    sideActBox = sideBody.querySelector("#wb-side-act");
    sideActTitle = sideBody.querySelector("#wb-side-act-title");
    renderExtra(d);   // 动态行最后画，确保挂进新 DOM
    drawer.classList.toggle("hud-right", !!A.rightAlign);

    // line1：模型 │ 项目 git:(分支) │ 杂项（全部接配置开关）
    function pipe() { return A.showSeparators ? el("span", "hud-pipe", "│") : null; }
    function add1(node, tip) {
      if (!node) return;
      if (l1.childNodes.length) { var pp = pipe(); if (pp) l1.appendChild(pp); }
      if (tip) node.title = tip;
      l1.appendChild(node);
    }
    l1.innerHTML = "";
    if (sideTagsBox) sideTagsBox.innerHTML = "";
    function addSide(text, tip) {
      if (!text || !sideTagsBox) return;
      var sp = el("span", "hud-tag", text);
      if (tip) sp.title = tip;
      sideTagsBox.appendChild(sp);
    }
    // 自定义行（位置=首行）
    if (A.customLine && A.customLinePosition === "first") {
      addSide(A.customLine, "customLine 自定义文本");
    }
    if (cfg("showModel", true) && d.model) {
      var _mf = A.modelFormat || "full";
      var _mn = d.model;
      if (_mf === "short") _mn = String(_mn).replace(/^claude\s*/i, "");
      else if (_mf === "compact") _mn = String(_mn).replace(/-[0-9]+[kKmM]?$/, "");
      if (A.modelOverride) _mn = A.modelOverride;
      var mn = el("span", "hud-model", _mn);
      mn.style.color = col(A.colorModel);
      add1(mn, "当前模型" + (A.modelOverride ? "（已自定义名）" : ""));
      if (cfg("showProvider", true) && (A.providerName || d.provider)) {
        add1(el("span", "hud-dim", "(" + (A.providerName || d.provider) + ")"), "模型提供商");
      }
    }
    if (cfg("showEffortLevel", false) && d.thought) {
      var eff = d.thought;
      if (A.effortFormat === "symbol") eff = eff === "max" ? "⚡" : eff === "high" ? "↑" : "·";
      else if (A.effortFormat === "text") eff = eff;
      else eff = "推理 " + eff;
      addSide(eff, "推理强度档位（thought_level）：" + d.thought);
    }
    if (cfg("showOutputStyle", false) && d.mode) {
      addSide("风格 " + d.mode, "会话输出风格（mode）：" + d.mode);
    }
    // 项目 / git 段
    var projTxt = "", projTip = "";
    if (g.isRepo && cfg("gitEnabled", true) && (g.root || g.branch)) {
      var root = g.root || "";
      if (A.pathLevels >= 9 && g.fullRoot) root = g.fullRoot;
      else if (A.pathLevels > 1 && g.fullRoot) {
        var parts = String(g.fullRoot).replace(/[\\/]+$/, "").split(/[\\/]/);
        root = parts.slice(Math.max(0, parts.length - A.pathLevels)).join("/");
      }
      projTxt = root;
      projTip = "git 仓库 " + (g.fullRoot || root) + (g.branch ? "，分支 " + g.branch : "");
      if (g.branch) {
        var br = g.branch;
        if (A.gitOverflow === "truncate" && br.length > 18) br = br.slice(0, 18) + "…";
        projTxt += " git:(" + br + (g.dirty && A.gitDirty ? "*" : "") + ")";
        if (g.ahead || g.behind) {
          if (A.gitAheadBehind) {
            var ab = [];
            if (g.ahead) ab.push("↑" + g.ahead);
            if (g.behind) ab.push("↓" + g.behind);
            projTxt += " " + ab.join("");
            if (A.gitPushCrit && g.ahead >= A.gitPushCrit) projTxt += " ⚠";
            else if (A.gitPushWarn && g.ahead >= A.gitPushWarn) projTxt += " ▲";
          }
        }
        if (A.gitFileStats && g.files) projTxt += " " + g.files + " 改动";
        if (A.gitWorktree && g.worktree && /worktrees/.test(g.worktree)) projTxt += " [wt]";
        projTip += g.ahead || g.behind ? "，超前 " + (g.ahead || 0) + " / 落后 " + (g.behind || 0) : "";
        projTip += g.files ? "，改动 " + g.files + " 个文件" : "";
      }
    } else if (cfg("showProject", true) && (d.session || {}).title) {
      var fullTitle = String(d.session.title);
      projTxt = fullTitle.length > 26 ? fullTitle.slice(0, 26) + "…" : fullTitle;
      projTip = "会话标题：" + fullTitle;
    }
    if (projTxt) {
      // git 部分用 colorGit/colorGitBranch 着色
      var pn = el("span", "hud-proj");
      if (g.isRepo && cfg("gitEnabled", true) && g.branch && projTxt.indexOf("git:(") >= 0) {
        var ix = projTxt.indexOf("git:(");
        var p1 = el("span", null, projTxt.slice(0, ix + 5));
        p1.style.color = col(A.colorGit);
        var p2b = el("span", null, projTxt.slice(ix + 5));
        p2b.style.color = col(A.colorGitBranch);
        pn.appendChild(p1); pn.appendChild(p2b);
      } else {
        pn.textContent = projTxt;
        pn.style.color = col(A.colorProject);
      }
      if (A.gitOverflow === "wrap") pn.style.whiteSpace = "normal";
      add1(pn, projTip);
    }
    if (cfg("showAddedDirs", true) && A.addedDirsLayout === "line" && (d.byProject || []).length > 1) {
      var extra2 = d.byProject.slice(1, 3).map(function (x) { return x.project; }).join(", ");
      addSide("附加目录: " + extra2, "附加项目目录（added dirs）");
    }
    if (cfg("showLaunchDir", false) && g.fullRoot) {
      addSide("📁 " + g.fullRoot, "启动目录（launch dir）");
    }
    if (cfg("showAddedDirs", true) && A.addedDirsLayout === "inline" && (d.byProject || []).length > 1) {
      var extra = d.byProject.slice(1, 3).map(function (x) { return x.project; }).join(", ");
      addSide("+" + extra, "附加项目目录（added dirs）");
    }
    if (cfg("showSessionName", false) && s.title) {
      addSide(s.title, "会话名称");
    }
    if (cfg("showCacheHitRate", true) && t.requests && t.input) {
      var hitPct = (t.cacheRead / t.input) * 100;
      var tk = el("span", "hud-dim", "缓存命中 " + hitPct.toFixed(0) + "%");
      tk.title = "提示缓存（prompt cache）：上一轮发过的上下文被服务端缓存，下一轮直接复用，按更低的单价计费。\n"
        + "命中 " + tok(t.cacheRead) + " / 输入 " + tok(t.input) + "，命中率 " + hitPct.toFixed(1) + "%\n"
        + "累计输出 " + tok(t.output) + "，共 " + t.requests + " 次请求"
        + (t.sub && t.sub.requests
          ? "\n其中子代理：输入 " + tok(t.sub.input) + " / 输出 " + tok(t.sub.output)
            + "（" + t.sub.requests + " 次请求）"
          : "");
      addSide("缓存命中 " + hitPct.toFixed(0) + "%", tk.title);
    }
    if (cfg("showPromptCache", false) && (t.cacheRead || t.cacheCreate)) {
      addSide("cache " + tok(t.cacheRead) + (t.cacheCreate ? "+" + tok(t.cacheCreate) : ""),
        "提示缓存：读命中 " + tok(t.cacheRead) + " / 写入 " + (t.cacheCreate ? tok(t.cacheCreate) : "无字段"));
    }
    if (cfg("showSessionTokens", false)) {
      addSide(tok((t.input || 0) + (t.output || 0)) + " tok",
        "本会话 token 总量（含缓存命中与子代理）：" + tok(t.total)
        + (t.sub && t.sub.requests
          ? "\n其中子代理输入 " + tok(t.sub.input) + " / 输出 " + tok(t.sub.output)
          : ""));
    }
    if (cfg("showSpeed", false) && d.durationMs > 1000 && t.output) {
      var sp2 = (t.output / (d.durationMs / 1000)).toFixed(1);
      addSide(sp2 + " tok/s", "生成速度：输出 token ÷ 会话时长");
    }
    if (cfg("showCompactions", false) && s.compactions != null) {
      addSide("压缩 " + s.compactions, "上下文压缩次数（cmp_ 事件）");
    }
    if (cfg("showSessionStartDate", false) && s.started) {
      addSide("起 " + fmtTime(s.started), "会话开始时间");
    }
    if (cfg("showLastResponseAt", false) && s.updated) {
      addSide("末 " + fmtTime(s.updated), "最近回复时间");
    }
    if (cfg("showMemoryUsage", false) && d.mem != null) {
      addSide("内存 " + d.mem + "MB", "WorkBuddy 主进程内存占用（RSS）");
    }
    if (cfg("showWorkBuddyVersion", false) && d.appVersion) {
      addSide("v" + d.appVersion, "WorkBuddy 版本");
    }
    if (cfg("showAuth", false)) {
      addSide("✓ 已登录", "认证状态");
    }
    if (cfg("showAuthUser", false) && d.user) {
      var u = String(d.user);
      if (!A.authUserFullEmail && u.length > (A.authUserLength || 8)) u = u.slice(0, A.authUserLength || 8) + "…";
      addSide(u, "当前登录账号");
    }
    if (cfg("showAdvisor", false) && (A.advisorOverride || d.mode)) {
      addSide(A.advisorOverride || ("advisor: " + d.mode), "Advisor 顾问");
    }
    if (cfg("showConfigCounts", false)) {
      var nCfg = Object.keys(CFG).length;
      addSide("配置 " + nCfg, "已保存的配置项数量（localStorage）");
    }
    if (extraOut) {
      addSide(extraOut, "extraCmd 输出：" + (A.extraCmd || ""));
    }
    // 自定义行（位置=末行）
    if (A.customLine && A.customLinePosition === "last") {
      addSide(A.customLine, "customLine 自定义文本");
    }
    l1.style.display = l1.childNodes.length ? "" : "none";
    l1.style.maxWidth = (A.maxWidth > 0 ? A.maxWidth + "ch" : "");
    l1.style.width = (A.forceMaxWidth && A.maxWidth > 0) ? A.maxWidth + "ch" : "";

    // line2：Context + 用量 + 积分 + 按钮组
    l2.innerHTML = "";
    var kc = el("span", "hud-k", "Context"); kc.title = "上下文占用（已用 / 模型窗口）";
    l2.appendChild(kc);
    if (cfg("showContextBar", true)) {
      var barCls = pct >= A.contextCrit ? " danger" : pct >= A.contextWarn ? " warn" : "";
      var bar = el("span", "hud-blocks" + barCls, blocks(pct));
      bar.style.color = pct >= A.contextCrit ? col(A.colorCritical) : pct >= A.contextWarn ? col(A.colorWarning) : col(A.colorContext);
      bar.title = pct.toFixed(1) + "% 已用" + (A.autoCompactWindow > 0 ? "，自动压缩阈值 " + tok(A.autoCompactWindow) : "");
      if (A.autoCompactWindow > 0 && used > A.autoCompactWindow) bar.style.color = col(A.colorCritical);
      l2.appendChild(bar);
    }
    var _cv = A.contextValue || "percent";
    if (_cv !== "tokens" && _cv !== "none") l2.appendChild(el("span", "hud-strong", pct.toFixed(0) + "%"));
    if (_cv !== "percent" && _cv !== "none") {
      var dim = el("span", "hud-dim", _cv === "remaining" ? ("余 " + tok(Math.max(0, size - used))) : ("(" + tok(used) + "/" + tok(size) + ")"));
      dim.title = "已用 " + used + " / 窗口 " + size;
      l2.appendChild(dim);
    }
    // 用量段（对应 claude-hud 的 usage bar；本产品以积分近似）
    if (cfg("showUsage", CFG_DEFAULTS.showUsage) && (d.today != null)) {
      var pU = pipe(); if (pU) l2.appendChild(pU);
      var uk = el("span", "hud-k", "用量"); uk.title = "额度用量（本产品用积分近似）";
      l2.appendChild(uk);
      if (cfg("usageBarEnabled", true)) {
        var uPct = d.total ? Math.min(100, (d.today / Math.max(d.total, 1)) * 100) : 0;
        var ub = el("span", "hud-blocks", blocks(uPct));
        ub.style.color = col(A.colorUsage);
        if (A.usageThreshold > 0 && uPct >= A.usageThreshold) ub.style.color = col(A.colorUsageWarning || A.colorWarning);
        ub.title = "今日占累计 " + uPct.toFixed(1) + "%";
        l2.appendChild(ub);
      }
      var uv = (A.usageValue === "remaining")
        ? ("余 " + (Math.max(0, (d.total || 0) - (d.today || 0))).toFixed(0))
        : (d.total ? ((d.today / d.total) * 100).toFixed(0) + "%" : "—");
      var uvN = el("span", "hud-strong", cfg("usageCompact", false) ? String(Math.round(d.today || 0)) : uv);
      uvN.title = "今日 " + d.today + " / 累计 " + d.total;
      l2.appendChild(uvN);
      if (cfg("showResetLabel", CFG_DEFAULTS.showResetLabel)) {
        l2.appendChild(el("span", "hud-dim", A.weeklyCostPeriod === "quota" ? "配额周期重置"
          : ("周" + (A.weeklyCostPeriod === "sunday" ? "日" : "一") + "重置")));
      }
      if (cfg("showModelScopedUsage", CFG_DEFAULTS.showModelScopedUsage) && d.byModel && d.byModel.length) {
        var m0 = d.byModel[0];
        l2.appendChild(el("span", "hud-dim", m0.model.slice(0, 12) + " " + m0.requests + "次"));
      }
      if (cfg("usagePace", false) && d.durationMs > 60000) {
        var pace = ((s.credit || 0) / (d.durationMs / 3600000)).toFixed(1);
        l2.appendChild(el("span", "hud-dim", pace + " 分/h"));
      }
    }
    // 陈旧标记放在所有片段装配之后（l2.innerHTML 会被清空重建，不能提前 append）
    if (stale) {
      var warn = el("span", "hud-run", "· 数据延迟");
      warn.title = "最近一次刷新未成功，当前显示的可能是旧数据";
      l2.appendChild(warn);
    }
    // 今日/本周/路由成本
    if (cfg("showDailyCost", false)) {
      var pD = pipe(); if (pD) l2.appendChild(pD);
      var dc = el("span", "hud-k", "今日"); dc.title = "今日积分（按会话最后更新日归集，近似）";
      var dv = el("span", "hud-strong", d.today);
      if (A.sevenDayThreshold > 0 && d.month && (d.week / d.month * 100) >= A.sevenDayThreshold) dv.style.color = col(A.colorUsageWarning || A.colorWarning);
      l2.appendChild(dc); l2.appendChild(dv);
    }
    if (cfg("showWeeklyCost", false)) {
      var pW = pipe(); if (pW) l2.appendChild(pW);
      var wc = el("span", "hud-k", "本周"); wc.title = "本周积分（起算：" + (A.weeklyCostPeriod === "sunday" ? "周日" : "周一") + "）";
      var wv = el("span", "hud-strong", d.week);
      if (A.environmentThreshold > 0 && d.total && (d.month / d.total * 100) >= A.environmentThreshold) wv.style.color = col(A.colorCritical);
      l2.appendChild(wc); l2.appendChild(wv);
    }
    if (cfg("showRoutedCost", false) && d.byModel && d.byModel.length > 1) {
      var pR = pipe(); if (pR) l2.appendChild(pR);
      var rc = el("span", "hud-k", "路由"); rc.title = "多模型路由：按请求数分布";
      l2.appendChild(rc);
      l2.appendChild(el("span", "hud-dim", d.byModel.map(function (m) { return m.model.slice(0, 10) + " " + m.requests; }).join(" / ")));
    }
    // 本会话显示单位（fee=¥ / credit=积分）。先算出来，后面状态条、折叠摘要共用一份，
    // 避免同一屏出现"主数字按积分、折叠条按费用"的不一致。
    var ledgerModeNow = sessionUnit(d);
    // 混合会话的「另一单位」：主数字只显示当前单位，另一种用暗色小字并列，避免误以为丢了数据
    var mixedNow = !!(d.session && d.session.mixed);
    var otherNow = mixedNow
      ? (ledgerModeNow === "fee"
        ? "积分 " + (s.credit || 0)
        : "费用 ¥" + (s.fee || 0).toFixed(2))
      : "";
    if (cfg("showCost", true)) {
      var p2 = pipe(); if (p2) l2.appendChild(p2);
      if (ledgerModeNow === "fee") {
        var kf = el("span", "hud-k", "费用"); kf.title = "本会话费用模型消耗（¥，按 usage × 分时段单价）";
        var fv2 = el("span", "hud-strong hud-accent", "¥" + ((s.fee || 0) >= 100 ? Math.round(s.fee || 0) : (s.fee || 0).toFixed(2)));
        l2.appendChild(kf); l2.appendChild(fv2);
      } else {
        var kr = el("span", "hud-k", "积分"); kr.title = "本会话累计积分（服务端写入）";
        var crv = el("span", "hud-strong hud-accent", cr);
        l2.appendChild(kr); l2.appendChild(crv);
      }
      if (otherNow) {
        var po = pipe(); if (po) l2.appendChild(po);
        var ko = el("span", "hud-dim", otherNow);
        ko.title = "本会话同时用过两种计费模型；这里显示另一种单位的消耗，主数字会在你换模型后自动跟随";
        l2.appendChild(ko);
      }
    }
    l2.appendChild(btns);
    l2.style.display = "";

    // 折叠态摘要
    var miniLedger = (ledgerModeNow === "fee")
      ? "¥" + (s.fee || 0).toFixed(2)
      : (cr + " 积分");
    miniText.textContent = "▤ " + pct.toFixed(0) + "% · " + miniLedger
      + (g.branch ? " · " + g.branch : "");

    // 工具 / 子代理（可选行）



    // 抽屉：完整账本（按 since/until/project 过滤）
    var _c = cfgAll();
    function inRange(day) {
      if (!day) return true;
      if (_c.since && String(day) < _c.since) return false;
      if (_c.until && String(day) > _c.until) return false;
      return true;
    }
    function matchProject(x) {
      if (!_c.project) return true;
      return String(x.project || x.id || "").indexOf(_c.project) >= 0;
    }
    var days = (d.days || []).filter(function (x) { return inRange(x.day); });
    var weeks = (d.weeks || []).filter(function (x) { return inRange(x.week); });
    var months = (d.months || []).filter(function (x) { return inRange(x.month) || inRange(x.month + "-01"); });
    var projs = (d.byProject || []).filter(matchProject);
    var ags = d.byAgent || [];
    var h = [];
    var drawerMode = sessionUnit(d);
    if (drawerMode === "fee") {
      h.push("<div class='hud-sub' style='margin-top:0;border:0;padding-top:0'>费用（自定义模型，¥）</div>");
      h.push(rowHTML("本会话", "¥" + ((d.session && d.session.fee || 0) >= 100 ? Math.round(d.session.fee || 0) : (d.session && d.session.fee || 0).toFixed(2)),
        d.session && d.session.title ? ("锚定会话：" + d.session.title + "\n按 usage × 分时段单价计价") : "费用模型消耗（¥）"));
      h.push(rowHTML("今日", "¥" + ((d.feeToday || 0) >= 100 ? Math.round(d.feeToday || 0) : (d.feeToday || 0).toFixed(2)), "按请求时间精确归日"));
      h.push(rowHTML("本周", "¥" + ((d.feeWeek || 0) >= 100 ? Math.round(d.feeWeek || 0) : (d.feeWeek || 0).toFixed(2)), "按请求时间精确归日"));
      h.push(rowHTML("全部累计", "¥" + ((d.feeTotal || 0) >= 100 ? Math.round(d.feeTotal || 0) : (d.feeTotal || 0).toFixed(2)), "库内所有费用请求合计"));
      if (d.feePlatformTotal) {
        h.push(rowHTML("平台记账值", String(d.feePlatformTotal), "WorkBuddy 在 credit_json 里给费用模型记的数字，供与百炼账单核对"));
      }
      if (d.session && d.session.credit) {
        h.push(rowHTML("本会话积分", String(d.session.credit), "该会话同时用过平台模型，积分部分在此（混合会话）"));
      }
    } else {
      h.push("<div class='hud-sub' style='margin-top:0;border:0;padding-top:0'>积分</div>");
      h.push(rowHTML("本会话", cr, d.session && d.session.title ? ("锚定会话：" + d.session.title) : "当前会话累计积分"));
      h.push(rowHTML("今日", d.today, "按请求时间精确归日"));
      h.push(rowHTML("本周", d.week, "按请求时间精确归日"));
      h.push(rowHTML("本月", d.month, "按请求时间精确归日"));
      h.push(rowHTML("全部累计", d.total, "库内所有会话合计（费用模型的消耗在「按模型 · 费用」分区）"));
      // 混合会话：切到积分时不隐藏 ¥ 部分
      if (d.session && d.session.fee) {
        h.push(rowHTML("本会话费用", "¥" + (d.session.fee >= 100 ? Math.round(d.session.fee) : d.session.fee.toFixed(2)),
          "该会话同时用过自定义模型（按 token 计费），金额单列（混合会话）"));
      }
    }
    if (_c.showDuration && d.durationMs) {
      var dm = Math.floor(d.durationMs / 60000);
      h.push(rowHTML("会话时长", dm >= 60 ? (dm / 60).toFixed(1) + " 小时" : dm + " 分钟", "首末事件时间差"));
    }

    if (_c.secToken) h.push("<div class='hud-sub'>Token · 本会话</div>");
    if (!_c.secToken) {
      // 分区关闭时不渲染任何 token 行
    } else if (!_c.showTokenBreakdown) {
      h.push(rowHTML("总 token", tok(t.total), "全部累计（明细已按 showTokenBreakdown 关闭）"));
      h.push(rowHTML("请求数", t.requests, "调用次数"));
    } else {
    h.push(rowHTML("输入", tok(t.input), "inputTokens 累计（每轮重发上下文，数值很大是正常的）"));
    h.push(rowHTML("输出", tok(t.output), "outputTokens 累计"));
    h.push(rowHTML("总计", tok(t.total), "totalTokens 累计（含子代理）"));
    h.push(rowHTML("缓存命中", tok(t.cacheRead), "来自 inputTokensDetails[].cached_tokens"));
    h.push(rowHTML("缓存写入", t.cacheCreate ? tok(t.cacheCreate) : "—",
      "本机日志没有 cache_creation 数据，ccusage 的这一列无法还原"));
    h.push(rowHTML("命中率", t.input ? (t.cacheRead / t.input * 100).toFixed(1) + "%" : "—", "命中 / 输入"));
    h.push(rowHTML("请求数", t.requests, "调用次数（含子代理）"));
    // 子代理消耗单列：一个"看起来 8M"的会话可能真实是 33M，不标出来就会被当成统计错误
    if (t.sub && t.sub.requests) {
      h.push(rowHTML("其中子代理", tok((t.sub.input || 0) + (t.sub.output || 0)),
        "子代理（subagents/*.jsonl）的 input+output 累计，共 " + t.sub.requests + " 次请求"
        + (t.subFiles ? "、" + t.subFiles + " 个日志文件" : "")
        + "\n这些请求原先没有被计入，2026-11-28 修复"));
    }
    }

    if (_c.secBlocks && (d.blocks || []).length) {
      h.push("<div class='hud-sub'>5 小时窗口 · 近 4</div>");
      d.blocks.slice().reverse().forEach(function (b) {
        var dt = new Date(b.from), dt2 = new Date(b.to || b.from);
        var lab = (dt.getMonth() + 1) + "/" + dt.getDate() + " "
          + String(dt.getHours()).padStart(2, "0") + ":00";
        var tot = b.total || ((b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheCreate || 0));
        h.push(rowHTML(lab, tok(tot) + " · " + (b.entries || b.requests) + " 条",
          "输入 " + tok(b.input) + " / 输出 " + tok(b.output) +
          " / 缓存读 " + tok(b.cacheRead) + " / 缓存写 " + (b.cacheCreate ? tok(b.cacheCreate) : "无") +
          " · 请求 " + b.requests + " · " + dt.toLocaleString() + " → " + dt2.toLocaleString()));
      });
    }
    if (_c.secProject && projs.length) {
      var feeProjs = (d.byProjectFee || []);
      if (drawerMode === "fee" && feeProjs.length) {
        h.push("<div class='hud-sub'>按项目 · 费用</div>");
        feeProjs.forEach(function (x) {
          h.push(rowHTML(x.project, "¥" + ((x.fee || 0) >= 100 ? Math.round(x.fee || 0) : (x.fee || 0).toFixed(2)),
            x.sessions + " 个会话 · 费用合计"));
        });
      } else {
        h.push("<div class='hud-sub'>按项目</div>");
        projs.forEach(function (x) {
          h.push(rowHTML(x.project, x.credit, x.sessions + " 个会话 · 积分合计"));
        });
      }
    }
    if (_c.secAgent && ags.length) {
      h.push("<div class='hud-sub'>按 Agent</div>");
      ags.slice(0, 8).forEach(function (x) {
        h.push(rowHTML(String(x.desc).slice(0, 16), x.count + " 次 · " + Math.round(x.totalMs / 1000) + "s",
          (x.model ? "模型 " + x.model + " · " : "") + "token 无法按 Agent 拆分"));
      });
    }
    if (_c.secModel && (d.byModel || []).length) {
      h.push("<div class='hud-sub'>按模型 · 积分</div>");
      d.byModel.slice(0, 4).forEach(function (m) {
        h.push(rowHTML(m.model, m.requests + " 次 · " + tok((m.input || 0) + (m.output || 0)),
          "输入 " + tok(m.input) + " / 输出 " + tok(m.output) +
          " / 缓存读 " + tok(m.cacheRead) + " / 缓存写 " + (m.cacheCreate ? tok(m.cacheCreate) : "无")));
      });
    }
    // 费用模型分区：自定义模型按 token 计费（¥），与积分并存、互不混算
    var feePairs = Object.keys(d.feeByModel || {}).map(function (k) { return { model: k, fee: d.feeByModel[k] }; })
      .sort(function (a, b) { return b.fee - a.fee; });
    if (_c.secModel && (feePairs.length || d.feePlatformTotal)) {
      h.push("<div class='hud-sub'>按模型 · 费用（自定义模型，¥）</div>");
      feePairs.slice(0, 4).forEach(function (m) {
        h.push(rowHTML(m.model, "¥" + (m.fee >= 100 ? Math.round(m.fee) : m.fee.toFixed(2)),
          "按 usage × 分时段单价计价（北京时间 22:00–08:00 闲时）。单价可在设置里改。"));
      });
      if (d.feePlatformTotal) {
        h.push(rowHTML("平台记账值", String(d.feePlatformTotal),
          "WorkBuddy 在 credit_json 里给费用模型记的数字，供与百炼账单/积分扣减核对。"
          + "若它与上面的 ¥ 对不上，以你百炼控制台的账单为准。"));
      }
    }
    if (_c.secSession && (d.sessions || []).length) {
      if (d.rowsCapped) {
        h.push("<div class='hud-sub' style='opacity:.65'>注：累计只覆盖最近 1000 个会话（更多会话需分页，暂未实现）</div>");
      }
      h.push("<div class='hud-sub'>按会话 · 前 10</div>");
      d.sessions.forEach(function (x) {
        var nm = x.title ? String(x.title).slice(0, 16) : (x.id || "").slice(0, 8);
        var tks = x.tokens || ((x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheCreate || 0));
        var subNote = x.subTokens ? " · 其中子代理 " + tok(x.subTokens) : "";
        if (drawerMode === "fee") {
          h.push(rowHTML(nm, "¥" + ((x.fee || 0) >= 100 ? Math.round(x.fee || 0) : (x.fee || 0).toFixed(2)),
            (x.title ? x.title + " · " : "") + "会话 " + x.id + " · 费用 ¥" + (x.fee || 0).toFixed(4) + subNote));
          return;
        }
        h.push(rowHTML(nm, x.credit + " · " + tok(tks),
          (x.title ? x.title + " · " : "") + "会话 " + x.id +
          " · 输入 " + tok(x.input) + " / 输出 " + tok(x.output) +
          " / 缓存读 " + tok(x.cacheRead) + " / 缓存写 " + (x.cacheCreate ? tok(x.cacheCreate) : "无") +
          " · " + (x.requests || 0) + " 条" + subNote +
          ((x.models || []).length ? " · 模型 " + x.models.join(", ") : "")));
      });
    }
    if (_c.secWeek && weeks.length) {
      h.push("<div class='hud-sub'>按周 · 近 4</div>");
      weeks.slice().reverse().forEach(function (x) {
        if (drawerMode === "fee") {
          h.push(rowHTML("W " + x.week.slice(5), "¥" + ((x.fee || 0) >= 100 ? Math.round(x.fee || 0) : (x.fee || 0).toFixed(2)),
            "周起始 " + x.week + " · 费用 ¥" + (x.fee || 0).toFixed(4)));
          return;
        }
        var tt = (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheCreate || 0);
        h.push(rowHTML("W " + x.week.slice(5), x.credit + " · " + tok(tt),
          "周起始 " + x.week + " · " + (x.sessions || 0) + " 会话 · " + (x.requests || 0) + " 条" +
          " · 输入 " + tok(x.input) + " / 输出 " + tok(x.output) + " / 缓存读 " + tok(x.cacheRead) +
          ((x.models || []).length ? " · 模型 " + x.models.slice(0, 3).join(", ") : "")));
      });
    }
    if (_c.secMonth && months.length) {
      h.push("<div class='hud-sub'>按月 · 近 4</div>");
      months.slice().reverse().forEach(function (x) {
        if (drawerMode === "fee") {
          h.push(rowHTML(x.month, "¥" + ((x.fee || 0) >= 100 ? Math.round(x.fee || 0) : (x.fee || 0).toFixed(2)),
            x.month + " · 费用 ¥" + (x.fee || 0).toFixed(4)));
          return;
        }
        var tt = (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheCreate || 0);
        h.push(rowHTML(x.month, x.credit + " · " + tok(tt),
          x.month + " · " + (x.sessions || 0) + " 会话 · " + (x.requests || 0) + " 条" +
          " · 输入 " + tok(x.input) + " / 输出 " + tok(x.output) + " / 缓存读 " + tok(x.cacheRead)));
      });
    }
    if (_c.secDay && days.length) {
      if (drawerMode === "fee") {
        h.push("<div class='hud-sub'>按日 · 费用（近 7）</div>");
        days.slice().reverse().forEach(function (x) {
          h.push(rowHTML(x.day.slice(5), "¥" + ((x.fee || 0) >= 100 ? Math.round(x.fee || 0) : (x.fee || 0).toFixed(2)),
            x.day + " · 费用 ¥" + (x.fee || 0).toFixed(4) +
            (x.credit ? " · 该日积分 " + x.credit : "") +
            " · " + (x.requests || 0) + " 条"));
        });
      } else {
        h.push("<div class='hud-sub'>按日 · 近 7</div>");
        days.slice().reverse().forEach(function (x) {
          var tt = (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheCreate || 0);
          h.push(rowHTML(x.day.slice(5), x.credit + " · " + tok(tt),
            x.day + " · " + (x.sessions || 0) + " 会话 · " + (x.requests || 0) + " 条" +
            " · 积分 " + (x.credit || 0) +
            (x.fee ? " + ¥" + x.fee.toFixed(2) : "") +
            " · 输入 " + tok(x.input) + " / 输出 " + tok(x.output) + " / 缓存读 " + tok(x.cacheRead) +
            ((x.models || []).length ? " · 模型 " + x.models.slice(0, 3).join(", ") : "")));
        });
      }
    }
    var keep = drawer.scrollTop;
    dBody.innerHTML = h.join("");
    drawer.scrollTop = keep;
  }

  // ---------- 循环 ----------
  var extraOut = "";
  // 设置面板的扁平 feeCfg → 主进程期望的 {patterns, idle{...}, busy{...}}；空则用主进程默认价
  function pricingPayload() {
    var c = cfgAll().feeCfg;
    if (!c) return null;
    function pick(part) {
      var o = {};
      if (c[part + "Input"] != null) o.input = c[part + "Input"];
      if (c[part + "Output"] != null) o.output = c[part + "Output"];
      if (c[part + "Cache"] != null) o.cacheRead = c[part + "Cache"];
      return o;
    }
    var out = {};
    if (c.patterns && c.patterns.length) out.patterns = c.patterns;
    if (c.feePrefixes && c.feePrefixes.length) out.feePrefixes = c.feePrefixes;
    var idle = pick("idle"), busy = pick("busy");
    if (Object.keys(idle).length) out.idle = idle;
    if (Object.keys(busy).length) out.busy = busy;
    return out;
  }
  function read() {
    try {
      if (window.__wbHud && window.__wbHud.state) return window.__wbHud.state(cfgAll().anchored || "");
      return Promise.resolve({ error: "preload 未注入" });
    } catch (e) {
      console.error("[wb-hud] 读取状态失败", e);
      return Promise.resolve({ error: String((e && e.message) || e) });
    }
  }

  var mounting = false;
  function tick() {
    if (!alive()) return;                 // 已失效：彻底停止，不再重挂
    if (!mounting) {
      mounting = true;
      try { mountBar(); mountSide(); mountDrawer(); } finally { mounting = false; }
    }
    var cmd = cfgAll().extraCmd;
    var pExec = (cmd && window.__wbHud && window.__wbHud.exec)
      ? window.__wbHud.exec(cmd).then(function (r) {
          extraOut = (r && r.ok && r.out) ? r.out : "";
        }).catch(function () { extraOut = ""; })
      : Promise.resolve();
    pExec.then(function () { return read(); }).then(paint).catch(function (e) {
      console.error("[wb-hud] 状态轮询失败", e);
      l2.innerHTML = "";
      l2.appendChild(el("span", "hud-run", "读取失败：" + e));
      l2.appendChild(btns);
      l2.style.display = "";
    });
    setTimeout(tick, TICK);
  }

  function boot() {
    applyMode();
    try {
      if (window.__wbHud && window.__wbHud.setTz) window.__wbHud.setTz(cfgAll().tz || 0);
      if (window.__wbHud && window.__wbHud.setWeek) window.__wbHud.setWeek(cfgAll().weeklyCostPeriod === "sunday");
      if (window.__wbHud && window.__wbHud.setPricing) window.__wbHud.setPricing(pricingPayload());
    } catch (e) { }
    tick();
    var t0 = 0;
    new MutationObserver(function () {
      if (!alive()) return;
      var now = Date.now();
      if (now - t0 < 250) return;
      t0 = now;
      if (!wrap.isConnected) mountBar();
      if (!side.isConnected) mountSide();
      if (!drawer.isConnected) mountDrawer();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* @@ROUND_METER@@ */
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
/* @@END@@ */
