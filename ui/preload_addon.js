// WorkBuddy 工作台 · preload 附加（追加到 preload/index.js 末尾）
// 只暴露一个只读接口，不加任何写能力。
(function () {
  try {
    var e = require('electron');
    if (!e || !e.contextBridge || !e.ipcRenderer) return;
    e.contextBridge.exposeInMainWorld('__wbHud', {
      state: function (anchored) { return e.ipcRenderer.invoke('wb-hud:state', anchored); },
      exec: function (cmd) { return e.ipcRenderer.invoke('wb-hud:exec', cmd); },
      diag: function (data) { return e.ipcRenderer.invoke('wb-hud:diag', data); },
      setTz: function (h) { return e.ipcRenderer.invoke('wb-hud:settz', h); },
      setWeek: function (sunday) { return e.ipcRenderer.invoke('wb-hud:setweek', sunday); },
      setPricing: function (cfg) { return e.ipcRenderer.invoke('wb-hud:setpricing', cfg); },
    });
  } catch (err) { /* 静默 */ }
})();
