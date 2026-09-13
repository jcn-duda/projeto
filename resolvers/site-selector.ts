import { USER_AGENT, parseHost } from './runtime.js';
import type { SiteSelector } from './types.js';

/** Overrides opcionais do seletor (o harness injeta para não depender de env). */
export interface SiteSelectorOptions {
  probeTtlMs?: number;
  failsBeforeProbe?: number;
}

function isNetworkError(err: unknown, extraExcluded = ''): boolean {
  if (!err) return false;
  // Preserva a semântica antiga para QUALQUER thrown com `.message` (não só
  // `instanceof Error`): o transporte rejeita objetos simples em testes e o
  // `in` cobre os dois sem cast. Falsy cai em String(err), como antes.
  const message = typeof err === 'object' && err !== null && 'message' in err
    ? String(err.message || err)
    : String(err);
  const excluded = `http_|blocked_host|unsupported_protocol|missing_redirect|not_detail_page|no_magnet|too_many_redirects${extraExcluded}`;
  return !new RegExp(`^(?:${excluded})`).test(message);
}

/**
 * Seletor de domínio com failover. `envUrlsCsv` e `primaryUrl` podem chegar
 * vazios (modo embutido sem env): só os candidatos não vazios entram.
 */
function createSiteSelector(
  tag: string,
  envUrlsCsv: string | null | undefined,
  primaryUrl: string | null | undefined,
  fallbackHosts: string[],
  options: SiteSelectorOptions = {},
): SiteSelector {
  const fromCsv = String(envUrlsCsv || '').split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean);
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const url of [primaryUrl, ...fromCsv, ...fallbackHosts.map((host) => `https://${host}`)]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
  }

  // Injetável; sem override, a env é lida AGORA (chamada), não no import —
  // o teste de failover cria instâncias com env própria sem cache-busting.
  const ttlMs = options.probeTtlMs !== undefined
    ? Number(options.probeTtlMs)
    : Number(process.env.BR_DOMAIN_PROBE_TTL_MS || 30 * 60_000);
  const failsBeforeProbe = options.failsBeforeProbe !== undefined
    ? Number(options.failsBeforeProbe)
    : Number(process.env.BR_DOMAIN_FAILS_BEFORE_PROBE || 2);
  const probeTimeoutMs = 5_000;
  let current = candidates[0];
  let lastProbeAt = 0;
  let consecutiveFails = 0;
  let probing: Promise<string> | null = null;
  const changeListeners: Array<(url: string) => void> = [];

  function hosts(): string[] {
    return Array.from(new Set(candidates.map((url) => parseHost(url)).filter(Boolean)));
  }

  async function probe(): Promise<string | null> {
    for (const url of candidates) {
      try {
        const response = await fetch(`${url}/?s=teste`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
          redirect: 'follow',
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (response.ok) return url;
      } catch {}
    }
    return null;
  }

  async function noteFailure(): Promise<string> {
    consecutiveFails += 1;
    if (consecutiveFails < failsBeforeProbe) return current;
    if (Date.now() - lastProbeAt < ttlMs) return current;
    if (candidates.length <= 1) return current;
    if (probing) return probing;
    probing = (async () => {
      try {
        const winner = await probe();
        lastProbeAt = Date.now();
        consecutiveFails = 0;
        if (winner && winner !== current) {
          console.log(`${tag} domínio ativo mudou: ${current} → ${winner}`);
          current = winner;
          for (const listener of changeListeners) {
            try { listener(current); } catch {}
          }
        }
        return current;
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  return {
    url: () => current,
    hosts,
    noteFailure,
    noteSuccess() { consecutiveFails = 0; },
    onDomainChange(listener: (url: string) => void) { changeListeners.push(listener); },
  };
}

export { createSiteSelector, isNetworkError };
