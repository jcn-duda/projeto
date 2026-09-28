# Runbook — Reparo de locação de série (crawl-repair-series-locations)

One-shot para o Defeito A da Fase 7 (v2, 2026-09-27): releases de série
gravadas na locação ERRADA — na RAIZ quando o título/dn declara TEMPORADA
(9 hashes de Stranger Things E01..E08 medidos em produção; batches raiz de
Reacher/Dexter/The Last of Us) e na TEMPORADA errada quando o card impôs a
dele (TWD: packs da 4ª gravados em S1/S5; dn real com entidade destruída
"4ordf" = "4ª"). O planejamento é puro (`scripts/crawl-repair-plan.ts`).

## O que o script faz (nesta ordem)

0. **Escopo (crawl.db primeiro)** — SOMENTE IMDb comprovadamente SÉRIE: linha
   `kind='tv_show'` no `crawl.db`. O banco é aberto ANTES de qualquer
   relatório/movimento/delete/requeue; linha de FILME (ou IMDb sem linha
   no crawl) NUNCA entra — sem prova de série, sem movimento. Vale para
   TODAS as locações (raiz, S, S:E). crawl.db ausente ⇒ escopo vazio e saída
   sem tocar em nada.
1. **magnets.db** — para cada linha do escopo compara a evidência declarada
   com a locação armazenada; a régua é EQUIVALENTE à do runtime
   (`chooseEpisodeParse`/`routeWorkLocation`, `src/utils/release-work.ts`):
   o `dn=` do magnet VENCE o título do post só quando é MAIS ESPECÍFICO, e
   entidades destruídas ("4ordf"/"4#170;") são decodificadas antes do parse.
   Título que declara EPISÓDIO ÚNICO SEM dn PRESERVA {S,E} — sem dn não há
   prova de pack, e rebaixar (S,E)→(S,-1) era falso move (19 linhas medidas
   2026-09-27).
   - **Mover/fundir** — locação declarada ≠ armazenada: move para
     `(hash,imdb,S,E|-1)`; se a PK destino já existe (mesmo hash em duas
     temporadas erradas, segunda passada), FUNGE na linha destino
     (first_seen=min, last_seen=max, passed_filter=OR).
   - **Excluir por identidade** — release "Live Action" de OUTRA adaptação
     gravada sob a série (One Piece 2023/2026 sob o anime tt0388629):
     a linha é EXCLUÍDA, nunca remanejada para outro IMDb. Exige o ano de
     estreia da obra via `--premiere=tt…:AAAA` (repetível); sem o ano, a
     suspeita só é RELATADA (`SUSPEITA sem ano de estreia`).
   - **Sanear título** — título com `E01` FICTÍCIO (prova: o dn declara
     pack/temporada SEM episódio único): o marcador é removido do
     `magnet.title`. Sem dn não há prova e nada é tocado.
   - Raiz legítima (série inteira, "Todas as Temporadas", sem pista) e linha
     já na locação certa ficam. Uma transação com rollback.
2. **cache.db** — apaga TODAS as chaves das obras AFETADAS: idx real
   `idx:v13:<imdb>`, `…:S4`, `…:S4E5` (o episódio COLA na temporada, sem
   segundo ":" — por isso a chave raiz exata + o prefixo `:%` cobrem tudo) e
   as listas prontas por instalação `streams:v20:series:<imdb>:%` (padrão
   `streams:%:series:<imdb>:%`, qualquer config/conta). O índice e as buscas
   regravam do acervo vivo. Transação própria.
3. **crawl.db** — URLs `tv_show` do escopo DO SITE `vacatorrent` (por imdb no
   escopo OU `error series_truncated:%` daquele site) voltam a `pending` do
   zero — INDEPENDENTE de haver moves: `series_truncated` precisa voltar à
   fila mesmo com plano vazio. Só a linha NÃO convergida é tocada (segunda
   passada é no-op). O motor reprocessa com o adaptador corrigido.
   Transação própria.

