// Fase 8, item 8.16 — Evicção por busca: cada busca paga a própria conta.
//
// A busca que deposita ~23 magnets no AllDebrid remove os mais antigos
// PROVADAMENTE estrangeiros, tornando a ocupação ESTACIONÁRIA em vez de
// monotônica. O gatilho é o próprio tráfego que causa o entupimento — não há
// relógio (8.7 deixa de ser necessário para este fim) e sobrevive a deploy.
//
// Regras de seleção, TODAS obrigatórias em CONJUNÇÃO (PLANO_MELHORIAS §8.16):
//   1. foreignVerdict(filename) === 'condena' — estrangeiro provado; ausência
//      de marca PT NUNCA condena (trava dura 2 da Fase 8), ambíguo fica.
//   2. Nunca estado ativo (ACTIVE_STATES) — download em curso não é lixo.
//   3. Nunca skipCleanup — hold volátil do autofetch nem acervo BR durável.
//   4. Nunca preexistente (knownBefore) — o que já era do usuário.
//   5. Nunca hash que ESTA busca consultou (o upload da própria checagem).
//   6. uploadDate > 0 — sem data, a idade não está provada; fica.
//   7. Mais antigo primeiro (uploadDate crescente).
//
// Orçamento: alvo = min(hashes consultados, HARVEST_EVICT_MAX_PER_SEARCH,
// ocupação − HARVEST_EVICT_FLOOR). Conta folgada (abaixo do piso) não apaga
// nada; teto por busca é conservador e nunca ilimitado.
//
// Segurança (lição do item 1.6 — risco de PRAZO): fire-and-forget TOTAL, zero
// await da seleção/rede no prazo da resposta; escopo B-2 só da conta do
// operador; anti-reentrada por conta (a concorrente conta `busy` e sai);
// erro é fail-open (loga, não afeta resposta). Inventário null pula a rodada
// FECHADO — ausência de referência nunca autoriza remoção. NÃO escreve davail
// nem magnetdb; o que sai de verdade ganha o marcador `adrm` do 8.14.
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { foreignVerdict } from '../utils/audio-quality.js';
import { ACTIVE_STATES, magnetList, type AllDebridMagnetRow } from './alldebrid-api.js';
import { preexistingHashes } from './alldebrid-inventory.js';
import { skipCleanup, deleteMagnets } from './alldebrid-cleanup.js';
import { markReuploadBlocked } from './alldebrid-reupload.js';

/**
 * Escopo B-2: só a conta do OPERADOR — gate de operador ativo E a chave
 * efetiva EXATAMENTE a do .env. Chave BYO/instalação nunca sofre evicção.
 */
function isOperatorAccount(apiKey: string): boolean {
  if (!config.debrid.envOperatorAccount) return false;
  const chave = String(apiKey || '');
  return Boolean(chave) && Boolean(config.debrid.apiKey) && chave === config.debrid.apiKey;
}

// Anti-reentrada por conta: UMA evicção em voo por vez. A chamada concorrente
// conta `busy` e retorna — nunca empilha rodada (rajada de buscas não pode
// multiplicar varreduras de conta nem disputar o mesmo acervo a apagar).
const inFlight = new Map<string, Promise<void>>();

/**
 * Agenda a evicção em FUNDO para a conta. Zero rede/await no chamador: os
 * guards são síncronos e o resto roda solto. Nunca lança.
 *
 * @param apiKey chave efetiva da requisição — a evicção ignora o que não for
 *   exatamente a chave do operador no .env
 * @param consultados hashes que ESTA busca realmente consultou (eco do
 *   /magnet/upload) — alimentam o alvo e ficam FORA da seleção (nunca evictar
 *   o que a própria busca acabou de subir)
 */
