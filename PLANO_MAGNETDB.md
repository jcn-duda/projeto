# Banco de magnets (`d0f27c1`) — plano de correção v2

Revisão do plano v1 de análise do banco de magnets. Mantém a direção da v1
(prioridade no `markBad`, ordem por dano ativo, kill-switch por TTL) e corrige o
que a v1 dimensionou ou afirmou errado sobre o código real.

> **Status histórico.** As **fases 1 a 4 foram implementadas** em `98cd842`,
> commit que também trouxe este documento. O texto abaixo é o plano como estava
> ANTES da execução — as âncoras `arquivo:linha` apontam para a árvore em
> `6ee8ff7` e saíram do lugar com o próprio commit que as implementou. Duas
> coisas mudaram na execução em relação ao planejado, ambas descobertas ao
> escrever o código:
>
> - o `pickFile` que lança também atinge o `waiting_files_selection` do
>   Real-Debrid (`resolveLink` e `enqueue`), que o plano não tinha mapeado — ver
>   a revisão do `98cd842`;
> - a Fase 2 dizia "medido"; a justificativa correta é aritmética (teto abaixo
>   da soma das cotas torna a repartição inalcançável), e o comentário no
>   `cache.ts` foi corrigido para dizer isso.
>
> O crash descrito em "O que a v1 não viu" já havia entrado antes, em `6ee8ff7`,
> e não faz parte das fases.

## Contexto

O `d0f27c1` introduziu o banco de magnets: histórico durável por hash, escopado
por serviço + conta, que alimenta duas decisões da listagem — descartar o que
provou estar quebrado (`bad`) e desempatar a ordem a favor do que provou tocar
na hora (`alive`). O módulo é [magnetdb.ts](src/utils/magnetdb.ts); os dois
pontos de consumo são o filtro pré-checagem em
[providers/index.ts:582](src/providers/index.ts:582) e o `instant` do
`sortAndLimit` em [providers/index.ts:1518](src/providers/index.ts:1518).

O desenho está certo e a v1 verificou bem os pontos que importam:

- **Escopo e privacidade.** A chave é `mag:v1:<lado>:<adapterId>:<sha256(apiKey)>:<hash>`
  — nunca vaza credencial, não cruza contas, e conta compartilhada compartilha
  histórico por design (o cache do debrid é da conta, não da instalação).
  Confirmado no SQLite do container: 114 registros `alive` convivendo entre
  `alldebrid` e `premiumize` sobre a mesma conta.
- **Complementaridade com o `davail`.** Não é redundância: o `davail` responde à
  checagem por minutos, o `alive` desempata a ordenação por dias. Tem uma fuga,
  tratada na Fase 3.
- **Posição do `instant` no sort.** Depois de episódio exato, qualidade, dublado
  e prioridade de indexer. Correto: o histórico desempata, não reordena.

O que está errado é o lado `bad`, e ele está errado de um jeito que causa dano
ativo hoje.

## Correções sobre a v1

1. **A "opção mínima" da v1 não é implementável.** Ela propõe que "o `/resolve`
   só grave `bad` quando o adaptador listou os arquivos e nenhum é vídeo" — mas
   o `/resolve` recebe um `null` opaco de `debrid.resolveLink()` e não tem como
   saber se houve listagem. A informação só existe dentro do adaptador. Ver
   Fase 1: existe um caminho melhor que nenhuma das duas opções da v1.
2. **O item "case do `instantSet`" não é bug.** `extractInfoHash` normaliza para
   minúscula em **todos** os caminhos de retorno
   ([format.ts:110-117](src/utils/format.ts:110)) e `base32ToHex` termina em
   `toString(16)`, que já é minúsculo. `toStremioStream` não produz hash
   maiúsculo, então o `Set` não tem entrada maiúscula para perder. É defesa em
   profundidade, não correção — fora do plano.
3. **O número das cotas está errado, e para o lado otimista.** A v1 diz "≈24,5k
   vs 25k". A soma real é **26.000** contra `MAX_ENTRIES = 25000`: as cotas
   estão sobrecomprometidas, não folgadas. Ver Fase 2.
4. **O risco de despejo do histórico durável não existe.** A v1 teme que o teto
   global "despeje exatamente o histórico que o recurso promete". O despejo
   global é FIFO por ordem de inserção
   ([cache.ts:347](src/utils/cache.ts:347)), mas
   [cache.ts:458](src/utils/cache.ts:458) faz `removeFromStore` antes do `set` —
   renovar um `alive` o manda para o fim da fila. Hash reconfirmado não é
   despejado; só envelhece quem parou de ser confirmado, que é o comportamento
   desejado. Nada a fazer.
5. **Falta o pior caso concreto desta instância.** Ver Fase 1: o site que a
   conta cheia da AllDebrid aciona.

