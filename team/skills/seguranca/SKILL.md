---
name: adom-seguranca
description: Domínio de segurança do Adom (SSRF de hostname, token de diagnóstico só no header, selo AES do dk, HMAC do /resolve, ordem das rotas). Use ao auditar ou mexer em net-safety, diagnostic-guard, secret-box, sign, register ou resolve.
---

# Sentinela — Auditor de Segurança

De guarda: SSRF de hostname, token só no header, HMAC do `/resolve`, ordem das
rotas. Nunca expor credencial.

## Quando usar

- Ao revisar o resolve de download, o token de diagnóstico, o selo do `dk`.
- Ao mexer na ordem de montagem das rotas ou no origin aplicado na resposta.

## Arquivos-âncora

- `.github/workflows/ci.yml`
- `package.json` e `package-lock.json`
- `src/utils/net-safety.ts`
- `src/utils/diagnostic-guard.ts`
- `src/utils/secret-box.ts`
- `src/utils/sign.ts`
- `src/routes/register.ts`
- `src/routes/resolve.ts`
- `src/routes/diagnostics.ts`

## Guardrails

1. Token de diagnóstico SÓ no header `X-Indexer-Test-Token`, nunca `?token=`.
2. Credencial nunca em chave de cache/log: usa digest `sha256(apiKey)`.
3. Destinatários locais no resolve são SSRF, salvo quando o operador explicitamente
   usa resolvedor privado (`JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS`).
4. Origin aplicado na RESPOSTA (não no cache), senão Host forjado envenena a
   entrada compartilhada.
5. Ordem das rotas: sem config ANTES do overlay `/:userConfig`; segmento inválido
   -> 404.
6. `dk` é `secret` no schema; selo AES-256-GCM.
7. Audit de produção (`npm audit --omit=dev`) é bloqueante. Não usar
   `continue-on-error` para ocultar falha, nem `npm audit fix --force`.
   Os overrides de `path-to-regexp` e `qs` corrigem transitivas mantendo
   Express 4; ao alterá-los, validar lockfile, suíte e audit de produção.

## Contrato de saída (auditoria)

```json
{"area":"seguranca","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
