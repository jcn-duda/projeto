# Fase C4 — Sidecar Rust do Raspador

## O que é

O sidecar é um binário Rust estático (musl) que executa o loop de crawl
(raspagem de sites BR) fora do processo Node. Ele roda como processo separado
no mesmo container, iniciado pelo `scripts/entrypoint.sh` quando
`CRAWL_ENGINE=rust`.

Enquanto o motor TS roda dentro do processo do addon (single-threaded,
compartilha heap com a busca), o sidecar Rust:

- Faz o loop de descoberta + raspagem em threads próprias (tokio)
- Lê e escreve o mesmo `crawl.db` (SQLite, schema compatível com o TS)
- POSTA resultados no Node via `POST /internal/crawl-result`
- Lê atividade do Node via `GET /internal/activity` (ociosidade)
- Expõe healthcheck em `GET /health`

## Como ativar

No `.env`:

```bash
CRAWL_ENGINE=rust
```

O entrypoint inicia o sidecar antes do addon, aguarda até 10s o healthcheck
responder e só então sobe o addon. O sidecar **NÃO** entra no `wait -n` do
supervisor — ele não derruba o container se morrer. O shutdown do container
mata o sidecar via SIGTERM junto com os demais processos.

Para voltar ao motor TS:

```bash
CRAWL_ENGINE=ts
```

O `crawl.db` é o mesmo (schema compatível). Nenhum dado é perdido na troca.

## Comunicação com o Node

### Sidecar → Node (POST resultados)

```
POST http://127.0.0.1:7000/internal/crawl-result
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

O Node recebe, valida e grava no `crawl.db` (mesma lógica do motor TS).

### Sidecar ← Node (GET atividade)

```
GET http://127.0.0.1:7000/internal/activity?window_ms=600000
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
(`store::schema::migrate`). O motor TS e o sidecar Rust podem operar no
mesmo banco sem conflito — as tabelas são as mesmas, os índices são os
mesmos.

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

## Rollback

Voltar para `CRAWL_ENGINE=ts` é seguro a qualquer momento:

1. O `crawl.db` é o mesmo — o motor TS lê o estado onde o sidecar parou
2. URLs em `crawl_url` com status `processing` são retomadas pelo TS
3. Resultados já gravados permanecem intactos

Não há migração de dados. O schema é idêntico.

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `CRAWL_ENGINE` | `ts` | Motor do raspador: `ts` (Node) ou `rust` (sidecar) |
| `CRAWL_SIDECAR_PORT` | `7077` | Porta do healthcheck/status do sidecar |
| `CRAWL_DB_PATH` | `./data/crawl.db` | Caminho do SQLite compartilhado |
| `CRAWL_NODE_URL` | `http://127.0.0.1:7000` | URL do Node para POST de resultados |
| `ADMIN_TOKEN` | *(obrigatório)* | Token de autenticação (header `X-Indexer-Test-Token`). Alias: `JACKETT_TEST_TOKEN` |
| `CRAWL_IDLE_WINDOW_MS` | `60000` | Janela de inatividade para freio (sidecar binário) |
| `CRAWL_MAX_CONCURRENT` | `4` | Tarefas simultâneas |
| `CRAWL_DELAY_MS` | `1000` | Atraso entre ciclos em ms |

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
bloqueia acesso externo a essas rotas com `respond /internal/* 403`. O token
`ADMIN_TOKEN`/`JACKETT_TEST_TOKEN` é a segunda camada de autenticação (header
`X-Indexer-Test-Token`).

## Arquivos

- `rust/crates/adom-crawl/` — crate do sidecar (binário `adom-sidecar`)
- `rust/crates/adom-crawl/src/bin/adom_sidecar.rs` — entrypoint do sidecar
- `rust/crates/adom-crawl/src/store/schema.rs` — DDL e migration do SQLite
- `rust/crates/adom-crawl/src/store/ops.rs` — operações do CrawlStore
- `rust/crates/adom-crawl/src/motor/` — motor de crawl (loop, config, types)
- `rust/crates/adom-crawl/src/sidecar/` — cliente HTTP e freio de tráfego
- `rust/crates/adom-crawl/src/protector.rs` — protetor de link (port Rust)
- `scripts/entrypoint.sh` — inicia o sidecar quando `CRAWL_ENGINE=rust`
- `Dockerfile` — compila no estágio `rustcore`, copia para `dist/rust/`
- `Caddyfile` — bloqueia `/internal/*` do acesso externo

## Limites

- O sidecar **não** substitui o motor TS — é uma alternativa ativada por
  `CRAWL_ENGINE=rust`. O motor TS continua sendo o default.
- O protetor de link Rust é um módulo novo; o TS continua funcionando. A
  migração do protetor ativo acontecerá quando o sidecar for o default.
- O `crawl.db` é compartilhado, mas o sidecar e o motor TS **não** devem
  rodar simultaneamente no mesmo banco (risco de conflito de escrita).
- O `ADMIN_TOKEN` é obrigatório para o sidecar iniciar. Sem ele, o processo
  recusa (exit 1).