---

## Fase 1 — `bad` para de condenar torrent bom

### O problema

[app.ts:254](src/app.ts:254) marca `bad` em **qualquer** `null` devolvido pelo
`resolveLink`. Mas `null` não significa "sem vídeo" em lugar nenhum além de um
site por adaptador — e em dois adaptadores não significa isso em site algum:

| adaptador | site | significado |
|---|---|---|
| alldebrid | [319](src/debrid/alldebrid.ts:319) `!magnet?.id` | upload falhou — **transitório** |
| alldebrid | [348](src/debrid/alldebrid.ts:348) timeout esperando `Ready` | **transitório** |
| alldebrid | [353](src/debrid/alldebrid.ts:353) `!file` | sem vídeo — **determinístico** |
| realdebrid | [53](src/debrid/realdebrid.ts:53) `!add?.id` | **transitório** |
| realdebrid | [80](src/debrid/realdebrid.ts:80) `status !== READY` | **transitório** |
| realdebrid | [92](src/debrid/realdebrid.ts:92) `!link` | **ambíguo** — não passa por `pickFile` quando há 1 arquivo selecionado |
| torbox | [86](src/debrid/torbox.ts:86) `torrentId == null` | **transitório** |
| torbox | [99](src/debrid/torbox.ts:99) `!download_finished` | **transitório** |
| torbox | [108](src/debrid/torbox.ts:108) `!file` | sem vídeo — **determinístico** |
| debridlink | [53](src/debrid/debridlink.ts:53) / [63](src/debrid/debridlink.ts:63) | **transitório** |
| debridlink | [71](src/debrid/debridlink.ts:71) `file?.link \|\| null` | sem vídeo — **determinístico** |
| premiumize | [82](src/debrid/premiumize.ts:82) | **ambíguo** — `data.content` vem vazio tanto em "sem vídeo" quanto em transferência fria |

Reprodução: serviço sem `cacheCheck` (Real-Debrid, Debrid-Link) faz todo play de
fonte fria passar pelo `/resolve` → "ainda baixando" → `null` → hash condenado
por 24h e filtrado de **toda** lista futura pelo filtro pré-checagem. O pior
caso é circular: o próprio autofetch baixa o torrent e o banco esconde o
resultado pronto por um dia.

**O caso desta instância:** a conta cheia da AllDebrid
(`Magnets limit reached (1000 accross all tabs)`, documentado no
[AGENTS.md:329](AGENTS.md:329)) cai no site 319. Com a conta no teto, cada
clique do usuário condena o hash por 24h — uma tarde de tentativas frustradas
grava uma blacklist justamente do que ele mais quis assistir, e ela sobrevive à
limpeza da conta.

### A correção: uma função, não cinco adaptadores

O predicado determinístico verdadeiro não é "o `resolveLink` devolveu null". É:

> **a listagem veio com arquivos E nenhum deles é vídeo**

Esse predicado só existe inteiro dentro do `pickFile`
([common.ts:290](src/debrid/common.ts:290)), que já recebe `files` e já calcula
`videos`. É também a função que já implementa esta mesma distinção para os
outros dois casos — [common.ts:365](src/debrid/common.ts:365) diz, ao lançar
`WorkPickError`: *"null significaria 'sem vídeo' — mas há vídeo, só não sabemos
qual"*.

Ou seja: o `null` do `pickFile` **já é** o contrato certo. Quem o violou foram
os adaptadores, ao reusar `null` para "não pronto".

**Mudança:**

1. `NoVideoError` em [common.ts](src/debrid/common.ts), ao lado de
   `WorkPickError`/`EpisodePickError`, com o par `isNoVideoError` (mesma forma
   dos dois existentes, [common.ts:101-127](src/debrid/common.ts:101)).
2. **Uma linha** no `pickFile`. Hoje
   [common.ts:290](src/debrid/common.ts:290) é
   `if (videos.length === 0) return null;` — a guarda já está escrita, só não
   distingue a origem do vazio:

   ```ts
   if (videos.length === 0) {
     // Listagem COM arquivos e nenhum vídeo é prova; listagem vazia é
     // transferência fria, e prova nenhuma.
     if (files.length > 0) throw new NoVideoError();
     return null;
   }
   ```
3. `/resolve` ([app.ts:254](src/app.ts:254)): o `markBad` sai do `if (!link)` e
   vira uma branch no `catch`, ao lado das duas que já existem
   ([app.ts:266](src/app.ts:266)). `null` **nunca mais** marca `bad`.
4. Os cinco adaptadores: **zero mudanças.**

Custo: ~14 linhas, uma delas a troca do `return null` de uma guarda que já
existe. Ganhos sobre a proposta "estruturada" da v1 (que mudava o
retorno dos cinco adaptadores):

