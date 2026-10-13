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
GET http://127.0.0.1:7000/internal/activity
```

Responde com o estado de ociosidade do addon (harvest idle, última busca,
etc.). O sidecar usa para decidir quando raspar (só com app ocioso).

### Healthcheck

```
GET http://127.0.0.1:7077/health
```

Responde `200 OK` quando o sidecar está pronto. O entrypoint aguarda até 10s
(10 tentativas × 1s) antes de prosseguir.

## Schema do crawl.db

O sidecar lê e escreve o **mesmo** `crawl.db` do motor TS. O schema é
compartilhado:

- `crawl_state` — estado por site (última leitura, cursor, etc.)
- `crawl_queue` — URLs a processar
- `crawl_results` — resultados gravados (magnets, metadados)
- `crawl_captures` — páginas capturadas (opcional, para fixtures)

A compatibilidade é garantida pelo schema SQL definido em
`rust/crates/adom-crawl/src/db.rs` (migration inicial). O motor TS e o
sidecar Rust podem operar no mesmo banco sem conflito — as tabelas são as
mesmas, os índices são os mesmos.

## Rollback

Voltar para `CRAWL_ENGINE=ts` é seguro a qualquer momento:

1. O `crawl.db` é o mesmo — o motor TS lê o estado onde o sidecar parou
2. URLs em `crawl_queue` com status `processing` são retomadas pelo TS
3. Resultados já gravados permanecem intactos

Não há migração de dados. O schema é idêntico.

## Healthcheck e monitoring

O sidecar expõe `/health` na porta `CRAWL_SIDECAR_PORT` (default 7077). O
entrypoint faz o healthcheck inicial; após o boot, o sidecar é supervisionado
fora do `wait -n` (reinício próprio ou manual).

Para verificar o status em runtime:

```bash
curl http://127.0.0.1:7077/health
```

Logs do sidecar aparecem no stdout do container com prefixo `[sidecar]`
(quando iniciado pelo entrypoint).

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `CRAWL_ENGINE` | `ts` | Motor do raspador: `ts` (Node) ou `rust` (sidecar) |
| `CRAWL_SIDECAR_PORT` | `7077` | Porta do healthcheck/status do sidecar |
| `CRAWL_DB_PATH` | `./data/crawl.db` | Caminho do SQLite compartilhado |
| `CRAWL_NODE_URL` | `http://127.0.0.1:7000` | URL do Node para POST de resultados |

## Compilação

O Dockerfile compila o sidecar no estágio `rustcore` (mesmo do adom-napi):

```dockerfile
RUN cargo build --release --bin adom-sidecar \
 && cp target/release/adom-sidecar /adom-sidecar
```

O binário é copiado para `/app/dist/rust/adom-sidecar` no runtime. É um
binário estático musl (igual ao adom-napi), sem dependências dinâmicas.

## Arquivos

- `rust/crates/adom-crawl/` — crate do sidecar (binário `adom-sidecar`)
- `rust/crates/adom-crawl/src/main.rs` — entrypoint do sidecar
- `rust/crates/adom-crawl/src/db.rs` — schema e queries SQLite
- `scripts/entrypoint.sh` — inicia o sidecar quando `CRAWL_ENGINE=rust`
- `Dockerfile` — compila no estágio `rustcore`, copia para `dist/rust/`
