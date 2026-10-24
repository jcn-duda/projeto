# Fase C4 — Sidecar Rust do Raspador

## O que é

O sidecar é um binário Rust estático (musl) que executa o loop de crawl
(raspagem de sites BR) fora do processo Node. Ele roda como processo separado
no mesmo container, iniciado pelo `scripts/entrypoint.sh` quando
`CRAWL_ENGINE=rust` — o **default** do entrypoint e do `src/config/crawl.ts`.

O container tem um desenho fixo de portas: o **gateway Rust (`adom-server`)
na 7000** é o caminho público do `/stream`, sempre iniciado pelo entrypoint, e
o **Node na 7100**. O sidecar fala direto com o Node na 7100 (`CRAWL_NODE_URL`
fixado pelo entrypoint): a fachada da 7000 recusa `/internal/*` antes do proxy.
Não há sombra, canário nem frozen de runtime no caminho — esses instrumentos
saíram no R1 (ver `rust-stream-contract.md` §9, histórico).

Enquanto o motor TS roda dentro do processo do addon (single-threaded,
compartilha heap com a busca), o sidecar Rust:

- Faz o loop de descoberta + raspagem em threads próprias (tokio)
- Lê e escreve o mesmo `crawl.db` (SQLite, schema compatível com o TS)
- POSTA resultados no Node via `POST /internal/crawl-result`
- Lê atividade do Node via `GET /internal/activity` (ociosidade)
- Expõe healthcheck em `GET /health`

## Como ativar

O sidecar é o **default**: o entrypoint usa `CRAWL_ENGINE:-rust` e o
`src/config/crawl.ts` só cai em `ts` com `CRAWL_ENGINE=ts` explícito. Não há
flag de modo do núcleo no caminho (o antigo `RUST_CORE=off|shadow|on` saiu no
R7; o núcleo é obrigatório).

Desde a Fase 6 **todos os nove sites** (oito cards do Jackett + o Mico) têm
adaptador apenas no sidecar. `CRAWL_ENGINE=ts` virou modo LEGADO: o sidecar não
sobe e o motor TS não tem adaptador para nenhum site da tabela — ele mantém o
painel, as ações e o status, mas não raspa nada. Por isso o rollback de
produção é a imagem anterior, não a troca do env (ver "Rollback").

O entrypoint inicia o sidecar antes do addon, aguarda até 10s o healthcheck
responder e só então sobe o addon. O sidecar **NÃO** entra no `wait -n` do
supervisor — ele não derruba o container se morrer. O shutdown do container
mata o sidecar via SIGTERM junto com os demais processos.

## Comunicação com o Node

### Sidecar → Node (POST resultados)

```
POST http://127.0.0.1:7100/internal/crawl-result
Content-Type: application/json
X-Indexer-Test-Token: <ADMIN_TOKEN>

{
  "site": "vacatorrent",
  "url": "https://...",
  "title": "...",
  "magnets": [...],
  "capturedAt": "2026-10-13T..."
}
```

O Node recebe, valida e grava no `crawl.db` (mesma lógica do motor TS). A
porta é a do Node; o entrypoint fixa `CRAWL_NODE_URL=http://127.0.0.1:7100` no
container. O default do binário isolado continua `http://127.0.0.1:7000`, mas a
7000 é a fachada do gateway, que recusa `/internal/*` — no container o valor é
sobrescrito.

### Sidecar ← Node (GET atividade)

```
GET http://127.0.0.1:7100/internal/activity?window_ms=600000
X-Indexer-Test-Token: <ADMIN_TOKEN>
```

Responde com o estado de ociosidade do addon (harvest idle, última busca,
etc.). O sidecar usa para decidir quando raspar (só com app ocioso).

### Healthcheck

```
GET http://127.0.0.1:7077/health
```

Responde `200 OK` quando o sidecar está pronto. O entrypoint aguarda até 10s
(10 tentativas × 1s) antes de prosseguir.

## Servidor HTTP do sidecar

O sidecar expõe um servidor HTTP próprio na porta `CRAWL_SIDECAR_PORT`
(default 7077) com os seguintes endpoints:

