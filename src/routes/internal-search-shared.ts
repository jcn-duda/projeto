// Peças compartilhadas da rota interna de busca (`internal-search-effects.ts`).
// Extraído pela catraca de linhas: a guarda (loopback + token) e a decodificação
// do `encoded` do corpo. As rotas de leitura (meta/state/collect) saíram com os
// caminhos nativos (corte do fallback de 2026-10-31), e o prazo interno
// (`withinDeadline`/`DEADLINE`) saiu junto com a última leitora.
//
// Observação de borda da guarda: se um proxy NA FRENTE do addon encaminhar
// `/internal/*`, o socket local continua 127.0.0.1 e a guarda de loopback não
// vê o cliente real — quem barra nesse cenário é o token. O gateway Rust
// (`GATEWAY=on`) recusa `/internal/*` antes do proxy; o Caddy também bloqueia.
import express from 'express';
import type { AppServices } from './types.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Chamadas internas fora do loopback são recusadas (defesa em profundidade). */
export function isLoopbackAddress(address: string | null | undefined) {
  return Boolean(address) && LOOPBACK_ADDRESSES.has(String(address));
}

/**
 * Guarda das rotas internas. Devolve `true` quando a resposta já foi escrita —
 * o handler sai na hora. Ordem: 403 (origem), 503 (operador sem token), 401
 * (token errado); o token é o que classifica o cliente, por isso vem depois.
 */
export function rejectedByGuard(services: AppServices, req: express.Request, res: express.Response) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    res.status(403).json({ ok: false, error: 'rota interna disponível apenas em loopback' });
    return true;
  }
  if (!services.config.jackett.testToken) {
    res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
    return true;
  }
  if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    return true;
  }
  return false;
}

export type DecodedUserConfig = NonNullable<ReturnType<AppServices['runtime']['decode']>>;

/** Decodifica o `encoded` do corpo; `null` = config inválida (400 no handler). */
export function decodeTarget(services: AppServices, body: unknown) {
  const encoded = typeof (body as { encoded?: unknown })?.encoded === 'string'
    ? String((body as { encoded: string }).encoded)
    : '';
  if (!encoded) return null;
  const opts = services.runtime.decode(encoded);
  return opts ? { opts, encoded } : null;
}
