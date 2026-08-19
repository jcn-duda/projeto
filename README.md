# Adom Power-Movie

Addon Stremio self-hosted que agrega torrents do Jackett/Prowlarr e de fontes
brasileiras dubladas, com resolução opcional via debrid (Premiumize,
Real-Debrid, AllDebrid, TorBox, Debrid-Link). Tudo sobe com Docker Compose.

Os **cinco** objetivos de uma vez:

| # | Objetivo | Como |
|---|----------|------|
| 1 | Addon no Stremio | Adom, Node/Express — P2P puro ou via debrid |
| 2 | Rodar na sua pasta | `npm start` → `http://127.0.0.1:7000/manifest.json` |
| 3 | Criar o **seu** lado | código em `src/` (provedores, filtros, nome) |
| 4 | Subir no Docker | `docker compose up -d --build` (container único) |
| 5 | Stack completa em VPS | Caddy/HTTPS + addon + Jackett + resolvers BR, tudo num container |

---

## Arquitetura

```
Internet / Stremio
       ↓ HTTPS
┌─────────────────── container único (stremio-adom) ───────────────────┐
│ Caddy ──→ adom.seudominio.com ──→ Adom ──→ Jackett ──→ indexers globais (P2P) │
│                                    │            └──→ cards BR ──→ *-resolvers  │
│                                    ├──────────→ scraper direto do BLUDV         │
│                                    ├──────────→ debrid opcional (/resolve)      │
│                                    └── FlareSolverr (Cloudflare)                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Tudo roda em **um único container** (addon Node + Jackett + FlareSolverr +
Caddy, todos conversando por `127.0.0.1`); o `scripts/entrypoint.sh` supervisiona
os quatro processos e qualquer um que morrer derruba o container para o
`restart: unless-stopped` recriar a stack.

- **Adom** = addon Node deste repositório: busca em paralelo no Jackett
  (indexers globais + cards brasileiros), no Prowlarr e no scraper do BLUDV.
- **Jackett** = gerenciador de indexers; os cards BR (Bludv, ComandoTorrents,
  NerdFilmes, TorrentDosFilmes V2) vêm embutidos na imagem e dependem
  dos microserviços `*-resolver` para seguir protetores de links.
- **FlareSolverr** = resolve desafios Cloudflare dos indexers que exigem.
- **Caddy** = HTTPS automático na frente do addon.
- **Debrid** = opcional: com ele o play passa pela rota `/resolve` assinada
  com HMAC; sem ele, P2P puro (o Stremio baixa o torrent).
- **Demo** = modo local do Adom que valida o pipeline com *Big Buck Bunny*.

---

## Início rápido (local, sem Docker)

### 1. Instalar dependências

```powershell
cd "e:\stremio adom"
copy .env.example .env
npm install
```

### 2. Rodar em modo demo

No `.env`:

```env
PROVIDER=demo
PORT=7000
```

```powershell
npm start
```

### 3. Instalar no Stremio

Abra **`http://127.0.0.1:7000/configure`** no navegador, escolha as opções e
clique em **Instalar no Stremio**.

Ou, para instalar com os padrões do `.env`, cole
`http://127.0.0.1:7000/manifest.json` em **Addons → Addon repository URL**.

Depois, busque o filme **Big Buck Bunny** e abra os streams.

---

## Página de configuração

Igual ao Torrentio: as opções ficam **codificadas no próprio install URL**
(`/<config>/manifest.json`), então o servidor não guarda estado e cada pessoa da
casa pode instalar com preferências diferentes na mesma instância.

Dá pra ajustar:

| Opção | O que faz |
|---|---|
| Fontes | Jackett, Prowlarr ou modo demo |
| Qualidade | Filtra 4K / 1080p / 720p / 480p / SD / sem resolução |
| Cotas por qualidade e por indexer | Teto de vagas; `qn` é separado do SD (fontes BR não publicam resolução) |
| Vagas BR · BR primeiro · só BR | Reserva e prioridade das fontes brasileiras |
| Somente dublado · preferir dublado | Corta legendado BR, ou só ordena dublado na frente |
| Sem CAM · tamanho máximo | |
| Indexers Jackett · prioridade · limite por id | Cards na página, com teste e breaker |
| Debrid | Serviço + API key, só cache, mostrar BR fora do cache, baixar dublado |

