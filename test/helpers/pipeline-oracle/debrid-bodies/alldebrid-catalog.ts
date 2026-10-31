/**
 * Operações de CONTA da AllDebrid usadas pelo catálogo durável e pelo limpador
 * (listar magnets, arquivos de um magnet, deletar com gate, snapshot de
 * preexistentes). Saíram do adaptador `alldebrid.ts` e de `src/`: em produção a
 * conta do catálogo é do gateway (`/account-catalog/*`), e nada em `src/` chama
 * estas funções mais. O oráculo `catalog/catalog-env.ts` e os testes da AllDebrid
 * as importam daqui.
 *
 * Os corpos são cópias fiéis do que estava em `alldebrid-api.ts`
 * (`magnetList`/`magnetFiles`), `alldebrid-cleanup.ts` (`deleteMagnets` com o
 * gate único por conta e o backoff em duas rodadas) e `alldebrid-inventory.ts`
 * (`preexistingHashes`). Quem usa o estado vivo (`preexisting`, `knownBefore`)
 * segue lendo o mesmo módulo de `src/`.
 *
 * `deleteMagnets` é também a dependência de `dropMagnets` no corpo de checagem
 * do oráculo (`debrid-bodies/alldebrid.ts`): o gate é um só, para não voltar a
 * dois executores somando 5 × 4 deletes na mesma conta.
 */
import { accountScope } from '../../../../src/utils/request-key.js';
import { wait } from '../../../../src/debrid/common.js';
import { raceWithDeadline } from '../../../../src/utils/deadline.js';
import {
  call,
  flattenFiles,
  type AllDebridMagnet,
  type AllDebridMagnetRow,
} from '../../../../src/debrid/alldebrid-api.js';
import { knownBefore, preexisting } from '../../../../src/debrid/alldebrid-inventory.js';
import type { DebridFile } from '../../../../src/debrid/file-selector.js';

/**
 * Lista TODOS os magnets da conta (uma chamada a `/magnet/status`). Itens sem
 * `id` ou sem `hash` não fazem sentido para o catálogo/limpador — hash é o que
 * liga ao resto do pipeline e id é o que o delete usa.
 */
export async function magnetList(apiKey: string): Promise<AllDebridMagnetRow[]> {
  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: AllDebridMagnetRow[] = [];
  for (const magnet of list) {
    const id = magnet.id;
    const hash = String(magnet.hash || '').toLowerCase();
    if (id == null || !hash) continue;
    out.push({
      id,
      hash,
      filename: String(magnet.filename || ''),
      size: Number(magnet.size) || 0,
      status: String(magnet.status || ''),
      ready: Boolean(magnet.ready) || /^ready$/i.test(String(magnet.status || '')),
      uploadDate: (Number(magnet.uploadDate) || 0) * 1000,
    });
  }
  return out;
}

/**
 * Árvore de arquivos de UM magnet pronta para o catálogo auditar conteúdo.
 * Magnet ausente ou ainda não `Ready` devolve `[]` — estado de download é
 * transição, não erro de rede/auth (só o `call` lança nesses casos).
 */
export function magnetFiles(apiKey: string, serviceId: string | number): Promise<DebridFile[]> {
  return (async () => {
    const status = await call(apiKey, '/magnet/status', { id: serviceId });
    let info = status?.magnets;
    // A resposta às vezes vem como lista de um item só (mesmo shape do resolveLink).
    if (Array.isArray(info)) info = info[0];
    if (!info || !/^ready$/i.test(String(info.status || ''))) return [];
    if (!Array.isArray(info.files)) return [];
    return flattenFiles(info.files);
  })();
}

// Limpeza em fila curta com backoff exponencial e reenfileiramento (ver o
// histórico no corpo de `deleteMagnets`).
const DROP_CONCURRENCY = 4;
const DROP_RETRY_DELAYS = [400, 800, 1600];

// ---------------------------------------------------------------------------
// Gate ÚNICO de deleção por conta (Fase 8, B-4).
//
// Disparar os deletes em paralelo fazia a AllDebrid devolver 503 em rajada; e
// dois executores (checagem e catálogo) abriam 5 × 4 = 20 deletes concorrentes
// para a MESMA conta. O gate serializa por accountScope: só UMA chamada
// deleteMagnets em voo por conta; os 4 workers internos valem DENTRO da chamada.
// Sem preempção: a ordem de chegada é a ordem de execução.
// ---------------------------------------------------------------------------
const deleteQueues = new Map<string, Promise<void>>();

function enqueueDelete<T>(account: string, job: () => Promise<T>): Promise<T> {
  const anterior = deleteQueues.get(account) ?? Promise.resolve();
  // `then(job, job)`: o job roda depois do anterior ASSENTAR (sucesso ou falha).
  const resultado = anterior.then(job, job);
  // A CAUDA nunca rejeita: a falha é do chamador; o encadeamento segue.
  const cauda = resultado.then(() => undefined, () => undefined);
  deleteQueues.set(account, cauda);
  cauda.then(() => {
    // Só apaga a entrada se nenhum job novo assumiu a cabeça enquanto esta cauda assentava.
    if (deleteQueues.get(account) === cauda) deleteQueues.delete(account);
  });
  return resultado;
}

/**
 * Remove magnets por id. O contrato de retorno é `{ ok, falhas, removedIds }`;
 * a execução tolera o 503 em rajada: até `delays.length` tentativas por id com
 * espera crescente (400 → 800 → 1600ms); o que ainda falhar é REENFILEIRADO UMA
 * vez, e só na segunda rodada a falha vira `falhas`. `removedIds` são os ids que
 * SAÍRAM de verdade (o anti-reenchimento marca só esses).
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

/**
 * Snapshot `knownBefore` AGUARDADO, para caminhos de FUNDO (catálogo e limpezas
 * do painel). `null` = sem prova de proveniência: quem recebe null não apaga.
 */
export async function preexistingHashes(apiKey: string): Promise<Set<string> | null> {
  const account = accountScope(apiKey);
  const direto = knownBefore(apiKey, account);
  if (direto) return direto;
  const loading = preexisting.get(account);
  return raceWithDeadline(loading?.promise ?? Promise.resolve(null), 30_000, () => null);
}
