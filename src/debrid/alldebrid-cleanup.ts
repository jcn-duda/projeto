import { accountScope } from '../utils/request-key.js';
import { wait } from './common.js';
import * as held from './protected.js';
import * as metrics from '../utils/metrics.js';
import { call, id } from './alldebrid-api.js';

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

// ---------------------------------------------------------------------------
// Gate ÚNICO de deleção por conta (Fase 8, B-4).
//
// Dois executores chamam deleteMagnets (dropReady/dropDownload da checagem e
// catálogo/painel) e cada chamada abre os 4 workers internos — sem travessão
// comum, uma busca que deposita 23 ids somada a uma limpeza simultânea chegava
// a 5 × 4 = 20 deletes concorrentes para a MESMA conta, exatamente a rajada de
// 503 que o backoff abaixo existe para absorver. As varreduras de conteúdo
// (mortos, não-dublados, reconcile e represados) são NATIVAS e não passam por
// aqui. O gate serializa por accountScope: só UMA chamada deleteMagnets em voo
// por conta; os 4 workers internos continuam valendo DENTRO da chamada. Sem
// preempção: a ordem de chegada é a ordem de execução.
// ---------------------------------------------------------------------------
const deleteQueues = new Map<string, Promise<void>>();

function enqueueDelete<T>(account: string, job: () => Promise<T>): Promise<T> {
  const anterior = deleteQueues.get(account) ?? Promise.resolve();
  // `then(job, job)`: o job roda depois do anterior ASSENTAR (sucesso ou
  // falha) — a fila nunca fica travada por um erro antigo.
  const resultado = anterior.then(job, job);
  // A CAUDA nunca rejeita: a falha é do chamador; o encadeamento segue.
  const cauda = resultado.then(() => undefined, () => undefined);
  deleteQueues.set(account, cauda);
  cauda.then(() => {
    // Só apaga a entrada se nenhum job novo assumiu a cabeça enquanto esta
    // cauda assentava (evita vazar Map para contas de um request só).
    if (deleteQueues.get(account) === cauda) deleteQueues.delete(account);
  });
  return resultado;
}

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
 *
 * TODA chamada passa pelo gate único da conta (B-4): o corpo em
 * `deleteMagnetsNow` roda com exclusão mútua por accountScope.
 */
export function deleteMagnets(
  apiKey: string,
  ids: Array<string | number>,
  opts: { waitFn?: (ms: number) => Promise<unknown>; delays?: number[] } = {},
) {
  return enqueueDelete(accountScope(apiKey), () => deleteMagnetsNow(apiKey, ids, opts));
}

async function deleteMagnetsNow(
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
