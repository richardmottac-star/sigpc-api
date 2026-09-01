// CAMINHO: sigpc-api/lib/busca-global.js
//
// BUSCA GLOBAL — localizar qualquer TR ou PC do sistema, numa tela só. SÓ SUPERADMIN.
//
// Existe porque os analistas pedem "onde está a TR tal?" e a resposta exigia abrir Estoque,
// Minha Planilha e Controle Interno separados, cada um com o seu recorte.
//
// ─────────────────────────────────────────────────────────────────────────────
// O RESULTADO É UMA TR POR CARD — NUNCA UMA LINHA SOLTA
//
// Medido em 13/08: buscar "APAE" devolve 2.953 PCs em 295 TRs de 38 analistas; "ASSOCIACAO"
// devolve 11.438 PCs em 1.188 TRs. Uma lista de PCs seria ilegível e não responderia à
// pergunta, que é sobre a TR. Então a busca escolhe TRs, e cada TR vem inteira.
//
// ⚠️ POR QUE `tr IN (subconsulta)` E NÃO A BUSCA NO WHERE — o defeito de 09/08.
//
// Com o termo no mesmo WHERE das agregações, o filtro roda ANTES do GROUP BY e as contagens
// passam a ver só as linhas que casaram: a TR 2019TR000168 tem 20 PCs e aparecia com 2 ao
// buscar "FCEE5830". E a tela deriva "concluída" de `baixadas >= total`, então uma TR de 20
// PCs com 2 baixadas era exibida como BAIXADA. A busca seleciona o CONJUNTO de TRs; as
// agregações continuam vendo todas as linhas de cada uma.
//
// ⚠️ A NL NUNCA ATRAVESSA TR NEM ANALISTA. Medido: das 9.933 NLs, ZERO aparecem em mais de
// uma TR e ZERO têm mais de um analista. 2.351 se espalham por várias parciais DA MESMA TR
// (máx. 17 — a 2022NL008336). Então buscar por NL sempre cai num card só, e o que a NL faz
// é destacar várias parciais dentro dele. Não há ambiguidade a resolver.
// ─────────────────────────────────────────────────────────────────────────────

const { condicaoBusca, condicaoTr, condicaoProcesso } = require('./busca');

// ⚠️ MESMO CORTE DO SINO (`job_notificacoes.js`). O `dt_limite_pc` histórico NÃO é prazo — é
// cálculo em lote, decisão do Richard em 10/08. A prova está na distribuição: 29/07/2024 é a
// data mais recente de TODOS os 44 analistas, e as 231 de 2027 caem todas em 30/01/2027.
// Mostrar "1.361 dias de atraso" na busca ressuscitaria justamente o número aposentado.
// Prazo só existe a partir de data inserida no sistema.
const CORTE_PRAZO = '2026-08-01';

const TERMO_MIN = 2;
const MAX_TRS = 60;     // teto por busca; o total real vai no cabeçalho

/**
 * Valida o que a tela manda. Devolve a mensagem de erro, ou null.
 *
 * ⚠️ SÃO TRÊS ENTRADAS DESDE 31/08/2026, e BASTA UMA. A barra da Busca global deixou de ser
 * um campo livre só: a TR e o processo SGPe ganharam caixa própria, como nas outras sete
 * barras do sistema. Exigir `termo` continuaria recusando com "Digite o que procura." quem
 * preencheu a TR — a caixa estaria cheia e a resposta diria que está vazia.
 *
 * ⚠️ O MÍNIMO DE 2 CARACTERES É SÓ DO `termo`, e continua sendo. Ele existe porque o campo
 * livre varre entidade, NL e PC com ILIKE: uma letra sozinha traria milhares de TRs e o teto
 * de ${MAX_TRS} esconderia o resto sem dizer. A TR e o processo são filtros de coluna e o
 * pedaço curto ali é legítimo — "2021" na caixa do ano é uma busca inteira, não um começo.
 */
function validar(b) {
  if (!b) return 'Nada informado.';
  const t  = (b.termo ?? '').toString().trim();
  const tr = (b.tr ?? '').toString().trim();
  const pr = (b.processo ?? '').toString().trim();
  if (!t && !tr && !pr) return 'Digite o que procura.';
  if (t && t.length < TERMO_MIN) return `Digite ao menos ${TERMO_MIN} caracteres.`;
  if (!b.usuario_id) return 'usuario_id é obrigatório.';
  return null;
}

/**
 * As três entradas viram UMA condição, combinadas com AND.
 *
 * ⚠️ AND, E NÃO OR — é a mesma escolha das outras barras (`ci-fila.montarFiltro`, 31/08).
 * Quem preenche a TR E o processo está estreitando, não somando: com OR, acrescentar um
 * segundo critério AUMENTARIA o resultado, que é o contrário do que uma barra de filtro
 * promete. Dentro de cada entrada continua valendo o OR — o `termo` varre vários campos, e o
 * processo olha `processo_pc` e `processo_mae`.
 *
 * ⚠️ E ISTO SÓ PODE SER USADO NA SUBCONSULTA QUE ESCOLHE AS TRs, nunca no WHERE das
 * agregações. É o defeito de 09/08 escrito no topo deste arquivo: aplicado junto do GROUP BY,
 * o filtro faria `total_pcs` contar 3 de 44 — um número menor, plausível e errado.
 *
 * Devolve null quando não há nada a filtrar. Quem chama já passou pela `validar`.
 */
