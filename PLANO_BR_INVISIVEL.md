# Plano: o dublado invisível

Escrito em 2026-09-08, a partir do caso Event Horizon (`tt0119081`) medido na
instância local e conferido na VPS. O objetivo não é consertar um filme: é
fechar o ciclo que deixa uma release BR dublada existir em três lugares do
sistema e mesmo assim não chegar à lista do usuário — e tornar o próximo caso
diagnosticável em minutos, não em horas.

---

## 1. O caso, com evidência datada

| fato | onde foi medido |
|---|---|
| índice de `tt0119081` tem **60 releases**, e exatamente **uma** é BR dublada: `Event.Horizon.1997.1080p.BDRip.DUBLADO.PT.BR.gmenezes.mkv`, `br=1 dub=1 lied=0 seed=0` | `cache.db` do container, chave `idx:v10:tt0119081`, gravada 23:36 |
| duas OUTRAS dubladas (`O Enigma do Horizonte (1997) BRrip Blu-Ray 1080p/720p Dublado`) estão `Cached` + `Download Ready` na conta TorBox, baixadas pelo Chupim ~23:34 | painel do TorBox |
| nenhuma das três apareceu na lista; as 9 opções entregues eram todas gringas (Kickass, TPB, Therarbg) | captura do usuário, 00:34 |
| o waiver do piso de seeders **está ativo e disparou**: `search.brDubbed.seedFloorWaived = 4` (local) e `= 4` (VPS) | `/metrics.json` |
| o binário em execução tem o código novo (`br-gap.js`, `_seedFloorWaived`, `UNRELIABLE_CATEGORY_INDEXERS`) nos **dois** ambientes | `docker exec` no `dist/` |
| o nome pt-BR estava disponível desde 23:22, antes da busca: `tmdb:tt0119081 = {pt: "O Enigma do Horizonte"}` | `cache.db`, TTL 7 dias |
| o filtro de relevância **aprova** os três títulos quando o contexto tem esse nome (`inv=1` nos três) | reprodução isolada de `filterInventoryRelevant` |
| `search.account.items` **ausente**, com `cache.hit.dinv = 4`: o inventário foi lido 4× e não contribuiu com um único item | `/metrics.json` |

Conclusão que se sustenta sozinha: **não foi o piso de seeders, não foi o
build, não foi o matching de título e não foi o filtro de relevância.** As
quatro suspeitas naturais foram testadas e caíram, uma a uma.

---

## 2. Causa raiz estrutural

> **O Chupim escreve no debrid, mas não escreve na memória da busca.**

Fato do código, não hipótese: os únicos dois pontos que gravam no índice de
releases são `src/providers/harvest-worker.ts` (colhedor) e
`src/providers/stream-builder-pipeline.ts` (busca). O autofetch não aparece na
lista — `grep -rln "releaseIndex.record" src/` devolve exatamente esses dois.

O efeito é um ciclo que não fecha:

1. a busca não acha BR dublada tocável;
2. o Chupim baixa uma para aquecer o cache — e acerta, ela fica `Ready`;
3. a release baixada não entra no índice da obra;
4. a busca seguinte continua sem conhecê-la;
5. volta ao passo 1.

Isso explica também o desperdício visível na conta: `O.Protetor.2.2018`,
`O.Protetor.2015`, `O.Protetor.2014` e duplicatas — o Chupim re-decide baixar
porque a busca nunca registra que ele já resolveu aquilo.

O único caminho que poderia salvar o passo 4 é "a conta como fonte de busca"
(`src/providers/account.ts`), e no caso medido ele rendeu **zero** — o
inventário foi lido e o casamento por obra descartou tudo. Por que descartou é
a única pergunta que ficou aberta, e a Fase 1 existe para respondê-la sem
outra caçada.

---

## 3. Causas de segunda ordem (o que fez isto custar horas)

**D1 — falha silenciosa.** `search.account.items` só era contado quando
sobrava alguém. A ausência do contador era indistinguível de "a conta nem foi
lida". *(Já corrigido nesta sessão: `search.account.read` + `search.account.allFiltered`.)*

**D2 — o trace do operador é inacessível.** `/stream-trace.json?type=movie&id=…`
responde `no-material` porque o trace fica preso ao escopo de cache daquela
config de usuário. Quem diagnostica não tem a URL selada do usuário, e o
diagnóstico morre aí. Foi o que me obrigou a ler o `cache.db` por dentro.

**D3 — verde que depende de quem roda.** Seis testes passavam só com o `.env`
do operador (chave RD, chave TMDB, oráculo Torrentio ligado) e caíam no CI.
Corrigido hoje, mas a categoria continua aberta: nada impede o próximo.

---

## 4. Fases

### F1 — Tornar o buraco visível (baixo risco, faz primeiro)

| ação | critério de aceitação |
|---|---|
| ~~métrica de inventário filtrado a zero~~ **feito** | `search.account.read` sem `search.account.items` aparece no `/metrics.json` quando a conta é lida e nada casa |
| trace do operador acha a busca em **qualquer** escopo quando chamado sem config (é rota atrás de token) | `/stream-trace.json?type=movie&id=tt0119081` devolve os estágios da última busca daquela obra, sem precisar da URL do usuário |
| registrar no trace o estágio `account` (quantos itens vieram, quantos casaram, o motivo do descarte de cada um) | o trace mostra por que `O Enigma do Horizonte` não entrou |

