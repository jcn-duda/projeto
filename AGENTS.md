# AGENTS.md — Adom (branch `rust`)

Guia curto para agentes de código. **Este branch é só Rust.** A versão
TypeScript (addon completo: busca, debrid, painel) vive no branch `esm`, que
segue sendo a produção, e é a referência de comportamento: em dúvida sobre
uma regra, leia o TS do `esm` (`git show esm:src/...`). O histórico das
decisões está em [`docs/AGENTS-DETALHADO.md`](docs/AGENTS-DETALHADO.md)
(escrito para o TS; os invariantes continuam valendo).

---

## O que é

Addon Stremio self-hosted de torrents com foco em **conteúdo brasileiro
dublado**, sendo reescrito em Rust para desligar o Node. Container único:
servidor Rust + Jackett + FlareSolverr + Caddy. Plano por fases (F1–F7):
gateway → busca → debrid leitura → debrid escrita → fundo → painel.

## O que já roda em Rust

| Peça | Onde | Estado |
|---|---|---|
| Servidor na 7000 | `rust/crates/adom-server` | `/health`, rotas internas do raspador, `/acervo.json`; o resto responde **501** até ser portado (com `GATEWAY_UPSTREAM` vira proxy para um Node) |
| Resolvers BR (8700–8707) | `rust/crates/adom-resolvers` | Os 8 sites; os cards do Jackett (`jackett-bludv/*.yml`) chamam `/search` e `/resolve` |
| Raspador | `rust/crates/adom-crawl` (`adom-sidecar`) | Descoberta + páginas; segue protetor pelo resolver local; entrega ao servidor, que grava em `data/acervo.db` |
| Núcleo puro | `rust/crates/adom-core` | Normalização de título, régua BR/dublado, cotas, cache keys, HMAC do resolve, decisões de debrid (escolha de arquivo, veredito de cache, gate/ledger RD, quem pode apagar) — **sem cliente HTTP de debrid ainda** |

Ainda não existe em Rust: `/manifest.json`, `/stream`, `/resolve` do play,
adaptadores de debrid, autofetch, painel e página de configuração
(`web/public` guarda o HTML/CSS para quando forem portados).

## Comandos

```bash
cd rust
cargo test --workspace
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
docker compose up -d --build   # na raiz
```

- Catraca: **400 linhas por `.rs`** (CI `rust.yml`). Teste vai em `*_tests.rs`.
- Diagnóstico: `/acervo.json` (contagem por site) e `/acervo.json?imdb=tt…`
  exigem `X-Indexer-Test-Token` = `JACKETT_TEST_TOKEN` (alias `ADMIN_TOKEN`).
- `crawl.db` (fila do raspador) e `acervo.db` (releases) ficam em
  `./docker-data/addon` (`/app/data` no container).

## Goldens (paridade com o TS)

Os goldens (`scripts/golden/*.json`, `rust/crates/*/tests/golden`) foram
gerados do TypeScript e são o contrato. Para regenerar, rode o oráculo contra
um checkout do `esm`:

```bash
git worktree add ../adom-esm esm && (cd ../adom-esm && npm ci && npm run build)
node scripts/rust/resolver-golden/<site>.mjs --dist=../adom-esm/dist
```

Nunca edite o `expected` de um golden à mão para o teste passar.

## Regras que mais mordem

- **Paridade JS↔Rust em regex:** `\b` do JS é ASCII → `(?-u:\b)` (regex) ou o
  lookaround `FB` (fancy-regex, `common/release.rs`); `\d` = `[0-9]`;
  `encodeURIComponent` = `common::encode_uri_component`; entidades HTML pelo
  `common/text.rs` (15 nomes do `text.ts`).
- **Orçamento de tempo:** Stremio aborta em 10 s; o app Power Movie
  (User-Agent `Dart/`) recebe 15 s. Resposta parcial + busca em fundo.
- **Origem BR é campo, não regex de título**; fontes BR não publicam seeders
  (`seeders:1` é placeholder); release BR passa pelo filtro de título estrito.
- **BLUDV:** o botão é um portão de anúncio; o índice e o raspador nunca o
  atravessam.
- **Raspador:** "nada reconhecido" é falha, nunca vazio-e-completo; página só
  com protetor sem magnet colhido é `no-torrent`, nunca `done` vazio.
- **Heredoc/scripts comem barra invertida** em regex: edite `.rs` com a Edit tool.
- Comentários, logs e mensagens em **português**; identificadores em inglês.
  Comente o porquê. Logs com prefixo de subsistema (`[crawl]`, `[resolver]`).
- Nada de config hardcoded: env lida no binário (`main.rs`/`bin/`), a lib não
  lê `.env`; documente em `.env.example`.

## Git

Branch de trabalho: `rust` (só Rust). `esm` = produção TypeScript. Commits em
português com prefixo convencional. `.env` contém chaves reais — nunca faça
commit nem cole seu conteúdo.
