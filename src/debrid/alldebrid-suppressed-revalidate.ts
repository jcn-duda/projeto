// Item 1b — revalidação de fundo dos represados da AllDebrid (conta BYO).
//
// A parada por progresso da AllDebrid (Fase 3, `autofetch-progress`) é uma
// derivação HEURÍSTICA: bytes parados por N rechecks. Por isso o
// `collapseTerminal` do ramo `progress` NUNCA apaga direto — ele blacklista,
// libera holds e registra o id na fila de represados (`autofetch-suppressed`).
// O que destrava a remoção depois é o `drainSuppressed`, que só roda com o
// knob `DEBRID_REMOVE_BY_ID` (default OFF) e é acionado pelo recheck do lote.
//
// Sobra o canto da conta BYO: a varredura periódica (`sweepDead`) só existe
// para a conta do OPERADOR (`env-ops`), então um represado de instalação pode
// ficar até o TTL sem ninguém reavaliá-lo. Este módulo fecha o ciclo SEM
// apagar por heurística e SEM guardar credencial: quando a MESMA instalação
// volta a buscar, o `checkCached` agenda uma rodada em FUNDO que reavalia os
// represados com a apiKey corrente e só remove o que o status AUTORITATIVO
// declarar terminal pelo TEXTO (`isDeadMagnet`, via hash — a mesma autoridade
// do `sweepDead`). `downloading`/`unknown` mantêm o registro; `ready` cura o
// registro e a blacklist indevida do autofetch (a heurística errou).
//
// ESCOPO: a fila `sup:` carrega represados de TODAS as origens (progresso,
// `via:'id'` nativo, `expired-unready`) — a revalidação alcança a fila inteira,
// não só o ramo de progresso. Toda remoção continua passando pelas MESMAS
// travas: estado terminal pelo texto, idade mínima, re-add do usuário detectado
// pelo `uploadDate` × etiqueta `adsub` e hold volátil.
//
// Contrato e travas:
//   - Knob DESTRUTIVO `DEBRID_SUPPRESSED_REVALIDATE` (default FALSE): desligado,
//     o módulo é zero rede — a fila segue para o knob/painel de sempre.
//   - AllDebrid-only: o status autoritativo e o gate de delete são daqui; a
//     remoção passa pelo gate ÚNICO da conta (`deleteMagnets`, B-4) — nunca
//     `removeTorrent` nem delete por id cru.
//   - Conta do operador NÃO entra: ela já tem `sweepDead` periódico. O gate é
//     `isByoAccount` (a chave corrente difere da do `.env`, ou não há chave de
//     operador).
//   - Fire-and-forget: zero await de rede no caminho da resposta.
//   - Coalescing por conta (anti-reentrada) + intervalo mínimo + backoff
//     exponencial por erro — o status não é consultado a cada busca.
//   - Falha (rede/auth) preserva fila e provas; o registro só sai quando o
//     status prova terminal/ready/ausente. Nenhum `adrm` é gravado aqui.
//   - Não drena a fila (`drainNext`) de novo: o dreno é do recheck, uma vez.
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as cache from '../utils/cache.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as held from './protected.js';
import { deadKey } from '../providers/autofetch-keys.js';
import * as suppressed from '../providers/autofetch-suppressed.js';
import { id as ADAPTER_ID, isDeadMagnet, magnetList, type AllDebridMagnetRow } from './alldebrid-api.js';
import { deleteMagnets } from './alldebrid-cleanup.js';
import { forgetSubmitted, submittedAt } from './alldebrid-inventory.js';

// Intervalo mínimo entre rodadas POR CONTA: o gatilho é a checagem (várias por
// minuto); um `/magnet/status` de fundo não acompanha esse ritmo. Constante de
// módulo (como o backoff da própria fila): não é knob de operador.
const MIN_INTERVAL_MS = 5 * 60_000;
// Backoff por erro consecutivo: base 5min dobrando, cap 6h — a conta fora do ar
// não é martelada a cada busca.
const ERROR_BACKOFF_BASE_MS = 5 * 60_000;
const ERROR_BACKOFF_CAP_MS = 6 * 3600_000;