Sem F1, toda fase seguinte é chute. Com F1, o caso Event Horizon se responde
em uma requisição.

### F2 — Fechar o ciclo do Chupim

O autofetch passa a registrar no índice da obra a release que enfileirou, com
a mesma evidência que a busca registraria (`isBr`, `dubbed`, `lied`, seeders,
indexer). O item já foi coletado e classificado no momento do enqueue — não há
consulta nova nem custo de rede.

Critério de aceitação: baixar uma dublada por autofetch e, **sem nova coleta**,
a busca seguinte da mesma obra oferecê-la. Teste de regressão: enqueue de
autofetch → `releaseIndex.lookupQuiet` da obra contém o hash enfileirado.

Cuidado explícito: gravar no índice muda `idxPoolCovered`, e uma obra pode
passar a "coberta" por causa de um único download. O registro deve entrar
marcado, e a cobertura de pool continuar exigindo o que ela já exige hoje —
isso precisa de teste próprio, senão a correção vira a próxima regressão.

### F3 — Parar de baixar o que já foi baixado

Com F2 no lugar, o Chupim passa a enxergar o próprio histórico. Fecha o
desperdício visível na conta (mesma obra baixada 3×) e devolve cota de debrid.

Critério de aceitação: `autofetch.skip.already-cached` cresce e o número de
downloads por obra na conta para de crescer entre buscas repetidas.

### F4 — Guarda-corpos contra a volta

1. **Teste de ambiente vazio no CI.** Rodar a suíte com um `.env` vazio
   explícito (`DOTENV_CONFIG_PATH` para um arquivo vazio), não com a ausência
   acidental do arquivo. Fecha a categoria D3 de vez.
2. **Invariante do ciclo.** Um e2e que cubra os cinco passos: busca sem BR →
   autofetch baixa → índice registra → busca seguinte oferece. É o teste que
   teria pego este caso antes de chegar ao usuário.
3. **Nenhum caminho de descarte silencioso.** Todo ponto que devolve lista
   vazia num caminho BR conta uma métrica. A regra vale para revisão de código
   novo, não só para os pontos de hoje.

---

## 5. Ordem recomendada

F1 → F2 → F3, com F4.1 em paralelo (é independente e barato). F2 sem F1 é
trabalhar às cegas; F3 sem F2 não tem como funcionar.

---

## 6. O que este plano NÃO propõe

- Mexer no waiver do piso de seeders: ele está correto e comprovadamente ativo.
- Mexer no matching de título: foi testado e aprova os três títulos.
- Rebuild ou deploy: os dois ambientes já rodam o código novo.

Três becos sem saída que custaram tempo hoje e que ficam registrados aqui
justamente para ninguém os repetir.

---

## 7. Segunda medição: 2026-09-08, noite (Premiumize)

O mesmo `tt0119081`, agora na instalação premiumize + `cachedOnly` do operador,
em produção. O ciclo do lado da BUSCA está fechado — e a falha se mudou de
lugar.

| fato | onde foi medido |
|---|---|
| a lista traz 9 gringas mais a linha `Fontes BR dubladas existem, mas ainda fora do cache` | `/stream` de produção via loopback |
| a conta Premiumize acumula dezenas de transferências `[WWW.BLUDV.TV] ... [DUBLADO]` paradas em `0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes` | painel do Premiumize, captura do usuário |
| `The Locals` (`tt0387357`), que voltava lista VAZIA, agora responde `⏳ Baixando no debrid` e o Chupim enfileira dois candidatos SD/DVD5 | log do container, `search.qualityFilter.relaxed = 2` |

Três coisas distintas, na ordem em que mordem:

1. **O último recurso funciona.** Título obscuro onde o filtro de qualidade e o
   piso de seeders fechavam juntos volta a produzir candidato — quality filter
   reabre SD/480p/sem-resolução quando o conjunto permitido fica vazio
   (`search.qualityFilter.relaxed`), e o pool seeds relaxa para 1 seeder
   (`autofetch.top-seeded-relaxed`). O gatilho do primeiro é *vazio*, nunca
   *fraco*: `_seeders` é sintético em agregador BR (o BluDV grava `1` fixo), e
   qualquer piso de saúde afrouxaria o filtro do usuário em busca BR normal.
2. **A varredura não enxergava a fila.** Transferência de nome humano não
   casa com a cascata de hash do Premiumize, e o `sweepDead` a ignorava para
   sempre. Corrigido com a ponte `id -> hash` dos markers — ver `DEBRID.md`,
   seção Premiumize.
3. **E ninguém chama a varredura para essa conta.** `sweepDeadEnv` resolve o
   adapter por `config.debrid.service` (`alldebrid` no `.env` da VPS); a
   instalação usa premiumize com chave própria. Nenhuma rotina periódica
   alcança essa conta — só o botão do painel. **Em aberto**, junto com a
   transferência travada no meio (`progress != 0` a isenta da varredura).

A lição de método é a mesma da seção 3: a linha de aviso da lista já dizia qual
dos dois mundos falhou (`⏳ Baixando` = enfileirou; `fora do cache` = achou e
não ficou pronto). Ler essa linha primeiro teria poupado a metade da caçada.
