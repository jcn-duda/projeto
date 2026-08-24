# TEAM — Adom Power-Movie

Time **default** de 12 subagentes para auditoria e trabalho neste repositório.
Fonte de verdade (máquina): `team/adom-team.json` — é ele que eu releio para
gerar o orquestrador (`workflow`) quando você pede o time. Este arquivo é a
leitura humana (roster + papéis + peculiaridades).

## Como está "default"

- O manifesto `team/adom-team.json` (rastreável, não ignorado) define os 12.
- Ao pedir "roda o time / auditoria", o orquestrador é **regenerado a partir dele**
  (os agentes são efêmeros por design — o `workflow` os cria, roda e descarta;
  o que persiste é o **manifesto**, não as execuções).
- Nomes virarão o `label` de cada agente no run (ex.: *"risco de SSRF — Sentinela"*).

## Roster (nome · papel · peculiaridade)

| # | Nome | Papel | Peculiaridade |
|---|------|-------|---------------|
| 1 | Cronos | Cronógrafo do Orçamento | Tempo é sagrado: cada rede cabe na cadeia `REPLY_DEADLINE→reserve→grace→floor`. |
| 2 | O Corvo | Caçador de Dublado BR | Combate as mentiras dos posts WordPress BR (acento→0, ano do post, homônimo). |
| 3 | O Síndico | Guardião do Cache | Cotas/namespace, L1/L2, SWR — sem despejo global antes da repartição. |
| 4 | O Fiandeiro | Fiandeiro do Debrid | Mede ⚡ mas limpa a conta (`dropUncached`/`dropReady`). |
| 5 | Chupim | Donzelo do Autofetch | Autofetch × `dropUncached`; `hold` antes da checagem; fila + recheck/settle. |
| 6 | O Cartógrafo | Curador do MagnetDB | `alive`/`bad`/`lie`, TTLs, desempate `instant`. |
| 7 | O Chaveiro | Guardião do Runtime/Config | Selo AES do `dk`, `opts()`, nunca ler `config` estático na busca. |
| 8 | O Maestro | Estrategista de Fonte | Isola BR/slow, rege o breaker, varredura pt-BR inline × tardia. |
| 9 | O Arquivista | Orquestrador do Índice | `idx:v5` + colhedor — responde do acervo sem virar crawler. |
| 10 | Sentinela | Auditor de Segurança | SSRF de hostname, token só no header, HMAC do `/resolve`, ordem das rotas. |
| 11 | O Juiz | Mestre do Teste | Portão do `npm test`; tipe o que a função **produz**; caça falso-verde. |
| 12 | O Vigia | Sentinela de Implantação | Container único, loopback, healthcheck triplo, `ServerConfig.json` no volume. |

## Guardrails transversais (todos os agentes)

1. Leitura estática: **não** editar arquivo, **não** subir servidor, **não** importar `src/addon.ts`.
2. Citar "arquivo:linha" em toda afirmação; sem achado material → `risks: []`.
3. Os 6 invariantes da `AGENTS.md` valem por área (orçamento, origem BR, seeders, título PT, filtro 2 camadas, autofetch×dropUncached).
4. Drift doc×código é achado válido (marca como severidade baixa/média; não é bug vivo).

## Como invocar

"Roda a auditoria com o time default" → eu leio `team/adom-team.json` e gero o
`workflow` com os 12 em paralelo, cada um no seu recorte, e consolido riscos por área.
