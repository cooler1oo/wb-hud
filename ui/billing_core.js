/* 计费核心（唯一真源）。由 tools/sync_billing.py 整段内联进 ui/main_addon.js，
 * 数据部分（BILLING_DEFAULTS）由 tools/billing.json 生成。
 *
 * 为什么这样分层（2026-11-26 重构）：
 *   旧实现用「模型名包含某关键词」判断是否按 token 计费，而真正的计费依据是
 *   请求走的是谁的密钥——也就是 requestModelId 的前缀（custom-local: = 用户自带
 *   密钥，按 token 付费；无前缀 = 平台模型，扣积分）。模型名会随版本变
 *   （deepseek-v4.1-flash-1017 → deepseek-v4.1-flash），前缀不会。
 *   实测全库 29481 条请求：只有 custom-local: 和「无前缀」两种，前者的模型名
 *   恰好与平台同名，旧判定只是"碰巧命中"，换一个自定义模型就会全盘失效。
 *
 * 纯函数、无 DOM、无 require：主进程内联可用，Node 测试可 eval 后调用。
 */
var WBBilling = (function () {
  var BILLING_DEFAULTS = /* @@BILLING_JSON@@ */
    {
      "_note": "计费规则唯一真源。改完运行 `python tools/sync_billing.py`，再重新安装（install.cmd）生效。判定依据是 requestModelId 的前缀（计费来源），不是模型名——模型名会随版本变，前缀不会。",
      "version": 2,
      "tzOffset": 8,
      "feePrefixes": [
        "custom-local:"
      ],
      "feePatterns": [],
      "idleHours": [
        22,
        8
      ],
      "pricing": {
        "default": {
          "idle": {
            "input": 1.0,
            "output": 4.0,
            "cacheRead": 0.02
          },
          "busy": {
            "input": 2.0,
            "output": 8.0,
            "cacheRead": 0.04
          }
        },
        "models": {
          "deepseek-v4.1-flash-1017": {
            "idle": {
              "input": 1.0,
              "output": 4.0,
              "cacheRead": 0.02
            },
            "busy": {
              "input": 2.0,
              "output": 8.0,
              "cacheRead": 0.04
            }
          }
        }
      }
    }
/* @@END_BILLING_JSON@@ */;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 用户配置（UI 设置面板）与默认值合并。只覆盖全局单价，不动按模型的价格表
  function merge(override) {
    var base = clone(BILLING_DEFAULTS);
    if (!override || typeof override !== "object") return base;
    if (override.feePrefixes && override.feePrefixes.length) base.feePrefixes = override.feePrefixes.slice();
    if (override.patterns && override.patterns.length) base.feePatterns = override.patterns.slice();
    var def = base.pricing && base.pricing["default"];
    if (def) {
      if (override.idle) for (var k in override.idle) if (override.idle[k] != null) def.idle[k] = +override.idle[k];
      if (override.busy) for (var k2 in override.busy) if (override.busy[k2] != null) def.busy[k2] = +override.busy[k2];
    }
    return base;
  }

  function lower(s) { return String(s == null ? "" : s).toLowerCase(); }

  // 去掉提供方前缀，得到模型本名（用于价格表匹配）
  function bareName(modelId) {
    var s = String(modelId == null ? "" : modelId);
    var i = s.indexOf(":");
    return lower(i >= 0 ? s.slice(i + 1) : s);
  }

  /* 计费单位：'fee'（按 token 付费，¥）或 'credit'（扣积分）。
   * 判定顺序：前缀 → 手工关键词 → 默认积分。前缀优先，因为它表达的是计费来源。 */
  function unitOf(modelId, cfg) {
    if (!modelId) return "credit";
    var s = lower(modelId);
    var pre = (cfg && cfg.feePrefixes) || [];
    for (var i = 0; i < pre.length; i++) {
      var p = lower(pre[i]);
      if (p && s.indexOf(p) === 0) return "fee";
    }
    var pats = (cfg && cfg.feePatterns) || [];
    for (var j = 0; j < pats.length; j++) {
      var q = lower(pats[j]);
      if (q && s.indexOf(q) >= 0) return "fee";
    }
    return "credit";
  }

  function isFeeModel(modelId, cfg) { return unitOf(modelId, cfg) === "fee"; }

  /* 价格：按模型名最长匹配 models 表，未命中回落 default 并标 known=false。
   * known=false 表示"这个模型没有配单价，金额是估算"——宁可标出来，也不假装精确。 */
  function priceOf(modelId, cfg) {
    var def = (cfg && cfg.pricing && cfg.pricing["default"]) || {
      idle: { input: 1, output: 4, cacheRead: 0.02 },
      busy: { input: 2, output: 8, cacheRead: 0.04 }
    };
    var models = (cfg && cfg.pricing && cfg.pricing.models) || {};
    var name = bareName(modelId), best = null, bestLen = -1;
    for (var k in models) {
      var kk = lower(k);
      if (kk && name.indexOf(kk) >= 0 && kk.length > bestLen) { best = models[k]; bestLen = kk.length; }
    }
    if (!best) return { idle: def.idle, busy: def.busy, known: false };
    var out = { idle: {}, busy: {}, known: true };
    for (var f in def.idle) out.idle[f] = def.idle[f];
    for (var f2 in (best.idle || {})) if (best.idle[f2] != null) out.idle[f2] = +best.idle[f2];
    for (var f3 in def.busy) out.busy[f3] = def.busy[f3];
    for (var f4 in (best.busy || {})) if (best.busy[f4] != null) out.busy[f4] = +best.busy[f4];
    return out;
  }

  function hourInTz(ms, tz) {
    return new Date((+ms || Date.now()) + (+tz || 0) * 3600000).getHours();
  }

  function isIdle(ms, cfg, tz) {
    var ih = (cfg && cfg.idleHours) || [22, 8];
    var h = hourInTz(ms, tz);
    return (h >= ih[0] || h < ih[1]);
  }

  /* 费用 = ((输入 - 缓存命中) × 输入单价 + 缓存命中 × 缓存单价 + 输出 × 输出单价) ÷ 1e6
   * usage 形如 {input, output, cacheRead, cacheCreate}；缺字段按 0。 */
  function calcFee(usage, ms, modelId, cfg, tz) {
    var p = priceOf(modelId, cfg);
    var pp = isIdle(ms, cfg, tz) ? p.idle : p.busy;
    var input = (usage && usage.input) || 0;
    var output = (usage && usage.output) || 0;
    var cacheRead = (usage && usage.cacheRead) || 0;
    var paid = input - cacheRead;
    if (paid < 0) paid = 0;
    return (paid * (pp.input || 0) + cacheRead * (pp.cacheRead || 0) + output * (pp.output || 0)) / 1e6;
  }

  /* conversationRequestId 前 12 位十六进制 = 请求的毫秒时间戳（ULID）。
   * 但并不是所有请求 ID 都是 ULID：实测库里混着 20 条普通 UUID，
   * 把前 12 位当十六进制解析会得到公元 5000 年，new Date() 变 Invalid Date，
   * 于是分时段单价取错档、按日聚合出现 NaN。越界一律返回 0，由调用方兜底。 */
  var TS_MIN = 1420070400000, TS_MAX = 4102444800000;   // 2015-01-01 ~ 2100-01-01
  function cridMs(id) {
    var ms = parseInt(String(id || "").slice(0, 12), 16);
    return (ms >= TS_MIN && ms <= TS_MAX) ? ms : 0;
  }

  /* 会话的计费画像（2026-11-26 重构的核心）。
   *
   * 旧实现只有一个布尔 usesFeeModel =「本会话出现过任一条费用请求」。
   * 混合会话里这个值一旦变 true 就再也不回落，于是用户切回平台模型后账本
   * 仍锁在 ¥ 模式，逐轮行把平台轮显示成 ¥0.0000。
   *
   * 现在拆成三个独立事实：
   *   unit  最近一次请求的单位（"现在正在用什么"）—— 自动模式跟它走
   *   mixed 本会话是否用过两种计费 —— 决定要不要并列显示另一单位
   *   usedFeeModel 历史事实（兼容旧字段名 usesFeeModel）
   */
  function sessionBilling(reqModels, cfg) {
    var list = [], seen = {}, hasFee = false, hasCredit = false;
    var latestModel = "", latestAt = 0;
    if (reqModels) {
      for (var k in reqModels) {
        var m = reqModels[k];
        if (!m) continue;
        if (!seen[m]) { seen[m] = 1; list.push(m); }
        var u = unitOf(m, cfg);
        if (u === "fee") hasFee = true; else hasCredit = true;
        var ms = cridMs(k);
        if (ms && ms >= latestAt) { latestAt = ms; latestModel = m; }
      }
    }
    return {
      list: list,
      unit: latestModel ? unitOf(latestModel, cfg) : "",
      model: latestModel,
      at: latestAt,
      mixed: hasFee && hasCredit,
      usedFeeModel: hasFee
    };
  }

  return {
    defaults: function () { return clone(BILLING_DEFAULTS); },
    merge: merge,
    bareName: bareName,
    unitOf: unitOf,
    isFeeModel: isFeeModel,
    priceOf: priceOf,
    isIdle: isIdle,
    calcFee: calcFee,
    cridMs: cridMs,
    sessionBilling: sessionBilling
  };
})();