| Rota | Método | Descrição |
|---|---|---|
| `/health` | GET | Healthcheck — retorna `200 OK` quando o sidecar está pronto |
| `/status` | GET | Status do motor (sites ativos, filas, progresso) |
| `/action` | POST | Ações administrativas (pausar, retomar, forçar ciclo) |

As rotas `/status` e `/action` exigem o header `X-Indexer-Test-Token` com o
valor de `ADMIN_TOKEN`.

## Mico: lane de ritmo próprio (`own_pace`)

O Mico não é site HTML nem card do Jackett: é um addon Stremio público
consultado por IMDb, com descoberta por catálogo paginado e leitura por
`/stream/...json`. Ele roda numa lane dedicada do motor
(`rust/crates/adom-crawl/src/motor/mico_lane.rs`), com dono único de claim e
de ritmo:

- **fora do teto horário, da janela de ociosidade e das vagas do
  `CRAWL_MAX_CONCURRENT`** — o único limitador é `MICO_CRAWL_MIN_GAP_MS` do
  cliente (`mico_net`); pausa global e auto-pausa continuam valendo;
- **descoberta nativa** (`mico_discovery.rs`): paginação por `skip` com passo
  FIXO (`stride_at`: 25 até 1000, 50 depois — `metas.length` não é o índice),
  reconsulta de página vazia intermitente (`MICO_CRAWL_EMPTY_RETRIES`), fim só
  após vazias seguidas (`MICO_CRAWL_END_AFTER_EMPTIES`) e teto
  `MICO_CRAWL_MAX_PAGES` por tipo;
- **varredura completa** (reprocessa o acervo e reenfileira o balde de
  releitura) só a cada `MICO_CRAWL_FULL_SWEEP_HOURS` horas, com o marcador
  `full-sweep:<tipo>` em `crawl_state`; entre elas a rodada é incremental e
  para após `MICO_CRAWL_KNOWN_PAGES_TO_STOP` páginas só com obras já na fila —
  sai `complete` sem mover o marcador;
- **leitura** reutiliza `page_parser::parse_mico_content` (streams do TS):
  filme vira card por IMDb; série lê temporadas/episódios do Cinemeta, segue
  os botões e grava progresso MONOTÔNICO (`{v,doneCards,totalCards}`) para
  retomar de onde parou;
- **claim**: `store::ops::take_next` aceita `own_pace` (o chamador é a lane);
  `take_next_batch` continua excluindo `own_pace`, então a página do Mico não
  consome vaga nem é cobrada no teto agregado do lote paralelo.

O `tick_once` dispara a lane em task separada; `MicoLane::try_enter` impede
dois passos simultâneos (uma série de 40 episódios não é atropelada pelo tick
seguinte). `MICO_ENABLED=false` desliga a fonte inteira.

## Schema do crawl.db

O sidecar lê e escreve o **mesmo** `crawl.db` do motor TS. O schema é
compartilhado, definido em `rust/crates/adom-crawl/src/store/schema.rs`:

- `crawl_url` — fila de trabalho (chave composta `(site, url_key)`). Colunas:
  `site`, `url`, `url_key`, `lastmod`, `kind`, `status`, `imdb`, `tries`,
  `next_at`, `checked_at`, `releases`, `error`, `progress`, `added_at`.
  Índice `crawl_url_due` para o scheduler `(site, status, next_at)`.
- `crawl_run` — rodadas do motor. Colunas: `id`, `site`, `phase`,
  `cursor_val`, `started_at`, `finished_at`, `counters` (JSON). Índice
  `crawl_run_site` para listar rodadas por site.
- `crawl_state` — estado durável por site (pares chave/valor). Colunas:
  `site`, `key`, `value`, `updated_at`. Chave composta `(site, key)`.

A compatibilidade é garantida pela migration idempotente
(`store::schema::migrate`). As tabelas são as mesmas, os índices são os
mesmos. Com o corte da Fase 6 o dono de cada site é ÚNICO: os nove sites são
do sidecar (o Mico pela lane `own_pace`), e o motor TS não reivindica nenhum
id da tabela.

## Protetor de link