// Anti-reentrada: UMA rodada em voo por conta. Rajada de buscas não multiplica
// varreduras.
const inFlight = new Map<string, Promise<void>>();
// Última rodada CONCLUÍDA por conta (marcada no finally): o intervalo conta da
// conclusão, não do disparo.
const ultimaRodada = new Map<string, number>();
// Erros consecutivos por conta — resetado por uma rodada bem-sucedida.
const errorStreak = new Map<string, number>();

/** Kill-switch explícito: knob destrutivo OFF = zero rede, zero delete. */
function enabled(): boolean {
  return config.debrid.suppressedRevalidate && config.debrid.suppressedTtl > 0;
}

/**
 * Conta BYO = a chave efetiva da requisição difere da do `.env` (ou não há
 * chave de operador). A conta do operador já é coberta pelo `sweepDead`
 * periódico; duplicar aqui só somaria rede.
 */
function isByoAccount(apiKey: string): boolean {
  const chave = String(apiKey || '');
  if (!chave) return false;
  if (config.debrid.envOperatorAccount && config.debrid.apiKey && chave === config.debrid.apiKey) return false;
  return true;
}

function backoffMs(account: string): number {
  const fails = errorStreak.get(account) || 0;
  if (fails <= 0) return 0;
  return Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (fails - 1), ERROR_BACKOFF_CAP_MS);
}

/**
 * Cura a blacklist do autofetch quando o hash reaparece tocável (ready): a
 * derivação que a criou estava errada, e manter a marca esconderia o ⚡ do
 * acervo. Leitura por `isDeadQuiet` (peek) e expurgo pelo MESMO `deadKey`; o
 * índice de contagem do autofetch se poda sozinho no próximo snapshot.
 */
function healBlacklist(account: string, hash: string): void {
  const key = deadKey(ADAPTER_ID, account, hash);
  if (cache.peek(key) !== 1) return;
  cache.forget(key);
  metrics.count('autofetch.dead.cleared');
}

/**
 * Agenda a revalidação em FUNDO para a conta da requisição. Zero rede/await no
 * chamador: os guards são síncronos e o resto roda solto. Nunca lança.
 *
 * @param apiKey chave EFETIVA da instalação — o único lugar de onde ela sai
 *   (nunca é persistida: o registro do represado guarda só adapter/conta/hash).
 */
export function scheduleSuppressedRevalidate(apiKey: string): void {
  try {
    if (!enabled() || !isByoAccount(apiKey)) return;
    const account = accountScope(apiKey);
    const agora = Date.now();
    const espera = Math.max(MIN_INTERVAL_MS, backoffMs(account));
    if (agora - (ultimaRodada.get(account) ?? 0) < espera) {
      metrics.count('autofetch.suppressed.revalidate.skippedInterval');
      return;
    }
    if (inFlight.has(account)) {
      metrics.count('autofetch.suppressed.revalidate.busy');
      return;
    }
    const job = runRevalidate(apiKey, account)
      .then(() => {
        errorStreak.delete(account);
      })
      .catch((err) => {
        // Fail-open: erro de rede/auth nunca afeta resposta nenhuma e o backoff
        // evita repetir a consulta a cada busca.
        errorStreak.set(account, (errorStreak.get(account) || 0) + 1);
        metrics.count('autofetch.suppressed.revalidate.error');
        log.warn('[alldebrid] revalidação de represados falhou (fail-open):', log.errorMessage(err));
      })
      .finally(() => {
        ultimaRodada.set(account, Date.now());
        if (inFlight.get(account) === job) inFlight.delete(account);
      });
    inFlight.set(account, job);
  } catch (err) {
    log.warn('[alldebrid] revalidação de represados: falha ao agendar (fail-open):', log.errorMessage(err));
  }
}

