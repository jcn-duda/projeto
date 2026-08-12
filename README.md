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
| 4 | Subir no Docker | `docker compose up -d --build` |
| 5 | Stack completa em VPS | Caddy/HTTPS + addon + Jackett + resolvers BR |

---

## Arquitetura

```
Internet / Stremio
       ↓ HTTPS
Caddy ──→ adom.seudominio.com ──→ Adom ──→ Jackett ──→ indexers globais (P2P)
                                   │            └──→ cards BR ──→ *-resolvers (protetores de link)
                                   ├──────────→ scraper direto do BLUDV
                                   └──────────→ debrid opcional (play via /resolve assinado)
```

- **Adom** = addon Node deste repositório: busca em paralelo no Jackett
  (indexers globais + cards brasileiros), no Prowlarr e no scraper do BLUDV.
- **Jackett** = gerenciador de indexers; os cards BR (Bludv, ComandoTorrents,
  NerdFilmes, TorrentDosFilmes V2) vêm embutidos na imagem local e dependem
  dos microserviços `*-resolver` para seguir protetores de links.
- **FlareSolverr** = resolve desafios Cloudflare dos indexers que exigem.
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
| Qualidade | Filtra 4K / 1080p / 720p / 480p |
| Vagas BR | Quantos slots ficam garantidos para fontes brasileiras |
| Somente dublado | Descarta as versões legendadas dos posts BR |
| Só fontes BR | Esconde tudo que não vier dos indexers brasileiros |
| Máx. streams · mín. seeders | Tamanho e piso do resultado |
| Debrid | Serviço + API key, e se mostra só o que já está em cache |

### Serviços de debrid suportados

| Serviço | Consulta de cache |
|---|---|
| Premiumize | sim |
| TorBox | sim |
| Real-Debrid | não |
| AllDebrid | não |
| Debrid-Link | não |

Real-Debrid, AllDebrid e Debrid-Link aposentaram os endpoints de disponibilidade
instantânea, então **não dá para saber de antemão** o que toca na hora. Nesses
serviços todos os resultados passam pelo debrid, sem o ⚡, e a opção *somente em
cache* fica desligada — se o torrent não estiver em cache, o play falha e você
escolhe outro. Com Premiumize ou TorBox o comportamento antigo continua: ⚡ nos
que tocam na hora e filtro funcionando.

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

O compose constrói uma imagem do Jackett que já contém o card **Bludv**.

Suba somente o addon + Jackett para o fluxo local (a stack completa também
exige as senhas do Comet/Postgres e um domínio configurado):

```powershell
docker compose up -d --build addon jackett
```

1. Abra o Jackett: http://127.0.0.1:9117  
2. Procure por **Bludv**, adicione-o, teste e salve. Configure os demais
   indexers desejados e copie a API Key.  
3. Coloque a key em `.env` → `JACKETT_API_KEY=...` e `PROVIDER=jackett`  
4. Recrie o addon:

```powershell
docker compose up -d --build addon
```

5. No Stremio: `http://127.0.0.1:7000/manifest.json`

#### Card Bludv

O card está em `jackett-bludv/bludv-cardigann.yml` e é copiado para a imagem do Jackett
em `jackett-bludv/Dockerfile`. Ele consulta o buscador WordPress do BLUDV e
extrai de cada card o título (sem o rótulo "Torrent"), o tamanho real, o
poster e o título original em inglês. No download, o serviço interno
`bludv-resolver` escolhe o **melhor** botão `Magnet-Link` do post —
dublado/dual primeiro, maior qualidade depois — e segue os redirects do
protetor de links até o magnet; ele não expõe nenhuma porta na rede local e
aceita `?audio=dublado|legendado` e `?quality=720|1080|2160` para forçar a
escolha. O BLUDV não informa seeds; o card usa `1` para evitar que filtros
mínimos descartem a release antes da consulta ao swarm. Como o site troca de
domínio com frequência, atualize `links` no YAML se o teste do indexer falhar.

Para atualizar o Jackett sem perder o card, atualize o digest base em
`jackett-bludv/Dockerfile` e reconstrua a imagem em vez de usar o auto-update
interno:

```bash
docker compose build jackett
docker compose up -d jackett
```

Depois da primeira inclusão do Bludv na UI, o estado continua persistido em
`docker-data/jackett`.

#### Card ComandoTorrents

O card **ComandoTorrents** é incluído na mesma imagem do Jackett. Adicione-o
pela UI do Jackett depois de subir a stack. O `comandotorrents-resolver` segue
o protetor de links e expande cada botão de qualidade/áudio em uma release do
Jackett; ele não expõe portas na rede local.

#### Card NerdFilmesTorrent / XNerdFilmes

O card **NerdFilmesTorrent / XNerdFilmes** também é incluído na imagem local do Jackett.
Adicione-o pela UI após reconstruir a stack. O resolver acompanha o domínio
atual `xnerdfilmes.net`, segue o protetor de links e expande cada qualidade e
áudio como uma release separada. O serviço não publica porta no host.

#### Card TorrentDosFilmes V2

O card **TorrentDosFilmes V2** está incluído na imagem local do Jackett e
expande cada botão de qualidade/áudio em uma release do Jackett. O serviço trata
magnets diretos, o protetor SystemAds e a página JavaScript `DEST_URL`, sem
expor porta no host.

### Prowlarr (opcional)

```powershell
docker compose --profile full up -d --build
```

```env
PROVIDER=prowlarr
# ou: PROVIDER=both
PROWLARR_URL=http://127.0.0.1:9696
PROWLARR_API_KEY=sua_chave
```

No Docker o compose já aponta o addon para `http://prowlarr:9696` e `http://jackett:9117`.

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

O Prowlarr continua opcional: inicie-o com
`docker compose --profile full up -d` e só habilite o provider correspondente
quando desejar configurá-lo.

### Manutenção

```bash
docker compose up -d --build   # o rebuild também puxa imagens base atualizadas
docker compose logs -f addon
docker compose down
```

O estado do Jackett persiste em `./docker-data/jackett`; os certificados do
Caddy ficam nos volumes `caddy_data` e `caddy_config`. Faça backup de
`docker-data/`; não versione `.env`.

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
├── scripts/smoke.js          # smoke test contra o addon rodando
├── docker-compose.yml
├── jackett-bludv/            # imagem do Jackett com os cards BR
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
| `npm run docker:up` | build + sobe compose |
| `npm run docker:down` | para tudo |
| `npm run docker:logs` | logs do addon |

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
