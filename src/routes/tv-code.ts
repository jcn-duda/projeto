/* Encurtador próprio para TV: troca o link de instalação por um código de 7
 * dígitos que o app Power Movie digita no controle remoto.
 *
 * Nasceu porque o encurtador da AFTVnews passou a levar de 12 s a 29 s para
 * responder (medido em 2026-11-12), estourando o timeout do app.
 *
 * O link pode carregar a chave de debrid (o "Liberar chave" deixa o `dk`
 * legível), e 7 dígitos são só 9 milhões de combinações. Por isso:
 * - o código vale 30 min E no máximo 2 usos (o 2º cobre uma instalação que
 *   falhou no meio); fica só em memória — restart apaga, é só para instalar;
 * - só aceita link de manifest de addon (`.../manifest.json`): desta instância
 *   ou de outro addon em https (legendas, Torrentio...) — nunca URL qualquer;
 * - código que não é nosso é resolvido na AFTVnews pelo FlareSolverr
 *   (`utils/aftv-resolve.ts`), porque a AFTVnews passou a barrar apps;
 * - consulta tem teto por IP e teto global, que tornam varrer o espaço inviável.
 */

import { randomInt } from 'node:crypto';
import type express from 'express';
import type { AftvResult } from '../utils/aftv-resolve.js';

const CODE_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;
const MAX_URL_LENGTH = 9_000;
const CODE_PATTERN = /^\d{7}$/;
const MAX_USES = 2;
// Códigos da AFTVnews variam de tamanho (antigos têm 5-6 dígitos).
const AFTV_CODE_PATTERN = /^\d{3,9}$/;

interface Entry { url: string; expiresAt: number; usesLeft: number }

interface WindowLimit { limit: number; windowMs: number }

/** Contador de janela deslizante por chave (IP ou `global`). */
function createRateLimiter({ limit, windowMs }: WindowLimit, now: () => number) {
  const hits = new Map<string, number[]>();
  return function allow(key: string): boolean {
    const time = now();
    const recent = (hits.get(key) || []).filter((stamp) => time - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(time);
    hits.set(key, recent);
    // Poda barata: um IP que sumiu não deve segurar memória para sempre.
    if (hits.size > 10_000) {
      for (const [k, stamps] of hits) {
        if (!stamps.some((stamp) => time - stamp < windowMs)) hits.delete(k);
      }
    }
    return true;
  };
}

interface TvCodeOptions {
  now?: () => number;
  /** Teste injeta sequência fixa; produção usa `crypto.randomInt`. */
  nextCode?: () => string;
  createPerIp?: WindowLimit;
  lookupPerIp?: WindowLimit;
  lookupGlobal?: WindowLimit;
  /** Resolve códigos que não são nossos na AFTVnews (FlareSolverr). */
  aftv?: { resolve(code: string): Promise<AftvResult> };
}

/**
 * IP do cliente. Em produção há Cloudflare → Caddy → gateway → Node: o
 * `cf-connecting-ip` é escrito pela Cloudflare; sem ela, o último salto do
 * `x-forwarded-for` é o que o Caddy viu. O teto global cobre o caso de
 * alguém forjar o cabeçalho batendo direto na origem.
 */
function clientIp(req: express.Request): string {
  const cf = req.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Aceita link de manifest de addon Stremio:
 * - desta instância: `http(s)://<este host>/<segmento>/manifest.json`;
 * - de outro addon: `https://<host>/.../manifest.json` (query permitida, que
 *   alguns addons usam para a configuração).
 * Nunca uma URL qualquer: o encurtador não vira redirecionador genérico.
 */
function acceptableUrl(raw: string, host: string | undefined): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH || !host) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hash || parsed.username || parsed.password) return null;
  if (parsed.host.toLowerCase() === host.toLowerCase()) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!/^\/[^/]+\/manifest\.json$/.test(parsed.pathname)) return null;
    if (parsed.search) return null;
    return parsed.toString();
  }
  if (parsed.protocol !== 'https:') return null;
  if (!/\/manifest\.json$/.test(parsed.pathname)) return null;
  return parsed.toString();
}

