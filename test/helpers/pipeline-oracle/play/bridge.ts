/**
 * Ponte de PLAY do Node — oráculo de teste. Era o `resolveLink` do `wrap` em
 * `src/debrid/rust-remote.ts`: o `/resolve` de produção e os efeitos dele
 * (magnetdb, proteção, ledger, listas) são do gateway (`play_effects_native*`),
 * então este caminho só serve aos testes que exercitam o contrato do
 * POST /debrid/link e a gravação TS dos efeitos.
 */
import type { DebridAdapter, PlayHint } from '../../../../types/domain.js';
import { post, remoteOptions, playError, type RemoteOptions } from '../../../../src/debrid/rust-remote.js';
import { alldebridLinkFacts } from './rust-link-facts.js';
import { takeResolveEffect, type RustResolveEffect } from './rust-resolve-apply.js';
import { applyPlayEffects } from './rust-play-effects.js';

type ResolveLink = NonNullable<DebridAdapter['resolveLink']>;

/** `resolveLink` pela 8710 para o adaptador, como o `wrap` fazia antes. */
export function bridgedResolveLink(adapter: Pick<DebridAdapter, 'id'>, overrides: Partial<RemoteOptions> = {}): ResolveLink {
  const opts = remoteOptions(overrides);
  return async (apiKey: string, hash: string, episode?: PlayHint) => {
    // held true = não apagar. Ausente no Rust protege; aqui o Node diz a verdade.
    const held = adapter.id === 'alldebrid' ? alldebridLinkFacts(apiKey, hash).held : undefined;
    const remote = await post(opts, '/debrid/link', {
      service: adapter.id,
      apiKey,
      hash,
      episode: episode ?? null,
      ...(held === undefined ? {} : { held }),
    });
    if (!remote.ok) {
      // Mentira de dublagem: o TS grava a prova antes de lançar.
      if (remote.files !== undefined) await applyPlayEffects(adapter.id, apiKey, hash, { files: remote.files });
      const error = playError(remote, [apiKey, opts.token]);
      const effect = takeResolveEffect(remote.effect);
      if (effect) (error as Error & { effect?: RustResolveEffect }).effect = effect;
      throw error;
    }
    const body = remote.json as { url?: unknown } | null;
    await applyPlayEffects(adapter.id, apiKey, hash, body);
    return body && typeof body.url === 'string' ? body.url : null;
  };
}

/** Adaptador da ponte com o play do oráculo por cima. */
export function withPlayBridge<T extends DebridAdapter>(adapter: T, overrides: Partial<RemoteOptions> = {}): T & { resolveLink: ResolveLink } {
  return { ...adapter, resolveLink: bridgedResolveLink(adapter, overrides) };
}
