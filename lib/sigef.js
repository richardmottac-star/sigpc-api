// CAMINHO: sigpc-api/lib/sigef.js
//
// A CONFERÊNCIA COM O SIGEF — as três situações, e a declaração do analista.
// Especificação do Richard, 27/08/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO RESOLVE
//
// O extrato do SIGEF que a CGE enviou (`Baixas FCEE.xlsx`) foi carregado em 27/08 nas colunas
// `sigef_status` e `data_baixa_sigef`: 3.466 PCs. Cruzar esse extrato com o nosso estado
// revela três desencontros, e cada um pede uma ação diferente de quem está com a PC na mão.
//
// ⚠️ A CLASSIFICAÇÃO É CALCULADA, NUNCA GRAVADA. Não há coluna `sigef_tag`, e não pode haver:
// ela mudaria sozinha a cada extração nova da CGE, e uma coluna gravada ficaria mentindo até
// alguém rodar um script para recalculá-la. O que se grava é o FATO (o extrato, e a
// declaração do analista); a tag é leitura desses fatos, feita na hora.
//
// ⚠️ E ESTA LIB É O ÚNICO LUGAR ONDE A REGRA MORA. O `server.js` cola `SQL_TAG` no SELECT e
// devolve `sigef_tag` pronto em cada linha; a tela só pinta o que recebeu. Se a tela também
// classificasse, seriam duas regras — e a segunda cópia é sempre a que fica velha (foi assim
// com o `MAPA_PLAN_EST`, em 17/08).
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ O CORTE DA EXTRAÇÃO. O extrato da CGE tem `Data Ult Mod` até 31/07/2026, então uma PC
// baixada aqui a partir de 01/08 NÃO PODIA aparecer nele — ela é posterior à foto. Classificar
// essas seria acusar de "sem registro no SIGEF" 321 parciais e 40 finais que a equipe baixou
// em agosto, e mandar o analista conferir o que está certo.
//
// ⚠️ VALE PARA AS TRÊS SITUAÇÕES, e não só para a primeira — decisão do Richard, 27/08. Sem
// ele em `VERIFICAR_FINAL` a contagem dá 324 em vez de 284.
//
// ⚠️ A COMPARAÇÃO É DIRETA CONTRA O `timestamp` NAIVE, e isso está medido: existem ZERO PCs
// com `data_baixa` na janela entre 31/07 20h e 01/08 04h, então nenhuma leitura de fuso muda
// de lado. Não é o caso da armadilha 18 — aqui não há conversão nenhuma, é uma data fixa
// histórica contra uma coluna naive. Não trocar por `HOJE_BR`: aquilo é para "hoje", e este
// corte não anda.
const CORTE_EXTRACAO = '2026-08-01';

// ─────────────────────────────────────────────────────────────────────────────
// AS TAGS
//
// ⚠️ O CÓDIGO É O CONTRATO ENTRE SERVIDOR E TELA. Cor e texto são da tela (índice único no
// `index.html`); aqui fica só o código e o que ele significa. Trocar um código quebra a tela
// em silêncio — ela cai no `else` e não pinta nada.
// ─────────────────────────────────────────────────────────────────────────────
const TAGS = {
  // Baixada aqui, e o extrato do SIGEF não conhece. A parcial pode ter tido o parecer
  // anexado ao SGPe sem ter sido registrada no SIGEF — é o erro que este cruzamento acha.
  SEM_REGISTRO_SIGEF: 'SEM_REGISTRO_SIGEF',
  // O SIGEF baixou e nós não. O conserto é aqui dentro, não lá: falta o parecer no sistema.
  ABERTA_COM_BAIXA_SIGEF: 'ABERTA_COM_BAIXA_SIGEF',
  // A final não está no extrato — mas o extrato de finais só lista as aprovadas pelo
  // Secretário, então ausência ali não prova ausência no SIGEF. Por isso "verificar", e não
  // "sem registro": é a mesma forma da armadilha 19 — um sinal só não confirma nada.
  VERIFICAR_FINAL: 'VERIFICAR_FINAL',
  // O analista já declarou. Fica assim até a CGE mandar a próxima extração.
  REGISTRO_DECLARADO: 'REGISTRO_DECLARADO',
};

// ⚠️ SÓ DUAS DAS TRÊS ACEITAM DECLARAÇÃO. A declaração diz "o parecer está registrado no
// SIGEF" — e no caso âmbar o SIGEF JÁ REGISTROU: o que falta é o parecer aqui dentro.
// Declarar ali não teria o que afirmar, e encheria a coluna de linhas sem sentido nas 401.
// É o que os próprios textos da tela dizem: o vermelho e o azul terminam em "declare abaixo";
// o âmbar termina em "confirme o parecer no sistema".
const TAGS_QUE_DECLARAM = [TAGS.SEM_REGISTRO_SIGEF, TAGS.VERIFICAR_FINAL];