async function runRevalidate(apiKey: string, account: string): Promise<void> {
  // Leitura indexada: nada de varredura O(L1) no caminho quente.
  const pendentes = suppressed.listSuppressedForAccount(ADAPTER_ID, account);
  if (pendentes.length === 0) return;
  metrics.count('autofetch.suppressed.revalidate.checked', pendentes.length);

  // UMA leitura autoritativa da conta (pode lançar → error/backoff no chamador).
  const conta: AllDebridMagnetRow[] = await magnetList(apiKey);
  const porHash = new Map(conta.map((m) => [String(m.hash || '').toLowerCase(), m]));

  const remover: Array<{ hash: string; id: string | number }> = [];
  let stillActive = 0;
  let curados = 0;
  let sumidos = 0;

  for (const reg of pendentes) {
    const row = porHash.get(reg.hash);
    if (!row) {
      // Sumiu da conta por outra via (usuário, reciclagem): nada a apagar — o
      // registro perdeu objeto. A blacklist PERMANECE: ausência de dado nunca
      // destrava re-download de um torrent que já provou falhar; é ela que
      // impede a esteira recomeçar o ciclo.
      suppressed.forgetSuppressed(ADAPTER_ID, account, reg.hash);
      sumidos += 1;
      continue;
    }
    if (row.ready || /^ready$/i.test(String(row.status || ''))) {
      // Heurística errou: voltou a tocar. Cura registro + blacklist, sem delete.
      suppressed.forgetSuppressed(ADAPTER_ID, account, reg.hash);
      healBlacklist(account, reg.hash);
      curados += 1;
      continue;
    }
    // Terminal SÓ pelo texto autoritativo (isDeadMagnet); downloading/unknown
    // mantêm o registro. Held volátil (autofetch em voo) adia.
    if (isDeadMagnet(row.status) && row.id != null && !held.isHeld(reg.hash, account)) {
      // PROVA DE POSSE obrigatória: sem `adsub` (nem marker) o magnet pode ser
      // acervo do usuário que a fila `sup:` pegou por `expired-unready` sem
      // prova — e apagar acervo é irreversível para ele. Sem prova, o registro
      // fica para o sweepDead/painel (o mesmo fail-safe do 8.15: ausência
      // nunca autoriza). `magnetList` já devolve uploadDate em ms.
      const posse = submittedAt(account, reg.hash);
      if (posse == null) {
        stillActive += 1;
        continue;
      }
      // Re-add do usuário: uploadDate POSTERIOR à etiqueta `adsub` + margem
      // significa que o hash foi readicionado por fora — nunca sai (mesma
      // regra/margem do reconcile); o registro sai da fila (deixou de ser
      // nosso) e a etiqueta fica para o reconcile purgar.
      const quando = Number(row.uploadDate || 0);
      if (quando <= 0) {
        stillActive += 1; // sem data legível, NÃO remove (ausência não autoriza)
        continue;
      }
      if (quando > posse + config.debrid.reconcileAgeMarginMs) {
        suppressed.forgetSuppressed(ADAPTER_ID, account, reg.hash);
        metrics.count('autofetch.suppressed.revalidate.readded');
        continue;
      }
      // Idade mínima na conta (mesmo piso do sweepDead): terminal recém-chegado
      // pode ser o download que a conta acabou de aceitar.
      if (quando > Date.now() - config.debrid.suppressedRevalidateMinAgeMs) {
        stillActive += 1;
        continue;
      }
      remover.push({ hash: reg.hash, id: row.id });
      continue;
    }
    stillActive += 1;
  }

  if (stillActive) metrics.count('autofetch.suppressed.revalidate.stillActive', stillActive);
  if (curados) metrics.count('autofetch.suppressed.revalidate.healed', curados);
  if (sumidos) metrics.count('autofetch.suppressed.revalidate.gone', sumidos);
  if (remover.length === 0) return;

  // Gate único de delete por conta (B-4): nada de `removeTorrent`/id cru.
  const { falhas, removedIds } = await deleteMagnets(apiKey, remover.map((r) => r.id));
  if (falhas.length) metrics.count('autofetch.suppressed.revalidate.failed', falhas.length);
  // Só o que saiu DE VERDADE tem o represado esquecido — falha de delete
  // preserva o registro e a próxima rodada tenta de novo.
  const removidos = new Set((removedIds || []).map((value) => String(value)));
  let removidosOk = 0;
  for (const alvo of remover) {
    if (!removidos.has(String(alvo.id))) continue;
    suppressed.forgetSuppressed(ADAPTER_ID, account, alvo.hash);
    // O magnet saiu de verdade da conta: a etiqueta adsub não pode sobreviver
    // e transformar um re-add futuro do usuário em posse do addon.
    forgetSubmitted(account, alvo.hash);
    removidosOk += 1;
  }
  metrics.count('autofetch.suppressed.revalidate.removed', removidosOk);
  if (removidosOk) {
    log.info(`[alldebrid] revalidação: ${removidosOk} represado(s) em estado terminal removido(s) da conta`);
  }
}