function condicaoAlvo(b, valores) {
  const partes = [];
  let prox = valores.length + 1;
  const t = (b.termo ?? '').toString().trim();
  if (t) { const c = condicaoBusca(t, valores, prox); partes.push(c.condicao); prox = c.proximo; }
  const cTr = condicaoTr(b.tr, valores, prox);
  if (cTr) { partes.push(cTr.condicao); prox = cTr.proximo; }
  const cPr = condicaoProcesso(b.processo, valores, prox);
  if (cPr) { partes.push(cPr.condicao); prox = cPr.proximo; }
  return partes.length ? partes.join(' AND ') : null;
}

/**
 * A situação da TR, derivada das PCs. Uma só definição — a tela, o card e o documento
 * dependem dela, e três comparações soltas divergiriam no primeiro ajuste.
 *
 * A ordem é a de quem procura: o que está pendurado no C.I. importa mais que o resto,
 * e "concluída" só quando não sobrou nada.
 */
function situacaoTr(c) {
  if (!c.com_dono)                       return { chave: 'livre',      rotulo: 'No estoque' };
  if (c.no_ci > 0)                       return { chave: 'ci',         rotulo: 'No Controle Interno' };
  if (c.baixadas >= c.pcs)               return { chave: 'concluida',  rotulo: 'Concluída' };
  if (c.diligencia > 0)                  return { chave: 'diligencia', rotulo: 'Em diligência' };
  if (c.reanalise > 0)                   return { chave: 'reanalise',  rotulo: 'Em reanálise' };
  return { chave: 'analise', rotulo: 'Em análise' };
}

/**
 * O prazo que PODE ser mostrado. Devolve null quando a data é do acervo antigo.
 *
 * ⚠️ Não baixar o corte "porque parece conservador demais": baixá-lo faz a busca mostrar
 * atraso sobre datas que ninguém definiu.
 */
function prazoVisivel(dtLimite, hojeIso) {
  const iso = paraIso(dtLimite);
  if (!iso) return null;
  if (iso < CORTE_PRAZO) return null;
  const dias = Math.floor((Date.parse(hojeIso) - Date.parse(iso)) / 86400000);
  return { data: iso, vencido: dias > 0, dias_atraso: dias > 0 ? dias : 0 };
}

/**
 * A data em ISO (AAAA-MM-DD), venha ela como string ou como `Date`.
 *
 * ⚠️ O `pg` devolve coluna `date`/`timestamp` como OBJETO Date, não como texto. `String(d)`
 * num Date dá "Thu Mar 31 2022 ..." — e `.slice(0,10)` disso vira "Thu Mar 31", que compara
 * como texto contra "2026-08-01" e passa em qualquer teste de corte. Foi assim que a busca
 * mostrou 9.221 dias de atraso sobre um prazo que não deveria nem aparecer.
 */
function paraIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Dias corridos entre uma data e hoje. Null quando não há data. */
function diasDesde(d, hojeIso) {
  const iso = paraIso(d);
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.parse(hojeIso) - Date.parse(iso)) / 86400000));
}

/**
 * Monta os cards a partir das linhas cruas — uma linha por PC.
 *
 * `casaram` é o conjunto de `codigo_pc` que bateram com o termo: é ele que destaca as
 * parciais na tabela. Sem isso, buscar uma NL de 17 parciais mostraria 57 linhas iguais e a
 * pessoa teria de achar as 17 no olho.
 */