- resolve o Premiumize e o RD-`!link` de graça — listagem vazia não lança,
  então não condena;
- o 404 vira honesto (`"o torrent ainda está baixando no debrid"` no lugar de
  `"nenhum arquivo de vídeo no torrent"`, que hoje mente em todo play de fonte
  fria);
- `sample.mkv` sozinho e pack só de `.rar` continuam condenados, que é o
  comportamento desejado (`SAMPLE` já sai do `videos` no filtro do `pickFile`).

**Limitação aceita e documentada:** Real-Debrid com 1 arquivo selecionado não
passa por `pickFile` ([realdebrid.ts:86-92](src/debrid/realdebrid.ts:86)), então
nunca marca `bad`. É falso negativo — o lado certo de errar, pela regra de ouro
do módulo ("descartar um magnet bom esconde stream do usuário").

### Testes

O harness já existe: [app-routes.test.ts:19-29](test/app-routes.test.ts:19)
registra adaptador fake no registry real e exercita o `/resolve` ponta a ponta
(assinatura → `current()` → `resolveLink`). Acrescentar, com `resolveLink` fake:

- devolve `null` → 404 e **nenhum** `bad` gravado ← *este é o bug*
- lança `NoVideoError` → 404 **e** `bad` gravado
- lança `WorkPickError` → 404, nada gravado
- lança `EpisodePickError` → 404, nada gravado
- devolve link → 302 **e** `alive` gravado
- `MAGNET_DB=false` → nenhum dos anteriores grava nada

Em [magnet-db.test.ts](test/magnet-db.test.ts), sobre o `pickFile` direto:

- `pickFile([], …)` → `null`, sem lançar (listagem vazia não é prova)
- `pickFile([{ path: 'x.rar' }], …)` → lança `NoVideoError`
- `pickFile([{ path: 'sample.mkv' }], …)` → lança `NoVideoError`

---

## Fase 2 — a aritmética das cotas

`MAX_ENTRIES = 25000` ([cache.ts:17](src/utils/cache.ts:17)) contra a soma das
cotas de [cache.ts:18-37](src/utils/cache.ts:18):

```
streams 2000 · dlmag 4000 · tmdb 2000 · meta 2000 · raw 800
davail 5000 · mag 8000 · autofetch 2000 · indexer-status 200   =  26.000
```

Sobrecomprometido em 4%. Não é "sob pressão pode despejar": com o cache cheio o
teto global **sempre** morde antes das cotas de namespace, e a repartição justa
que elas prometem nunca chega a valer.

Promovida da fase 3 da v1 para cá porque é uma linha, e porque o `mag` tem a
maior cota do sistema (8000): deixar a conta quebrada enquanto se acrescenta
consumo ao namespace mais durável é acumular dívida no lugar errado.

**Ação:** `MAX_ENTRIES` para 30.000, refazendo antes a conta de memória. O `raw`
domina o custo (800 entradas × ~100 KB de teto ≈ 79 MB no pior caso, conforme a
justificativa que já está no comentário da cota); os demais namespaces são
entradas minúsculas — `mag` e `davail` guardam `0/1`. Confrontar com o
`mem_limit: 3g` do [docker-compose.yml](docker-compose.yml), que hoje cobre
~1 GB de Chromium do FlareSolverr + ~300 MB do resto.

**Métrica que valida:** `cache.evicted` (teto global) contra
`cache.evicted.quota.<ns>`. Depois da mudança, o primeiro deve ir a zero em
operação normal — despejo por teto é justamente o sinal, já documentado em
[cache.ts:351](src/utils/cache.ts:351), de que `MAX_ENTRIES` ficou pequeno.

---

## Fase 3 — coerência do `alive`

### O atalho do `davail` não renova o histórico

[debrid/index.ts:280](src/debrid/index.ts:280) retorna
`{ cached: fromCache, known: true }` quando o L1 cobre todos os hashes — e o
`markAlive` está lá embaixo, na [333](src/debrid/index.ts:333). Um hash
confirmado só pelo `davail` nunca renova os 7 dias do `alive`. O efeito é
perverso: quanto mais buscado o título, mais ele é servido pelo atalho, e mais
cedo o desempate `instant` morre em silêncio no meio do TTL.

**Ação:** `markAlive(adapter.id, apiKey, [...fromCache])` antes do return da 280.
É a mesma evidência confirmada, só servida da memória. O guard `!result.unusable`
da linha 333 não se aplica aqui — não houve rede, e o `davail` só guarda
positivo confirmado.

### Política para `alive` + `bad` no mesmo hash

Hoje é possível (as janelas de TTL são distintas: 7 dias contra 24h) e o
comportamento é indefinido — o `bad` filtra em `applyDebrid` e o `alive` ainda
empurra no sort. **Definir: `bad` vence e apaga o `alive`**, dentro do
`markBad`.

