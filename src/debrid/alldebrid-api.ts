import {
  json,
  AuthError, isAuthError, QuotaError, isQuotaError,
} from './common.js';
import type { InventoryItem } from '../../types/domain.js';
import type { DebridFile } from './file-selector.js';

// v4.1: a AllDebrid descontinuou /v4/magnet/status ("DISCONTINUED"), o que
// fazia toda resolução falhar com 502. upload e link/unlock respondem em ambas.
const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

/**
 * Identidade do adaptador mora aqui (e não na fachada `alldebrid.ts`) porque
 * os módulos irmãos de limpeza e checagem precisam do id para falar com
 * `protected.ts` — importá-lo da fachada criaria ciclo (fachada → irmãos →
 * fachada).
 */
export const id = 'alldebrid';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {Object} [params]
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {number} [options.timeout]
 */
export async function call(
  apiKey: string,
  path: string,
  params: Record<string, string | number | string[] | undefined> = {},
  { method = 'GET', body, timeout }: { method?: string; body?: BodyInit | null; timeout?: number } = {},
) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('agent', AGENT);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const data = await json(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeout,
  });
  // A AllDebrid responde 200 com { status: "error" }; o HTTP sozinho não basta.
  if (data.status === 'error') {
    const code = data.error?.code || '';
    const message = data.error?.message || code || 'alldebrid retornou erro';
    const full = `${message}${code ? ` (${code})` : ''}`;
    // Nenhuma das duas é falha transitória: enquanto a chave não for trocada
    // (AUTH_*) ou a conta não for esvaziada (MAGNET_TOO_MANY_ACTIVE), toda
    // tentativa volta igual. Sobem classificadas para o orquestrador degradar
    // para P2P em vez de prometer um debrid que não vai resolver.
    if (isAuthError({ message: `${code} ${message}` })) throw new AuthError(full);
    if (isQuotaError({ message: `${code} ${message}` })) throw new QuotaError(full);
    throw new Error(message);
  }
  return data.data;
}

/**
 * Linha de `/magnet/status`. Todo campo é opcional de propósito: a forma vem da
 * API, não do nosso código, e quem usa é que decide o default — daí o
 * `String(m.hash || '')` repetido nos filtros em vez de confiar no tipo.
 */
export interface AllDebridMagnet {
  id?: string | number;
  hash?: string;
  status?: string;
  filename?: string;
  /** Em segundos, não milissegundos. */
  uploadDate?: number;
  size?: number;
  ready?: boolean;
}

// Estados dos quais a AllDebrid não volta: o torrent não vai baixar.
export const DEAD = /no peer|expired|not available|error|failed/i;
export const ACTIVE_STATES = /^(?:queued|downloading|processing|compressing|moving|uploading)$/i;

/**
 * Na v4.1 os arquivos vêm como árvore, não como lista de links: `n` é o nome,
 * `e` são as entradas de uma pasta, e a folha traz `s` (tamanho) e `l` (link).
 */
export function flattenFiles(nodes: AllDebridFileNode[], prefix = ''): DebridFile[] {
  const out: DebridFile[] = [];
  for (const node of nodes || []) {
    const path = prefix ? `${prefix}/${node.n}` : node.n;
    if (Array.isArray(node.e)) {
      out.push(...flattenFiles(node.e, path));
    } else if (node.l) {
      out.push({ path, size: node.s, link: node.l });
    }
  }
  return out;
}

/** Nó da árvore de arquivos da v4.1: `n` nome, `e` entradas, `s` tamanho, `l` link. */
interface AllDebridFileNode {
  n?: string;
  e?: AllDebridFileNode[];
  s?: number;
  l?: string;
}

/**
 * Linha NORMALIZADA de magnet da conta, para o catálogo e o limpador. A API
 * entrega `uploadDate` em SEGUNDOS e o resto do addon trabalha em ms, e o hash
 * é normalizado em minúsculo como em todos os outros pontos de uso. `ready`
 * aceita tanto o booleano quanto o status `Ready` textual.
 */
export interface AllDebridMagnetRow {
  id: string | number;
  hash: string;
  filename: string;
  size: number;
  status: string;
  ready: boolean;
  /** Em milissegundos (a API manda segundos); 0 quando ausente. */
  uploadDate: number;
}

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

/**
 * Ocupação da conta, por estado. Serve ao verificador: encher é o que derruba
 * a checagem de cache (que é um upload) e faz o ⚡ sumir da lista inteira, e
 * até estourar não existe nenhum sinal — o erro só chega quando já é tarde.
 *
 * Sem percentual: a AllDebrid tem DOIS limites que não batem entre si e nenhum
 * dos dois é consultável. A doc documenta `MAGNET_TOO_MANY_ACTIVE` como
 * "maximum allowed active magnets (30)", enquanto a mensagem que derrubou esta
 * conta na prática dizia "Magnets limit reached (1000 accross all tabs)" — e a
 * conta tinha 2309 registros funcionando. Inventar "% ocupado" sobre um teto
 * que não conhecemos dizia "231% ocupado" para uma conta que respondia normal.
 * Melhor relatar o que dá para medir e deixar o limiar explícito.
 */
export async function accountStatus(apiKey: string) {
  const data = await call(apiKey, '/magnet/status');
  const magnets = Array.isArray(data?.magnets) ? data.magnets : [];

  let ready = 0;
  let active = 0;
  let error = 0;
  for (const magnet of magnets) {
    const status = String(magnet.status || '');
    if (magnet.ready || /^ready$/i.test(status)) ready += 1;
    else if (ACTIVE_STATES.test(status)) active += 1;
    else if (status) error += 1;
  }

  return {
    magnets: magnets.length,
    ready,
    active,
    error,
    oldestAt: magnets.reduce(
      (min: number | null, m: AllDebridMagnet) => (m.uploadDate && (!min || m.uploadDate < min) ? m.uploadDate : min),
      null,
    ),
  };
}

/**
 * Inventário PRONTO da conta (`{ title, infoHash, size }`): base da
 * conta-como-fonte. Só o que já está pronto interessa — o que ainda baixa não
 * é tocável e não deve aparecer como stream.
 *
 * Entrada cujo filename É o próprio hash é magnet sem metadado resolvido
 * (5 no inventário real medido): título vazio não casa com obra nenhuma.
 */
export async function inventory(apiKey: string) {
  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: InventoryItem[] = [];
  for (const magnet of list) {
    // Mesmo critério de "pronto" do accountStatus: `ready` ou status Ready.
    if (!(magnet.ready || /^ready$/i.test(String(magnet.status || '')))) continue;
    const infoHash = String(magnet.hash || '').toLowerCase();
    const title = String(magnet.filename || '').trim();
    if (!infoHash || !title) continue;
    if (title.toLowerCase() === infoHash) continue;
    out.push({ title, infoHash, size: Number(magnet.size) || 0 });
  }
  return out;
}