O relatório do DRY-RUN é o plano COMPLETO: moves, saneamentos, chaves
idx/streams planejadas e fila planejada — o `--apply` grava exatamente esse
relatório (paridade coberta por teste).

## Pré-requisitos do `--apply` (gates; sem eles o script recusa)

- **Fix deployado antes** — o adaptador corrigido precisa estar rodando, ou o
  reprocesso recria o defeito.
- **Addon parado** — o script sonda `127.0.0.1:7000` (default). Porta
  respondendo → recusa. Ajuste com `--port=<n>`; `--port=0` desliga a sonda
  (só em teste com bancos sintéticos).
- **Lock exclusivo (lockOwned)** — lock alheio em `data/crawl-repair.lock`
  (override `--lock=<path>`) recusa; o lock PRÓPRIO é criado com `wx` no
  início da mutação e, no `finally`, só o lock CRIADO por aquele processo é
  removido (falha no meio não deixa lock órfão e nunca apaga lock alheio).
- **Backup verificável** — `--backup=<dir>` obrigatório: diretório existente
  com cópia NÃO VAZIA dos três bancos (`magnets.db*`, `cache.db*`,
  `crawl.db*`, sufixo livre).

Conexões usam `busy_timeout=5000`; cada banco muta em UMA transação com
rollback (ou o passo inteiro, ou nada). O dry-run abre TODOS os bancos com
`readOnly: true` — a conexão recusa escrita por construção, não faz
checkpoint no close e NÃO altera `db`/`wal` (byte-idênticos, coberto por
teste). O SQLite pode criar/tocar o arquivo `-shm` TRANSITÓRIO ao abrir um
banco em WAL — é livro de concorrência, não dado: some no close e `db`/`wal`
permanecem intactos. `wal_checkpoint` nunca roda no dry-run (checkpoint é
escrita no arquivo; o mtime/hash dos bancos só muda no `--apply`, inclusive
com WAL quente de crash). crawl.db ausente ou VAZIO (0 bytes)
⇒ mensagem amigável de escopo vazio e exit 0 antes de abrir qualquer banco.
O script é OFFLINE por desenho: nenhum ano é buscado em rede.

## Procedimento

```bash
npm run build
# 1. Relatório (nada grava; suspeitas de contaminação aparecem sem ano):
node dist/scripts/crawl-repair-series-locations.js
# 2. Backup real dos três bancos (docker-data/addon/ ou data/):
cp data/magnets.db data/backup-<data>/magnets.db   # idem cache.db, crawl.db
# 3. Aplicar (com os anos de estreia das obras com contaminação):
node dist/scripts/crawl-repair-series-locations.js --apply \
  --backup=data/backup-<data> --premiere=tt0388629:1999
# 4. Subir o addon e validar:
#    - /painel → aba Magnets: hashes do escopo em (S,E);
#    - busca de Stranger Things S01E01 sem E01 fictício na raiz;
#    - One Piece anime sem releases "Live Action" no acervo;
#    - aba Raspagens: fila do Vaca reprocessando.
# 5. Segunda passada: relatório vazio (idempotente).
```

## Rollback

Restaurar as cópias do `--backup` com o addon parado e apagar o lock se
existir. O dry-run anterior ao apply é o inventário do que foi movido.

## Limitações

- O script não reprocessa nada sozinho: a recolheita das URLs reenfileiradas
  é do motor (respeita delayMs/maxPerHour/freio de tráfego).
- `done` legados do dry-run antigo (sem acervo) NÃO são tocados — decisão do
  operador via "Zerar site" (ver `crawl-recovery.ts`).
- Contaminação de identidade SEM `--premiere` é só relatada: ausência de dado
  nunca autoriza remoção.
- No runtime, o veto de identidade (`liveActionYearContradicts`) também exige
  as duas provas (marcador "Live Action" + ano longe da estreia): packs do
  próprio anime ("S01-S15", faixa "1999-2023") e o pack da própria live
  action (estreia 2023, temporada 2026) NÃO são condenados.
