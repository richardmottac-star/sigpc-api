// CAMINHO: sigpc-api/lib/pc-nova.js
//
// CADASTRAR PC (frente C). Especificação do Richard, 18/08/2026.
//
// O analista cria uma PC nova numa TR dele — parcial ou final. **Grava direto, sem
// aprovação.** O técnico do sistema cadastra em qualquer TR.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA DE NEGÓCIO FIXA (Richard, 18/08/2026)
//
//   Toda TR tem parciais + UMA PC final. A final é o relatório de conclusão: **não tem valor
//   financeiro**, **conta produtividade**, e vence 90 dias após a extinção do convênio.
//
//   Marcadores da final:  tipo='final' · parcela_seq=999 · codigo_pc com sufixo -PFINAL
//                         · codigo_nl NULA
//
// ⚠️ NA ABA FINAL O ANALISTA NÃO DIGITA NADA DISSO. O sufixo, o 999, o valor zero e a NL nula
// são postos aqui, no servidor. Pedir na tela seria oferecer quatro campos em que a única
// resposta certa já é conhecida — e três deles são a chave que a produtividade lê.
//
// ⚠️ O `valor = 0` DA FINAL CONTRARIA AS 1.031 FINAIS QUE JÁ EXISTEM, e isso está medido: em
// 18/08/2026, **nenhuma** das 1.031 tem `valor = 0` — todas carregam o valor do convênio.
// A regra nova vale para o que for criado daqui pra frente; o histórico **não é tocado**.
// Está escrito aqui porque quem ler `SUM(valor)` por TR vai encontrar os dois padrões
// convivendo, e isso não é defeito: é a data de corte.
//
// ⚠️ `parcial_num` DA FINAL É 'FINAL', e não o número. O banco tem QUATRO grafias herdadas
// ('FINAL' 986, 'Final' 39, 'final' 1, '1' em 5). Escrevemos sempre a maiúscula, que é a
// maioria — e nenhuma rota nova usa `parcial_num` como chave, justamente por causa dessas 5.

// O sufixo é parte da identidade da final: `codigo_pc LIKE '%-PFINAL'` é como as telas a
// reconhecem quando não têm a coluna `tipo` à mão.
const SUFIXO_FINAL = '-PFINAL';
const PARCELA_SEQ_FINAL = 999;
const PARCIAL_NUM_FINAL = 'FINAL';

// 90 dias após a extinção do convênio — a regra de vencimento da final. Fica aqui, e não
// espalhada na tela, porque é regra de negócio e vai mudar por decisão, não por layout.
const PRAZO_FINAL_DIAS = 90;

const TIPOS = ['parcial', 'final'];

/**
 * O `codigo_pc` da final é DERIVADO da TR, não digitado.
 *
 * ⚠️ E é por isso que a final não pede código do SIGEF: ela não tem um. As 1.031 finais do
 * banco seguem `{TR}-PFINAL` sem exceção (conferido em 18/08), e é esse padrão que o
 * `planEhFinal` da tela reconhece.
 */
function codigoFinal(tr) {
  const t = (tr ?? '').toString().trim().toUpperCase();
  return t ? `${t}${SUFIXO_FINAL}` : null;
}

/**
 * Monta a linha a inserir, já com os marcadores da final aplicados.
 *
 * Recebe o corpo do pedido e devolve `{ erro }` ou `{ linha }`. Quem grava é a rota — esta
 * função não fala com o banco, e é isso que a torna testável com dublê.
 */