function montarCards(rows, casaram, hojeIso, devolvidaEm) {
  const porTr = new Map();
  for (const p of rows) {
    if (!porTr.has(p.tr)) porTr.set(p.tr, {
      tr: p.tr, entidade: null, cnpj_cpf: null, analista_nome: null, analista_id: null,
      grupo: null, processo_mae: null, pcs: 0, baixadas: 0, diligencia: 0, reanalise: 0,
      no_ci: 0, com_dono: 0, parciais: new Map(), dt_assumida: null, dt_inicio_analise: null,
      dt_limite: null, pareceres: new Set(), casou: 0,
    });
    const c = porTr.get(p.tr);
    c.entidade = c.entidade || p.entidade;
    c.cnpj_cpf = c.cnpj_cpf || p.cnpj_cpf;
    c.processo_mae = c.processo_mae || p.processo_mae;
    if (p.analista_id) { c.analista_id = p.analista_id; c.analista_nome = p.analista_nome; c.grupo = p.grupo; c.com_dono++; }
    c.pcs++;
    if (p.baixada) c.baixadas++;
    if (p.status === 'diligencia') c.diligencia++;
    if (p.status === 'reanalise') c.reanalise++;
    if (p.ci_situacao) c.no_ci++;
    if (p.parecer_tipo) c.pareceres.add(p.parecer_tipo);
    // A data que vale é a mais ANTIGA da TR: é quando o trabalho começou.
    if (p.dt_assumida && (!c.dt_assumida || p.dt_assumida < c.dt_assumida)) c.dt_assumida = p.dt_assumida;
    if (p.dt_inicio_analise && (!c.dt_inicio_analise || p.dt_inicio_analise < c.dt_inicio_analise)) c.dt_inicio_analise = p.dt_inicio_analise;
    if (p.dt_limite_pc && (!c.dt_limite || p.dt_limite_pc < c.dt_limite)) c.dt_limite = p.dt_limite_pc;

    // A parcial. A PC final não é parcial — vai num grupo próprio, marcado.
    const ehFinal = String(p.tipo || '').trim().toLowerCase() === 'final';
    const chave = ehFinal ? 'FINAL' : String(p.parcial_num ?? '—');
    if (!c.parciais.has(chave)) c.parciais.set(chave, {
      num: chave, final: ehFinal, processo_pc: p.processo_pc, pcs: [],
      situacao: null, parecer: null, ci: null, casou: false,
    });
    const pa = c.parciais.get(chave);
    pa.processo_pc = pa.processo_pc || p.processo_pc;
    pa.parecer = pa.parecer || p.parecer_tipo;
    pa.situacao = pa.situacao || p.situacao_atual;
    if (p.ci_situacao) pa.ci = { situacao: p.ci_situacao, rodada: p.ci_rodada, dt: p.dt_envio_ci,
                                encerrado_em: p.ci_encerrado_em };
    pa.pcs.push({
      codigo_pc: p.codigo_pc,      // ⚠️ COMPLETO — 12 ou 19 caracteres, nunca truncado
      codigo_nl: p.codigo_nl,      // null nas finais: 1 PC = 1 NL, exceto a final
      status: p.status, baixada: !!p.baixada, parecer_tipo: p.parecer_tipo,
      casou: casaram.has(p.codigo_pc),
      // ⚠️ VIAJAM ATÉ O DOCUMENTO. O relatório marca a PC com * (NL repetida) e † (baixa
      // anterior ao GT) e explica as duas ao pé — quem decide é a lib/sigef.js.
      nl_residual: !!p.nl_residual, sigef_pre_gt: !!p.sigef_pre_gt, tr: p.tr,
    });
    if (casaram.has(p.codigo_pc)) { pa.casou = true; c.casou++; }
  }

  return [...porTr.values()].map(c => {
    const sit = situacaoTr(c);
    const parciais = [...c.parciais.values()]
      // A final por último; as demais pelo número, numericamente.
      .sort((a, b) => (a.final ? 1 : 0) - (b.final ? 1 : 0) || (parseInt(a.num, 10) || 0) - (parseInt(b.num, 10) || 0));
    return {
      tr: c.tr, entidade: c.entidade, cnpj_cpf: c.cnpj_cpf, processo_mae: c.processo_mae,
      analista_nome: c.analista_nome, analista_id: c.analista_id, grupo: c.grupo,
      situacao: sit,
      total_parciais: parciais.filter(p => !p.final).length,
      total_pcs: c.pcs, baixadas: c.baixadas, faltam: c.pcs - c.baixadas,
      no_ci: c.no_ci,
      dt_assumida: c.dt_assumida, dias_em_analise: diasDesde(c.dt_inicio_analise, hojeIso),
      // Só quando alguém devolveu: TR que nunca teve dono não tem "desde quando".
      no_estoque_desde: c.com_dono ? null : (devolvidaEm && devolvidaEm.get(c.tr)) || null,
      dt_inicio_analise: c.dt_inicio_analise,
      prazo: prazoVisivel(c.dt_limite, hojeIso),
      pareceres: [...c.pareceres],
      // ⚠️ O FILTRO DA FINAL AQUI TAMBÉM. Sem ele o cabeçalho dizia "7 parciais encontradas" e o
      // contador logo abaixo dizia 6, na mesma TR — a PC final entrava numa conta e não na
      // outra. Os dois números descrevem a MESMA coisa e têm de ter o mesmo filtro.
      parciais_casaram: parciais.filter(p => !p.final && p.casou).length,
      parciais,
    };
  })
  // Quem casou mais aparece primeiro; depois a TR mais recente.
  .sort((a, b) => b.parciais_casaram - a.parciais_casaram || String(b.tr).localeCompare(String(a.tr)));
}

module.exports = { CORTE_PRAZO, TERMO_MIN, MAX_TRS, condicaoBusca, condicaoAlvo,
                   validar, situacaoTr, prazoVisivel, paraIso, diasDesde, montarCards };