// As duas respostas possíveis. O código é o que se grava; o rótulo é o que a pessoa leu ao
// clicar, e vai junto para que a trilha não dependa de a tela continuar escrevendo igual.
const RESPOSTAS = {
  ja_estava: 'Já estava registrado no SIGEF',
  registrei_agora: 'Não estava; registrei agora',
};

// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, EM SQL
// ─────────────────────────────────────────────────────────────────────────────

// "Tem declaração?" — resistente a lixo. `jsonb_array_length` explode se o valor não for
// array, e a coluna é nova: uma linha gravada à mão como objeto derrubaria o SELECT inteiro
// de todas as telas.
const TEM_DECLARACAO = `
  (jsonb_typeof(COALESCE(p.sigef_declaracao, '[]'::jsonb)) = 'array'
   AND jsonb_array_length(COALESCE(p.sigef_declaracao, '[]'::jsonb)) > 0)`;

// A pendência bruta, ANTES de olhar a declaração. Serve para o `podeDeclarar` e para contar.
const PENDENCIA_SQL = `
  CASE
    WHEN p.baixada = true AND p.tipo = 'parcial' AND p.sigef_status IS NULL
         AND p.data_baixa < TIMESTAMP '${CORTE_EXTRACAO}'
      THEN '${TAGS.SEM_REGISTRO_SIGEF}'
    WHEN p.baixada = true AND p.tipo = 'final' AND p.sigef_status IS NULL
         AND p.data_baixa < TIMESTAMP '${CORTE_EXTRACAO}'
      THEN '${TAGS.VERIFICAR_FINAL}'
    WHEN p.sigef_status IS NOT NULL AND p.baixada = false
      THEN '${TAGS.ABERTA_COM_BAIXA_SIGEF}'
    ELSE NULL
  END`;

// A tag que vai para a tela: a pendência, com o cinza por cima quando já foi declarada.
//
// ⚠️ O CINZA SÓ COBRE O VERMELHO E O AZUL. Uma declaração numa PC âmbar não a apaga — lá o
// pendente é o parecer neste sistema, e nada que o analista declare sobre o SIGEF resolve.
const SQL_TAG = `
  CASE
    WHEN ${PENDENCIA_SQL} IN ('${TAGS.SEM_REGISTRO_SIGEF}', '${TAGS.VERIFICAR_FINAL}')
         AND ${TEM_DECLARACAO}
      THEN '${TAGS.REGISTRO_DECLARADO}'
    ELSE ${PENDENCIA_SQL}
  END`;

// ─────────────────────────────────────────────────────────────────────────────
// A MESMA REGRA, EM JS
//
// ⚠️ ELA EXISTE PARA SER TESTADA, e para quem já tem a linha na mão. O SELECT continua sendo
// a fonte: duas implementações da mesma regra só se justificam com um teste que prove que as
// duas concordam — e `teste_sigef.js` tem esse teste.
// ─────────────────────────────────────────────────────────────────────────────

