// WorkBuddy 工作台 · 主进程附加（追加到 main/index.js 末尾）
// 数据来源：workbuddy.db 的 session_usage/sessions + projects/<会话>.jsonl 的事件流。
// 采用增量读取（记录字节偏移），避免每次刷新全量解析。
(function () {
  try {
    var electron = require('electron');
    if (!electron || !electron.ipcMain) return;
    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var cp = require('child_process');

    var HOME = os.homedir();
    var DB = path.join(HOME, '.workbuddy', 'workbuddy.db');
    var PROJECTS = path.join(HOME, '.workbuddy', 'projects');

    var st;
    function reset(file) {
      st = {
        file: file, offset: 0, partial: '',
        model: '', provider: '',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, requests: 0 },
        events: [], startedAt: 0, endedAt: 0, agentStats: {},
        byModel: {}, tools: {}, calls: {}, agents: {}, todos: [], title: '',
        skills: {}, mcp: { n: 0, last: '' }
      };
    }
    reset(null);

    function brief(args) {
      if (!args) return '';
      try {
        var a = typeof args === 'string' ? JSON.parse(args) : args;
        var keys = ['file_path', 'path', 'pattern', 'query', 'url', 'description', 'subject'];
        for (var i = 0; i < keys.length; i++) {
          var v = a[keys[i]];
          if (typeof v === 'string' && v) {
            v = v.replace(/\\/g, '/');
            return (v.indexOf('/') >= 0 ? path.basename(v) : v).slice(0, 34);
          }
        }
        if (typeof a.command === 'string') return a.command.split(/\s+/).slice(0, 2).join(' ').slice(0, 30);
      } catch (e) { }
      return '';
    }

    function consume(line) {
      var d;
      try { d = JSON.parse(line); } catch (e) { return; }
      var t = d.type;

      if (d.providerData && d.providerData.model) {
        st.model = d.providerData.model;
        if (d.providerData.provider) st.provider = String(d.providerData.provider);
      }

      if (t === 'function_call') {
        var name = d.name || '?';
        var arg = brief(d.arguments);
        st.calls[d.callId] = { name: name, arg: arg, at: d.timestamp || 0 };
        var rec = st.tools[name] || (st.tools[name] = { n: 0, running: 0, lastArg: '' });
        rec.n++; rec.running++; rec.lastArg = arg;
        if (name === 'Skill') {
          var sn = '';
          try {
            var sa = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
            sn = (sa && (sa.skill || sa.command)) || '';
          } catch (e) { }
          var sk = st.skills[sn] || (st.skills[sn] = { name: sn || 'skill', n: 0 });
          sk.n += 1;
        }
        if (/^mcp__/.test(name)) {
          st.mcp.n += 1;
          st.mcp.last = name;
        }
        if (name === 'Agent') {
          var desc = '';
          try {
            var aa = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
            desc = (aa && (aa.description || aa.subagent_type)) || '';
          } catch (e) { }
          st.agents[d.callId] = { desc: desc || 'agent', at: d.timestamp || 0, model: st.model || '' };
        }
        if (name === 'TaskCreate') {
          var sub = '';
          try {
            var ta = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
            sub = (ta && ta.subject) || '';
          } catch (e) { }
          st.todos.push({ subject: sub || '任务', status: 'pending' });
        }
        if (name === 'TaskUpdate') {
          try {
            var ua = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
            if (ua && ua.taskId) {
              var ti = parseInt(String(ua.taskId).replace(/[^0-9]/g, ''), 10) - 1;
              if (ti >= 0 && ti < st.todos.length) {
                st.todos[ti].status = ua.status || st.todos[ti].status;
                if (ua.subject) st.todos[ti].subject = ua.subject;
              }
            }
            if (ua && ua.taskId && st.todos[ua.taskId]) {
              st.todos[ua.taskId].status = ua.status || st.todos[ua.taskId].status;
            }
          } catch (e) { }
        }
      } else if (t === 'function_call_result') {
        var c = st.calls[d.callId];
        if (c && st.tools[c.name]) {
          st.tools[c.name].running = Math.max(0, st.tools[c.name].running - 1);
        }
        if (st.agents[d.callId]) {
          var ad = st.agents[d.callId];
          var akey = ad.desc || 'agent';
          var ast = st.agentStats[akey] || (st.agentStats[akey] = { count: 0, totalMs: 0, model: ad.model || '' });
          ast.count += 1;
          ast.totalMs += Math.max(0, Date.now() - (ad.at || Date.now()));
          delete st.agents[d.callId];
        }
      } else if (t === 'ai-title') {
        st.title = d.title || st.title;
      }

      var u = d.providerData && d.providerData.usage;
      if (u) {
        var i = u.inputTokens || u.input_tokens || 0;
        var o = u.outputTokens || u.output_tokens || 0;
        var tot = u.totalTokens || u.total_tokens || (i + o);
        // 缓存命中量统一走 _cached()（见注释：cache_read_input_tokens 不可靠）
        var cr = _cached(u);
        var cc = u.cache_creation_input_tokens || 0;
        st.tokens.input += i;
        st.tokens.output += o;
        st.tokens.total += tot;
        st.tokens.cacheRead += cr;
        st.tokens.cacheCreate += cc;
        st.tokens.requests += (u.requests || 1);
        var ets = +d.timestamp || 0;
        if (ets) {
          if (!st.startedAt) st.startedAt = ets;
          st.endedAt = ets;
          st.events.push({ t: ets, i: i, o: o, cr: cr, cc: cc });
          if (st.events.length > 4000) st.events = st.events.slice(-3000);
        }
        var mk = st.model || 'unknown';
        var m = st.byModel[mk] || (st.byModel[mk] = { model: mk, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
        m.requests += 1; m.input += i; m.output += o; m.cacheRead += cr; m.cacheCreate += cc;
      }
    }

    function consumeFile(file) {
      if (st.file !== file) reset(file);
      var size;
      try { size = fs.statSync(file).size; } catch (e) { return; }
      if (size < st.offset) reset(file);
      if (size === st.offset) return;

      var len = size - st.offset;
      var buf = Buffer.alloc(len);
      var fd;
      try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, len, st.offset);
      } catch (e) {
        return;
      } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { } } }
      st.offset = size;

      var text = st.partial + buf.toString('utf8');
      var lines = text.split('\n');
      st.partial = lines.pop() || '';
      if (st.partial.length > (8 << 20)) st.partial = '';
      for (var k = 0; k < lines.length; k++) {
        var ln = lines[k].trim();
        if (ln) consume(ln);
      }
    }

    // ===== 历史 token 归集（对齐 ccusage 的 daily/session/blocks token 列）=====
    // 增量扫描各会话 JSONL，缓存聚合结果；每次 payload 最多花 250ms，不卡主进程。
    var HIST = {};    // sid -> {input,output,cacheRead,cacheCreate,requests,models:{},first,last,reqModels,reqUsage}
    var HSCAN = {};   // file -> {offset, partial}
    // 扫描结果持久化：106MB JSONL 全扫一遍很贵，重启后不能从零再来。
    // 存到插件目录的 .hist.json（只存聚合值，不含原文），按 offset 继续增量。
    // 版本号：聚合口径变更就递增，旧缓存自动作废并重扫。
    // v4（2026-11-28）：开始把 <会话ID>/subagents/*.jsonl 计入同一会话，
    // 旧缓存的数字本来就漏了子代理，继续用会"新代码 + 旧错数"。
    var CACHE_VER = 6;
    (function loadHistCache() {
      try {
        var fs2 = require('node:fs');
        var cands = [
          path.join(process.env.USERPROFILE || '', '.workbuddy', 'plugins', 'marketplaces', 'workbench-local', 'workbench-hud', 'tools', '.hist.json'),
        ];
        for (var ci = 0; ci < cands.length; ci++) {
          if (!fs2.existsSync(cands[ci])) continue;
          var j = JSON.parse(fs2.readFileSync(cands[ci], 'utf8'));
          if (j && j.hist && j.ver === CACHE_VER) {
            // 逐条补齐字段：缓存可能是"同版本但更早写入"的，缺字段会让 += 抛错
            HIST = {};
            for (var hk in j.hist) {
              var e = j.hist[hk];
              if (!e.sub) e.sub = { input: 0, output: 0, requests: 0 };
              if (!e.subAgents) e.subAgents = {};
              if (!e.subCridAgent) e.subCridAgent = {};
              if (!e._subFileAgent) e._subFileAgent = {};
              if (!e.ctxDrops) e.ctxDrops = [];
              HIST[hk] = e;
            }
            HSCAN = {};
            var src = j.hscan || {};
            for (var sk in src) HSCAN[_fkey(sk)] = src[sk];   // 载入即标准化
          }
          else if (j && j.hist && j.ver !== CACHE_VER) {
            try { fs2.unlinkSync(cands[ci]); } catch (e2) { }   // 旧版缓存直接删，重新扫
            HIST = {}; HSCAN = {};
          }
          break;
        }
      } catch (e) { }
    })();
    var histDirty = false, histSavedAt = 0;
    function saveHistCache(force) {
      if (!histDirty && !force) return;
      if (!force && Date.now() - histSavedAt < 20000) return;  // 最多 20 秒落一次盘
      try {
        var fs3 = require('node:fs');
        var p3 = path.join(process.env.USERPROFILE || '', '.workbuddy', 'plugins', 'marketplaces', 'workbench-local', 'workbench-hud', 'tools', '.hist.json');
        var hs = {};
        for (var hk in HSCAN) hs[_fkey(hk)] = HSCAN[hk];
        fs3.writeFileSync(p3, JSON.stringify({ ver: CACHE_VER, at: Date.now(), hist: HIST, hscan: hs }));
        histDirty = false; histSavedAt = Date.now();
      } catch (e) { }
    }
    var FILEMAP = { at: 0, map: null };

    function fileMap() {
      var now = Date.now();
      if (FILEMAP.map && now - FILEMAP.at < 30000) return FILEMAP.map;
      var m = {};
      try {
        var dirs = fs.readdirSync(PROJECTS);
        for (var i = 0; i < dirs.length; i++) {
          var dd = path.join(PROJECTS, dirs[i]);
          var ls;
          try { ls = fs.readdirSync(dd); } catch (e) { continue; }
          for (var j = 0; j < ls.length; j++) {
            if (ls[j].slice(-6) === '.jsonl') m[ls[j].slice(0, -6)] = path.join(dd, ls[j]);
          }
        }
      } catch (e) { }
      FILEMAP = { at: now, map: m };
      return m;
    }

    // 缓存命中 token 的统一取值：兼容三种写法，优先实测有效的那个
    function _cached(u) {
      if (!u) return 0;
      var c = 0;
      if (u.inputTokensDetails && u.inputTokensDetails.length) {
        for (var i = 0; i < u.inputTokensDetails.length; i++) {
          c += (u.inputTokensDetails[i].cached_tokens || 0);
        }
      }
      if (!c) c = u.cache_read_input_tokens || u.cacheReadInputTokens || 0;
      return c;
    }

    // 路径键标准化：客户端 findJsonl 给反斜杠，Python 预生成给正斜杠，
    // 不统一就会「键对不上 → 认为没扫过 → 整体重扫 → 在已有值上再加一遍」，
    // 实测症状是费用正好翻倍（¥2.21 → ¥4.56）。
    function _fkey(p) {
      // 只统一斜杠，不做小写化（Windows 上大小写混用，小写化反而更易错）
      return String(p || '').replace(/\\/g, '/');
    }

    /* ===== 会话日志的「一个会话可能多份文件」模型 =====
     * 实测（2026-11-28）：某会话主文件 input 7.98M，子代理另有 25.06M，
     * 旧实现只扫主文件，账本于是显示 8M、费用只算到 ¥0.76（实际 ¥3.53）。
     * 目录约定：<projects>/<项目目录>/<会话ID>/subagents/agent-*.jsonl
     * 这里把「主文件 + 子代理文件」当成同一个会话的数据源，逐文件维护扫描游标。 */
    var SUBMAP = {};             // sid -> { at, files }
    var SUBCACHE_MAX = 400;      // 防止长期运行后无限增长
    function subFiles(sid) {
      var now = Date.now();
      var hit = SUBMAP[sid];
      if (hit && now - hit.at < 5000) return hit.files;
      var out = [];
      try {
        var main = fileMap()[sid];
        if (main) {
          var dir = path.join(path.dirname(main), sid, 'subagents');
          var ls = fs.readdirSync(dir);
          for (var i = 0; i < ls.length; i++) {
            if (ls[i].slice(-6) === '.jsonl') out.push(path.join(dir, ls[i]));
          }
        }
      } catch (e) { /* 没有子代理目录是常态 */ }
      // 必须按会话缓存：payload 会遍历几百上千个会话，
      // 单条缓存会让每轮都重新 readdir 一遍，1s 轮询直接变慢。
      SUBMAP[sid] = { at: now, files: out };
      var keys = Object.keys(SUBMAP);
      if (keys.length > SUBCACHE_MAX) {
        for (var k = 0; k < keys.length - SUBCACHE_MAX / 2; k++) delete SUBMAP[keys[k]];
      }
      return out;
    }

    function newHist() {
      return {
        input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
        requests: 0, models: {}, first: 0, last: 0, compactions: 0,
        reqModels: {}, reqUsage: {}, subFiles: 0,
        sub: { input: 0, output: 0, requests: 0 },
        // 子代理按 agent 分组：动态（工具调用）、token、时长都要能单独看
        subAgents: {}, subCridAgent: {}, _subFileAgent: {},
        // 上下文变短事件（新版客户端压缩时不写 cmp_ 标记，只能从 token 轨迹看出来）
        ctxDrops: [], _lastInput: 0, _lastDropAt: 0,
        // 主线程最近一次请求：账本的"当前单位"只跟它走。
        // 子代理可能用另一套模型，让它带偏单位会显示错误的计费方式。
        lastMainAt: 0, lastMainModel: ''
      };
    }

    // 截断/重写后必须把「本会话所有文件」一起重扫：只清一个文件会把其它文件的贡献丢掉
    function rebuildHist(h, sid) {
      h.input = h.output = h.cacheRead = h.cacheCreate = h.requests = 0;
      h.models = {}; h.first = h.last = 0; h.compactions = 0;
      h.reqModels = {}; h.reqUsage = {}; h._doneKeys = {};
      h.sub = { input: 0, output: 0, requests: 0 };
      h.lastMainAt = 0; h.lastMainModel = '';
      h.subAgents = {}; h.subCridAgent = {}; h._subFileAgent = {};
      h.ctxDrops = []; h._lastInput = 0; h._lastDropAt = 0;
      var files = [fileMap()[sid]].concat(subFiles(sid));
      for (var i = 0; i < files.length; i++) {
        if (!files[i]) continue;
        HSCAN[_fkey(files[i])] = { offset: 0, partial: '' };
      }
    }

    function histOf(sid, file) {
      var h = HIST[sid] || (HIST[sid] = newHist());
      if (!file) return h;
      var subs = subFiles(sid);
      h.subFiles = subs.length;
      var rescan = scanHistFile(h, sid, file, false);
      for (var i = 0; i < subs.length; i++) {
        if (scanHistFile(h, sid, subs[i], true) === 'rebuild') rescan = 'rebuild';
      }
      if (rescan === 'rebuild') {
        rebuildHist(h, sid);
        scanHistFile(h, sid, file, false);
        for (var j = 0; j < subs.length; j++) scanHistFile(h, sid, subs[j], true);
      }
      // 每个 agent 的实际运行时长 = 其名下各文件自身跨度之和
      for (var ak2 in h.subAgents) {
        var a2 = h.subAgents[ak2], m2 = 0;
        for (var s3 in (a2.spans || {})) {
          var sp3 = a2.spans[s3];
          if (sp3 && sp3.first && sp3.last > sp3.first) m2 += (sp3.last - sp3.first);
        }
        a2.ms = m2;
      }
      return h;
    }

    function scanHistFile(h, sid, file, isSub) {
      var fk = _fkey(file);
      var sc = HSCAN[fk] || (HSCAN[fk] = { offset: 0, partial: '' });
      var size;
      try { size = fs.statSync(file).size; } catch (e) { return ''; }
      // 防御：缓存里已有累积值、但 offset 却是 0（键格式不一致等历史原因），
      // 直接认定该文件已处理完，避免再累加一遍（否则费用翻倍）
      if (sc.offset === 0 && h.requests > 0 && h._doneKeys && h._doneKeys[fk]) {
        sc.offset = size;
        return '';
      }
      if (size < sc.offset) return 'rebuild';      // 文件被截断/重写：整会话重扫
      if (size === sc.offset) return '';
      var len = Math.min(size - sc.offset, 8 << 20); // 每次最多 8MB（大 JSONL 几轮扫完，避免费用/积分长时间停在部分值）
      var buf = Buffer.alloc(len), fd;
      try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, len, sc.offset);
      } catch (e) { return ''; } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { } }
      }
      sc.offset += len;
      if (!h._doneKeys) h._doneKeys = {};
      if (sc.offset >= size) h._doneKeys[fk] = 1;
      var text = sc.partial + buf.toString('utf8');
      var lines = text.split('\n');
      sc.partial = (sc.offset >= size) ? '' : lines.pop();
      for (var li = 0; li < lines.length; li++) {
        var d;
        try { d = JSON.parse(lines[li]); } catch (e) { continue; }
        if (typeof d.id === 'string' && d.id.indexOf('cmp_') === 0) h.compactions += 1;
        // 每请求的「conversationRequestId → 模型」映射（credit_json 的键就是 conversationRequestId，
        // 实测覆盖率 100%）；顺带记录单请求 usage，供费用模型按单价计价
        var pdx = d.providerData || null;
        // 子代理逐 agent 归组：谁在干活、花了多少 token、调了哪些工具、跑了多久
        var sa = null;
        if (isSub && pdx && pdx.agent) {
          var an = String(pdx.agent);
          sa = h.subAgents[an] || (h.subAgents[an] = {
            name: an, files: 0, input: 0, output: 0, turns: 0,
            first: 0, last: 0, tools: {}, models: {},
            // 每个文件自身的首尾跨度：求和才是"实际运行时长"。
            // 用该 agent 全部请求的首尾差会跨会话中断/隔天继续，报出 15 小时这种假时长。
            spans: {}
          });
          if (!h._subFileAgent[fk]) { h._subFileAgent[fk] = an; sa.files += 1; }
          if (d.type === 'function_call' && d.name) {
            sa.tools[d.name] = (sa.tools[d.name] || 0) + 1;
          }
        }
        if (pdx && pdx.conversationRequestId) {
          var crid = pdx.conversationRequestId;
          var mdl = pdx.requestModelId || pdx.model;
          if (mdl) h.reqModels[crid] = mdl;
          // 主线程最近一次请求（决定"当前单位"），子代理请求不参与
          if (mdl && !isSub) {
            var cms = cridMs(crid);
            if (cms && cms >= (h.lastMainAt || 0)) { h.lastMainAt = cms; h.lastMainModel = mdl; }
          }
        }
        var u = d.providerData && d.providerData.usage;
        if (!u && d.message && d.message.usage) u = d.message.usage;
        if (!u) continue;
        var i2 = u.inputTokens || u.input_tokens || 0;
        var o2 = u.outputTokens || u.output_tokens || 0;
        // 缓存命中量：实测真实字段是 inputTokensDetails[0].cached_tokens；
        // cache_read_input_tokens 在本产品里几乎恒为 0（曾因只读它导致费用虚高 22 倍）
        var cr2 = _cached(u);
        var cc2 = u.cache_creation_input_tokens || 0;
        h.input += i2; h.output += o2; h.cacheRead += cr2; h.cacheCreate += cc2;
        h.requests += (u.requests || 1);
        // 子代理部分单独记一份：总数要算进去（否则漏账），但也要能说清"其中多少"，
        // 否则用户看到一个 8M 的会话变成 33M 会以为统计坏了。
        if (isSub) {
          h.sub.input += i2; h.sub.output += o2;
          h.sub.requests += (u.requests || 1);
        }
        var ts = +d.timestamp || 0;
        if (ts) { if (!h.first) h.first = ts; if (ts > h.last) h.last = ts; }
        // 上下文变短检测（只看主线程）：新版客户端压缩时不再写 cmp_ 标记，
        // 唯一可观测的信号是下一次请求的 inputTokens 明显小于上一次。
        // 实测（技术设计6）414,874→360,334 / 450,629→307,301 / 346,280→309,106，
        // 三次都无标记；旧版（技术设计2）每次压缩都伴随 ≥53% 的下跌。
        if (!isSub && i2) {
          var prevI = h._lastInput || 0;
          if (prevI >= 20000 && i2 < prevI * 0.9) {
            var lastD = h.ctxDrops[h.ctxDrops.length - 1];
            if (lastD && ts && (ts - (h._lastDropAt || 0)) <= 5 * 60000) {
              // 同一次重建可能分几步跌：并入上一条，幅度按整段算
              lastD.to = i2;
              lastD.pct = Math.round((1 - i2 / lastD.from) * 10000) / 100;
              h._lastDropAt = ts;
            } else {
              h.ctxDrops.push({
                from: prevI, to: i2, t: ts || 0,
                pct: Math.round((1 - i2 / prevI) * 10000) / 100
              });
              h._lastDropAt = ts || 0;
              if (h.ctxDrops.length > 50) h.ctxDrops = h.ctxDrops.slice(-50);
            }
          }
          h._lastInput = i2;
        }
        var mk = (d.providerData && (d.providerData.requestModelId || d.providerData.model)) || '';
        if (mk) h.models[mk] = 1;
        if (sa) {
          sa.input += i2; sa.output += o2;
          if (mk) sa.models[mk] = 1;
          if (ts) {
            if (!sa.first) sa.first = ts;
            if (ts > sa.last) sa.last = ts;
            if (!sa.spans) sa.spans = {};
            var sp = sa.spans[fk] || (sa.spans[fk] = { first: 0, last: 0 });
            if (!sp.first) sp.first = ts;
            if (ts > sp.last) sp.last = ts;
          }
        }
        var crid2 = pdx && pdx.conversationRequestId;
        if (crid2 && (i2 || o2)) {
          // 该请求属于哪个子代理（费用按请求计，所以归属也要落在请求粒度）
          if (sa && !h.subCridAgent[crid2]) { h.subCridAgent[crid2] = sa.name; sa.turns += 1; }
          // 同一请求的 usage 分散在多行（流式/多步），逐行累加。
          // 防重复：histOf 保证每行只解析一次（offset 单调推进 + partial 缓冲），
          // 且文件被截断/重扫时 reqUsage 会整体清空（见上方 size<offset 分支）。
          var ru = h.reqUsage[crid2] || (h.reqUsage[crid2] = {
            input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
            steps: 0, first: 0, last: 0, model: '', msgIds: []
          });
          ru.input += i2; ru.output += o2; ru.cacheRead += cr2; ru.cacheCreate += cc2;
          ru.steps += 1;
          if (ts) { if (!ru.first) ru.first = ts; if (ts > ru.last) ru.last = ts; }
          if (mk) ru.model = mk;
          // 记录该轮涉及的 messageId（DOM 上 data-message-id 用它匹配）
          var mid = pdx && pdx.messageId;
          // 上限 20 → 60：单轮可达 26+ 步，每步一个 messageId，
          // 20 会截断导致后续消息匹配不上。60 足够覆盖绝大多数轮次。
          if (mid && ru.msgIds && ru.msgIds.length < 60 && ru.msgIds.indexOf(mid) < 0) ru.msgIds.push(mid);
        }
      }
      return '';
    }

    function findJsonl(sid) {
      var fm = fileMap();
      if (fm[sid]) return fm[sid];
      try {
        var dirs = fs.readdirSync(PROJECTS);
        for (var i = 0; i < dirs.length; i++) {
          var f = path.join(PROJECTS, dirs[i], sid + '.jsonl');
          if (fs.existsSync(f)) return f;
        }
      } catch (e) { }
      return null;
    }

    function readDb() {
      var mod = require('node:sqlite');
      var db = new mod.DatabaseSync(DB, { readOnly: true });
      try {
        // 200 → 1000：累计是"对全部会话求和"，200 会在长期使用后静默少算。
        // 仍然保留上限：每个会话都要 stat 一次日志文件，无上限会让 1s 轮询变慢。
        var ROW_LIMIT = 1000;
        var rows = db.prepare('select session_id, used, size, credit_json, updated_at '
          + 'from session_usage order by updated_at desc limit ' + ROW_LIMIT).all() || [];
        var cwd = null;
        try {
          var r = db.prepare('select cwd, context_window, thought_level, mode, user_id from sessions where id = ?').get(rows[0] ? rows[0].session_id : '');
          cwd = r && r.cwd;
        } catch (e) { }
        var cmap = {}, tmap = {};
      try {
        var all = db.prepare('select id, cwd, title, custom_title from sessions').all() || [];
        for (var ci = 0; ci < all.length; ci++) {
          cmap[String(all[ci].id)] = all[ci].cwd || '';
          var tt = all[ci].custom_title || all[ci].title || '';
          if (tt) tmap[String(all[ci].id)] = tt;
        }
      } catch (e) { }
      return { rows: rows, cwd: cwd, ctxWin: (r && r.context_window) || 0, cwdMap: cmap, titleMap: tmap,
               thought: (r && r.thought_level) || '', mode: (r && r.mode) || '', user: (r && r.user_id) || '' };
      } finally { try { db.close(); } catch (e) { } }
    }

    function credits(json) {
      if (!json) return 0;
      try {
        var o = JSON.parse(json), n = 0;
        for (var k in o) if (typeof o[k] === 'number') n += o[k];
        return Math.round(n * 100) / 100;
      } catch (e) { return 0; }
    }

    function weekKey(ms) {
      var d = new Date((+ms || 0) + TZ_OFFSET_HOURS * 3600000);
      var day = WEEK_START_SUNDAY ? d.getDay() : (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    var TZ_OFFSET_HOURS = 0;
    var WEEK_START_SUNDAY = false;
    function dayKey(ms) {
      ms = (+ms || 0) + TZ_OFFSET_HOURS * 3600000;
      var d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    var gitCache = { at: 0, key: '', val: null };
    function gitInfo(cwd) {
      var now = Date.now();
      if (gitCache.val && gitCache.key === cwd && now - gitCache.at < 4000) return gitCache.val;
      var out = { branch: '', dirty: false, root: cwd ? path.basename(cwd) : '', isRepo: false,
                  fullRoot: cwd || '', ahead: 0, behind: 0, files: 0, worktree: '' };
      if (cwd && fs.existsSync(cwd)) {
        try {
          out.branch = cp.execSync('git rev-parse --abbrev-ref HEAD',
            { cwd: cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          out.isRepo = !!out.branch;
          try {
            out.dirty = cp.execSync('git status --porcelain',
              { cwd: cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
          } catch (e) { }
          try {
            var ab = cp.execSync('git rev-list --left-right --count @{upstream}...HEAD',
              { cwd: cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\s+/);
            out.behind = +ab[0] || 0; out.ahead = +ab[1] || 0;
          } catch (e) { }
          try {
            var fs2 = cp.execSync('git status --porcelain',
              { cwd: cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            out.files = fs2 ? fs2.split('\n').length : 0;
          } catch (e) { }
          try {
            out.worktree = cp.execSync('git rev-parse --short-git-dir',
              { cwd: cwd, timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          } catch (e) { }
        } catch (e) { }
      }
      gitCache = { at: now, key: cwd, val: out };
      return out;
    }

    // ===== 计费规则（唯一真源：tools/billing.json + ui/billing_core.js）=====
    // 这一段由 tools/sync_billing.py 生成，**不要手改**：改规则请改那两个文件再同步。
    //
    // 2026-11-26 重构要点（旧实现的两个结构性错误）：
    //   1) 旧版用「模型名包含某关键词」判断是否按 token 计费。真正的依据是请求
    //      走的是谁的密钥，即 requestModelId 的前缀：custom-local: = 用户自带密钥，
    //      按 token 付费（¥）；无前缀 = 平台模型，扣积分。模型名会随版本变
    //      （…-1017 → 不带版本号），前缀不会。旧写法只是"碰巧命中"，用户换一个
    //      自定义模型就整体失效，且失效方式是"静默变成 0 元"，比报错更危险。
    //   2) 单价写死单一模型。现在按模型名最长匹配价格表，未配置时回落默认价并
    //      标记 known=false，界面可据此提示"金额为估算"。
    /* @@BILLING_CORE@@ */
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
/* @@END_BILLING_CORE@@ */

    var PRICING_OVERRIDE = null;   // UI 通过 wb-hud:setpricing 推送的单价覆盖
    var _cfgCache = null, _cfgSrc = null;
    function billingCfg() {
      // 覆盖配置不常变，缓存合并结果，避免每次计价都深拷贝一份配置
      if (_cfgCache && _cfgSrc === PRICING_OVERRIDE) return _cfgCache;
      _cfgSrc = PRICING_OVERRIDE;
      _cfgCache = WBBilling.merge(PRICING_OVERRIDE);
      return _cfgCache;
    }
    // 回显给 UI：patterns 保留旧字段名，兼容已存在 localStorage 里的旧配置
    function pricing() {
      var c = billingCfg();
      return {
        patterns: c.feePatterns || [],
        feePrefixes: c.feePrefixes || [],
        idle: c.pricing['default'].idle,
        busy: c.pricing['default'].busy,
        models: Object.keys(c.pricing.models || {}),
        idleHours: c.idleHours
      };
    }
    function isFeeModel(m) { return WBBilling.unitOf(m, billingCfg()) === 'fee'; }
    function calcFee(u, ms, model) { return WBBilling.calcFee(u, ms, model, billingCfg(), TZ_OFFSET_HOURS); }
    function isPriceKnown(model) { return WBBilling.priceOf(model, billingCfg()).known; }
    function r2(n) { return Math.round(n * 100) / 100; }
    function r4(n) { return Math.round(n * 10000) / 10000; }

    // 请求 ID → 毫秒时间戳（越界返回 0）。实现见 ui/billing_core.js::cridMs
    var cridMs = WBBilling.cridMs;

    // 会话计费画像（unit/mixed/latestModel）。实现见 ui/billing_core.js::sessionBilling，
    // 放在内核里是为了能被 tools/test_billing.py 直接测到，不留"只有运行时才知道对不对"的逻辑。
    // 注意：unit 只看主线程的请求——子代理用的是另一套模型时，账本不应跟着跳单位。
    function sessionBilling(h) {
      var sb = WBBilling.sessionBilling(h && h.reqModels, billingCfg());
      if (h && h.lastMainModel) {
        sb.unit = isFeeModel(h.lastMainModel) ? 'fee' : 'credit';
        sb.model = h.lastMainModel;
        sb.at = h.lastMainAt || sb.at;
      }
      return sb;
    }

    // 读 WorkBuddy 自己的路由快照，拿到「用户当前正在看的会话」。
    // 来源：<userdir>/<uid>/startup-route.json → {"path":"/conversation/<sid>","savedAt":ms}
    // 这是应用自身的持久化机制（主进程 startup-route:persist 写入），不是猜测。
    function currentRouteSession() {
      try {
        var roots = [
          path.join(process.env.USERPROFILE || '', '.workbuddy'),
        ];
        for (var i = 0; i < roots.length; i++) {
          if (!fs.existsSync(roots[i])) continue;
          var subs = fs.readdirSync(roots[i]);
          for (var j = 0; j < subs.length; j++) {
            var p = path.join(roots[i], subs[j], 'startup-route.json');
            if (!fs.existsSync(p)) continue;
            var j2 = JSON.parse(fs.readFileSync(p, 'utf8'));
            var rp = j2 && j2.path;
            if (typeof rp !== 'string') continue;
            var mm = rp.match(/\/conversation\/([0-9a-fA-F-]{8,})/);
            if (mm) return mm[1];
          }
        }
      } catch (e) { }
      return null;
    }

    function payload(anchored) {
      var db;
      try { db = readDb(); } catch (e) { return { error: '读库失败: ' + (e && e.message || e) }; }
      var rows = db.rows || [];
      if (!rows.length) return { empty: true };

      // 会话选择：优先用 UI 锚定的会话（避免另一会话在后台工作时抢走显示）；
      // 未锚定或锚定失效时回退到最近更新的会话
      var cur = null, curFrom = '';
      // 1) 用户在面板里手动锚定的会话
      if (anchored) {
        for (var ai = 0; ai < rows.length; ai++) {
          if (String(rows[ai].session_id) === String(anchored)) { cur = rows[ai]; curFrom = 'anchor'; break; }
        }
      }
      // 2) 应用的路由快照 = 用户此刻正在看的会话（自动跟随）
      if (!cur) {
        var rsid = currentRouteSession();
        if (rsid) {
          for (var bi = 0; bi < rows.length; bi++) {
            if (String(rows[bi].session_id) === String(rsid)) { cur = rows[bi]; curFrom = 'route'; break; }
          }
        }
      }
      // 3) 兜底：最近更新
      if (!cur) { cur = rows[0]; curFrom = 'recent'; }
      var jf = findJsonl(String(cur.session_id));
      if (jf) { try { consumeFile(jf); } catch (e) { } }

      var byDay = {}, sessions = [], byWeek = {}, byMonth = {};
      // token/请求数仍按会话聚合到会话最后活动日（JSONL 有逐请求时间，但 token 归日
      // 价值不大）；积分改为逐请求精确归日（credit_json 键内嵌毫秒时间戳，实测 100% 可解码）
      function agg(map, key, hh, bump) {
        var a = map[key] || (map[key] = {
          credit: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0, sessions: 0, models: {}
        });
        if (bump !== false) a.sessions += 1;   // 仅费用条目建桶时 bump=false，不虚增会话数
        if (hh) {
          a.input += hh.input; a.output += hh.output;
          a.cacheRead += hh.cacheRead; a.cacheCreate += hh.cacheCreate;
          a.requests += hh.requests;
          for (var mk in hh.models) a.models[mk] = 1;
        }
        return a;
      }
      var total = 0, feeTotal = 0, feePlatformTotal = 0, byModel = {}, feeByModel = {};
      // 逐轮明细：供「消息末尾消耗行 + 悬浮卡」使用（crid 为键）
      var roundsMap = {};
      var creditBySid = {}, feeBySid = {}, platformBySid = {};
      // 子代理费用按 agent 归集：sid -> {agent: ¥}
      var subFeeBySid = {};
      var t0h = Date.now();
      var HIST_EMPTY = !Object.keys(HIST).length;
      var scanPending = false;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], c = credits(r.credit_json);
        var sid = String(r.session_id);
        // 增量扫 JSONL：首次（无缓存）不设上限一次扫完，之后按 250ms 限时增量
        // 扫描策略（2026-11-21 二次修正）：
        // 关键改动——**当前会话优先且不限预算**。
        // 此前按 rows 顺序遍历 + 统一 1500ms 预算，当前会话若排在后面，
        // 前面的会话耗尽预算后当前会话被跳过（scanPending=true），
        // 导致「上一轮结束很久消耗行都不出现」，要等重启才补上。
        var isCurrent = (String(cur.session_id) === String(sid));
        var fpath = findJsonl(sid);
        if (isCurrent) {
          // 当前会话：必须扫到文件末尾。histOf 单次最多读 8MB，
          // 大文件（实测 39MB）需要循环多次，否则尾部最新数据永远读不到。
          try {
            for (var loop = 0; loop < 6; loop++) {
              histOf(sid, fpath); histDirty = true;
              // 扫完后 offset 应等于文件大小，否则继续
              var sc2 = HSCAN[_fkey(fpath)];
              var sz2 = 0;
              try { sz2 = fs.statSync(fpath).size; } catch (e2) { break; }
              if (!sc2 || sc2.offset >= sz2) break;
            }
          } catch (e) { }
        } else {
          // 其他会话：限时分摊，超时的下轮继续（offset 单调推进，不会重复）
          var scanBudget = HIST_EMPTY ? 600000 : 1200;
          if (Date.now() - t0h < scanBudget) {
            try { histOf(sid, fpath); histDirty = true; } catch (e) { }
          } else { scanPending = true; }
        }
        var hh = HIST[sid] || null;
        var ts = (hh && hh.last) || r.updated_at || 0, dk = dayKey(ts);
        agg(byDay, dk, hh);
        agg(byWeek, weekKey(ts), hh);
        agg(byMonth, dk.slice(0, 7), hh);
        // 逐请求精确归日 + 按模型拆分（credit_json 键 = conversationRequestId，键前 12 位
        // 十六进制即请求的 Unix 毫秒时间戳，实测 313 条全部可解码）
        var sidModels = (hh && hh.reqModels) || null;
        var sidUsage = (hh && hh.reqUsage) || null;
        var cj = null;
        try { cj = r.credit_json ? JSON.parse(r.credit_json) : null; } catch (e) { }
        var feeHere = 0, platformHere = 0;
        // 费用统计走 JSONL 全量请求（不依赖 credit_json）：百炼等费用模型大多没有
        // 积分条目——实测 25 条费用请求中仅 2 条出现在 credit_json，只扫 credit_json 会漏 92%
        if (sidModels) {
          for (var fk0 in sidModels) {
            var fmdl = sidModels[fk0];
            if (!fmdl || !isFeeModel(fmdl)) continue;
            var frts = cridMs(fk0) || ts || Date.now();
            var fu = sidUsage ? sidUsage[fk0] : null;
            var fv = fu ? calcFee(fu, frts, fmdl) : 0;
            feeHere += fv;
            // 费用按请求计，请求归属到哪个 agent 就记到哪个 agent 头上
            var agOfCrid = hh && hh.subCridAgent ? hh.subCridAgent[fk0] : null;
            if (agOfCrid) {
              var sf = subFeeBySid[sid] || (subFeeBySid[sid] = {});
              sf[agOfCrid] = r4((sf[agOfCrid] || 0) + fv);
            }
            feeByModel[fmdl] = Math.round(((feeByModel[fmdl] || 0) + fv) * 10000) / 10000;
            var fk1 = dayKey(frts), fk2 = weekKey(frts), fk3 = fk1.slice(0, 7);
            if (!byDay[fk1]) agg(byDay, fk1, null, false);
            if (!byWeek[fk2]) agg(byWeek, fk2, null, false);
            if (!byMonth[fk3]) agg(byMonth, fk3, null, false);
            byDay[fk1].fee = r4((byDay[fk1].fee || 0) + fv);
            byWeek[fk2].fee = r4((byWeek[fk2].fee || 0) + fv);
            byMonth[fk3].fee = r4((byMonth[fk3].fee || 0) + fv);
            // 逐轮明细（费用模型）
            var rr = fu || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
            roundsMap[fk0] = {
              crid: fk0, sid: sid, model: fmdl,
              input: rr.input || 0, output: rr.output || 0,
              cacheRead: rr.cacheRead || 0, cacheCreate: rr.cacheCreate || 0,
              steps: rr.steps || 0, first: rr.first || frts, last: rr.last || frts,
              msgIds: rr.msgIds || [],
              credit: 0, fee: Math.round(fv * 10000) / 10000, isFee: true,
              // unit 是「这一轮自己的」计费单位，不再由会话推断：
              // 同一会话可以在自定义模型和平台模型之间来回切，单位必须逐轮成立
              unit: 'fee', priced: isPriceKnown(fmdl)
            };
          }
        }
        if (cj) {
          for (var ck in cj) {
            var v = cj[ck];
            if (typeof v !== 'number') continue;
            var rts = cridMs(ck) || ts || Date.now();
            var mdl = sidModels ? sidModels[ck] : null;
            if (mdl && isFeeModel(mdl)) {
              // 费用模型在 credit_json 里也有条目（平台记账值）：单列核对，不并入积分，
              // 也不重复计入 fee（¥ 以 JSONL usage × 单价为准）
              platformHere = Math.round((platformHere + v) * 100) / 100;
              continue;
            }
            total += v;
            creditBySid[sid] = Math.round(((creditBySid[sid] || 0) + v) * 100) / 100;
            byModel[mdl || '未知'] = Math.round(((byModel[mdl || '未知'] || 0) + v) * 100) / 100;
            var k1 = dayKey(rts), k2 = weekKey(rts), k3 = k1.slice(0, 7);
            if (!byDay[k1]) agg(byDay, k1, null, false);
            if (!byWeek[k2]) agg(byWeek, k2, null, false);
            if (!byMonth[k3]) agg(byMonth, k3, null, false);
            byDay[k1].credit = r2((byDay[k1].credit || 0) + v);
            byWeek[k2].credit = r2((byWeek[k2].credit || 0) + v);
            byMonth[k3].credit = r2((byMonth[k3].credit || 0) + v);
            // 逐轮明细（积分模型）：token 取该轮 usage，积分取 credit_json 的值
            var iu = (sidUsage && sidUsage[ck]) || null;
            roundsMap[ck] = {
              crid: ck, sid: sid, model: mdl || '',
              input: iu ? (iu.input || 0) : 0, output: iu ? (iu.output || 0) : 0,
              cacheRead: iu ? (iu.cacheRead || 0) : 0, cacheCreate: iu ? (iu.cacheCreate || 0) : 0,
              steps: iu ? (iu.steps || 0) : 0,
              first: iu && iu.first ? iu.first : rts, last: iu && iu.last ? iu.last : rts,
              msgIds: (iu && iu.msgIds) || [],
              credit: v, fee: 0, isFee: false, unit: 'credit', priced: false
            };
          }
        }
        // 精度 2 位 → 4 位：此前每轮四舍五入到分，多轮累加会产生累积误差
        // （实测「本会话」¥22.47 vs rounds 求和 ¥23.01，差 ¥0.54 就是这个原因）
        feeBySid[sid] = Math.round(feeHere * 10000) / 10000;
        platformBySid[sid] = Math.round(platformHere * 10000) / 10000;
        feeTotal = Math.round((feeTotal + feeHere) * 10000) / 10000;
        feePlatformTotal = Math.round((feePlatformTotal + platformHere) * 100) / 100;
        if (i < 10) {
          var tks = hh ? (hh.input + hh.output + hh.cacheRead + hh.cacheCreate) : 0;
          sessions.push({
            id: sid.slice(0, 8), credit: (creditBySid[sid] || 0), fee: (feeBySid[sid] || 0),
            title: (db.titleMap || {})[sid] || '',
            input: hh ? hh.input : 0, output: hh ? hh.output : 0,
            cacheRead: hh ? hh.cacheRead : 0, cacheCreate: hh ? hh.cacheCreate : 0,
            requests: hh ? hh.requests : 0, tokens: tks,
            // 子代理消耗单列，便于「按会话」里看出谁在放大用量
            subTokens: hh && hh.sub ? (hh.sub.input + hh.sub.output) : 0,
            subFiles: hh ? (hh.subFiles || 0) : 0,
            models: hh ? Object.keys(hh.models) : [],
            first: hh ? hh.first : 0, last: hh ? hh.last : 0
          });
        }
      }

      var toolList = Object.keys(st.tools).map(function (n) {
        var t = st.tools[n];
        return { name: n, n: t.n, running: t.running, arg: t.lastArg };
      }).sort(function (a, b) { return (b.running - a.running) || (b.n - a.n); }).slice(0, 6);

      var running = Object.keys(st.calls).map(function (k) { return st.calls[k]; }).slice(-3);

      var todos = st.todos.map(function (t, i) {
        return { id: String(i + 1), subject: t.subject, status: t.status };
      });
      var done = todos.filter(function (t) { return String(t.status).toLowerCase() === 'completed'; }).length;

      var agents = Object.keys(st.agents).map(function (k) {
        return { desc: st.agents[k].desc, ms: Date.now() - (st.agents[k].at || Date.now()) };
      });

      // 5 小时窗口（ccusage 的 blocks）：按事件时间戳分桶，以首条事件为起点
      var blocks = [];
      if (st.events.length) {
        var W = 5 * 3600 * 1000, start0 = st.events[0].t, bmap = {};
        for (var ei = 0; ei < st.events.length; ei++) {
          var ev = st.events[ei];
          var bk = Math.floor((ev.t - start0) / W);
          var b = bmap[bk] || (bmap[bk] = { from: start0 + bk * W, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0, entries: 0, last: 0 });
          b.input += ev.i; b.output += ev.o;
          b.cacheRead += ev.cr || 0; b.cacheCreate += ev.cc || 0;
          b.requests += 1; b.entries += 1;
          if (ev.t > b.last) b.last = ev.t;
        }
        blocks = Object.keys(bmap).sort(function (a, b) { return a - b; }).slice(-4).map(function (k) {
          var b = bmap[k];
          return {
            from: b.from, to: b.last || (b.from + W), input: b.input, output: b.output,
            cacheRead: b.cacheRead, cacheCreate: b.cacheCreate,
            total: b.input + b.output + b.cacheRead + b.cacheCreate,
            requests: b.requests, entries: b.entries
          };
        });
      }

      // 按项目归集（用 sessions.cwd 的目录名）：积分与费用各自聚合，账本模式切换用
      var pmap = {}, cwdMap = db.cwdMap || {};
      for (var pi = 0; pi < rows.length; pi++) {
        var pr = rows[pi], pc = creditBySid[String(pr.session_id)] || 0;
        var pf = feeBySid[String(pr.session_id)] || 0;
        var cwp = cwdMap[String(pr.session_id)] || '';
        var pn = cwp ? path.basename(String(cwp).replace(/[\\/]+$/, '')) : '未知项目';
        if (!pmap[pn]) pmap[pn] = { project: pn, credit: 0, fee: 0, sessions: 0 };
        pmap[pn].credit = Math.round((pmap[pn].credit + pc) * 100) / 100;
        pmap[pn].fee = Math.round((pmap[pn].fee + pf) * 100) / 100;
        pmap[pn].sessions += 1;
      }
      var byProject = Object.keys(pmap).map(function (k) { return pmap[k]; })
        .sort(function (a, b) { return b.credit - a.credit; }).slice(0, 8);
      var byProjectFee = Object.keys(pmap).map(function (k) { return pmap[k]; })
        .filter(function (x) { return x.fee > 0; })
        .sort(function (a, b) { return b.fee - a.fee; }).slice(0, 8);

      var byAgent = Object.keys(st.agentStats).map(function (k) {
        return { desc: k, count: st.agentStats[k].count, totalMs: st.agentStats[k].totalMs, model: st.agentStats[k].model };
      }).sort(function (a, b) { return b.count - a.count; });

      var models = Object.keys(st.byModel).map(function (k) { return st.byModel[k]; })
        .sort(function (a, b) { return b.requests - a.requests; });

      // 落盘必须在 return 之前（此前误放在 return 之后，是死代码，导致缓存永不更新）
      try { saveHistCache(false); } catch (e) { }

      var sb = sessionBilling(HIST[String(cur.session_id)]);
      // 兜底：会话刚建、reqModels 还没建立时，用当前会话最近一轮的单位
      if (!sb.unit) {
        var curRounds = [];
        for (var crk in roundsMap) if (roundsMap[crk].sid === String(cur.session_id)) curRounds.push(roundsMap[crk]);
        curRounds.sort(function (a, b) { return (b.last || b.first || 0) - (a.last || a.first || 0); });
        if (curRounds.length) {
          sb.unit = curRounds[0].unit || (curRounds[0].isFee ? 'fee' : 'credit');
          sb.model = sb.model || curRounds[0].model || '';
        }
      }

      return {
        session: {
          id: String(cur.session_id), used: cur.used, size: (cur.size || db.ctxWin || 0),
          credit: (creditBySid[String(cur.session_id)] || 0),
          fee: (feeBySid[String(cur.session_id)] || 0),
          platform: (platformBySid[String(cur.session_id)] || 0),
          // modelList：本会话出现过的模型（供 UI 展示费用模型名）
          modelList: sb.list,
          // unit：最近一次请求的单位。自动模式跟随它，因此换模型会立刻切账本。
          unit: sb.unit || 'credit',
          latestModel: sb.model || '',
          latestAt: sb.at || 0,
          // mixed：本会话同时用过两种计费（如 20 轮自定义 + 2 轮平台）
          mixed: !!sb.mixed,
          // 兼容旧字段名：语义已收窄为"本会话曾用过费用模型"，不再用于决定显示单位
          usesFeeModel: !!sb.usedFeeModel,
          updated: cur.updated_at,
          started: (HIST[String(cur.session_id)] || {}).first || 0,
          compactions: (HIST[String(cur.session_id)] || {}).compactions || 0,
          // 上下文变短事件（新版客户端压缩无标记，只能靠 token 轨迹）：最近 10 次
          ctxDrops: ((HIST[String(cur.session_id)] || {}).ctxDrops || []).slice(-10),
          title: st.title || (db.titleMap || {})[String(cur.session_id)] || ''
        },
        sessionList: rows.slice(0, 30).map(function (sr) {
          var ssid = String(sr.session_id);
          return { id: ssid, title: (db.titleMap || {})[ssid] || '', credit: (creditBySid[ssid] || 0),
                   fee: (feeBySid[ssid] || 0), used: sr.used, size: sr.size, updatedAt: sr.updated_at };
        }),
        anchored: curFrom === 'anchor',
        sessionSource: curFrom,
        mem: Math.round(process.memoryUsage().rss / 1048576),
        appVersion: (electron.app && electron.app.getVersion) ? electron.app.getVersion() : '',
        skills: Object.keys(st.skills).map(function (k) { return st.skills[k]; })
          .sort(function (a, b) { return b.n - a.n; }).slice(0, 6),
        mcp: st.mcp,
        model: st.model, provider: st.provider,
        thought: db.thought || '', mode: db.mode || '', user: db.user || '',
        // 会话 token 以 HIST（主文件 + 子代理文件）为准，而不是只看主文件：
        // 两个数不一致时，状态条和账本会互相打脸（用户就是这么发现漏账的）。
        tokens: (function () {
          var hc = HIST[String(cur.session_id)];
          if (!hc) return st.tokens;
          return {
            input: hc.input, output: hc.output,
            cacheRead: hc.cacheRead, cacheCreate: hc.cacheCreate,
            requests: hc.requests, total: hc.input + hc.output,
            sub: hc.sub || { input: 0, output: 0, requests: 0 },
            subFiles: hc.subFiles || 0
          };
        })(),
        byModel: models,
        tools: { list: toolList, running: running },
        agents: agents,
        todos: { total: todos.length, done: done, items: todos.slice(0, 6) },
        git: gitInfo(db.cwd),
        total: Math.round(total * 100) / 100,
        today: (byDay[dayKey(Date.now())] || {}).credit || 0,
        week: (byWeek[weekKey(Date.now())] || {}).credit || 0,
        month: (byMonth[dayKey(Date.now()).slice(0, 7)] || {}).credit || 0,
        feeTotal: feeTotal,
        feePlatformTotal: feePlatformTotal,
        feeToday: (byDay[dayKey(Date.now())] || {}).fee || 0,
        feeWeek: (byWeek[weekKey(Date.now())] || {}).fee || 0,
        feeMonth: (byMonth[dayKey(Date.now()).slice(0, 7)] || {}).fee || 0,
        byModel: byModel,
        feeByModel: feeByModel,
        pricing: pricing(),
        weeks: Object.keys(byWeek).sort().slice(-4).map(function (k) {
          var a = byWeek[k];
          return { week: k, credit: a.credit || 0, fee: a.fee || 0, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheCreate: a.cacheCreate, requests: a.requests, sessions: a.sessions, models: Object.keys(a.models) };
        }),
        months: Object.keys(byMonth).sort().slice(-4).map(function (k) {
          var a = byMonth[k];
          return { month: k, credit: a.credit || 0, fee: a.fee || 0, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheCreate: a.cacheCreate, requests: a.requests, sessions: a.sessions, models: Object.keys(a.models) };
        }),
        days: Object.keys(byDay).sort().slice(-7).map(function (d) {
          var a = byDay[d];
          return { day: d, credit: a.credit || 0, fee: a.fee || 0, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheCreate: a.cacheCreate, requests: a.requests, sessions: a.sessions, models: Object.keys(a.models) };
        }),
        sessions: sessions,
        blocks: blocks,
        byProject: byProject,
        byProjectFee: byProjectFee,
        byAgent: byAgent,
        durationMs: (st.startedAt && st.endedAt) ? (st.endedAt - st.startedAt) : 0,
        // rounds 只输出【当前会话】的轮次（修复：此前是全局所有会话，
        // 实测混入 20 个会话 374 轮，导致 rounds 求和 ≠ 本会话费用）。
        // 上限 1000 足够覆盖单会话；消息末尾消耗行只需当前会话数据。
        rounds: (function () {
          var curSid = String(cur.session_id);
          var arr = [];
          for (var rk in roundsMap) {
            if (roundsMap[rk].sid === curSid) arr.push(roundsMap[rk]);
          }
          arr.sort(function (a, b) { return (b.first || 0) - (a.first || 0); });
          return arr.slice(0, 1000);
        })(),
        // 子代理逐 agent 明细：动态（工具）、token、费用、时长
        subAgents: (function () {
          var hc = HIST[String(cur.session_id)];
          if (!hc || !hc.subAgents) return [];
          var fmap = subFeeBySid[String(cur.session_id)] || {};
          var out = [];
          for (var ak in hc.subAgents) {
            var s2 = hc.subAgents[ak];
            var tl = [];
            for (var tn in s2.tools) tl.push({ name: tn, n: s2.tools[tn] });
            tl.sort(function (a, b) { return b.n - a.n; });
            out.push({
              name: s2.name, files: s2.files, input: s2.input, output: s2.output,
              turns: s2.turns,
              ms: s2.ms || 0,
              fee: Math.round((fmap[s2.name] || 0) * 10000) / 10000,
              tools: tl.slice(0, 6)
            });
          }
          out.sort(function (a, b) { return b.input - a.input; });
          return out.slice(0, 8);
        })(),
        scanPending: scanPending,
        // 触发 1000 行上限时明确告知，避免"累计"看起来是精确值其实是截断值
        rowsCapped: (db.rows || []).length >= 1000,
        at: Date.now()
      };
    }

    electron.ipcMain.handle('wb-hud:setweek', function (ev, sunday) {
      WEEK_START_SUNDAY = !!sunday;
      return { ok: true, sunday: WEEK_START_SUNDAY };
    });

    electron.ipcMain.handle('wb-hud:settz', function (ev, hours) {
      TZ_OFFSET_HOURS = Number(hours) || 0;
      return { ok: true, tz: TZ_OFFSET_HOURS };
    });

    // 诊断通道：注入层把「消息挂载结果」写到这里，供排查用（不影响正常功能）
    electron.ipcMain.handle('wb-hud:diag', function (ev, payload) {
      try {
        var p2 = path.join(process.env.USERPROFILE || '', '.workbuddy',
          'plugins', 'marketplaces', 'workbench-local', 'workbench-hud', 'tools', '.mount-diag.json');
        fs.writeFileSync(p2, JSON.stringify({ at: Date.now(), data: payload }, null, 1));
        return { ok: true };
      } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
    });

    electron.ipcMain.handle('wb-hud:exec', function (ev, cmd) {
      try {
        var c = String(cmd || '').trim();
        if (!c) return { ok: true, out: '' };
        if (c.length > 300) return { ok: false, error: '命令过长' };
        var out = cp.execSync(c, { timeout: 3000, encoding: 'utf8', shell: true,
                                  stdio: ['ignore', 'pipe', 'ignore'] });
        return { ok: true, out: String(out).trim().replace(/\s+/g, ' ').slice(0, 220) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
      }
    });

    electron.ipcMain.handle('wb-hud:state', function (ev, anchored) {
      try { return payload(anchored); } catch (e) { return { error: String(e && e.message || e) }; }
    });
    // UI 推送费用模型配置（匹配模式 + 分时段单价，元/百万 token）；存内存，UI 启动时重新推送
    electron.ipcMain.handle('wb-hud:setpricing', function (ev, cfg) {
      try {
        if (cfg && typeof cfg === 'object') PRICING_OVERRIDE = cfg;
        return { ok: true, pricing: pricing() };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
  } catch (e) { }
})();
