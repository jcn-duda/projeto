// Rotas internas do `/resolve` nativo do gateway (incondicional).
//
// POR QUE EXISTEM: o play é do Rust, mas o que o play PROVA (magnet vivo, sem
// vídeo, dublagem falsa, episódio ausente, bloqueio legal, arquivos do torrent)
// grava estado que mora neste processo: `magnetdb`, proteção durável, ledger
// do RD, `davail`, prova de arquivo e o L1 das listas. As decisões já vêm
// prontas do núcleo (`adom_debrid::resolve_effects`); aqui só se aplica, com os
// MESMOS helpers da ponte `rust-remote.ts` (`applyResolveEffects`,
// `applyPlayEffects`).
//
// - POST /internal/resolve/facts   `{ encoded?, service, hash }`
//   → `{ ok, held, dropUncached }`. Só AllDebrid: o hold do autofetch decide se
//   o play pode apagar o magnet frio. Qualquer falha no gateway = `held:true`.
// - POST /internal/resolve/effects `{ encoded?, service, hash, imdbId?, season?,
//   episode?, outcome: 'ok'|'error', alive?, effect?, files?, unavailable? }`
//   → `{ ok }`. Responde DEPOIS do flush do store nativo: o gateway espera esta
//   resposta antes do 404, para a reabertura imediata já não servir o hash.
//
// A chave nunca vai no JSON: sai do runtime do `encoded` (ou dos defaults do
// operador, como o `/resolve` sem segmento). `service` tem que ser o serviço
// desse runtime — senão 400, sem gravar nada.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard } from './internal-search-shared.js';
import { applyResolveEffects, effectFromRustJson } from '../debrid/rust-resolve-apply.js';
import { applyPlayEffects } from '../debrid/rust-play-effects.js';
import { alldebridLinkFacts } from '../debrid/rust-link-facts.js';
import { flushNativeStreamStores } from '../utils/streams-store-native.js';

type Target = { service: string; apiKey: string };

/** Runtime do corpo: `encoded` decodificado ou os defaults do operador. */
function withTarget<T>(
  services: AppServices,
  body: { encoded?: unknown } | undefined,
  task: (target: Target) => T,
): T | null {
  const encoded = typeof body?.encoded === 'string' ? body.encoded : '';
  const read = () => {
    const opts = services.runtime.opts();
    return task({ service: String(opts.debridService || '').toLowerCase(), apiKey: opts.debridApiKey || '' });
  };
  if (!encoded) return read();
  const opts = services.runtime.decode(encoded);
  return opts ? services.runtime.run({ opts, encoded }, read) : null;
}

const HASH = /^[a-f0-9]{40}$/;

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

async function handleFacts(services: AppServices, req: express.Request, res: express.Response) {
  const body = req.body as { encoded?: unknown; service?: unknown; hash?: unknown } | undefined;
  const hash = typeof body?.hash === 'string' ? body.hash.toLowerCase() : '';
  if (!HASH.test(hash)) return res.status(400).json({ ok: false, error: 'hash inválido' });
  if (body?.service !== 'alldebrid') {
    return res.status(400).json({ ok: false, error: 'fatos do play só existem para alldebrid' });
  }
  const facts = withTarget(services, body, (target) => (
    target.service === 'alldebrid' ? alldebridLinkFacts(target.apiKey, hash) : undefined
  ));
  if (!facts) return res.status(400).json({ ok: false, error: 'config ou serviço não confere' });
  return res.json({ ok: true, ...facts });
}

async function handleEffects(services: AppServices, req: express.Request, res: express.Response) {
  const body = req.body as Record<string, unknown> | undefined;
  const hash = typeof body?.hash === 'string' ? body.hash.toLowerCase() : '';
  if (!HASH.test(hash)) return res.status(400).json({ ok: false, error: 'hash inválido' });
  const outcome = body?.outcome;
  const effect = outcome === 'error' ? effectFromRustJson(body?.effect) : undefined;
  if (outcome !== 'ok' && !(outcome === 'error' && effect)) {
    return res.status(400).json({ ok: false, error: 'outcome/effect inválido' });
  }
  const imdbId = typeof body?.imdbId === 'string' && /^tt\d+$/.test(body.imdbId) ? body.imdbId : '';
  const applied = withTarget(services, body, async (target) => {
    if (!target.service || target.service !== body?.service || !target.apiKey) return false;
    // `files`/`unavailable` valem nos dois desfechos: a prova de áudio de uma
    // dublagem falsa chega junto com o erro (o TS a grava antes de lançar).
    await applyPlayEffects(target.service, target.apiKey, hash, {
      files: body?.files,
      unavailable: body?.unavailable,
    });
    if (outcome === 'ok') {
      if (body?.alive === true) services.magnetdb.markAlive(target.service, target.apiKey, [hash]);
      services.metrics.count('resolve.native.ok');
      return true;
    }
    applyResolveEffects(effect, {
      adapterId: target.service,
      apiKey: target.apiKey,
      infoHash: hash,
      imdbId,
      season: intOrNull(body?.season),
      episode: intOrNull(body?.episode),
      services,
    });
    // O 404 do gateway espera isto: a lista nativa tem que estar limpa antes.
    if (effect?.cache.invalidate !== 'none') await flushNativeStreamStores();
    services.metrics.count('resolve.native.effect');
    return true;
  });
  if (!(await applied)) return res.status(400).json({ ok: false, error: 'config ou serviço não confere' });
  return res.json({ ok: true });
}

/** Registra as rotas antes do overlay `/:userConfig`, com a guarda interna. */
export function registerInternalResolve(router: Router, services: AppServices): void {
  const json = express.json({ limit: '256kb' });
  router.post('/internal/resolve/facts', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleFacts(services, req, res);
  }));
  router.post('/internal/resolve/effects', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleEffects(services, req, res);
  }));
}
