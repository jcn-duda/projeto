---
name: adom-deploy
description: Domínio do deploy do Adom (container único com Caddy + Jackett + FlareSolverr + addon, tudo por loopback, healthcheck quádruplo, resolvers embutidos, painel ESM emitido no build). Use ao auditar ou mexer em Dockerfile, docker-compose.yml, entrypoint.sh, br-resolvers.ts, build-assets.ts, tsconfigs do cliente ou workflows Docker/CI.
---

# O Vigia — Sentinela de Implantação

Zela pelo container único: 4 processos, loopback, healthcheck quádruplo,
`ServerConfig.json` no volume.

## Quando usar

- Ao mexer em `Dockerfile`, `docker-compose.yml`, `scripts/entrypoint.sh`.
- Ao revisar o caminho dos resolvers no `dist/`, o `ServerConfig.json` ou as
  definições Cardigann.
- Ao mexer no build do painel (`src/client/`, `tsconfig.client*.json`).
- Ao avaliar portas, envs de loopback ou o healthcheck.

## Arquivos-âncora

- `Dockerfile`
- `.github/workflows/docker.yml` e `ci.yml`
- `.dockerignore`
- `package.json` e `package-lock.json`
- `docker-compose.yml`
- `scripts/entrypoint.sh`
- `src/br-resolvers.ts`
- `scripts/build-assets.ts` e `scripts/clean.js`
- `resolvers/` (TypeScript: `env-config.ts`, `shim-instance.ts`, `types.ts` e `profiles/`)
- `*-resolver/server.ts`
- `tsconfig.client.json` e `tsconfig.client.test.json`
- `src/routes/public.ts` (`PAGE_ASSETS` e `CLIENT_ASSETS`)
- `docker-data/jackett/ServerConfig.json`

## Guardrails

1. Nada de hostname de container: tudo por `127.0.0.1` (Jackett, resolvers,
   Caddy, FlareSolverr).
2. `ServerConfig.json` vive no **volume** `./docker-data/jackett` — trocar a
   imagem não corrige nada lá; `FlareSolverrUrl` deve ser `http://127.0.0.1:8191`.
3. Definitions Cardigann vêm da **imagem**; nunca montar volume sobre elas.
4. Os 6 `*-resolver` são embutidos no processo do addon: `src/br-resolvers.ts`
   importa estaticamente os seis profiles de `resolvers/profiles/` (portas
   8700–8705). `BR_RESOLVERS_EMBEDDED=false` desliga a carga embutida e não é
   produção. Não existe mais Dockerfile por resolver — os antigos copiavam só o
   `server.js`, quebraram com o ESM e saíram em 2026-09-12.
5. Caminho relativo muda com `dist/`: o `tsc` emite `resolvers/` e os shims em
   `/app/dist` (o build-assets não copia mais `resolvers/` e não há
   `/app/resolvers` na imagem); `CACHE_DB_PATH` sobe 3 níveis para achar `data/cache.db`.
6. Healthcheck **quádruplo** (7000 + Jackett 9117 + FlareSolverr 8191 + API
   admin do Caddy `:2019` com header `Origin` explícito — sem ele a sonda
   recebe 403 e o container cai unhealthy com os quatro processos vivos).
7. Push em `origin/esm` = deploy na VPS (cron `*/5`); não confiar só no
   `git HEAD` do host — checkout roda **antes** do build.
8. Builder e runtime instalam pelo `package-lock.json`; runtime usa
   `npm ci --omit=dev`. Não trocar por resolução sem lockfile.
9. Novos `COPY` exigem conferir filtros de push e PR em `docker.yml`:
   núcleo `resolvers/**`, todos os `*-resolver/**`, os tsconfigs e `.dockerignore` incluídos.
10. `npm audit --omit=dev` é bloqueante no CI. Separe build local da imagem,
    saúde do container e comprovação de deploy; um não prova os demais.
11. O builder precisa dos **três** tsconfigs: o `npm run build` emite o painel
    ESM (`tsconfig.client.json` → `dist/src/public/client/`) e o emit de Node
    dos testes. Módulo do painel fora da `CLIENT_ASSETS` dá 404 no browser;
    asset listado e ausente no `dist/` **derruba o boot** (o fingerprint lê
    todos na criação do app). O painel exige WebView com ES modules.

## Contrato de saída (auditoria)

```json
{"area":"deploy","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`. (Não rode docker; auditoria
estática sobre os arquivos.)