Não é só higiene. O `instantSet` é montado em `buildStreams`
([providers/index.ts:1518](src/providers/index.ts:1518)) **antes** do
`applyDebrid`, então um hash nessa condição sobe ao topo do `sortAndLimit` e só
depois é cortado pelo filtro pré-checagem — gastando uma vaga do pool de
candidatos, que é dimensionado por `candidatePoolFactor`.

---

## Fase 4 — diagnóstico

1. **Métrica única para duas causas.**
   [providers/index.ts:587](src/providers/index.ts:587) soma em
   `magnetdb.dropped` tanto o `isBad` quanto o `isDead` do autofetch. Separar em
   `magnetdb.dropped.bad` / `magnetdb.dropped.dead` — sem isso o diagnóstico
   culpa o banco por corte do autofetch e vice-versa. É também o instrumento que
   valida a Fase 1 em produção: depois dela, `.bad` deve despencar.
2. **Aviso enganoso.** `candidatesBeforeDebrid` é contado **antes** do
   `applyDebrid` ([providers/index.ts:1543](src/providers/index.ts:1543)), então
   os itens cortados por `bad`/`dead` entram na conta e o texto sai como
   `"N resultado(s) fora do cache"` quando o motivo real foi histórico ruim.
   Texto próprio quando o filtro pré-checagem foi quem esvaziou a lista.
3. **Fronteira `bad` × `dead` no AGENTS.md.** Mesmo TTL de 24h, mesmo filtro,
   origens diferentes (play sem vídeo × estado terminal no recheck). Manter
   separados — as evidências são distintas —, mas o `AGENTS.md` hoje não tem
   seção do banco de magnets. Documentar junto do quadro de debrids que já
   existe em [AGENTS.md:295](AGENTS.md:295). Unificar com o `dead` só se um
   terceiro consumidor aparecer.

---

## O que a v1 não viu

A revisão auditou a **semântica** do `d0f27c1` e passou direto pelo **crash**: o
desempate lia `.infoHash` de um `null` — `toStremioStream` devolve `null` para
item sem infoHash e `sortAndLimit` recebe `(Stream | null)[]` de propósito — e
derrubava a busca inteira com `TypeError`. Medido em `tt11198330:2:1`: 520
releases coletados, **zero** streams entregues. Corrigido em `6ee8ff7`.

É a mesma raiz que a v1 identificou corretamente na seção de lacunas de teste: o
caminho novo entrou sem teste no **ponto de consumo**. O gap custou dois bugs,
não um — e o segundo era pior, porque atingia toda busca com chave de debrid
configurada, não só quem clicava play.

**Regra que atravessa todas as fases:** nenhuma entra sem teste no ponto de
consumo, não só no módulo.

## Ordem e risco

| Fase | Escopo | Toca | Risco |
|---|---|---|---|
| 1 | `NoVideoError` + `/resolve` + testes | `common.ts`, `app.ts` | **Dano ativo.** Patch pequeno, harness pronto |
| 2 | `MAX_ENTRIES` 25k → 30k | `cache.ts` | Uma linha; medir memória antes |
| 3 | `alive` no atalho do davail + política `bad` > `alive` | `debrid/index.ts`, `magnetdb.ts` | Coerência; sintoma é desempate fraco, não usuário sem stream |
| 4 | Métricas separadas, aviso, docs | `providers/index.ts`, `AGENTS.md` | Cosmético/diagnóstico |

## Apêndice — como inspecionar o banco em execução

`JACKETT_TEST_TOKEN` e `RESOLVE_SECRET` não estão no `.env` desta instância,
então `/metrics.json`, `/dashboard-status.json` e `/seal-config` respondem erro.
Para ver o estado real, vá ao SQLite do container:

```bash
docker exec stremio-adom node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/cache.db',{readOnly:true});console.log('alive:',db.prepare(\"SELECT COUNT(*) c FROM cache WHERE key LIKE 'mag:v1:alive:%'\").get().c,'| bad:',db.prepare(\"SELECT COUNT(*) c FROM cache WHERE key LIKE 'mag:v1:bad:%'\").get().c)"
```

Tabela `cache(key, value, expires_at)`. Prefixos:
`mag:v1:<alive|bad>:<serviço>:<accountScope>:<hash>`, `streams:v5:…`,
`davail:…`, `autofetch:v3:…`. Para forçar uma busca nova sem esperar o TTL,
apague a linha `streams:%<imdbId>%` e reinicie o container — o addon recarrega o
L1 a partir do disco na subida.

Kill-switches, todos no `.env`: `MAGNET_DB=false` desliga o banco inteiro;
`MAGNET_ALIVE_TTL=0` e `MAGNET_BAD_TTL=0` desligam cada lado
([config.ts:408](src/config.ts:408)).
