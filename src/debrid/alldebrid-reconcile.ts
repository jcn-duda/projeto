// Fase 8 — Reconcile da posse (`adsub`) com a conta real: o evictor do que é
// NOSSO e sobrou.
//
// A etiqueta de posse (8.15) e a limpeza por busca convivem com um canto: hash
// etiquetado que a limpeza da própria checagem não alcançou (lote que estourou
// o prazo, delete que a conta recusou, hash omitido na resposta do upload). Ele
// fica pronto na conta para sempre — nem morto está para o sweepDead, nem
// estrangeiro-provado precisa estar para o sweepUndubbed/evicção. O reconcile
// é a varredura destes: ready + posse ativa + não preexistente + prova de que
// o upload NÃO é re-add do usuário ⇒ sai da conta, com purga da posse e o
// marcador anti-reenchimento do 8.14.
//
// Regras de seleção, TODAS obrigatórias em CONJUNÇÃO:
//   1. `ready` (nunca ACTIVE_STATES — download em curso não é lixo).
//   2. Nunca `skipCleanup` no momento da deleção (held volátil + adprot
//      durável, N5 — reavaliado na seleção, que é o instante antes do gate).
//   3. Nunca preexistente (`preexistingHashes`; `null` ⇒ rodada pulada
//      FECHADA — ausência de referência nunca autoriza remoção, N1).
//   4. Registro `adsub` ativo (posse nossa provada, em memória ou durável).
//   5. Anti-re-add (N3): só se `uploadDate <= adsub.at + margem`. Upload
//      POSTERIOR à etiqueta significa re-add do usuário — NUNCA remove. (A
//      API manda uploadDate em segundos; o `magnetList` já normaliza para ms,
//      então a comparação é direta em ms.)
//   6. Nunca hash que ESTA busca consultou (o upload da própria checagem).
//   7. Mais antigos primeiro (uploadDate crescente); teto por rodada.
//
// Segurança (as mesmas lições do evictor 8.16): fire-and-forget TOTAL, zero
// await de rede no caminho da resposta; escopo B-2 — só a conta do operador;
// anti-reentrada por conta (a concorrente conta `busy` e sai); intervalo
// mínimo por conta (o gatilho é a checagem, que pode rodar várias vezes por
// minuto — a varredura não acompanha esse ritmo); erro é fail-open. NUNCA
// escreve davail nem magnetdb: aqui a decisão é sobre POSSE, não sobre
// disponibilidade. Deletes passam pelo gate único B-4 (`deleteMagnets`); só o
// que saiu de verdade (removedIds) ganha `adrm` + purga do `adsub`.
//
// O `reuploadBlock` NÃO é dependência de disparo: com o marcador desligado o
// reconcile continua removendo e purgando — só não grava o `adrm`.
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { ACTIVE_STATES, magnetList, type AllDebridMagnetRow } from './alldebrid-api.js';
import { preexistingHashes, forgetSubmitted, submittedAt } from './alldebrid-inventory.js';
import { skipCleanup, deleteMagnets } from './alldebrid-cleanup.js';
import { markReuploadBlocked } from './alldebrid-reupload.js';

/**
 * Escopo B-2: só a conta do OPERADOR — gate de operador ativo E a chave
 * efetiva EXATAMENTE a do .env (mesma regra do evictor). Chave BYO/instalação
 * nunca sofre reconcile.
 */
function isOperatorAccount(apiKey: string): boolean {
  if (!config.debrid.envOperatorAccount) return false;
  const chave = String(apiKey || '');
  return Boolean(chave) && Boolean(config.debrid.apiKey) && chave === config.debrid.apiKey;
}

// Anti-reentrada por conta: UMA rodada em voo por vez. A chamada concorrente
// conta `busy` e retorna — rajada de buscas não pode multiplicar varreduras.
const inFlight = new Map<string, Promise<void>>();

// Última rodada CONCLUÍDA por conta: rodadas mais próximas que o intervalo
// mínimo são puladas (`skippedInterval`). Marcada no fim da rodada — durante
// a execução quem chega conta `busy`, não `skippedInterval`.
const ultimaRodada = new Map<string, number>();

/**
 * Agenda o reconcile em FUNDO para a conta. Zero rede/await no chamador: os
 * guards são síncronos e o resto roda solto. Nunca lança.
 *
 * @param apiKey chave efetiva da requisição — só a exata do operador no .env
 * @param consultados hashes que ESTA busca consultou — ficam FORA da seleção
 *   (nunca reconciliar o que a própria busca acabou de subir)
 */