function makeTvCodeHandlers(options: TvCodeOptions = {}) {
  const now = options.now ?? Date.now;
  const nextCode = options.nextCode ?? (() => String(randomInt(1_000_000, 10_000_000)));
  const allowCreate = createRateLimiter(options.createPerIp ?? { limit: 20, windowMs: 10 * 60_000 }, now);
  const allowLookupIp = createRateLimiter(options.lookupPerIp ?? { limit: 20, windowMs: 60_000 }, now);
  const allowLookupGlobal = createRateLimiter(options.lookupGlobal ?? { limit: 300, windowMs: 60_000 }, now);
  const byCode = new Map<string, Entry>();
  const byUrl = new Map<string, string>();

  function sweep(time: number) {
    for (const [code, entry] of byCode) {
      if (entry.expiresAt <= time) {
        byCode.delete(code);
        if (byUrl.get(entry.url) === code) byUrl.delete(entry.url);
      }
    }
  }

  const create = (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    if (!allowCreate(clientIp(req))) {
      return res.status(429).json({ error: 'muitos códigos gerados; tente em alguns minutos' });
    }
    const url = acceptableUrl(String(req.body || '').trim(), req.get('host'));
    if (!url) return res.status(400).json({ error: 'link de instalação inválido' });

    const time = now();
    sweep(time);
    // Mesmo link dentro da validade devolve o mesmo código: clicar duas vezes
    // não deve trocar o número que a pessoa já está digitando na TV.
    const existing = byUrl.get(url);
    if (existing && byCode.has(existing)) {
      const entry = byCode.get(existing)!;
      return res.json({
        code: existing,
        expiresInSec: Math.ceil((entry.expiresAt - time) / 1000),
        usesLeft: entry.usesLeft,
      });
    }
    if (byCode.size >= MAX_ENTRIES) {
      return res.status(503).json({ error: 'encurtador cheio; tente em alguns minutos' });
    }
    let code = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = nextCode();
      if (!byCode.has(candidate)) { code = candidate; break; }
    }
    if (!code) return res.status(503).json({ error: 'encurtador indisponível' });

    byCode.set(code, { url, expiresAt: time + CODE_TTL_MS, usesLeft: MAX_USES });
    byUrl.set(url, code);
    return res.json({ code, expiresInSec: CODE_TTL_MS / 1000, usesLeft: MAX_USES });
  };

  async function fromAftv(code: string, res: express.Response) {
    try {
      const result = await options.aftv!.resolve(code);
      if (!result.url) return res.status(404).json({ error: 'código não encontrado' });
      return res.json({ url: result.url, source: 'aftvnews' });
    } catch (error) {
      if (error instanceof Error && error.message === 'busy') {
        return res.status(429).json({ error: 'encurtador ocupado; tente de novo em instantes' });
      }
      return res.status(502).json({ error: 'não foi possível consultar a AFTVnews' });
    }
  }

  const lookup = async (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    if (!allowLookupGlobal('global') || !allowLookupIp(clientIp(req))) {
      return res.status(429).json({ error: 'muitas tentativas; aguarde um minuto' });
    }
    const code = String(req.params.code || '');
    const entry = CODE_PATTERN.test(code) ? byCode.get(code) : undefined;
    if (!entry || entry.expiresAt <= now()) {
      if (options.aftv && AFTV_CODE_PATTERN.test(code)) return fromAftv(code, res);
      return res.status(404).json({ error: 'código não encontrado, expirado ou já usado' });
    }
    entry.usesLeft -= 1;
    if (entry.usesLeft <= 0) {
      byCode.delete(code);
      if (byUrl.get(entry.url) === code) byUrl.delete(entry.url);
    }
    return res.json({ url: entry.url, usesLeft: entry.usesLeft });
  };

  return { create, lookup };
}

export { makeTvCodeHandlers, acceptableUrl, CODE_TTL_MS, MAX_USES };
