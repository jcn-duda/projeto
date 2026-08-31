// Dublê de conta AllDebrid com ESTADO REAL, compartilhado pelos testes da
// limpeza (`debrid-drop-uncached.test.ts`) e da autoridade das listas de
// limpeza (`debrid-drop-authority.test.ts`).
//
// O /magnet/status lista o que existe naquele instante — incluindo o que o
// /magnet/upload acabou de criar e excluindo o que o /magnet/delete removeu.
// O upload é idempotente como na API de verdade: reenviar um hash que já está
// na conta devolve o MESMO id, sem duplicar.
//
// Essa fidelidade existe por causa da corrida do inventário: no serviço real o
// /magnet/status do snapshot é disparado junto com os uploads da MESMA
// checagem e costuma chegar depois deles — o snapshot nasce já poluído com o
// que a checagem criou. Um dublê de lista fixa nunca reproduz isso, e era
// exatamente o caso que deixava o resíduo da primeira busca "protegido para
// sempre" como se fosse do usuário.
//
// `snapshotAfterUploads: true` atrasa a resposta do inventário em um
// macrotask: como o upload roda no mesmo tick, depois do disparo do snapshot,
// ele registra primeiro — e o snapshot reflete o estado poluído.

/** Arquivo do /magnet/status no formato da API (o que o pickFile lê). */
export interface FileEntry {
  n: string;
  e: { n: string; s: number; l: string }[];
}

export function mockAccountWith(
  preexisting: any,
  readyHashes: any,
  { snapshotAfterUploads = false, failDelete = false, failStatus = false, statusDelayMs = 0 } = {},
) {
  const deleted: number[] = [];
  let failStatusActive = failStatus;
  let statusDelay = statusDelayMs;
  let statusCalls = 0;
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  // Estado da conta: id → magnet. Os preexistentes entram prontos (1000+i);
  // os uploads ganham ids a partir de 2000.
  const byId = new Map();
  const byHash = new Map();
  let nextId = 2000;
  preexisting.forEach((hash: any, i: any) => {
    const magnet = { hash, id: 1000 + i, status: 'Ready', ready: true };
    byId.set(magnet.id, magnet);
    byHash.set(hash, magnet);
  });

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });

    if (url.pathname.endsWith('/magnet/status')) {
      if (failStatusActive) {
        return {
          ok: false,
          status: 500,
          async json() { return { status: 'error', error: { message: 'Internal Server Error' } }; },
        };
      }
      const id = url.searchParams.get('id');
      if (id != null) {
        const magnet = byId.get(Number(id));
        return body({ magnets: magnet ? [magnet] : [] });
      }
      // Sem id é o inventário/ocupação: a lista do que existe NESTE instante.
      statusCalls += 1;
      if (statusDelay) await new Promise((resolve) => setTimeout(resolve, statusDelay));
      if (snapshotAfterUploads) {
        // A resposta só é montada no macrotask seguinte: o upload desta
        // checagem (disparado depois do status) registra antes, e o snapshot
        // já inclui os magnets que a checagem criou.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return body({ magnets: [...byId.values()] });
    }
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      return body({
        magnets: hashes.map((hash) => {
          let magnet = byHash.get(hash);
          if (!magnet) {
            magnet = { hash, id: nextId++, status: 'Ready', ready: true };
            byId.set(magnet.id, magnet);
            byHash.set(hash, magnet);
          }
          return { ...magnet, ready: readyHashes.includes(hash) };
        }),
      });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      // A AllDebrid responde 200 com {status:"error"} quando recusa; é assim que
      // uma conta no teto rejeita a limpeza sem devolver HTTP de erro.
      if (failDelete) {
        return {
          ok: true,
          async json() { return { status: 'error', error: { code: 'MAGNET_INVALID_ID', message: 'conta recusou' } }; },
        };
      }
      const magnet = byId.get(id);
      if (magnet) {
        byId.delete(id);
        byHash.delete(magnet.hash);
      }
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    set failStatus(val: boolean) {
      failStatusActive = val;
    },
    get failStatus() {
      return failStatusActive;
    },
    set statusDelayMs(val: number) {
      statusDelay = val;
    },
    get statusCalls() {
      return statusCalls;
    },
    addExternal(hash: string, ready = true) {
      const id = nextId++;
      const magnet = { hash, id, status: 'Ready', ready };
      byId.set(id, magnet);
      byHash.set(hash, magnet);
      if (ready && !readyHashes.includes(hash)) {
        readyHashes.push(hash);
      }
      return id;
    },
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/** A limpeza é disparada sem await (efeito colateral, não resposta). */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Deixa o snapshot atrasado do inventário resolver antes da checagem seguinte. */
export const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));