export function scheduleEvict(apiKey: string, consultados: Iterable<string>): void {
  try {
    // Guardas síncronas, custo zero quando OFF. O gancho na checagem repete o
    // guard do knob por economia de alocação; aqui ele vale por si só (a
    // função é pública e os testes chamam direto).
    if (!config.debrid.evictPerSearch) return;
    if (config.debrid.harvestEvictMaxPerSearch <= 0) return; // 0 desliga
    if (!isOperatorAccount(apiKey)) return;
    const account = accountScope(apiKey);
    if (inFlight.has(account)) {
      metrics.count('debrid.evicted.busy');
      return;
    }
    const hashes = [...new Set([...consultados].map((h) => String(h || '').toLowerCase()).filter(Boolean))];
    const job = runEvict(apiKey, account, hashes)
      .catch((err) => {
        // Fail-open: erro de rede/da conta nunca afeta resposta nenhuma.
        metrics.count('debrid.evicted.failed');
        log.warn('[alldebrid] evicção por busca falhou (fail-open):', err?.message || String(err));
      })
      .finally(() => {
        if (inFlight.get(account) === job) inFlight.delete(account);
      });
    inFlight.set(account, job);
  } catch (err) {
    log.warn('[alldebrid] evicção por busca: falha ao agendar (fail-open):', (err as Error)?.message || String(err));
  }
}

async function runEvict(apiKey: string, account: string, consultados: string[]): Promise<void> {
  // Fail-safe fechado: sem prova de proveniência (inventário frio, refresh em
  // voo, falha de status), a rodada INTEIRA desiste — `null` nunca autoriza
  // remoção (mesma regra do dropReady).
  const preexistentes = await preexistingHashes(apiKey);
  if (preexistentes === null) {
    log.info('[alldebrid] evicção por busca pulada: inventário de proveniência não chegou');
    return;
  }

  // Uma leitura de /magnet/status em FUNDO — é ela que mede a ocupação real e
  // entrega os filenames para o veredito de estrangeiro.
  const conta: AllDebridMagnetRow[] = await magnetList(apiKey);
  const ocupacao = conta.length;
  const vaga = ocupacao - config.debrid.harvestEvictFloor;
  if (vaga <= 0) {
    // Piso de ocupação: conta folgada não apaga nada. O contador prova que o
    // gate está vivo sem remover acervo nenhum.
    metrics.count('debrid.evicted.skippedFloor');
    return;
  }

  // Alvo, não corte: evictar aproximadamente o que a busca depositou.
  const alvo = Math.min(consultados.length, config.debrid.harvestEvictMaxPerSearch, vaga);
  if (alvo <= 0) {
    metrics.count('debrid.evicted.none');
    return;
  }

  const atuais = new Set(consultados);
  const candidatos = conta
    .filter((m) => {
      if (m.id == null) return false;
      const hash = String(m.hash || '').toLowerCase();
      if (!hash || atuais.has(hash)) return false; // nunca o que ESTA busca subiu
      if (preexistentes.has(hash)) return false; // nunca o que já era do usuário
      if (ACTIVE_STATES.test(m.status)) return false; // download em curso não é lixo
      if (skipCleanup(account, hash)) return false; // held (volátil) + adprot (durável)
      // Só estrangeiro PROVADO; `unknown` fica para a auditoria de arquivos.
      if (foreignVerdict(m.filename) !== 'condena') return false;
      return Number(m.uploadDate) > 0; // sem data a idade não está provada — fica
    })
    // Mais antigos primeiro — é o regime do "cada busca paga a própria conta".
    .sort((a, b) => a.uploadDate - b.uploadDate)
    .slice(0, alvo);
  if (!candidatos.length) {
    metrics.count('debrid.evicted.none');
    return;
  }

  // Pelo gate único da conta (B-4): não disputa rajada com dropReady/varreduras.
  const { ok, falhas, removedIds } = await deleteMagnets(apiKey, candidatos.map((m) => m.id));
  metrics.count('debrid.evicted.perSearch', ok);
  if (falhas.length) metrics.count('debrid.evicted.failed', falhas.length);

  // 8.14 — remoção INTENCIONAL marca "não re-subir" SÓ o que saiu de verdade
  // (removedIds; falha de delete não marca — o magnet continua lá). O mark
  // carrega a blindagem BR (brOriginMark nunca grava) dentro dele.
  const porId = new Map(candidatos.map((m) => [String(m.id), m]));
  let marcados = 0;
  for (const rid of removedIds || []) {
    const m = porId.get(String(rid));
    if (m && markReuploadBlocked(account, m.hash, m.filename)) marcados += 1;
  }

  log.info(
    `[alldebrid] evicção por busca: ${ok}/${candidatos.length} gringo(s) mais antigo(s) removido(s)` +
      (marcados ? ` (${marcados} marcado(s) "não re-subir")` : '') +
      ` — ocupação ${ocupacao}, piso ${config.debrid.harvestEvictFloor}`,
  );
}