O módulo `protector` (`rust/crates/adom-crawl/src/protector.rs`) é o port
Rust do `followProtectedUrl` do TS (`resolvers/transport.ts`). Faz o loop
de saltos pelo protetor de link com `redirect: manual`, extraindo o magnet
do HTML e descobrindo o próximo salto via `discover_next_url` e
`extract_meta_refresh`.

Funções principais:

- `extract_meta_refresh(html) -> Option<String>` — extrai destino de
  `<meta http-equiv="refresh">`
- `extract_magnet(html) -> Option<String>` — extrai primeiro magnet do HTML
- `discover_next_url(html, base_url, hosts, suffixes) -> Option<String>` —
  descobre próxima URL de protetor (variável JS + busca genérica)
- `follow_protected_url(opts) -> Result<String, ProtectorError>` — loop
  completo de saltos

Reutiliza `decode_entities` do `adom-core` para entidades HTML.

## Rollback e alternância

O rollback de FATIA é **commit/imagem anterior** (não env). `CRAWL_ENGINE=ts`
não é mais um caminho de raspagem: desde a Fase 6 o TS não tem adaptador para
nenhum dos nove sites, então com `ts` o sidecar não sobe e nada é raspado.
Trocar o env não perde dados — o `crawl.db` é o mesmo e o sidecar retoma a
fila no próximo boot — mas o rollback funcional exige a imagem anterior.

1. O `crawl.db` é o mesmo — o motor anterior lê o estado onde o sidecar parou
2. URLs em `crawl_url` com status `processing` são retomadas no boot
3. Resultados já gravados permanecem intactos

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `CRAWL_ENGINE` | `rust` | Motor do raspador: `rust` (sidecar, dono dos nove sites) ou `ts` (LEGADO: sem adaptador TS, não raspa nada) |
| `CRAWL_SIDECAR_PORT` | `7077` | Porta do healthcheck/status do sidecar |
| `CRAWL_DB_PATH` | `./data/crawl.db` | Caminho do SQLite compartilhado |
| `CRAWL_NODE_URL` | `http://127.0.0.1:7100` (entrypoint; default do binário isolado: `7000`) | URL do Node para POST de resultados; no container aponta para a 7100, porque a 7000 é a fachada e recusa `/internal/*` |
| `JACKETT_TEST_TOKEN` | *(obrigatório)* | Token de autenticação (header `X-Indexer-Test-Token`), o mesmo das rotas de diagnóstico. `ADMIN_TOKEN` é alias (com aviso) |
| `CRAWL_IDLE_WINDOW_MS` | `60000` | Janela de inatividade para freio (sidecar binário) |
| `CRAWL_MAX_CONCURRENT` | `4` | Tarefas simultâneas (as vagas do lote HTML; a lane do Mico fica fora) |
| `CRAWL_DELAY_MS` | `1000` | Atraso entre ciclos em ms |
| `MICO_ENABLED` | `true` | Liga a fonte Mico (lane + leitura de página) no sidecar |
| `MICO_URL` | `https://mico-leao-dublado-apiv-2.vercel.app` | Base da API do Mico |
| `MICO_TIMEOUT_MS` | `15000` | Timeout de cada requisição do Mico |
| `MICO_CRAWL_MIN_GAP_MS` | `1000` | Intervalo mínimo entre chamadas (o ritmo da lane) |
| `MICO_CRAWL_MAX_PAGES` | `700` | Teto de requisições de catálogo por tipo e rodada |
| `MICO_CRAWL_EMPTY_RETRIES` | `2` | Reconsultas de uma página vazia intermitente |
| `MICO_CRAWL_END_AFTER_EMPTIES` | `4` | Vazias seguidas que provam o fim do catálogo |
| `MICO_CRAWL_KNOWN_PAGES_TO_STOP` | `2` | Páginas só com obras já na fila que encerram o incremental |
| `MICO_CRAWL_FULL_SWEEP_HOURS` | `24` | Intervalo mínimo entre varreduras completas por tipo |
| `MICO_CRAWL_REREAD_DAYS` | `14` | Balde de releitura de FILME (série usa 30 fixo) |
| `MICO_CRAWL_SERIES` | `true` | Descobre séries além de filmes |
| `MICO_CRAWL_SERIES_MAX_SEASONS` | `2` | Temporadas mais recentes lidas por série |
| `CRAWL_SERIES_MAX_BUTTONS` | `40` | Episódios por passe de leitura de série (progresso retomável) |
| `MICO_CRAWL_DISCOVERY_INTERVAL_MS` | `3600000` | Intervalo entre rodadas de descoberta da lane (ms) |

