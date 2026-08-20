/**
 * Hashes que a limpeza automática NÃO pode apagar da conta do debrid.
 *
 * Existe por causa de uma colisão: o `dropUncached` remove da conta tudo que não
 * está em cache (senão cada busca deixa um download fantasma lá), e o download
 * automático da fonte BR dublada faz exatamente o oposto — coloca de propósito
 * um torrent que ainda não está pronto. Sem esta lista, a busca seguinte veria
 * "não está em cache" e apagaria o download no meio.
 *
 * Só o hash escolhido para baixar entra aqui, e por tempo limitado: expirado,
 * ele volta a ser candidato à limpeza normal.
 */
const held = new Map();

function sweep() {
  const now = Date.now();
  for (const [hash, expiresAt] of held) if (expiresAt <= now) held.delete(hash);
}

function key(hash, account = 'none') {
  return `${account}:${String(hash || '').toLowerCase()}`;
}

/** Protege o hash por `ttlSeconds`. Chamar de novo renova o prazo. */
function hold(hash, ttlSeconds, account = 'none') {
  if (!hash) return;
  sweep();
  held.set(key(hash, account), Date.now() + Math.max(1, Number(ttlSeconds) || 0) * 1000);
}

/** Libera o hash: volta a valer a limpeza normal. */
function release(hash, account = 'none') {
  held.delete(key(hash, account));
}

function isHeld(hash, account = 'none') {
  const heldKey = key(hash, account);
  const expiresAt = held.get(heldKey);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    held.delete(heldKey);
    return false;
  }
  return true;
}

export { hold, release, isHeld };