Com `RESOLVE_SECRET` no `.env`, a API key vai **cifrada** no install URL.

### Serviços de debrid suportados

| Serviço | Consulta de cache | Como |
|---|---|---|
| Premiumize | sim | lote instantâneo, não escreve na conta |
| TorBox | sim | lote instantâneo, não escreve na conta |
| AllDebrid | sim | `ready` do `/magnet/upload` — **cria magnets** e precisa limpar |
| Real-Debrid | não | endpoint instantâneo aposentado |
| Debrid-Link | não | endpoint instantâneo aposentado |

Real-Debrid e Debrid-Link não informam o que toca na hora: todos os resultados
passam pelo debrid, sem ⚡, e *somente em cache* fica desligado. AllDebrid
**mede** o ⚡, mas a checagem é um upload — conta no teto de magnets faz o raio
sumir de todos os streams (`node scripts/magnets.js` / `/debrid-status.json`).
Premiumize e TorBox checam em lote sem sujar a conta.

Para mudar depois, abra o **botão de engrenagem** do addon no Stremio — ele volta
para a página já preenchida com a sua configuração atual.

> A API key do debrid viaja **dentro** do install URL. Trate esse link como
> senha e não compartilhe.

> Sem configuração na URL, o addon usa o `.env` — **inclusive a `DEBRID_API_KEY`
> do operador**. Se for expor a instância publicamente, deixe `DEBRID_API_KEY`
> vazia e peça que cada pessoa coloque a sua na página.

---

## Torrents de verdade (Jackett)

### Opção A — só no PC (Node + Jackett já instalado)

