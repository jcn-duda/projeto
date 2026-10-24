# @adom/napi — bindings NAPI-RS do adom-core

> **Status: 12 funções expostas.** O crate expõe as funções críticas do
> `adom-core` para o Node: normalização, matching BR, parse de S/E, magnet,
> origem BR, quotas e sign/verify. Testes de paridade cobrindo 34 casos.

## Como buildar

### Pré-requisitos

- **Rust toolchain** (rustup): `rustup toolchain install stable`
- **Node.js 20+** (produção usa 22)
- **Compilador C/C++** (para o linker do `cdylib`):
  - Linux/macOS: `gcc`/`clang` (já vêm na maioria das distros)
  - Windows: Visual Studio Build Tools (MSVC)
  - Alpine (Docker): `apk add build-base`

### Build local (debug)

```bash
cd rust/adom-napi
npm install          # instala @napi-rs/cli
npm run build        # gera o .node + index.js + index.d.ts
```

O artefato é `rust/adom-napi/adom-napi.<platform>.node` (ex.: `linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`).

### Build local (release)

```bash
cd rust/adom-napi
npm run build:release
```

### Usar do Node (ESM)

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeTitle, signResolve, verifyResolve } = require('../../../rust/adom-napi/index.js');

// normalizeTitle — paridade com o TS
const normalized = normalizeTitle('Star Wars: The Clone Wars');
// => "star wars the clone wars"

// signResolve — recebe o segredo como parâmetro (não lê config global)
const secret = config.debrid.resolveSecret || opts().debridApiKey || '';
const sig = signResolve(secret, infoHash, 'S01E01', '');

// verifyResolve — comparação em tempo constante
const ok = verifyResolve(secret, infoHash, 'S01E01', reqSig, '');
```

> **Nota:** o napi-rs gera `index.js` com `module.exports` (CJS). Como o addon
> é ESM, o `createRequire` é necessário. Um wrapper ESM pode ser adicionado
> depois (`rust/adom-napi/index.mjs`) se preferir.

## Funções expostas

| NAPI (snake_case)            | Node (camelCase)            | Origem `adom-core`                     | Propósito                                    |
|------------------------------|-----------------------------|----------------------------------------|----------------------------------------------|
| `normalize_title`            | `normalizeTitle`            | `normalize_title`                      | Normalização de títulos (paridade com TS)    |
| `sign_resolve`               | `signResolve`               | `sign_resolve`                         | Assina URLs de /resolve (HMAC-SHA256)        |
| `verify_resolve`             | `verifyResolve`             | `verify_resolve`                       | Verifica assinaturas (tempo constante)       |
| `matches_br_title`           | `matchesBrTitle`            | `matches_br_title`                     | Filtro estrito BR de título                  |
| `parse_title_season_episode` | `parseTitleSeasonEpisode`   | `parse_title_season_episode`           | Parse de S/E do título da release            |
| `matches_name`               | `matchesName`               | `matches_name`                         | Portão de cobertura de nome (60% tokens)     |
| `sanitize_magnet`            | `sanitizeMagnet`            | `sanitize_magnet`                      | Valida/limpa URI magnet                      |
| `default_magnet`             | `defaultMagnet`             | `default_magnet`                       | Magnet padrão com trackers do piso           |
| `extract_info_hash`          | `extractInfoHash`           | `extract_info_hash`                    | Extrai infoHash (hex/base32/btih)            |
| `br_origin_mark`             | `brOriginMark`              | `br_origin_mark`                       | Origem BR (site/PT/filme)                    |
| `has_pt_signs`               | `hasPtSigns`                | `has_pt_signs`                         | Sinais de português no título                |
| `limit_by_indexer`           | `limitByIndexer`            | `limit_by_indexer`                     | Cota por indexador                           |

O napi-rs converte automaticamente `snake_case` → `camelCase` nos exports JS.

### Structs de saída

| NAPI object             | Espelha `adom-core`            | Campos                                        |
|-------------------------|--------------------------------|-----------------------------------------------|
| `ParsedSeasonEpisode`   | `ParsedSeasonEpisode`          | `seasons`, `episodes`, `complete`, `seasonPack` |

O `#[napi(object)]` gera a interface TypeScript automaticamente.

## Estrutura

```
rust/
├── Cargo.toml                  # workspace (adom-core + adom-napi)
├── crates/
│   ├── adom-core/              # núcleo Rust (lógica real)
│   └── adom-napi/              # este crate (wrapping NAPI)
│       ├── Cargo.toml
│       ├── build.rs            # napi_build::setup()
│       └── src/lib.rs          # #[napi] exports
└── adom-napi/                  # pacote Node do binding
    ├── package.json            # scripts build/build:release
    ├── index.js                # gerado pelo napi-rs (CJS loader)
    ├── index.d.ts              # gerado pelo napi-rs (tipos)
    └── *.node                  # binário compilado (platform-specific)
```

## Integração com o Dockerfile (produção)

O Dockerfile atual **NÃO** builda o crate Rust. Para integrar, será preciso:

1. **Adicionar stage de build Rust** antes do `builder` Node:
   ```dockerfile
   FROM rust:1.82-alpine AS rust-builder
   RUN apk add --no-cache build-base
   WORKDIR /rust
   COPY rust/ ./
   RUN cargo build --release -p adom-napi
   ```

2. **Copiar o `.node`** para o runtime:
   ```dockerfile
   COPY --from=rust-builder /rust/target/release/libadom_napi.so /app/rust/adom-napi/adom-napi.linux-x64-musl.node
   ```

3. **Ajustar o `index.js`** para resolver o caminho do `.node` na imagem.

4. **Instalar `build-base`** no stage final se o `.node` depender de libs
   dinâmicas (musl em alpine = estático, então geralmente não precisa).

> **Importante:** o target triple do alpine é `x86_64-unknown-linux-musl`. O
> napi-rs detecta automaticamente via `--platform`, mas o stage de build Rust
> precisa ter o target correto (ou usar `cross` para compilação cruzada).

## Próximos passos

- [x] Adicionar mais funções do `adom-core` (12 expostas)
- [x] Testes de paridade (34 casos)
- [ ] Wrapper ESM (`index.mjs`) para evitar `createRequire` no addon
- [ ] Integrar build Rust no Dockerfile (stage separado)
- [ ] Benchmark: medir ganho de performance vs. implementação TS
- [ ] CI: buildar o `.node` em matrix (linux-x64-gnu, linux-x64-musl, darwin-arm64, win32-x64-msvc)

## Guardrails

- Este crate **NÃO** modifica `adom-core` — só consome as funções públicas.
- Segredos (HMAC) **NÃO** são lidos de config global — o Node os fornece.
- O `.node` é **platform-specific** — não comitar os binários (`.gitignore`).
- Comentários em português, identificadores em inglês (padrão do projeto).
