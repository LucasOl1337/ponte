(function (root) {
  'use strict';
  const monitors = state => (state?.monitors || []).filter(m => !m.disabled).slice().sort((a, b) => (a.x || 0) - (b.x || 0) || (a.y || 0) - (b.y || 0) || a.name.localeCompare(b.name));
  const workspaces = (state, name) => (state?.workspaces || []).filter(ws => ws.monitor === name && Number.isInteger(ws.id) && ws.id > 0).sort((a, b) => a.id - b.id);
  function windows(state, name) {
    const monitor = monitors(state).find(m => m.name === name);
    if (!monitor) return [];
    const ids = new Set(workspaces(state, name).map(ws => ws.id));
    return (state?.windows || []).filter(w => w.monitor === monitor.id || (w.monitor == null && ids.has(w.workspace?.id)));
  }
  function label(state, name) {
    const list = monitors(state), index = list.findIndex(m => m.name === name), monitor = list[index];
    if (!monitor) return 'Nenhum monitor';
    const position = list.length === 3 ? ['Esquerda', 'Centro', 'Direita'][index] : list.length === 2 ? ['Esquerda', 'Direita'][index] : `Monitor ${index + 1}`;
    return `${monitor.label || position} · ${name}`;
  }
  root.PonteScreenContext = { monitors, workspaces, windows, label };
})(typeof window !== 'undefined' ? window : globalThis);
