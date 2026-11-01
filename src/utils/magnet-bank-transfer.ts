// Contrato do arquivo de transferência do banco de magnets vivo (aba Magnets
// do painel).
//
// Para que serve: o `magnets.db` é acervo PERMANENTE — o que o site derrubado
// já não devolve só existe ali. O export é a cópia de segurança; o import a
// traz de volta. As DUAS mãos são do gateway agora: `GET /magnet-bank/export`
// streama o NDJSON (`adom-store::magnet_bank_export`) e o
// `POST /magnet-bank/import` o mescla (`adom-store::magnet_bank_import`), na
// admin 8711 com credencial destrutiva — a rota Node só gzipa/spoola e
// repassa (`src/routes/magnet-bank-transfer.ts`).
//
// Formato: NDJSON (uma linha JSON por registro), gzipado no transporte. A
// primeira linha é o cabeçalho `{"t":"meta","format":…,"v":1,…}`; depois
// vêm os registros com `t` = `m` (magnet), `s` (fonte) e `w` (obra), cada
// magnet seguido das SUAS fontes e obras.
//
// Este módulo sobreviveu ao corte da família TS `magnet-bank*` como o DONO do
// contrato do arquivo: o oráculo do import
// (`test/helpers/pipeline-oracle/magnet-bank-import.ts`) e os testes de rota
// consomem as constantes abaixo.

export const TRANSFER_FORMAT = 'adom-magnet-bank';
export const TRANSFER_VERSION = 1;
