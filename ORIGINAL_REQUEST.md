# Original User Request

## 2026-08-15T03:14:16Z

Executar análise arquitetural aprofundada, auditoria de código e implementação de melhorias de resiliência e performance no addon Stremio Adom Power-Movie.

Working directory: E:/stremio adom
Integrity mode: development

## Requirements

### R1. Resiliência e Confiabilidade dos Resolvers e Scrapers BR
- Auditar e fortalecer os microserviços de resolução (`bludv-resolver`, `comandotorrents-resolver`, `nerdfilmes-resolver`, `torrentdosfilmes-resolver`) e scrapers nativos contra falhas de rede, mudanças de URLs/layouts WordPress e protetores de link.
- Garantir que qualquer falha, lentidão ou bloqueio em uma fonte específica nunca derrube a busca global nem atrase os resultados de outras fontes dentro do orçamento de tempo (`REPLY_DEADLINE_MS`).
- Manter strict title matching (`matchesBrTitle`) e deduplicação sem falsos positivos.

### R2. Otimização de Performance, Latência e Gerenciamento de Cache
- Otimizar a camada de cache SQLite / memória (`src/utils/cache.js`) e a orquestração do passe tardio (`doSearch` / `collectRaw`).
- Reduzir contenção e overhead assíncrono no fan-out de consultas a indexadores e chamadas de checagem de cache Debrid (`src/debrid/`).
- Assegurar conformidade absoluta com o orçamento de tempo do Stremio (resposta rápida no primeiro passe e enriquecimento confiável no passe tardio).

### R3. Preservação Arquitetural e Invariantes do Sistema
- Preservar todas as regras de `AGENTS.md`: CommonJS sem build, dependências estritamente mínimas (`express`, `stremio-addon-sdk`, `dotenv`), ambiente Docker unificado em `127.0.0.1`, isolamento dos resolvers locais em portas internas.
- Manter o contrato de configuração por URL stateless via `opts()` (`src/runtime.js`).

## Acceptance Criteria

### Testes e Integridade
- [x] 100% dos testes da suíte nativa (`npm test`) continuam passando sem regressões.
- [x] Checagem de sintaxe limpa (`node --check src/providers/index.js` e em todos os arquivos modificados).
- [x] Nenhuma nova dependência npm desnecessária adicionada ao `package.json`.

### Resiliência & Performance
- [x] Todos os resolvers e provedores tratam erros com `try/catch` defensivos e logs prefixados (`[jackett]`, `[bludv]`, `[debrid]`, etc.).
- [x] Consultas e resoluções respeitam estritamente os timeouts e sinais de cancelamento configurados.
- [x] A persistência SQLite lida de forma graciosa com concorrência ou indisponibilidade do módulo nativo sem quebrar o processo.
