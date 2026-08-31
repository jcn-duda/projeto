import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { wait } from './common.js';
import * as held from './protected.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { foreignVerdict } from '../utils/audio-quality.js';
import { markReuploadBlocked } from './alldebrid-reupload.js';
import { call, id, DEAD, ACTIVE_STATES, type AllDebridMagnet } from './alldebrid-api.js';
import { preexistingHashes } from './alldebrid-inventory.js';

/**
 * Um magnet está a salvo da limpeza se há proteção VOLÁTIL (hold, autofetch em
 * voo) OU DURÁVEL (`adprot:v1`, acervo BR retido). Quando a proteção durável é
 * a que poupou o item, conta a métrica própria — o volátil é o comportamento
 * antigo e não é acervo retido, então não conta aqui.
 */
export function skipCleanup(account: string, hash: string): boolean {
  if (!held.isCleanupProtected(hash, account, id)) return false;
  if (held.isDurablyProtected(id, account, hash)) metrics.count('debrid.cleanup.protectedBrSkipped');
  return true;
}

// Limpeza em fila curta com backoff exponencial e reenfileiramento.
//
// Disparar os ~50 deletes de uma checagem em paralelo fazia a AllDebrid
// devolver 503 (página HTML, não JSON) em parte deles — medido: 13 de 45 numa
// única busca. Cada 503 é um magnet que fica na conta para sempre, e como a
// conta cheia derruba a própria checagem de cache, o erro se realimenta.
// O backoff não é firula: o 503 é sintoma de rajada, não de id inválido, e
// esperas crescentes (400 → 800 → 1600ms) dão tempo da rajada passar antes de
// reenfileirar o id para uma segunda rodada. Só aí falha de verdade.
const DROP_CONCURRENCY = 4;
const DROP_RETRY_DELAYS = [400, 800, 1600];

/**
 * Remove magnets por id. O contrato de retorno é o mesmo de sempre
 * (`{ ok, falhas }`), mas a execução tolera o 503 em rajada:
 *
 *   - cada id tem até `delays.length` tentativas com espera crescente a partir
 *     de 400ms (400 → 800 → 1600);
 *   - se ainda falhar, é REENFILEIRADO no fim da fila UMA vez, para a segunda
 *     rodada rodar só depois de a rajada passar;
 *   - na segunda rodada a falha é de verdade e o id vai para `falhas`.
 *
 * `waitFn`/`delays` são injeção opcional para os testes encurtarem as esperas
 * sem esperar o backoff real; produção usa `wait` (de `common.js`) e os
 * padrões acima.
 *
 * O retorno inclui `removedIds` (8.14): os ids que SAÍRAM de verdade. É o que
 * permite o chamador de deleção INTENCIONAL marcar "não re-subir" sem marcar
 * falha — magnet que a conta recusou apagar continua lá, e marcá-lo o
 * esconderia da checagem de cache à toa. Chamadores antigos que leem só
 * `{ ok, falhas }` continuam funcionando.
 */
export async function deleteMagnets(
  apiKey: string,
  ids: Array<string | number>,
  { waitFn = wait, delays = DROP_RETRY_DELAYS }: { waitFn?: (ms: number) => Promise<unknown>; delays?: number[] } = {},
) {
  const falhas: Array<{ message?: string }> = [];
  const removidos: Array<string | number> = [];
  let ok = 0;

  const round = async (alvo: Array<string | number>) => {
    const pendentes: Array<string | number> = [];
    const worker = async () => {
      while (alvo.length) {
        const id = alvo.shift();
        if (id === undefined) continue;
        let removido = false;
        for (const espera of delays) {
          try {
            await call(apiKey, '/magnet/delete', { id });
            ok += 1;
            removidos.push(id);
            removido = true;
            break;
          } catch {
            await waitFn(espera);
          }
        }
        if (!removido) pendentes.push(id);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DROP_CONCURRENCY, alvo.length) }, worker),
    );
    return pendentes;
  };

  const primeiraRodada = await round([...ids]);
  // Reenfileirados: a fila curta já drenou, a rajada passou — agora falha a sério.
  const segundaRodada = await round(primeiraRodada);
  for (const id of segundaRodada) falhas.push({ message: `falhou ao remover magnet ${id}` });
  return { ok, falhas, removedIds: removidos };
}

/** Alias interno não exportado: os demais pontos de limpeza seguem chamando-o. */
const dropMagnets = deleteMagnets;