1. Instale o [Jackett](https://github.com/Jackett/Jackett) e adicione indexers.  
2. Copie a **API Key** do Jackett.  
3. No `.env`:

```env
PROVIDER=jackett
JACKETT_URL=http://127.0.0.1:9117
JACKETT_API_KEY=sua_chave_aqui
MIN_SEEDERS=1
MAX_RESULTS=40
# QUALITY_FILTER=1080p,720p
```

4. `npm start` e reinstale/atualize o manifest no Stremio se precisar.

### Opção B — stack Docker (recomendado no dia a dia)

```powershell
cd "e:\stremio adom"
copy .env.example .env
```

Edite o `.env` (pode deixar `PROVIDER=demo` no primeiro boot):

```env
PROVIDER=jackett
PORT=7000
JACKETT_API_KEY=
```

O compose constrói **uma única imagem** (Dockerfile multi-stage) que já contém
o addon, o Jackett com os cards BR, o FlareSolverr e o Caddy:

```powershell
docker compose up -d --build
```

> **Migração do multi-container antigo:** se você já tinha a stack anterior,
> o `ServerConfig.json` do Jackett vive no volume `./docker-data/jackett` e
> ainda aponta o FlareSolverr pelo hostname antigo. Corrija uma vez:
>
> ```bash
> sed -i 's#http://flaresolverr:8191#http://127.0.0.1:8191#' docker-data/jackett/Jackett/ServerConfig.json
> ```

1. Abra o Jackett: http://127.0.0.1:9117  
2. Procure por **Bludv**, adicione-o, teste e salve. Configure os demais
   indexers desejados e copie a API Key.  
3. Coloque a key em `.env` → `JACKETT_API_KEY=...` e `PROVIDER=jackett`  
4. Recrie o container:

```powershell
docker compose up -d
```

5. No Stremio: `http://127.0.0.1:7000/manifest.json`

#### Card Bludv

O card está em `jackett-bludv/bludv-cardigann.yml` e é copiado para a imagem
única pelo `Dockerfile` raiz (stage `jackett`), junto com os demais cards BR.
Ele consulta o buscador WordPress do BLUDV e
extrai de cada card o título (sem o rótulo "Torrent"), o tamanho real, o
poster e o título original em inglês. No download, o serviço interno
`bludv-resolver` escolhe o **melhor** botão `Magnet-Link` do post —
dublado/dual primeiro, maior qualidade depois — e segue os redirects do
protetor de links até o magnet; ele não expõe nenhuma porta na rede local e
aceita `?audio=dublado|legendado` e `?quality=720|1080|2160` para forçar a
escolha. O BLUDV não informa seeds; o card usa `1` para evitar que filtros
mínimos descartem a release antes da consulta ao swarm. Como o site troca de
domínio com frequência, atualize `links` no YAML se o teste do indexer falhar.

Para atualizar o Jackett sem perder os cards, atualize o digest base do stage
`jackett` no `Dockerfile` raiz e reconstrua em vez de usar o auto-update
interno (o compose já roda com `AUTO_UPDATE=false`):

```bash
docker compose up -d --build
```

Depois da primeira inclusão do Bludv na UI, o estado continua persistido em
`docker-data/jackett`. As definitions Cardigann vêm sempre da **imagem** —
nunca monte volume sobre `/app/Jackett/Definitions`.

#### Card ComandoTorrents

O card **ComandoTorrents** é incluído na mesma imagem. Adicione-o
pela UI do Jackett depois de subir a stack. O `comandotorrents-resolver` segue
o protetor de links e expande cada botão de qualidade/áudio em uma release do
Jackett; ele não expõe portas na rede local.

#### Card NerdFilmesTorrent / XNerdFilmes

O card **NerdFilmesTorrent / XNerdFilmes** também é incluído na imagem única.
Adicione-o pela UI após reconstruir a stack. O resolver acompanha o domínio
atual `xnerdfilmes.net`, segue o protetor de links e expande cada qualidade e
áudio como uma release separada. O serviço não publica porta no host.

#### Card TorrentDosFilmes V2

O card **TorrentDosFilmes V2** está incluído na imagem única e
expande cada botão de qualidade/áudio em uma release do Jackett. O serviço trata
magnets diretos, o protetor SystemAds e a página JavaScript `DEST_URL`, sem
expor porta no host.

### Prowlarr (opcional, externo)

O Prowlarr **não** faz parte do container único. Se quiser usá-lo, rode uma
instância separada (ex.: `docker run -p 9696:9696 ghcr.io/linuxserver/prowlarr`)
e aponte o `.env` para ela:

```env
PROVIDER=prowlarr
# ou: PROVIDER=both
PROWLARR_URL=http://host.docker.internal:9696
PROWLARR_API_KEY=sua_chave
```

O `PROWLARR_URL` do compose é override: ajuste-o no `environment` do
`docker-compose.yml` se a instância externa não estiver no host.

---

## Deploy em VPS

> Substitua `seudominio.com` no `Caddyfile` e aponte o registro DNS **A** de
> `adom.seudominio.com` para a VPS **antes** de subir o Caddy, para que o
> certificado HTTPS possa ser emitido.

1. Em uma VPS Ubuntu 22.04 com pelo menos 2 GB de RAM, instale Docker Engine e
   o plugin Docker Compose. Libere apenas SSH, TCP 80 e TCP 443 no firewall.
2. Copie o projeto, excluindo `node_modules/`, `.env` e `docker-data/`.
3. Crie o arquivo de configuração:

   ```bash
   cp .env.example .env
   # Edite .env: PROVIDER=jackett, JACKETT_API_KEY e
   # PUBLIC_URL=https://adom.seudominio.com. Numa instância pública, deixe
   # DEBRID_API_KEY vazia (cada usuário põe a sua na página de configuração)
   # e preencha RESOLVE_SECRET com uma string aleatória.
   ```

4. Inicie a stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl -s https://adom.seudominio.com/health
   curl -s https://adom.seudominio.com/manifest.json
   ```

5. Abra `https://adom.seudominio.com/configure`, escolha as opções (serviço de
   debrid, API key, filtros) e instale no Stremio o manifest fornecido pela
   página.

### Configurar indexers com segurança

A UI do Jackett fica ligada apenas em `127.0.0.1` na VPS. Use um túnel SSH
para configurar o Jackett e copiar sua API key para `.env`:

