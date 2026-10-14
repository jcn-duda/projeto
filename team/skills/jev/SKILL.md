---
name: adom-jev
description: Avaliar e implementar melhorias semânticas com Jev no Stremio Adom. Use ao propor nova pergunta TypeSafe, alterar o runtime src/ai, seus probes, cache, métricas ou eventual influência na busca; não acione para todo ajuste determinístico.
---

# Jev no Adom

O Jev fornece julgamentos tipados; o código continua dono das regras e da
execução. O estado atual, seus portões e limites estão na seção TypeSafe do
`AGENTS.md`. Leia também `docs/TYPESAFE_SYSTEM_ONE.md` quando mexer nos probes
ou no runtime, e `docs/JEV_REFERENCIA.md` para o contrato conhecido. Confirme
API, modelo e primitivas em `https://docs.typesafe.ai/llms.txt` antes de
implementar: a documentação externa pode mudar.

## Avaliação de uma melhoria

1. Identifique a decisão concreta, o ponto no fluxo e a baseline determinística.
   Separe áudio, origem BR, relevância de título e disponibilidade de debrid:
   são eixos diferentes. Explique o efeito de cada tipo de erro no catálogo.
2. Verifique se Jev acrescenta informação que as regras e dados locais não
   fornecem. Escolha Noul para condição binária, Choice para opções fechadas
   ou Score para escala definida. Formule uma pergunta verificável e envie só
   os campos necessários, copiados por allowlist.
3. Monte corpus representativo de títulos BR, globais, contraditórios e packs,
   com rótulos humanos quando a meta for acurácia. Concordância com
   `looksPtBr` mede acordo com a regra, não verdade. Rode probe offline e,
   quando houver chave e escopo autorizado, amostra online controlada;
   registre erros, latência, custo e comportamento sem resposta.
4. Mantenha experimentos inicialmente em shadow, fora do prazo da primeira
   resposta. Compare contra a baseline e revise falsos positivos/negativos
   antes de propor qualquer decisão ativa. Um teste isolado de API não basta.

## Contratos do runtime atual

- `src/ai/index.ts` é a fachada; módulos de decisão não importam `src/ai/`.
  Preserve `test/typesafe-shadow-graph.test.ts` e o default OFF.
- Estado online de áudio usa apenas `post_title`; não envie credenciais,
  magnet, hash, config ou arquivos sem justificativa e revisão específicas.
- Mantenha fila limitada, orçamento/breaker compartilhados, timeout,
  fail-open e chave só em `Authorization`. Não bloqueie `buildStreams`.
- Pergunta ou modelo alterado exige revisar `PROMPT_VERSION`, fingerprint,
  cache `tsj:v1` e paridade com o probe. Alias móvel não libera overlay.
- O overlay atual só trata DUB genérico isolado, é cache-only e default OFF.
  Não use Jev para gravar `bad`/`lie`, alterar índice, limpar magnets ou
  acionar debrid/autofetch sem desenho e validação explícitos.

Valide mudanças de código com `npm run typecheck`, `npm run build`,
`npm run test:complete` e testes TypeSafe pertinentes do `npm test` após o
build. Use `team/skills/testes/SKILL.md` para os gates completos.