/**
 * Varre da conta os magnets em estado terminal.
 *
 * A limpeza do checkCached só alcança hashes que estão NA busca do momento.
 * Um torrent que morreu (sem peer, expirado) e nunca mais é pesquisado fica
 * ocupando vaga para sempre — e vaga é o recurso que, esgotado, faz a conta
 * recusar até o /magnet/delete que a consertaria.
 *
 * Não consulta o inventário de preexistentes de propósito: magnet em estado
 * terminal não é acervo de ninguém. O `held` continua valendo, para não
 * matar um download do autofetch que a conta marcou cedo demais.
 */
export async function sweepDead(apiKey: string, { minAgeMs = config.debrid.sweepDeadMinAgeMs } = {}) {
  const account = accountScope(apiKey);
  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  // Após ler o status, poda o acervo durável dos hashes que NÃO estão mais na
  // conta — o registro de um BR retido que sumiu por outra via é resíduo. O
  // hold volátil adia a poda (download fresco pode ainda não constar aqui).
  held.pruneMissing(id, account, list.map((m) => m.hash).filter((h): h is string => Boolean(h)), minAgeMs);
  const limite = Date.now() - Math.max(0, Number(minAgeMs) || 0);

  const alvo = list.filter((m) => {
    if (!DEAD.test(String(m.status || ''))) return false;
    if (!m.id) return false;
    // A proteção DURÁVEL NÃO bloqueia a varredura de mortos — estado terminal
    // é lixo que ocupa vaga, não acervo. Só o hold volátil segue adiando, para
    // não matar um download que a conta acabou de aceitar.
    if (held.isHeld(String(m.hash || ''), account)) return false;
    // uploadDate vem em segundos; sem data, trata como antigo o bastante.
    const quando = Number(m.uploadDate || 0) * 1000;
    return !quando || quando <= limite;
  });

  if (!alvo.length) return { varridos: 0, falhas: 0 };
  // Estado terminal: destrava a proteção durável dos alvos ANTES de apagar —
  // sem unprotect, o registro retido apontaria para um hash que vai sair da conta.
  for (const m of alvo) held.unprotect(id, account, String(m.hash || ''));
  const { ok, falhas } = await dropMagnets(apiKey, alvo.flatMap((m) => (m.id == null ? [] : [m.id])));
  metrics.count('debrid.swept', ok);
  if (falhas.length) {
    log.warn(
      `[alldebrid] varredura: ${ok}/${alvo.length} magnet(s) morto(s) removido(s) — ${falhas.length} falhou(ram): ${falhas[0]?.message || falhas[0]}`,
    );
  } else {
    log.info(`[alldebrid] varredura: ${ok} magnet(s) morto(s) removido(s) da conta`);
  }
  return { varridos: ok, falhas: falhas.length };
}

/**
 * Varre da conta os magnets ANTIGOS com idioma ESTRANGEIRO PROVADO: só o que
 * o `foreignVerdict` CONdena — marca de áudio estrangeiro explícita
 * (TrueFrench/German etc.) ou grupo de cena EN — e nenhum sinal PT em lugar
 * nenhum. É a única limpeza que alcança o que nem está morto nem aparece mais
 * em busca — está pronto, só não serve a este addon.
 *
 * O antigo critério (balde `lixo` do `audioBucket`) condenava qualquer nordo
 * sem marca PT — foi assim que a conta chegou a 812 magnets, cheia de generic
 * estrangeiro que o enunciado do plano chamou de "conteúdo que não é BR".
 * Ausência de marca PT NUNCA mais é condenação: falso positivo aqui destrói
 * acervo que custou horas de download. Ambíguo (`unknown`) fica — o catálogo
 * resolve com auditoria dos ARQUIVOS, não com palpite de título.
 *
 * Por ser destrutiva sobre conteúdo TOCÁVEL, as travas andam juntas:
 *   - idade mínima (só o que passou de `sweepUndubbedMinAgeMs`);
 *   - `held` (download do autofetch em curso) e a retenção durável;
 *   - `knownBefore` (o acervo que já era do usuário);
 *   - estados ATIVOS (`ACTIVE_STATES`) — download em curso não é lixo;
 *   - sem data de upload, a idade não está PROVADA — fica (diferente do
 *     sweepDead: morto é lixo em qualquer idade; tocável exige prova).
 *
 * INVENTÁRIO FRIO: como a varredura é em FUNDO (fora do prazo da resposta), o
 * snapshot é AGUARDADO em vez de pular a rodada — a guarda de 5min do TTL
 * contra o timer de 6h fazia a rodada inteira desistir (fail-safe fechado) e a
 * conta entupir. Aguarda até 30s (`raceWithDeadline`); só se o inventário não
 * chegar (timeout/falha/servidor fora do ar) é que o fail-safe mantém-se:
 * `pulado: 'inventário frio'` e nada sai.
 */