**Nota sobre `idle_window_ms`**: o binário do sidecar lê `CRAWL_IDLE_WINDOW_MS`
com default 60000ms (1 min). O `MotorConfig` do motor Rust tem default
600_000ms (10 min). O valor efetivo depende de qual caminho é usado — o
sidecar binário passa o valor do ambiente para o `MotorConfig` na
construção.

## Compilação

O Dockerfile compila o sidecar no estágio `rustcore` (mesmo do adom-napi):

```dockerfile
RUN cargo build --release --bin adom-sidecar \
 && cp target/release/adom-sidecar /adom-sidecar
```

O binário é copiado para `/app/dist/rust/adom-sidecar` no runtime. É um
binário estático musl (igual ao adom-napi), sem dependências dinâmicas.

## Segurança

As rotas `/internal/*` do Node são acessíveis apenas pelo loopback. O Caddy
bloqueia acesso externo a essas rotas com `respond /internal/* 403`; a fachada
Rust (7000) também recusa `/internal/*` **antes** do proxy — a guarda de
loopback do Node não distingue o cliente atrás do proxy. O sidecar contorna
isso falando direto com o Node na 7100. O token
`ADMIN_TOKEN`/`JACKETT_TEST_TOKEN` é a segunda camada de autenticação (header
`X-Indexer-Test-Token`).

## Arquivos

- `rust/crates/adom-crawl/` — crate do sidecar (binário `adom-sidecar`)
- `rust/crates/adom-crawl/src/bin/adom_sidecar.rs` — entrypoint do sidecar
- `rust/crates/adom-crawl/src/store/schema.rs` — DDL e migration do SQLite
- `rust/crates/adom-crawl/src/store/ops.rs` — operações do CrawlStore
- `rust/crates/adom-crawl/src/motor/` — motor de crawl (loop, config, types)
- `rust/crates/adom-crawl/src/motor/mico_lane.rs` — lane de ritmo próprio do Mico (claim + passo)
- `rust/crates/adom-crawl/src/mico_discovery.rs` — descoberta paginada do Mico (passo fixo, full sweep, incremental)
- `rust/crates/adom-crawl/src/mico_net/` — cliente HTTP e tipos da API do Mico
- `rust/crates/adom-crawl/src/mico_page.rs` — leitura de página do Mico (filme/série, progresso)
- `rust/crates/adom-crawl/src/sidecar/` — cliente HTTP e freio de tráfego
- `rust/crates/adom-crawl/src/protector.rs` — protetor de link (port Rust)
- `scripts/entrypoint.sh` — inicia o sidecar quando `CRAWL_ENGINE=rust`
- `Dockerfile` — compila no estágio `rustcore`, copia para `dist/rust/`
- `Caddyfile` — bloqueia `/internal/*` do acesso externo

## Limites

- O sidecar é o **default** e o **único** caminho de raspagem. `CRAWL_ENGINE=ts`
  permanece no contrato das rotas do painel, mas não raspa nenhum site da
  tabela (não há adaptador TS desde a Fase 6).
- A descoberta do Mico no Rust não tem um deadline TOTAL como o
  `CRAWL_DISCOVERY_DEADLINE_MS` do TS: o limite é `MICO_CRAWL_MAX_PAGES` por
  tipo × timeout de cada requisição. A lane roda em background, fora do passo
  de linha, então uma varredura longa não trava o lote paralelo.
- O protetor de link Rust é um módulo novo; o TS continua funcionando. A
  migração do protetor ativo acompanha o motor escolhido.
- O `crawl.db` é compartilhado, mas o sidecar e o motor TS **não** devem
  rodar simultaneamente no mesmo banco (risco de conflito de escrita).
- O `JACKETT_TEST_TOKEN` (ou o alias `ADMIN_TOKEN`) é obrigatório para o sidecar iniciar. Sem ele, o processo
  recusa (exit 1).
