// CAMINHO: sigpc-api/lib/datas.js
//
// A DATA DE HOJE, EM HORÁRIO DE BRASÍLIA.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
//
// O Postgres do Railway roda em UTC:
//     SELECT current_setting('TimeZone')  ->  Etc/UTC
//
// Então `CURRENT_DATE` vira o dia seguinte às 21h de Brasília. Todo prazo deste sistema é
// data CIVIL brasileira — o prazo que a FCEE tem para analisar, o prazo que o analista deu à
// entidade. Comparar com `CURRENT_DATE` faz o sistema achar que amanhã já chegou, três horas
// antes de chegar.
//
// O que isso causava, medido em 11/08:
//   · "Diligência vence hoje" chegando às 21h da VÉSPERA;
//   · "N dias de atraso" subindo um dia à noite e voltando de manhã;
//   · o servidor discordando da tela — o navegador do analista está em América/São_Paulo.
//
// ⚠️ NÃO TROCAR DE VOLTA POR `CURRENT_DATE` "para simplificar". São expressões diferentes em
// três horas por dia, e o erro só aparece à noite, que é quando ninguém está olhando.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trecho de SQL com a data de hoje no fuso de Brasília. Use no lugar de `CURRENT_DATE`
 * em qualquer comparação de prazo.
 *
 *   `WHERE dt_limite_pc <= ${HOJE_BR} + 7`
 *
 * `NOW()` devolve `timestamptz`; `AT TIME ZONE` converte para a hora local de Brasília; o
 * `::date` corta o horário. Não depende do fuso do servidor, então continua correto se o
 * Railway mudar de região.
 */
const HOJE_BR = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;

const FUSO = 'America/Sao_Paulo';

module.exports = { HOJE_BR, FUSO };
