'use strict';
const progressI18n = window.PonteI18n;
const escapeHTML = progressI18n.escape;
let progressData = null;
let progressFailed = false;
function localize(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && ('en' in value || 'pt' in value)) return value[progressI18n.language] ?? value.en ?? value.pt ?? '';
  return value;
}
function format(value) {
  value = localize(value);
  if (Array.isArray(value)) return value.map(format).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key,val]) => `${key}: ${format(val)}`).join('\n');
  return progressI18n.t(String(value ?? ''));
}
function renderProgress() {
  const t = progressI18n.t;
  const data = progressData;
  if (data) {
    const items = data.phases || data.steps || data.milestones || data.tasks;
    let html = '';
    if (data.status || data.summary || data.current) html += `<div class="progress-row"><span class="progress-status">${escapeHTML(format(data.status || t('Em andamento')))}</span><strong>${escapeHTML(format(data.summary || data.current || t('Ponte em construção')))}</strong></div>`;
    if (Array.isArray(items)) html += items.map(item => typeof item === 'string' ? `<div class="progress-row"><strong>${escapeHTML(format(item))}</strong></div>` : `<div class="progress-row"><span class="progress-status">${escapeHTML(format(item.status || t('Planejado')))}</span><strong>${escapeHTML(format(item.title || item.name || item.label || item.id || t('Etapa')))}</strong>${item.detail || item.details || item.description || item.note ? `<p>${escapeHTML(format(item.detail || item.details || item.description || item.note))}</p>` : ''}</div>`).join('');
    if (!html) html = `<div class="progress-row"><pre class="progress-details">${escapeHTML(format(data))}</pre></div>`;
    document.getElementById('progress').innerHTML = html;
    const timestamp = data.updatedAt || data.updated_at || data.updated;
    document.getElementById('updated').textContent = timestamp ? t('Atualizado {time}',{time:new Date(timestamp).toLocaleString(progressI18n.locale)}) : t('Progresso sincronizado agora.');
  }
  if (progressFailed) document.getElementById('updated').textContent = t('Aguardando atualização do servidor. Tentando novamente automaticamente.');
}
async function update() {
  try {
    const response = await fetch('/progress.json',{cache:'no-store',headers:{'Accept-Language':progressI18n.locale}});
    if (!response.ok) throw new Error('Progress unavailable');
    progressData = await response.json(); progressFailed = false;
  } catch { progressFailed = true; }
  renderProgress();
}
document.addEventListener('ponte-language-change',renderProgress);
update();
setInterval(update,6000);
