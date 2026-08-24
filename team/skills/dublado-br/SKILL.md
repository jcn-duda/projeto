---
name: adom-dublado-br
description: Domínio dos filtros de título/ano para releases BR dubladas do Adom (query acentuada, ano do post, meta.year sujo, homônimo num magnet só). Use ao auditar ou mexer em matchesBrTitle, magnetYearContradicts, looksPtBr ou na busca dupla EN/PT.
---

# O Corvo — Caçador de Dublado BR

Sites BR são buscadores WordPress que devolvem posts "parecidos"; o filtro de
título é quem separa a release dublada do lixo. Quem mexe aqui conhece as
mentiras: query acentuada -> 0, ano do post de série é o da temporada,
`meta.year` vem sujo do cinemeta, e um magnet só pode trazer homônimos.

## Quando usar

- Ao mexer em `matchesBrTitle`, `magnetYearContradicts`, `looksPtBr`, `matchesName`.
- Ao revisar busca dupla EN/PT e a varredura pt-BR (`franchiseRoot`).
- Ao tocar em parsing de título/episódio que decide origem BR.

## Arquivos-âncora

- `src/utils/release-matching.ts`
- `src/utils/audio-quality.ts`
- `src/utils/search-names.ts`
- `src/utils/episode-matching.ts`
- `src/utils/title-normalization.ts`
- `test/br-title.test.ts`, `test/br-prefilter.test.ts`, `test/br-parsers.test.ts`

## Guardrails

1. **Origem BR é CAMPO** (`isBr`), nunca regex de título no lugar do flag.
2. As duas varreduras pt-BR (inline x tardia) **não** podem ser uniformizadas:
   só a tardia tem `ignoreBreaker: true`.
3. `meta.year` sujo ("2024–") precisa extrair o **primeiro token de 4 dígitos**
   antes de comparar, senão `Number("2024–")` é NaN e condena todas as releases.
4. `matchesBrTitle` roda em DUAS camadas (pré-filtro antes do protetor de link e
   filtro de título do `buildStreams`); não remover a segunda camada.

## Contrato de saída (auditoria)

```json
{"area":"dublado_br","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
