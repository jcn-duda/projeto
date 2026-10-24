---
description: Convoca UM especialista do time do Adom para uma area so — o caminho certo quando o pedido mira um subsistema. Diga o nome (Cronos, Corvo, Sindico, Fiandeiro, Chupim, Cartografo, Chaveiro, Maestro, Arquivista, Sentinela, Juiz, Vigia) ou descreva o sintoma e deixe o roteamento escolher.
---

# A Convocacao Individual

Doze pareceres sobre uma linha de codigo e desperdicio caro. Quando o pedido
mira **uma** area, chame **um** especialista.

Este e o caminho que `/time` manda tomar quando o escopo e estreito.

## Escolhendo quem chamar

**Se o nome veio no pedido**, e esse. Se veio o sintoma, roteie:

| o sintoma | quem atende |
|---|---|
| "a resposta demorou", "reabra em instantes", timeout, deadline | **Cronos** |
| "o dublado sumiu", "entrou lixo na lista", titulo/ano/audio errado | **O Corvo** |
| "lista velha presa", cache frio, cota, TTL, SWR | **O Sindico** |
| "sumiu o ⚡ de todos", auth/quota do debrid, limpeza da conta | **O Fiandeiro** |
| "o download nao esquenta", fila girando, stall/dead, season fill | **Chupim** |
| `alive`/`bad`/`lie`, fronteira bad × dead, filtro pre-checagem | **O Cartografo** |
| preferencia do usuario ignorada, `dk`, `opts()`, opcao nova na URL | **O Chaveiro** |
| indexer BR atrasando os globais, breaker abrindo demais, pt-sweep | **O Maestro** |
| busca respondendo sem Jackett, colhedor, cobertura do indice | **O Arquivista** |
| rota, credencial, SSRF, HMAC, ordem de middleware | **Sentinela** |
| teste novo, lista do `npm test`, falso-verde, catraca | **O Juiz** |
| producao divergindo do HEAD, container, healthcheck, deploy | **O Vigia** |

**Na duvida entre dois, chame os dois.** Dois pareceres independentes que
concordam valem mais que um sozinho — e se discordarem, a discordancia e o
achado.

**Se o pedido cruza tres areas ou mais, use `/time`.** E o sinal de que o
problema nao e de area, e de sistema.

## Montando a convocacao

Leia o verbete do agente em `team/adom-team.json` — a fonte de verdade — e use
os **sete** campos:

```
VOCE E: {name}, {role}.
COMO VOCE PENSA: {peculiaridade}
SUA AREA: {focus}
ARQUIVOS-ANCORA: {files}
GUARDRAILS: {guards}

O PEDIDO: <o que o usuario perguntou, literal>
```

A `peculiaridade` e o que separa um especialista de um leitor generico com
cracha. Sem ela, o Cronos para de medir em milissegundos e o Corvo para de
desconfiar de post de WordPress — voce recebe um parecer correto e sem gume.

## As regras da casa

As mesmas de `/time`, e elas nao afrouxam por ser um agente so:

- **Leitura estatica**: nao edita arquivo, nao sobe servidor, nao roda
  `npm start`/`dev`.
- **Nunca importe `src/addon.ts`** — abre a porta e pendura o agente.
- **`arquivo:linha` ou nao aconteceu.** Sem evidencia material, o veredito
  honesto e "nao reproduzido" ou "inconclusivo" — nunca um palpite com cara
  de laudo.
- Divergencia doc × codigo e achado legitimo, e se REPORTA, nao se conserta.
- Se o proprio briefing estiver desatualizado (ja apontou `streams:v6` com o
  codigo em `v10`), **isso e achado** — reporte e siga pelo que o codigo diz.

## O que se espera de volta

Prosa, nao JSON — aqui e uma conversa, nao uma auditoria em lote:

1. **Veredito em uma linha** — confirmado | nao reproduzido | inconclusivo
2. **O que se ve** — `arquivo:linha` e o trecho que sustenta
3. **Por que importa** — a consequencia real, nao a teorica
4. **O que voce NAO olhou** — o limite do parecer, dito por voce e nao
   descoberto pelo usuario depois

Esse quarto item e o que distingue especialista de oraculo. Uma area so foi
auditada; dizer qual ficou de fora e parte do servico.

## Passando o bastao

Um especialista pode **convocar outro**. Deve, inclusive — a fresta estreita e
a forca dele, e fingir enxergar fora dela e como o parecer apodrece.

Chame outro agente quando a trilha sair da sua area:

- o **Corvo** persegue "sumiu o dublado", prova que o `matchesBrTitle` acertou
  e ve o item morrer no corte do `cachedOnly` → dai em diante e **Fiandeiro**;
- o **Chupim** acha a fila parada e descobre que o gate da conta e quem trava
  → **Fiandeiro** de novo, ou **Sindico** se for cota de cache;
- o **Arquivista** ve o indice respondendo velho → **Sindico** (TTL/SWR);
- qualquer um que precise de **medicao ao vivo** → `jackett-validator`.

Como passar:

1. **Termine o seu trecho.** Entregue o que voce provou, com `arquivo:linha`,
   antes de delegar. Bastao nao e fuga.
2. **Nomeie quem continua e por que** — "daqui e Fiandeiro: o hash sobrevive
   ao matching e morre em `debrid-pipeline-steps.ts:124`".
3. **Passe a evidencia junto**, nao a pergunta. O proximo agente comeca de onde
   voce parou, nao do zero.
4. **Nao delegue o que voce consegue responder.** Uma cadeia de quatro agentes
   para uma pergunta de um e o mesmo desperdicio de convocar os doze.

Onde o harness deixa o agente chamar outro diretamente, chame. Onde nao deixa
(no Claude Code, um subagente `Explore` **nao** tem o tool `Agent`; um
`general-purpose` tem), a entrega nomeada com evidencia faz o mesmo trabalho —
quem toca o sino da vez le o handoff e convoca o proximo.

## Quem NAO esta nesta lista

**`jackett-validator`** nao e agente de area — ele **mede ao vivo**, com regras
proprias de porta (7010, nunca a 7000 do usuario), de conta de debrid e de
repeticao (indexer instavel se mede tres vezes). Chame-o pelo nome quando
precisar de evidencia de execucao, nao de leitura.
