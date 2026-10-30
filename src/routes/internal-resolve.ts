// Rotas internas do `/resolve` nativo do gateway (incondicional).
//
// POR QUE EXISTE: o play é do Rust, mas o hold da AllDebrid (`protected.ts`)
// ainda mora neste processo. O gateway pergunta antes de decidir se pode apagar
// o magnet frio; sem resposta ele assume `held:true` e não apaga.
//
// Os EFEITOS do play (magnetdb, proteção durável, ledger do RD, `davail`, prova
// de arquivo e o L1 das listas) NÃO passam mais por aqui: o gateway os aplica
// direto nos stores nativos (`play_effects_native*.rs`), então não há rota de
// efeitos no Node. `POST /internal/resolve/effects` foi removida e responde 404.
//
// - POST /internal/resolve/facts   `{ encoded?, service, hash }`
//   → `{ ok, held, dropUncached }`. Só AllDebrid: o hold do autofetch decide se
//   o play pode apagar o magnet frio. Qualquer falha no gateway = `held:true`.
//
// A chave nunca vai no JSON: sai do runtime do `encoded` (ou dos defaults do
// operador, como o `/resolve` sem segmento). `service` tem que ser o serviço
// desse runtime — senão 400, sem gravar nada.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard } from './internal-search-shared.js';
import { alldebridLinkFacts } from '../debrid/rust-link-facts.js';

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

/** Registra as rotas antes do overlay `/:userConfig`, com a guarda interna. */
export function registerInternalResolve(router: Router, services: AppServices): void {
  const json = express.json({ limit: '256kb' });
  router.post('/internal/resolve/facts', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleFacts(services, req, res);
  }));
}
