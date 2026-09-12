'use strict';

const { USER_AGENT, parseHost } = require('./runtime');

function isNetworkError(err, extraExcluded = '') {
  if (!err) return false;
  const message = String(err.message || err);
  const excluded = `http_|blocked_host|unsupported_protocol|missing_redirect|not_detail_page|no_magnet|too_many_redirects${extraExcluded}`;
  return !new RegExp(`^(?:${excluded})`).test(message);
}

/**
 * @param {string} tag
 * @param {string} envUrlsCsv
 * @param {string} primaryUrl
 * @param {string[]} fallbackHosts
 * @param {object} [options]
 * @param {number} [options.probeTtlMs]      Imunidade do vencedor após um probe.
 * @param {number} [options.failsBeforeProbe] Falhas de rede consecutivas que disparam o probe.
 */
function createSiteSelector(tag, envUrlsCsv, primaryUrl, fallbackHosts, options = {}) {
  const fromCsv = String(envUrlsCsv || '').split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean);
  const candidates = [];
  const seen = new Set();
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
  let probing = null;
  const changeListeners = [];

  function hosts() {
    return Array.from(new Set(candidates.map((url) => parseHost(url)).filter(Boolean)));
  }

  async function probe() {
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

  async function noteFailure() {
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
    onDomainChange(listener) { changeListeners.push(listener); },
  };
}

module.exports = { createSiteSelector, isNetworkError };
