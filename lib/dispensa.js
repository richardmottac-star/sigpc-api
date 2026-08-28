// CAMINHO: sigpc-api/lib/dispensa.js
//
// A DISPENSA DE ANALISTAS — quem saiu, quem substituiu, e o que isso faz com a meta.
// Especificação do Richard, 28/08/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, EM UMA FRASE
//
// **Quem tem `data_saida` preenchida está dispensado.** O dispensado NÃO recebe meta e sai
// das somas de meta; os números que ele já tem PERMANECEM atribuídos a ele, sem recálculo.
//
// ⚠️ "CONGELA" NÃO É "RECALCULA POR DATA" — decisão do Richard, 28/08, e ela foi tomada
// contra a alternativa, com número na mesa. Cortar a contagem em `data_saida` zeraria três
// pessoas (Elquier, Samoel, Higor), e não porque não trabalharam: as baixas delas têm
// `data_baixa = 30/06/2026`, que é a data do RECARREGAMENTO da migração, não a do parecer.
// Zerar alguém por causa de um carimbo de carga seria erro grave. Congelar é parar de
// crescer e deixar a meta de valer — nada mais.
//
// ⚠️ E A CRONOLOGIA REAL CONFIRMOU QUE O CORTE POR DATA ERRARIA DOS DOIS LADOS. Medido em
// 28/08 contra `data_baixa_sigef`, que é a data de verdade: o Higor tem 6 PCs contando e as
// 6 são ANTERIORES à dispensa dele — trabalho legítimo que o corte apagaria. Já o Samoel tem
// 10, e as 10 têm registro no SIGEF POSTERIOR à dispensa (21/05 a 09/06, dispensa em 14/05).
// São perguntas diferentes, e nenhuma delas se responde com `data_baixa`.
//
// ⚠️ `ativo` CONTINUA `true`. O dispensado precisa terminar o que ficou em curso — decisão
// do Richard. Nada nesta lib fecha porta: ela decide o que a PRODUTIVIDADE conta e o que a
// TELA mostra, e mais nada.
//
// ⚠️ E `metas_analistas` NÃO É ALTERADA. A meta existiu no período em que a pessoa estava
// designada; marcar `vigente = false` reescreveria o passado. Ela é IGNORADA no cálculo, o
// que é diferente de ser apagada — e a diferença aparece no dia em que alguém abrir um
// relatório do período anterior.
// ─────────────────────────────────────────────────────────────────────────────

/** Este usuário está dispensado? A resposta é uma coluna, e só uma. */
function ehDispensado(u) {
  return !!(u && u.data_saida);
}

/**
 * Este usuário entra nas contas de meta?
 *
 * ⚠️ É o predicado que a soma de meta usa — 46 metas viram 39, e a soma 5.068 vira 4.425.
 * O dispensado continua aparecendo nas listas (com a tag), continua com os números dele e
 * continua com a linha em `metas_analistas`. O que ele não faz é entrar na conta.
 */
function contaMeta(u) {
  return !ehDispensado(u);
}

/** A data da saída como texto ISO, aceitando `Date` e string (armadilha 25). */
function paraIso(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

// ⚠️ ORDEM POR `data_publicacao`, e o desempate por `id`: a 203/2026 dispensou DUAS pessoas
// no mesmo dia, e sem desempate a listagem trocaria de ordem entre dois pedidos iguais.
const SQL_SUBSTITUICOES = `
  SELECT id, dispensado_id, dispensado_nome, substituto_id, substituto_nome,
         portaria, data_publicacao::text AS data_publicacao, grupo, observacao,
         criado_em
    FROM substituicao
   ORDER BY data_publicacao DESC, id DESC`;

/**
 * Monta os dois índices que a tela usa: por dispensado e por substituto.
 *
 * ⚠️ POR `id`, E SÓ POR `id`. Quatro das nove linhas têm id nulo de propósito (Luis Filipe e
 * Caroline de um lado, Fabiana e Carla do outro) — essas ficam de fora dos índices, e é o
 * certo: elas não têm cadastro para receber tag nenhuma. Casar por NOME aqui seria a
 * armadilha 1 de volta, e com dados de pessoal.
 *
 * ⚠️ E O ÍNDICE DO SUBSTITUTO É UMA LISTA, não um objeto. Uma pessoa pode substituir mais de
 * uma: o Willian (id 50) entrou no lugar da Caroline e saiu substituído pela Fabiana — ele é
 * as duas coisas. Guardar só a última apagaria metade da história.
 */
function indexar(linhas) {
  const porDispensado = new Map();
  const porSubstituto = new Map();
  for (const l of (linhas || [])) {
    if (l.dispensado_id != null) {
      if (!porDispensado.has(l.dispensado_id)) porDispensado.set(l.dispensado_id, []);
      porDispensado.get(l.dispensado_id).push(l);
    }
    if (l.substituto_id != null) {
      if (!porSubstituto.has(l.substituto_id)) porSubstituto.set(l.substituto_id, []);
      porSubstituto.get(l.substituto_id).push(l);
    }
  }
  return { porDispensado, porSubstituto };
}

module.exports = {
  ehDispensado, contaMeta, paraIso, indexar,
  SQL_SUBSTITUICOES,
};