export async function sweepUndubbed(
  apiKey: string,
  {
    minAgeMs = config.debrid.sweepUndubbedMinAgeMs,
    max = config.debrid.sweepUndubbedMax,
  }: { minAgeMs?: number; max?: number } = {},
): Promise<{ varridos: number; falhas: number; pulado?: string }> {
  const account = accountScope(apiKey);
  // O snapshot frio dispara o refresh e devolve null; a varredura é em fundo,
  // então AGUARDA via preexistingHashes (teto generoso de 30s, independente do
  // `debridCheckFloor` porque este caminho não disputa o prazo da resposta).
  const preexistentes = await preexistingHashes(apiKey);
  if (preexistentes === null) {
    log.info('[alldebrid] varredura de não-dublados pulada: inventário não chegou no teto de 30s');
    return { varridos: 0, falhas: 0, pulado: 'inventário frio' };
  }

  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  const limite = Date.now() - Math.max(0, Number(minAgeMs) || 0);

  const alvo = list.filter((m) => {
    if (!m.id) return false;
    // Download em curso não é lixo: estado ativo NUNCA é alvo.
    if (ACTIVE_STATES.test(String(m.status || ''))) return false;
    // BR retido no acervo (durável) ou autofetch em voo (volátil) não saem.
    if (skipCleanup(account, String(m.hash || ''))) return false;
    if (preexistentes.has(String(m.hash || '').toLowerCase())) return false;
    // Só estrangeiro PROVADO; ambíguo (`unknown`) fica para a auditoria de
    // arquivos do catálogo. Ausência de marca PT nunca mais condena.
    if (foreignVerdict(String(m.filename || '')) !== 'condena') return false;
    // uploadDate vem em segundos; sem data, não há prova de idade — fica.
    const quando = Number(m.uploadDate || 0) * 1000;
    return quando > 0 && quando <= limite;
  });

  if (!alvo.length) return { varridos: 0, falhas: 0 };
  // Teto por rodada: os mais antigos saem primeiro — o corte pega o resto.
  alvo.sort((a, b) => Number(a.uploadDate || 0) - Number(b.uploadDate || 0));
  const corte = alvo.slice(0, Math.max(0, Math.trunc(Number(max) || 0)));
  if (!corte.length) return { varridos: 0, falhas: 0 };

  const { ok, falhas, removedIds } = await dropMagnets(apiKey, corte.flatMap((m) => (m.id == null ? [] : [m.id])));
  // 8.14 — anti-reenchimento: marca "não re-subir" SÓ o que saiu de verdade
  // (removedIds; falha de delete não marca). A blindagem BR (brOriginMark no
  // filename) vive dentro do mark — falso positivo aqui esconderia o acervo
  // que a limpeza errou ao apagar. dropReady/dropDownload da checagem NÃO
  // marcam: lá a remoção é rotina de higiene, não decisão sobre o conteúdo.
  const porId = new Map(corte.map((m) => [String(m.id), m]));
  let marcados = 0;
  for (const rid of removedIds || []) {
    const m = porId.get(String(rid));
    if (m && markReuploadBlocked(account, String(m.hash || ''), m.filename)) marcados += 1;
  }
  metrics.count('debrid.swept.undubbed', ok);
  if (falhas.length) {
    log.warn(
      `[alldebrid] varredura de não-dublados: ${ok}/${corte.length} removido(s) — ${falhas.length} falhou(ram): ${falhas[0]?.message || falhas[0]}`,
    );
  } else {
    log.info(`[alldebrid] varredura de não-dublados: ${ok} magnet(s) antigo(s) sem áudio PT removido(s)`);
  }
  if (marcados) log.info(`[alldebrid] ${marcados} hash(es) marcado(s) como "não re-subir" (anti-reenchimento)`);
  return { varridos: ok, falhas: falhas.length };
}