export function scheduleReconcile(apiKey: string, consultados?: Iterable<string>): void {
  try {
    if (!config.debrid.reconcile) return;
    if (config.debrid.reconcileMaxPerRound <= 0) return; // 0 desliga
    // Sem labels (`adsub` desligado) não há posse a reconciliar; sem limpeza
    // ativa (dropReady/dropUncached) não há fluxo de busca que crie o cenário
    // com o ritmo do tráfego — a rodada seria redundante com as varreduras.
    if (config.debrid.alldebridSubmittedTtlMs <= 0) return;
    if (!(config.debrid.dropReady || config.debrid.dropUncached)) return;
    if (!isOperatorAccount(apiKey)) return;
    const account = accountScope(apiKey);
    const agora = Date.now();
    if (agora - (ultimaRodada.get(account) ?? 0) < config.debrid.reconcileMinIntervalMs) {
      metrics.count('debrid.reconcile.skippedInterval');
      return;
    }
    if (inFlight.has(account)) {
      metrics.count('debrid.reconcile.busy');
      return;
    }
    const atuais = new Set(
      [...(consultados ?? [])].map((h) => String(h || '').toLowerCase()).filter(Boolean),
    );
    const job = runReconcile(apiKey, account, atuais)
      .catch((err) => {
        // Fail-open: erro de rede/da conta nunca afeta resposta nenhuma.
        metrics.count('debrid.reconcile.failed');
        log.warn('[alldebrid] reconcile falhou (fail-open):', err?.message || String(err));
      })
      .finally(() => {
        ultimaRodada.set(account, Date.now());
        if (inFlight.get(account) === job) inFlight.delete(account);
      });
    inFlight.set(account, job);
  } catch (err) {
    log.warn('[alldebrid] reconcile: falha ao agendar (fail-open):', (err as Error)?.message || String(err));
  }
}

async function runReconcile(apiKey: string, account: string, atuais: Set<string>): Promise<void> {
  // Fail-safe fechado (N1): sem prova de proveniência (inventário frio,
  // refresh em voo, falha de status), a rodada INTEIRA desiste — `null` nunca
  // autoriza remoção.
  const preexistentes = await preexistingHashes(apiKey);
  if (preexistentes === null) {
    log.info('[alldebrid] reconcile pulado: inventário de proveniência não chegou');
    return;
  }

  // Uma leitura de /magnet/status em FUNDO — é ela que entrega estado,
  // filename (para o adrm) e uploadDate (para a idade e o anti-re-add).
  const conta: AllDebridMagnetRow[] = await magnetList(apiKey);
  const margem = config.debrid.reconcileAgeMarginMs;

  const elegiveis = conta.filter((m) => {
    const hash = String(m.hash || '').toLowerCase();
    if (!hash || atuais.has(hash)) return false; // nunca o que ESTA busca subiu
    if (!m.ready || ACTIVE_STATES.test(m.status)) return false; // download em curso não é lixo
    if (preexistentes.has(hash)) return false; // nunca o que já era do usuário
    const posse = submittedAt(account, hash);
    if (posse === null) return false; // sem posse nossa ativa, não é nosso
    // Sem data de upload não há prova de que o magnet é o MESMO que
    // etiquetamos (pode ser re-add do usuário): fail-safe fecha, fica.
    if (!(m.uploadDate > 0)) return false;
    // Anti-re-add: upload MAIS NOVO que a etiqueta + margem é re-add do
    // usuário — NUNCA remove (N3). A margem cobre defasagem de relógio entre
    // a AllDebrid e este processo.
    if (m.uploadDate > posse + margem) return false;
    return true;
  });

  // N5 — a trava vale no MOMENTO da deleção: held/adprot reavaliados na
  // seleção, que é o instante imediatamente anterior ao gate de delete.
  const candidatos = elegiveis.filter((m) => !skipCleanup(account, m.hash));

  // Mais antigos primeiro, teto por rodada = min(candidatos, maxPerRound).
  candidatos.sort((a, b) => a.uploadDate - b.uploadDate);
  const alvo = candidatos.slice(0, config.debrid.reconcileMaxPerRound);
  if (!alvo.length) {
    metrics.count('debrid.reconcile.none');
    return;
  }

  // Pelo gate único da conta (B-4): não disputa rajada com os drops/varreduras.
  const { ok, falhas, removedIds } = await deleteMagnets(apiKey, alvo.map((m) => m.id));
  metrics.count('debrid.reconcile.removed', ok);
  if (falhas.length) metrics.count('debrid.reconcile.failed', falhas.length);

  // 8.14 + purga: SÓ o que saiu de verdade (removedIds) recebe o marcador
  // "não re-subir" (blindagem BR dentro do mark) e tem a posse purgada —
  // falha de delete não marca nem purga (o magnet continua lá, e é nosso).
  const porId = new Map(alvo.map((m) => [String(m.id), m]));
  let marcados = 0;
  let purgados = 0;
  for (const rid of removedIds || []) {
    const m = porId.get(String(rid));
    if (!m) continue;
    if (markReuploadBlocked(account, m.hash, m.filename)) marcados += 1;
    forgetSubmitted(account, m.hash);
    purgados += 1;
  }

  log.info(
    `[alldebrid] reconcile: ${ok}/${alvo.length} magnet(s) com posse remanescente removido(s)` +
      (marcados ? ` (${marcados} marcado(s) "não re-subir")` : '') +
      (purgados ? ` (${purgados} posse(s) purgada(s))` : ''),
  );
}
