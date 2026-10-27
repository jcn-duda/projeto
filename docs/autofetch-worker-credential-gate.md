# Gate de credencial do worker nativo do Chupim (T3-L5/L6)

**O bloqueio:** o dreno/recheck do Chupim roda no Node dentro do
`RuntimeContext` da requisição e a chave do debrid vem de `opts().debridApiKey`;
o worker nativo proposto para o gateway (`rust/crates/adom-server`) não tem esse
contexto — e fila/marker/dead no KV (`autofetch:v3:q:`, `:m:`, `:dead:`) não guardam
credencial por desenho (`QueueCandidate` em
`adom-autofetch/src/v3/candidate.rs:65`; valor do marker em
`adom-core/src/autofetch_marker.rs:44-61`).

## (a) De onde a chave vem hoje

1. `debridApiKey` (`dk`) viaja no install URL (`SCHEMA`,
   `src/runtime.ts:60-91`); `/:userConfig` decodifica e abre o ALS
   (`src/routes/register.ts:90-93`). `opts()` lê o store (`runtime.ts:268-270`),
   `capture()` o devolve (:287-289) e `run()` o restaura (:323-325).
2. O gateway emite `autofetch_batch` com o `encoded` da requisição no corpo
   (`orchestrator/late.rs:250-279`); o payload do lote NÃO leva a chave
   (`orchestrator/effects.rs:198-215`) e o cliente interno exige `encoded`
   (`internal_client.rs:85-95`). O Node decodifica o corpo (`internal-search-shared.ts:47-53`),
   monta `ctx` e roda o efeito sob ele (`internal-search-effects.ts:196-204`).
3. `enqueueAutofetch` faz `capture()` (`autofetch-runner.ts:55`) e passa o
   contexto a `scheduleRecheck` (:147), guardado em `lot.ctx`
   (`autofetch-recheck.ts:61-86`); `runRecheck` restaura com `run(lot.ctx)`
   (:215) e usa `opts().debridApiKey` em `drainNext` (:99), `accountScope`
   (:229), `torrentStatus` (:256) e `maybeEvictFallbacks` (:309) — são
   ESCRITAS no debrid, não só o `enqueue`.

A chave existe **só em RAM** (`recheckLots` é um `Map` de processo,
`autofetch-recheck.ts:48`): restart já perde os lotes hoje. O worker não precisa
de mais durabilidade — precisa de um dono para a chave quando a requisição
acaba. O gateway já vê o `encoded` (`adom-search/src/request.rs:21-43`), sabe
extrair a chave no processo (`adom-search/src/resolve_url.rs:320-329`, o caminho do `/resolve`)
e o `dub_audit` já faz isso: chave no efeito (`orchestrator/effects.rs:99-100`),
interceptado em `adom-server/src/tail_effects.rs:39-55` (`batch.encoded` em :61), só em
memória (`adom-server/src/dub_audit.rs:40-53`).

## (b) Por que o gateway precisa decidir

O worker é um laço de fundo (recheck de horas, TTL do autofetch) fora de
qualquer requisição. Três desenhos, e eles mudam **quem** opera o Chupim:

1. **Job com chave pela admin/loopback** — rota nova em `store_admin.rs` (hoje só
   `/streams/*` e `/harvest*`, :14-24; loopback + token, :9-12/:74-76).
2. **Cofre em memória por conta** — decodificar o `encoded` que já chega e
   guardar `{account_scope -> apiKey}` enquanto houver lote; é o desenho do
   `dub_audit` e dispensa transporte novo.
3. **Só a conta do operador** — `DEBRID_API_KEY` já é lida para os defaults
   (`resolve_native.rs:150-176`); usuários BYO (`dk`) ficam sem Chupim.

## (c) Custo de cada opção

| opção | segurança | estado |
|---|---|---|
| (1) job com chave | segunda entrada de credencial (além de `/internal/*`) no token que hoje só mexe em store/colhedor; exige autorização por conta e idempotência contra injeção de job | se precisar sobreviver ao restart, a chave teria de ser persistida — proibido — e degenera para (2) |
| (2) cofre em memória | N chaves BYO em texto puro no gateway (hoje só no Node); nunca em KV/log (precedente do `dub_audit`: "só em memória, nunca em log") | N chaves em RAM com TTL/LRU por conta; restart perde os lotes como hoje |
| (3) só operador | zero chave de usuário (só a env, e só com `DEBRID_ALLOW_ENV_KEY=true`); menor custo | quebra o Chupim de quem usa `dk`; fila/marker/dead são por `accountScope` (`request_key.rs:40-47`), então fila mista exigiria filtro por conta |

## (d) Recomendação

**(2), alimentado pelo `encoded` que já chega no `EffectsBatch`** — sem rota
admin nova e sem `api_key` no payload: o worker intercepta o efeito como o
`dub_audit` (`tail_effects.rs:61`), decodifica a chave com
`resolve_native::debrid_config` (`resolve_native.rs:180-190`) e a mantém num
cofre por `account_scope` (`request_key.rs:40-47`), com TTL do autofetch e
descarte no fim do lote. Fila/marker/dead seguem sem credencial; o cofre nunca
é persistido nem logado. (1) só se o job tiver de nascer fora de uma busca
(painel), reaproveitando token/loopback da admin. (3) fica como kill-switch de
instalação pública (recusar `dk` no worker), não como desenho.
Enquanto isso não fecha, o dreno continua no Node — e é ele que paga o gate.