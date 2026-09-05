---
name: adom-deploy
description: Domínio do deploy do Adom (container único com Caddy + Jackett + FlareSolverr + addon, tudo por loopback, healthcheck quádruplo, resolvers embutidos). Use ao auditar ou mexer em Dockerfile, docker-compose.yml, entrypoint.sh, br-resolvers.ts, build-assets.ts ou workflows Docker/CI.
---

# O Vigia — Sentinela de Implantação

Zela pelo container único: 4 processos, loopback, healthcheck quádruplo,
`ServerConfig.json` no volume.

## Quando usar

- Ao mexer em `Dockerfile`, `docker-compose.yml`, `scripts/entrypoint.sh`.
- Ao revisar o caminho dos resolvers no `dist/`, o `ServerConfig.json` ou as
  definições Cardigann.
- Ao avaliar portas, envs de loopback ou o healthcheck.

## Arquivos-âncora

- `Dockerfile`
- `.github/workflows/docker.yml` e `ci.yml`
- `.dockerignore`
- `package.json` e `package-lock.json`
- `docker-compose.yml`
- `scripts/entrypoint.sh`
- `src/br-resolvers.ts`
- `scripts/build-assets.ts`
- `resolvers/`
- `*-resolver/server.js` e `server.d.ts`
- `docker-data/jackett/ServerConfig.json`

## Guardrails

1. Nada de hostname de container: tudo por `127.0.0.1` (Jackett, resolvers,
   Caddy, FlareSolverr).
2. `ServerConfig.json` vive no **volume** `./docker-data/jackett` — trocar a
   imagem não corrige nada lá; `FlareSolverrUrl` deve ser `http://127.0.0.1:8191`.
3. Definitions Cardigann vêm da **imagem**; nunca montar volume sobre elas.
4. Os 5 `*-resolver` são embutidos no processo do addon
   (`BR_RESOLVERS_EMBEDDED=false` volta ao modo separado, não é produção).
5. Caminho relativo muda com `dist/`: resolvers copiados para `/app/dist`, não
   `/app`; `CACHE_DB_PATH` sobe 3 níveis para achar `data/cache.db`.
6. Healthcheck **quádruplo** (7000 + Jackett 9117 + FlareSolverr 8191 + API
   admin do Caddy `:2019` com header `Origin` explícito — sem ele a sonda
   recebe 403 e o container cai unhealthy com os quatro processos vivos).
7. Push em `origin/esm` = deploy na VPS (cron `*/5`); não confiar só no
   `git HEAD` do host — checkout roda **antes** do build.

8. Builder e runtime instalam pelo `package-lock.json`; runtime usa
   `npm ci --omit=dev`. Não trocar por resolução sem lockfile.
9. Novos `COPY` exigem conferir filtros de push e PR em `docker.yml`:
   núcleo `resolvers/**`, todos os `*-resolver/**` e `.dockerignore` incluídos.
10. `npm audit --omit=dev` é bloqueante no CI. Separe build local da imagem,
    saúde do container e comprovação de deploy; um não prova os demais.

## Contrato de saída (auditoria)

```json
{"area":"deploy","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`. (Não rode docker; auditoria
estática sobre os arquivos.)
