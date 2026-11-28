/* 主进程扫描逻辑的回归测试（直接用 ui/main_addon.js 里的真实代码，只切片不重写）。
 *
 * 背景（2026-11-28）：客户端把子代理的请求写在 <会话ID>/subagents/*.jsonl，
 * 主进程原先只扫 <会话ID>.jsonl，于是账本漏掉子代理的 token 与费用
 * （实测某会话主文件 7.98M、子代理 25.06M，界面只显示 8M、费用少算 78%）。
 *
 * 这里验证四件事：
 *   1) 子代理文件能被发现并计入同一会话
 *   2) 子代理部分单独记一份（h.sub），用于"其中子代理"展示
 *   3) 增量追加不会重复计数
 *   4) 文件被重写（截断）时整会话重建，数字不丢也不翻倍
 *
 * 用法：node scripts/test_hist_scan.js [main_addon.js 路径]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAIN = process.argv[2] || path.join(__dirname, "..", "ui", "main_addon.js");
const src = fs.readFileSync(MAIN, "utf8");

const a = src.indexOf("    var SUBMAP = {");
const b = src.indexOf("    function findJsonl(sid) {");
if (a < 0 || b < 0 || b <= a) {
  console.error("[x] 切片失败：main_addon.js 里找不到扫描段（SUBMAP / findJsonl 边界）");
  process.exit(2);
}
const block = src.slice(a, b);

// 源码里这两个工具定义在切片之外，按其语义注入
function _fkey(p) { return String(p || "").replace(/\\/g, "/"); }
function _cached(u) {
  if (!u) return 0;
  let c = 0;
  if (u.inputTokensDetails && u.inputTokensDetails.length) {
    for (let i = 0; i < u.inputTokensDetails.length; i++) c += (u.inputTokensDetails[i].cached_tokens || 0);
  }
  if (!c) c = u.cache_read_input_tokens || u.cacheReadInputTokens || 0;
  return c;
}
function cridMs(id) {
  const ms = parseInt(String(id || "").slice(0, 12), 16);
  return (ms >= 1420070400000 && ms <= 4102444800000) ? ms : 0;
}

const HIST = {}, HSCAN = {}, FILES = {};
const fileMap = () => FILES;
const api = new Function("fs", "path", "fileMap", "HIST", "HSCAN", "_fkey", "_cached", "cridMs",
  block + "\nreturn { histOf: histOf, subFiles: subFiles };")(
  fs, path, fileMap, HIST, HSCAN, _fkey, _cached, cridMs);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-hist-"));
const SID = "aaaa1111-2222-3333-4444-555566667777";
const proj = path.join(tmp, "proj");
fs.mkdirSync(path.join(proj, SID, "subagents"), { recursive: true });
const mainFile = path.join(proj, SID + ".jsonl");
const subFile = path.join(proj, SID, "subagents", "agent-x.jsonl");

function row(crid, model, i, o, cr) {
  return JSON.stringify({ timestamp: Date.now(), providerData: {
    conversationRequestId: crid, requestModelId: model,
    usage: { inputTokens: i, outputTokens: o, requests: 1,
             inputTokensDetails: [{ cached_tokens: cr }] } } }) + "\n";
}

let fails = 0;
function ok(name, cond, detail) {
  console.log((cond ? "  [ok] " : "  [x] ") + name + (cond ? "" : "  " + (detail || "")));
  if (!cond) fails++;
}

try {
  fs.writeFileSync(mainFile, row("01a21d61ddda73c9b9e56f784b078fc5", "custom-local:deepseek-v4.1-flash-1017", 1000000, 1000, 0));
  fs.writeFileSync(subFile, row("01a21d6ab91b7a8783dbc6b9cb184700", "custom-local:deepseek-v4.1-flash-1017", 5000000, 5000, 0));
  FILES[SID] = mainFile;

  let h = api.histOf(SID, mainFile);
  ok("子代理文件被发现", api.subFiles(SID).length === 1, JSON.stringify(api.subFiles(SID)));
  ok("input 汇总含子代理（6,000,000）", h.input === 6000000, String(h.input));
  ok("sub.input 单列（5,000,000）", h.sub.input === 5000000, String(h.sub.input));
  ok("requests 计 2 次", h.requests === 2, String(h.requests));
  ok("reqModels 两个请求都在", Object.keys(h.reqModels).length === 2, JSON.stringify(Object.keys(h.reqModels)));
  ok("主线程最近请求被单独记录（单位判定用）", h.lastMainModel === "custom-local:deepseek-v4.1-flash-1017",
    String(h.lastMainModel));

  fs.appendFileSync(subFile, row("01a21d6ab91b7a8783dbc6b9cb184701", "custom-local:deepseek-v4.1-flash-1017", 100, 10, 0));
  h = api.histOf(SID, mainFile);
  ok("追加后不重复计数（input=6,000,100）", h.input === 6000100, String(h.input));

  fs.writeFileSync(subFile, row("01a21d6ab91b7a8783dbc6b9cb184700", "custom-local:deepseek-v4.1-flash-1017", 2000000, 2000, 0));
  h = api.histOf(SID, mainFile);
  ok("子代理文件被重写后整会话重建（3,000,000）", h.input === 3000000, String(h.input));
  ok("重建后 sub.input 正确（2,000,000）", h.sub.input === 2000000, String(h.sub.input));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? "\nFAIL " + fails : "\nPASS 全部通过");
process.exit(fails ? 1 : 0);
