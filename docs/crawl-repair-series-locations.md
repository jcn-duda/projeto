# Runbook — Reparo de locação de série (crawl-repair-series-locations)

One-shot para o Defeito A da Fase 7: releases de série gravadas na RAIZ da
obra (`magnet_work` season=-1/episode=-1) quando o título/dn declara
TEMPORADA (9 hashes de Stranger Things E01..E08 medidos em produção; batches
raiz de Reacher/Dexter/The Last of Us).

## O que o script faz (nesta ordem)

0. **Escopo (crawl.db primeiro)** — SOMENTE IMDb comprovadamente SÉRIE: linha
   `kind='tv_show'` no `crawl.db`. O banco é aberto ANTES de qualquer
   relatório/movimento/delete/requeue; linha raiz de FILME (ou IMDb sem linha
   no crawl) NUNCA entra — sem prova de série, sem movimento. crawl.db
   ausente ⇒ escopo vazio e saída sem tocar em nada.
1. **magnets.db** — varre `magnet_work` raiz DO ESCOPO; a régua é a MESMA do
   runtime
   (`declaredSeriesLocation`, `src/providers/crawl-sites/vaca-series-locate.ts`):
   o `dn=` do magnet VENCE o título do post. Linha que declara temporada única
   é movida para `(hash,imdb,S,E|-1)` preservando first/last_seen/
   passed_filter; raiz legítima (série inteira, "Todas as Temporadas", sem
   pista) fica. Uma transação com rollback.
2. **cache.db** — apaga as chaves raiz `idx:v13:<imdb>` do escopo (o erro foi
   todo para a raiz). Transação própria.
3. **crawl.db** — URLs `tv_show` do escopo DO SITE `vacatorrent` (por imdb no
   escopo OU `error series_truncated:%` daquele site) voltam a `pending` do
   zero; o motor reprocessa com o adaptador corrigido. Transação própria.

## Pré-requisitos do `--apply` (gates; sem eles o script recusa)

- **Fix deployado antes** — o adaptador corrigido precisa estar rodando, ou o
  reprocesso recria o defeito.
- **Addon parado** — o script sonda `127.0.0.1:7000` (default). Porta
  respondendo → recusa. Ajuste com `--port=<n>`; `--port=0` desliga a sonda
  (só em teste com bancos sintéticos).
- **Lock ausente** — `data/crawl-repair.lock` (override `--lock=<path>`) não
  pode existir.
- **Backup verificável** — `--backup=<dir>` obrigatório: diretório existente
  com cópia NÃO VAZIA dos três bancos (`magnets.db*`, `cache.db*`,
  `crawl.db*`, sufixo livre).

Conexões usam `busy_timeout=5000`; cada banco muta em UMA transação com
rollback (ou o passo inteiro, ou nada). O dry-run abre TODOS os bancos com
`readOnly: true` — a conexão não cria WAL/SHM, não faz checkpoint no close e
recusa escrita por construção — e nem `wal_checkpoint` roda nele (checkpoint é
escrita no arquivo; o mtime/hash dos bancos só muda no `--apply`, coberto por
teste, inclusive com WAL quente de crash). crawl.db ausente ou VAZIO (0 bytes)
⇒ mensagem amigável de escopo vazio e exit 0 antes de abrir qualquer banco.

## Procedimento

```bash
npm run build
# 1. Relatório (nada grava):
node dist/scripts/crawl-repair-series-locations.js
# 2. Backup real dos três bancos (docker-data/addon/ ou data/):
cp data/magnets.db data/backup-<data>/magnets.db   # idem cache.db, crawl.db
# 3. Aplicar:
node dist/scripts/crawl-repair-series-locations.js --apply --backup=data/backup-<data>
# 4. Subir o addon e validar:
#    - /painel → aba Magnets: hashes do escopo em (S,E);
#    - busca de Stranger Things S01E01 sem E01 fictício na raiz;
#    - aba Raspagens: fila do Vaca reprocessando.
```

## Rollback

Restaurar as cópias do `--backup` com o addon parado e apagar o lock se
existir. O dry-run anterior ao apply é o inventário do que foi movido.

## Limitações

- O script não reprocessa nada sozinho: a recolheita das URLs reenfileiradas
  é do motor (respeita delayMs/maxPerHour/freio de tráfego).
- `done` legados do dry-run antigo (sem acervo) NÃO são tocados — decisão do
  operador via "Zerar site" (ver `crawl-recovery.ts`).
