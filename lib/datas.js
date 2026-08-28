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

// ═══════════════════════════════════════════════════════════════════════════
//  O CORTE DO PRAZO — a data a partir da qual `dt_limite_pc` é prazo de verdade
//
// ⚠️ NÃO BAIXE ESTA DATA achando que o corte é conservador demais.
//
// O `dt_limite_pc` do acervo antigo NÃO É PRAZO: é cálculo em lote. Decisão do Richard em
// 10/08/2026, e a distribuição não deixa dúvida — medido em 28/08, **3.253 PCs "vencem"
// exatamente em 30/01/2021**, 769 em 29/07/2024 e 519 em 30/01/2022. Prestações de processos
// diferentes não vencem no mesmo dia por coincidência: são carimbos de lote.
//
// Prazo real só passa a existir quando o analista inserir a data no sistema, a partir da
// abertura para a equipe. Baixar o corte faz o sistema cobrar prazo que ninguém definiu.
//
// ⚠️ ELA MOROU EM `job_notificacoes.js` ATÉ 28/08/2026, e o alerta da Minha Planilha não a
// usava — o sino calava sobre o acervo antigo e a tela do analista mostrava as mesmas PCs
// como passivo dele. Eram duas respostas para "isto é prazo?", e só uma estava certa.
// Está aqui, e num lugar só, para que a próxima tela que perguntar não invente a terceira.
const CORTE_PRAZO = '2026-08-01';
// ═══════════════════════════════════════════════════════════════════════════

module.exports = { HOJE_BR, FUSO, CORTE_PRAZO };