/** A data de baixa como texto ISO, aceitando `Date` e string (armadilha 25). */
function paraIso(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function temDeclaracao(pc) {
  return Array.isArray(pc && pc.sigef_declaracao) && pc.sigef_declaracao.length > 0;
}

/** A pendência bruta, sem olhar a declaração. */
function pendencia(pc) {
  if (!pc) return null;
  const antesDoCorte = () => {
    const d = paraIso(pc.data_baixa);
    return !!d && d < CORTE_EXTRACAO;
  };
  if (pc.baixada === true && pc.tipo === 'parcial' && pc.sigef_status == null && antesDoCorte())
    return TAGS.SEM_REGISTRO_SIGEF;
  if (pc.baixada === true && pc.tipo === 'final' && pc.sigef_status == null && antesDoCorte())
    return TAGS.VERIFICAR_FINAL;
  if (pc.sigef_status != null && pc.baixada === false)
    return TAGS.ABERTA_COM_BAIXA_SIGEF;
  return null;
}

/** A tag final — a pendência, com o cinza por cima quando já foi declarada. */
function classificar(pc) {
  const p = pendencia(pc);
  if (TAGS_QUE_DECLARAM.includes(p) && temDeclaracao(pc)) return TAGS.REGISTRO_DECLARADO;
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// A DECLARAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quem pode declarar?
 *
 * ⚠️ SÓ O ANALISTA RESPONSÁVEL PELA PC, OU O SUPERADMIN — e o perfil vem do BANCO, nunca do
 * corpo do pedido. Foi o buraco que as quatro rotas de 14/08 fecharam: bastava mandar
 * `perfil: 'superadmin'` para passar.
 *
 * ⚠️ O superadmin entra por `perfilEfetivo`, e não por `u.perfil`: no papel de analista ele É
 * analista em toda parte, e aqui isso significa que ele só declara nas PCs dele.
 *
 * @param quem    o usuário lido do banco, com `perfil` e `papel_ativo`
 * @param pc      a linha de `prestacoes_contas`
 * @param perfil  o perfil EFETIVO (de `papel.perfilEfetivo`)
 */
function podeDeclarar(quem, pc, perfil) {
  if (!quem || !pc) return false;
  if (perfil === 'superadmin') return true;
  return pc.analista_id != null && String(pc.analista_id) === String(quem.id);
}

/**
 * Vale declarar nesta PC?
 *
 * ⚠️ A REDECLARAÇÃO É PERMITIDA DE PROPÓSITO. "Se o analista errar, ele declara de novo e o
 * histórico guarda as duas" — então `REGISTRO_DECLARADO` também entra aqui. Recusar a segunda
 * declaração deixaria o erro gravado para sempre, que é o oposto do que a coluna serve.
 */
function aceitaDeclaracao(pc) {
  const t = classificar(pc);
  return TAGS_QUE_DECLARAM.includes(t) || t === TAGS.REGISTRO_DECLARADO;
}

/**
 * Valida o corpo do pedido. Devolve a mensagem de erro, ou null.
 *
 * ⚠️ A DATA É CONFERIDA COMO TEXTO ISO, e não com `new Date(...)`. `new Date('31/08/2026')`
 * devolve `Invalid Date` em silêncio em alguns formatos e uma data errada em outros — é a
 * mesma família das armadilhas 18 e 25. Aqui só passa `AAAA-MM-DD` que sobrevive ao
 * ida-e-volta, o que recusa 2026-02-31 sem precisar de tabela de meses.
 */
function validarDeclaracao({ resposta, data_registro }) {
  if (!resposta || !Object.prototype.hasOwnProperty.call(RESPOSTAS, resposta))
    return `Resposta inválida. Use uma de: ${Object.keys(RESPOSTAS).join(', ')}.`;
  if (!data_registro || !/^\d{4}-\d{2}-\d{2}$/.test(String(data_registro)))
    return 'Informe a data do registro no formato AAAA-MM-DD.';
  const d = new Date(`${data_registro}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== String(data_registro))
    return 'Data do registro inexistente.';
  return null;
}

/**
 * Monta a linha que vai para o array do jsonb.
 *
 * ⚠️ O RÓTULO VAI JUNTO COM O CÓDIGO, e não só o código. O código serve para consultar; o
 * rótulo é o que a pessoa leu na tela ao clicar, e é o que responde à CGE meses depois — se
 * o texto do botão mudar, a trilha antiga continua dizendo o que foi afirmado na época.
 * É a mesma decisão do `executado_por`, que marca na coluna E no texto.
 */
function montarDeclaracao({ resposta, data_registro, quem, agora }) {
  return {
    resposta,
    resposta_rotulo: RESPOSTAS[resposta],
    data_registro,
    declarado_por: quem.id,
    declarado_por_nome: quem.nome || null,
    declarado_em: (agora || new Date()).toISOString(),
  };
}

// ⚠️ O `||` APENDA, NUNCA SUBSTITUI — é o que faz "a declaração não se desmarca". E o
// `COALESCE` com `'[]'` cobre a primeira, quando a coluna ainda é NULL.
//
// ⚠️ `sigef_registro_em` RECEBE A DATA DA DECLARAÇÃO MAIS RECENTE, e é por isso que ela é uma
// coluna e não um `->>` do jsonb: é dela que a próxima conferência vai ler, e ninguém deveria
// precisar saber a forma do json para responder "quando foi registrado".
//
// ⚠️ E NADA MAIS ENTRA NO `SET`. `baixada`, `enviado_ci`, `data_baixa`, `parecer_tipo` e
// `sigef_status` não aparecem aqui: declarar não baixa, não estorna e não move produtividade.
// Há teste que falha se um destes nomes voltar a este SQL.
const SQL_DECLARAR = `
  UPDATE prestacoes_contas
     SET sigef_declaracao = COALESCE(sigef_declaracao, '[]'::jsonb) || $2::jsonb,
         sigef_registro_em = $3::date
   WHERE codigo_pc = $1
  RETURNING codigo_pc, sigef_declaracao, sigef_registro_em`;

module.exports = {
  CORTE_EXTRACAO, TAGS, TAGS_QUE_DECLARAM, RESPOSTAS,
  SQL_TAG, PENDENCIA_SQL, TEM_DECLARACAO,
  paraIso, temDeclaracao, pendencia, classificar,
  podeDeclarar, aceitaDeclaracao, validarDeclaracao, montarDeclaracao,
  SQL_DECLARAR,
};
