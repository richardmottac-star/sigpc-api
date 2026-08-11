// CAMINHO: sigpc-api/lib/faixa.js
//
// FAIXA DE AVISOS — mensagens passando no rodapé.
//
// Três escopos, por mensagem:
//   'inicial'  só na tela inicial
//   'todas'    em todas as telas
//   'urgente'  em todas as telas, com destaque
//
// ⚠️ A JANELA DE EXIBIÇÃO É COMPARADA COM A DATA DE BRASÍLIA (`HOJE_BR`), nunca com
// `CURRENT_DATE`. O Postgres do Railway roda em UTC: com `CURRENT_DATE`, uma faixa marcada
// para começar amanhã apareceria hoje às 21h, e uma que termina hoje sumiria às 21h. Foi o
// defeito corrigido em 11/08 nos prazos — não repetir aqui.
//
// `inicio` e `fim` são DATE e podem ser NULL: sem data, vale enquanto estiver `ativo`.

const { HOJE_BR } = require('./datas');

const ESCOPOS = ['inicial', 'todas', 'urgente'];

/** Toda faixa cadastrada, para a tela de gestão. */
async function listar(db, grupo) {
  try {
    const cond = [];
    const val = [];
    if (grupo) { val.push(String(grupo)); cond.push(`(grupo IS NULL OR grupo = $${val.length})`); }
    const { rows } = await db.query(
      `SELECT * FROM faixa_aviso
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY ativo DESC, ordem, id DESC`, val);
    return rows;
  } catch (e) {
    // Tabela ainda não criada: a tela de gestão abre vazia em vez de dar erro.
    return [];
  }
}

/**
 * O que deve estar passando AGORA para este usuário.
 *
 * Devolve já ordenado: urgente primeiro, depois `ordem`. A tela não reordena nada — se
 * reordenasse, duas telas poderiam mostrar a mesma faixa em posições diferentes.
 */
async function ativas(db, grupo) {
  try {
    const { rows } = await db.query(
      `SELECT id, texto, escopo, ordem
         FROM faixa_aviso
        WHERE ativo = true
          AND (inicio IS NULL OR inicio <= ${HOJE_BR})
          AND (fim    IS NULL OR fim    >= ${HOJE_BR})
          AND (grupo  IS NULL OR grupo  = $1::text)
        ORDER BY (escopo = 'urgente') DESC, ordem, id`,
      [grupo ? String(grupo) : null]);
    return rows;
  } catch (e) {
    // ⚠️ Silêncio, e não erro: a faixa é adorno de rodapé. Se a tabela não existe ou o banco
    // oscila, o sistema inteiro continua funcionando sem ela.
    return [];
  }
}

/** Valida o que a tela e a rota exigem. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b || !b.texto || !String(b.texto).trim()) return 'O texto é obrigatório.';
  if (String(b.texto).trim().length > 300) return 'O texto passa de 300 caracteres.';
  if (b.escopo && !ESCOPOS.includes(b.escopo)) return `escopo deve ser um de: ${ESCOPOS.join(', ')}`;
  // A mesma conferência existe no CHECK da tabela. Aqui é para o usuário receber uma frase
  // em vez de um erro de constraint.
  if (b.inicio && b.fim && String(b.fim) < String(b.inicio))
    return 'O fim do período é anterior ao início.';
  return null;
}

module.exports = { ESCOPOS, listar, ativas, validar };
