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

function row(crid, model, i, o, cr, agent, ts) {
  const pd = {
    conversationRequestId: crid, requestModelId: model,
    usage: { inputTokens: i, outputTokens: o, requests: 1,
             inputTokensDetails: [{ cached_tokens: cr }] } };
  if (agent) { pd.agent = agent; pd.isSubAgent = true; }
  return JSON.stringify({ timestamp: ts || Date.now(), providerData: pd }) + "\n";
}

// 子代理的工具调用行（type=function_call，名字在顶层 name）
function toolRow(name, agent, ts) {
  return JSON.stringify({ type: "function_call", name: name, callId: "c" + Math.random(),
    timestamp: ts || Date.now(),
    providerData: { agent: agent, isSubAgent: true } }) + "\n";
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

  // ---- 子代理按 agent 分组（动态 / token / 时长） ----
  const SID2 = "bbbb1111-2222-3333-4444-555566667777";
  fs.mkdirSync(path.join(proj, SID2, "subagents"), { recursive: true });
  const main2 = path.join(proj, SID2 + ".jsonl");
  const aFile = path.join(proj, SID2, "subagents", "agent-a.jsonl");
  const bFile = path.join(proj, SID2, "subagents", "agent-b.jsonl");
  const t0 = Date.now() - 600000, t1 = Date.now() - 420000, t2 = Date.now() - 60000;
  fs.writeFileSync(main2, row("01a21d61ddda73c9b9e56f784b078fc5", "deepseek-v4.1-flash", 1000, 10, 0, "", t0));
  fs.writeFileSync(aFile,
    row("01a21d6ab91b7a8783dbc6b9cb184700", "custom-local:deepseek-v4.1-flash-1017", 1000000, 100, 0, "software-architect", t0)
    + toolRow("Bash", "software-architect", t0 + 1000)
    + toolRow("Bash", "software-architect", t0 + 2000)
    + toolRow("Read", "software-architect", t0 + 3000)
    + row("01a21d6ab91b7a8783dbc6b9cb184701", "custom-local:deepseek-v4.1-flash-1017", 2000000, 200, 0, "software-architect", t1));
  const a2File = path.join(proj, SID2, "subagents", "agent-a2.jsonl");
  fs.writeFileSync(a2File,
    row("01a21d6ab91b7a8783dbc6b9cb184900", "custom-local:deepseek-v4.1-flash-1017", 100, 10, 0, "software-architect", t2));
  fs.writeFileSync(bFile,
    row("01a21d6ab91b7a8783dbc6b9cb184800", "custom-local:deepseek-v4.1-flash-1017", 500000, 50, 0, "software-engineer", t1)
    + toolRow("Edit", "software-engineer", t2));
  FILES[SID2] = main2;

  const h2 = api.histOf(SID2, main2);
  const ag = h2.subAgents || {};
  ok("按 agent 分成 2 组", Object.keys(ag).length === 2, JSON.stringify(Object.keys(ag)));
  ok("architect 的 token 归组正确（3,000,100）", (ag["software-architect"] || {}).input === 3000100,
    JSON.stringify(ag["software-architect"]));
  ok("architect 有 2 个日志文件", (ag["software-architect"] || {}).files === 2,
    String((ag["software-architect"] || {}).files));
  ok("architect 记 3 个请求轮次", (ag["software-architect"] || {}).turns === 3,
    JSON.stringify(ag["software-architect"] && ag["software-architect"].turns));
  const tools = (ag["software-architect"] || {}).tools || {};
  ok("architect 的工具动态（Bash×2 / Read×1）", tools.Bash === 2 && tools.Read === 1, JSON.stringify(tools));
  ok("engineer 独立成组（500,000）", (ag["software-engineer"] || {}).input === 500000,
    JSON.stringify(ag["software-engineer"]));
  // 时长 = 各文件自身跨度之和；若按"全部请求首尾差"会算成 t2-t0（隔了很久），那是假的
  const archMs = (ag["software-architect"] || {}).ms || 0;
  ok("architect 时长 = 文件跨度之和（≈3 分钟，而非跨到 t2 的 9 分钟）",
    Math.abs(archMs - (t1 - t0)) < 5, archMs + " vs 首尾差 " + (t2 - t0));
  ok("会话合计仍正确（1,000 + 3,000,100 + 500,000）", h2.input === 3501100, String(h2.input));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? "\nFAIL " + fails : "\nPASS 全部通过");
process.exit(fails ? 1 : 0);