```bash
ssh -L 9117:127.0.0.1:9117 usuario@IP-DA-VPS
# Abra http://127.0.0.1:9117 no navegador local.
```

Após trocar `JACKETT_API_KEY`:

```bash
docker compose up -d
```

O Prowlarr é externo ao container único: rode uma instância separada se
desejar e ajuste `PROWLARR_URL`/`PROVIDER` no `.env`.

### Manutenção

```bash
docker compose up -d --build   # o rebuild também puxa imagens base atualizadas
docker compose logs -f         # logs de tudo: [addon], [jackett], [flaresolverr], [caddy]
docker compose down
```

O estado do Jackett persiste em `./docker-data/jackett`; os certificados do
Caddy ficam em `./docker-data/caddy` (data/config ACME). O cache SQLite do
addon fica em `./docker-data/addon`. Faça backup de `docker-data/`; não
versione `.env`.

---

## Estrutura do projeto

```
stremio adom/
├── src/
│   ├── addon.js              # entrada + manifest + HTTP + /resolve
│   ├── config.js             # .env (padrões do operador)
│   ├── runtime.js            # config por usuário na URL (overlay)
│   ├── providers/
│   │   ├── index.js          # orquestra busca, cache, deadline, debrid
│   │   ├── demo.js           # teste sem indexer
│   │   ├── jackett.js
│   │   ├── prowlarr.js
│   │   └── bludv.js          # scraper direto do BLUDV
│   ├── debrid/               # adaptadores: premiumize, realdebrid, …
│   ├── public/configure.html # página de configuração (sem build)
│   └── utils/
│       ├── cache.js
│       ├── cinemeta.js       # título/ano pelo IMDb
│       ├── tmdb.js           # título pt-BR
│       ├── sign.js           # HMAC dos links /resolve
│       └── format.js         # infoHash, qualidade, sort
├── test/                     # testes unitários (node:test)
├── scripts/
│   ├── smoke.js              # smoke test contra o addon rodando
│   └── entrypoint.sh         # supervisor dos 4 processos no container único
├── docker-compose.yml        # serviço único (adom)
├── jackett-bludv/            # definitions Cardigann dos cards BR (yml)
├── bludv-resolver/           # segue o protetor de links do BLUDV
├── comandotorrents-resolver/ # segue o protetor do ComandoTorrents
├── nerdfilmes-resolver/      # resolver do NerdFilmesTorrent
├── torrentdosfilmes-resolver/ # resolver do TorrentDosFilmes V2
├── Caddyfile
├── Dockerfile
├── .env.example
└── package.json
```

---

## Outro aparelho na rede (TV, celular)

1. Descubra o IP do PC (`ipconfig`).  
2. No Stremio do aparelho instale:  
   `http://IP-DO-PC:7000/manifest.json`  
3. Firewall do Windows: liberar porta **7000** (e 9117 se for configurar Jackett de fora).

---

## Comandos úteis

| Comando | Função |
|---------|--------|
| `npm start` | sobe o addon local |
| `npm run dev` | local com `--watch` |
| `npm test` | testes unitários (format.js + HMAC) |
| `npm run smoke` | smoke test contra o addon rodando |
| `npm run docker:up` | build + sobe o container único |
| `npm run docker:down` | para tudo |
| `npm run docker:logs` | logs da stack (addon/jackett/flaresolverr/caddy) |

---

## Limitações honestas

- Sem debrid o **Adom** é P2P: o Stremio baixa o torrent e depende de seeders.
- Com debrid, os resultados dependem de indexers saudáveis no Jackett e da
  conta no serviço escolhido.  
- Indexers, contas e legalidade dos conteúdos são **sua** responsabilidade.  
- Os domínios públicos são servidos pelo Caddy com HTTPS automático, desde que
  o DNS esteja apontado corretamente.

---

## Próximos passos (quando quiser)

1. Filtros por idioma (ex.: multi, DUAL, PT-BR).
2. Adicionar outros debrids, proxies de streams e scrapers.
3. Publicar o manifest em catálogo comunitário.

---

## Licença

MIT — use, fork, renomeie, faça o *seu* lado.