function montar(b, tr) {
  if (!b) return { erro: 'Nada informado.' };
  const tipo = (b.tipo || 'parcial').toString().trim().toLowerCase();
  if (!TIPOS.includes(tipo)) return { erro: `tipo deve ser um de: ${TIPOS.join(', ')}.` };

  const trLimpa = (tr ?? '').toString().trim().toUpperCase();
  if (!trLimpa) return { erro: 'tr é obrigatório.' };

  if (tipo === 'final') {
    // ⚠️ TUDO PREENCHIDO PELO SERVIDOR. O que vier da tela nestes quatro campos é IGNORADO,
    // não recusado: a tela nem os mostra na aba Final, e recusar transformaria um campo
    // invisível em erro que ninguém sabe corrigir.
    return {
      linha: {
        codigo_pc: codigoFinal(trLimpa),
        codigo_nl: null,
        tipo: 'final',
        tr: trLimpa,
        parcela_seq: PARCELA_SEQ_FINAL,
        parcial_num: PARCIAL_NUM_FINAL,
        valor: 0,
        processo_pc: (b.processo_pc ?? '').toString().trim() || null,
        processo_mae: (b.processo_mae ?? '').toString().trim() || null,
        entidade: (b.entidade ?? '').toString().trim() || null,
        cnpj_cpf: (b.cnpj_cpf ?? '').toString().trim() || null,
        dt_limite_pc: b.dt_limite_pc || null,
        prazo_analise_dias: b.prazo_analise_dias == null ? null : parseInt(b.prazo_analise_dias),
      },
    };
  }

  // ── parcial ────────────────────────────────────────────────────────────────
  const codigo = (b.codigo_pc ?? '').toString().trim().toUpperCase();
  if (!codigo) return { erro: 'Digite o código da PC (o do SIGEF).' };
  // ⚠️ O sufixo da final é reservado. Sem esta trava, uma "parcial" chamada
  // `2021TR000123-PFINAL` passaria a ser lida como final por toda tela que usa
  // `codigo_pc LIKE '%-PFINAL'`, e a `tipo` diria outra coisa.
  if (codigo.endsWith(SUFIXO_FINAL))
    return { erro: `"${SUFIXO_FINAL}" é o sufixo da PC final. Use a aba Final para cadastrá-la.` };

  const parcialNum = (b.parcial_num ?? '').toString().trim();
  if (!parcialNum) return { erro: 'Informe o nº da parcial.' };
  if (parcialNum.toUpperCase() === PARCIAL_NUM_FINAL)
    return { erro: 'Uma parcial não pode ter o nº "FINAL". Use a aba Final.' };

  const valorNum = b.valor == null || b.valor === '' ? 0 : Number(b.valor);
  if (!Number.isFinite(valorNum) || valorNum < 0)
    return { erro: 'Valor inválido.' };

  return {
    linha: {
      codigo_pc: codigo,
      codigo_nl: (b.codigo_nl ?? '').toString().trim().toUpperCase() || null,
      tipo: 'parcial',
      tr: trLimpa,
      // `parcela_seq` NÃO é a ordem do SIGEF (armadilha 16-C): na 2020TR000704 a parcial 2
      // tem seq 10. Fica nulo quando não informado, em vez de inventar uma ordem.
      parcela_seq: b.parcela_seq == null || b.parcela_seq === '' ? null : parseInt(b.parcela_seq),
      parcial_num: parcialNum,
      valor: valorNum,
      processo_pc: (b.processo_pc ?? '').toString().trim() || null,
      processo_mae: (b.processo_mae ?? '').toString().trim() || null,
      entidade: (b.entidade ?? '').toString().trim() || null,
      cnpj_cpf: (b.cnpj_cpf ?? '').toString().trim() || null,
      dt_limite_pc: b.dt_limite_pc || null,
      prazo_analise_dias: b.prazo_analise_dias == null || b.prazo_analise_dias === ''
        ? null : parseInt(b.prazo_analise_dias),
    },
  };
}

/**
 * O analista pode cadastrar nesta TR?
 *
 * Regra do Richard: "o analista cria PC nova numa TR DELE". O técnico cadastra em qualquer.
 *
 * ⚠️ "TR DELE" É MEDIDO PELO ACERVO, não por uma coluna de dono da TR — ela não existe. A TR
 * é dele se ALGUMA PC dela está com o `analista_id` dele. É a mesma definição que o
 * `lib/assumir.js` usa, e ela tem de continuar sendo uma só.
 *
 * ⚠️ TR SEM NENHUMA PC recusa em vez de aceitar. Aceitar deixaria qualquer um criar uma TR
 * nova digitando um código no campo — e TR nasce no SIGEF, não aqui.
 */
function podeCadastrar(perfilEfetivo, quemId, pcsDaTr) {
  if (perfilEfetivo === 'superadmin') return { pode: true, motivo: null };
  if (!pcsDaTr || !pcsDaTr.length)
    return { pode: false, motivo: 'Esta TR não existe no sistema. A TR nasce no SIGEF; aqui só se acrescenta PC a uma que já existe.' };
  const minha = pcsDaTr.some(p => String(p.analista_id ?? '') === String(quemId));
  if (!minha)
    return { pode: false, motivo: 'Esta TR não está com você. Só o dono da TR cadastra PC nela.' };
  return { pode: true, motivo: null };
}

// ⚠️ `codigo_pc` É `UNIQUE` NA TABELA, e a rota confere ANTES para dar mensagem legível — mas
// a trava de verdade é a do banco. Duas abas abertas no mesmo código chegariam juntas na
// conferência e as duas passariam; quem recusa a segunda é o índice.
const SQL_JA_EXISTE = `SELECT codigo_pc, tr, tipo FROM prestacoes_contas WHERE codigo_pc = $1`;

// As PCs da TR, para decidir o dono e herdar entidade/processo quando a tela não mandar.
const SQL_PCS_DA_TR = `
  SELECT codigo_pc, analista_id, analista_nome, grupo, entidade, cnpj_cpf, processo_mae, setorial_id
    FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2
   ORDER BY codigo_pc`;

// ⚠️ A PC NOVA NASCE COM DONO E GRUPO HERDADOS DA TR, não nulos. PC sem `analista_id` cai na
// definição de "livre" (`assumir.PC_LIVRE_SQL`) e apareceria no Estoque como disponível — a
// TR voltaria a ser oferecida a quem chegasse primeiro. Foi assim que 87 PCs se perderam no
// vão entre duas definições de "livre", em 16/08.
const SQL_INSERIR = `
  INSERT INTO prestacoes_contas
    (codigo_pc, codigo_nl, tipo, tr, parcela_seq, parcial_num, valor,
     processo_pc, processo_mae, entidade, cnpj_cpf, dt_limite_pc, prazo_analise_dias,
     setorial_id, analista_id, analista_nome, grupo, status, baixada, registrado_por,
     criado_em, atualizado_em)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'livre',false,$18,NOW(),NOW())
  RETURNING *`;

module.exports = {
  SUFIXO_FINAL, PARCELA_SEQ_FINAL, PARCIAL_NUM_FINAL, PRAZO_FINAL_DIAS, TIPOS,
  codigoFinal, montar, podeCadastrar,
  SQL_JA_EXISTE, SQL_PCS_DA_TR, SQL_INSERIR,
};
