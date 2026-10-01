import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApiError } from './process.mjs';

export function createDailyWork({ descriptor = process.env.PONTE_DAILYWORK_DESCRIPTOR || path.join(os.homedir(), '.config/DailyWork/api-ponte.json') } = {}) {
  let cached = null, fetchedAt = 0, pending = null;
  async function call(operation, args = [], write = false) {
    let d;
    try {
      const stat = lstatSync(descriptor);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error('private');
      d = JSON.parse(readFileSync(descriptor, 'utf8'));
      const url = new URL(d.baseUrl);
      if (d.origem !== 'ponte' || url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(d.token || '')) throw Error('invalid');
    } catch { throw Object.assign(new ApiError(503, 'DAILYWORK_UNAVAILABLE'), { confirmed: true }); }
    try {
      const r = await fetch(new URL('/api/v1/operacoes/' + operation.replace(':','/'), d.baseUrl), { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args }), signal: AbortSignal.timeout(operation === 'hoje:resumo' ? 6500 : 10000), redirect: 'error' });
      const result = await r.json();
      if (!r.ok || !result.ok) throw Object.assign(new ApiError(r.status >= 400 ? r.status : 502, 'DAILYWORK_REJECTED'), { dailywork: result.erro, confirmed: true });
      return result.data;
    } catch (e) {
      if (e.confirmed) throw e;
      throw Object.assign(new ApiError(503, write ? 'DAILYWORK_UNCERTAIN' : 'DAILYWORK_UNAVAILABLE'), { dailywork: { codigo: write ? 'RESULTADO_INCERTO' : 'DAILYWORK_INDISPONIVEL', chave_idempotencia: args[0]?.chave_idempotencia } });
    }
  }
  async function summary() {
    if (!pending && Date.now() - fetchedAt > 5000) pending = (async () => {
      try {
        const result = await call('hoje:resumo');
        if (result?.versao !== 1 || !['disponivel', 'parcial', 'indisponivel'].includes(result.estado) || !Array.isArray(result.pendencias) || !Array.isArray(result.agora) || !Number.isFinite(Date.parse(result.calculado_em))) throw Error('invalid summary');
        cached = result;
      }
      catch { cached = { estado: 'indisponivel', pendencias: [], agora: [], contador_pendencias: null }; }
      fetchedAt = Date.now();
    })().finally(() => { pending = null; });
    if (pending) await pending;
    const data = structuredClone(cached);
    if (data.calculado_em) {
      data.idade_ms = Date.now() - Date.parse(data.calculado_em);
      if (data.idade_ms > 60000 || data.dia !== new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date())) { data.estado = 'indisponivel'; data.contador_pendencias = null; }
      for (const source of Object.values(data.cobertura || {})) if (source.calculado_em) { source.idade_ms = Date.now() - Date.parse(source.calculado_em); if (source.idade_ms > 60000) source.estado = 'indisponivel'; }
    }
    return data;
  }
  async function action(type, value) {
    const { type: ignored, ...input } = value;
    const operations = { 'dailywork.requisicao-ler': ['requisicoes:ler', false], 'dailywork.requisicao-criar': ['requisicoes:criar', true], 'dailywork.frente-registrar': ['diario:registrar-frente', true], 'dailywork.aprovar-envio': ['requisicoes:aprovar-envio', true], 'dailywork.rejeitar-envio': ['requisicoes:rejeitar-envio', true], 'dailywork.frente-consultar-registro': ['diario:consultar-registro', false], 'dailywork.requisicao-consultar-registro': ['requisicoes:consultar-registro', false] };
    const spec = operations[type];
    if (!spec) throw new ApiError(400, 'DAILYWORK_ACTION_INVALID');
    if (type === 'dailywork.requisicao-criar') { input.origem = 'ponte'; input.preparar = false; if (typeof input.destinatario === 'string') input.destinatario = { nome: input.destinatario }; }
    if (type === 'dailywork.aprovar-envio' || type === 'dailywork.rejeitar-envio') input.via = 'ponte';
    const result = await call(spec[0], [input], spec[1]);
    fetchedAt = 0;
    return { ok: true, data: result };
  }
  return { summary, action };
}
