# Stremio Adom

Stack de addons Stremio pronta para Docker: **Comet + Real-Debrid** como
addon principal sem download P2P local, e **Adom** mantido como addon próprio
de backup/evolução.

Os **cinco** de uma vez:

| # | Objetivo | Como |
|---|----------|------|
| 1 | Addon principal no Stremio | Comet + Real-Debrid, sem P2P local |
| 2 | Rodar na sua pasta | `npm start` → `http://127.0.0.1:7000/manifest.json` |
| 3 | Criar o **seu** lado | código em `src/` (provedores, filtros, nome) |
| 4 | Subir no Docker | `docker compose up -d --build` |
| 5 | Stack completa em VPS | Caddy/HTTPS + Comet + Postgres + indexers |

---

## Arquitetura

```
Internet / Stremio
       ↓ HTTPS
Caddy ──→ comet.seudominio.com ──→ Comet ──→ Real-Debrid
      └─→ adom.seudominio.com  ──→ Adom ──→ Jackett/Prowlarr ──→ P2P
                                      ↑
                         Comet também consulta Jackett
```

- **Comet** = addon principal, busca torrents e reproduz via Real-Debrid.
- **Adom** = addon Node próprio, mantido como P2P de backup e para evolução.
- **Jackett / Prowlarr** = indexers; Comet usa Jackett por padrão.
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

1. Abra o Stremio  
2. **Addons** → caixinha de busca / “Addon repository URL”  
3. Cole: `http://127.0.0.1:7000/manifest.json`  
4. Instale **Stremio Adom**  
5. Busque o filme **Big Buck Bunny** e abra os streams  

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

## Deploy em VPS: Comet + Real-Debrid (principal)

> Substitua `seudominio.com` no `Caddyfile` e aponte os registros DNS **A** de
> `comet.seudominio.com` e `adom.seudominio.com` para a VPS **antes** de subir
> o Caddy, para que o certificado HTTPS possa ser emitido.

1. Em uma VPS Ubuntu 22.04 com pelo menos 2 GB de RAM, instale Docker Engine e
   o plugin Docker Compose. Libere apenas SSH, TCP 80 e TCP 443 no firewall.
2. Copie o projeto, excluindo `node_modules/`, `.env` e `docker-data/`.
3. Crie o arquivo de segredos e preencha as senhas obrigatórias:

   ```bash
   cp .env.example .env
   # Edite .env: POSTGRES_PASSWORD, ADMIN_DASHBOARD_PASSWORD,
   # CONFIGURE_PAGE_PASSWORD e JACKETT_API_KEY. As três senhas começam vazias
   # por segurança e devem ser preenchidas antes de iniciar a stack.
   ```

4. Inicie a stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl -s https://comet.seudominio.com/health
   curl -s https://adom.seudominio.com/manifest.json
   ```

5. Abra `https://comet.seudominio.com/configure`, adicione a chave da
   **Real-Debrid**, salve e instale no Stremio o manifest privado fornecido pela
   página. O dashboard administrativo fica em
   `https://comet.seudominio.com/admin`.
6. Instale também, se quiser o backup P2P, o manifest
   `https://adom.seudominio.com/manifest.json`.

### Configurar indexers com segurança

As UIs de Jackett e Prowlarr ficam ligadas apenas em `127.0.0.1` na VPS. Use
um túnel SSH para configurar Jackett e copiar sua API key para `.env`:

```bash
ssh -L 9117:127.0.0.1:9117 usuario@IP-DA-VPS
# Abra http://127.0.0.1:9117 no navegador local.
```

Após trocar `JACKETT_API_KEY`, execute:

```bash
docker compose up -d
docker compose restart comet
```

O Prowlarr continua opcional: inicie-o com
`docker compose --profile full up -d` e só habilite o scraper correspondente
quando desejar configurá-lo.

### Manutenção

```bash
docker compose pull
docker compose up -d
docker compose logs -f comet
docker compose down
```

Os volumes nomeados `comet_data`, `postgres_data`, `caddy_data` e
`caddy_config` mantêm os dados entre reinicializações. Faça backup de
`comet_data` e `postgres_data`; não versione `.env`.

---

## Estrutura do projeto

```
stremio adom/
├── src/
│   ├── addon.js              # entrada + manifest + HTTP
│   ├── config.js             # .env
│   ├── providers/
│   │   ├── index.js          # orquestra busca
│   │   ├── demo.js           # teste sem indexer
│   │   ├── jackett.js
│   │   └── prowlarr.js
│   └── utils/
│       ├── cache.js
│       ├── cinemeta.js       # título/ano pelo IMDb
│       └── format.js         # infoHash, qualidade, sort
├── docker-compose.yml
├── jackett-bludv/
│   ├── Dockerfile             # Jackett com card local
│   └── bludv-cardigann.yml    # definição Cardigann do BLUDV
├── bludv-resolver/             # resolve o protetor de links do BLUDV
├── comandotorrents-resolver/    # resolve o protetor de links do ComandoTorrents
├── nerdfilmes-resolver/          # indexador/resolver do NerdFilmesTorrent
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
| `npm run docker:up` | build + sobe compose |
| `npm run docker:down` | para tudo |
| `npm run docker:logs` | logs do addon |

---

## Limitações honestas

- O **Adom** é P2P (Stremio baixa o torrent); ele é apenas o backup nesta stack.
- O **Comet** requer uma conta Real-Debrid e indexers saudáveis no Jackett para
  retornar streams.  
- Indexers, contas e legalidade dos conteúdos são **sua** responsabilidade.  
- Os domínios públicos são servidos pelo Caddy com HTTPS automático, desde que
  o DNS esteja apontado corretamente.

---

## Próximos passos (quando quiser)

1. Unificar/evoluir o código próprio do Adom com o fluxo do Comet.
2. Filtros por idioma (ex.: multi, DUAL, PT-BR).
3. Adicionar outros debrids, proxies de streams e scrapers.
4. Publicar o manifest em catálogo comunitário.

---

## Licença

MIT — use, fork, renomeie, faça o *seu* lado.
