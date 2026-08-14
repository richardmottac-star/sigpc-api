// CAMINHO: sigpc-api/lib/devolucao-pedido.js
//
// O ANALISTA PEDE A DEVOLUÇÃO DA TR. ELE NÃO DEVOLVE.
// Especificação do Richard, 13/08/2026.
//
// ⚠️ NÃO CONFUNDIR COM `lib/devolucao.js`. Aquela é a devolução do SUPERADMIN, que executa
// na hora. Esta é o PEDIDO: cria uma linha em `solicitacao_devolucao` e espera decisão.
// Quando o pedido é aprovado, quem devolve de fato é a `devolucao.js` — a mesma função, na
// mesma transação. Duas regras de "o que volta" divergiriam mais cedo ou mais tarde.
//
// ⚠️ A TR CONTINUA CONTANDO NO LIMITE DO ANALISTA ENQUANTO O PEDIDO ESTÁ PENDENTE.
// Isso não é uma regra escrita aqui: é consequência de o pedido NÃO tocar em
// `prestacoes_contas.analista_id`. Se o pendente já liberasse a vaga, qualquer um abriria
// vaga só pedindo devolução. A TR só sai da contagem na APROVAÇÃO.
//
// ⚠️ E É POR ISSO QUE A TABELA É SEPARADA da `solicitacao_vaga`: sete consultas de
// `lib/limite-tr.js` leem aquela tabela sem filtro nenhum, e um pedido de devolução gravado
// lá viraria vaga extra aprovada, reserva no Estoque e autorização para furar o limite —
// tudo em silêncio. `limite-tr.js` continua sem saber que este arquivo existe.

const devolucao = require('./devolucao');

/**
 * Os seis motivos, na ordem em que aparecem na tela.
 *
 * ⚠️ O BANCO GUARDA O `id`, NÃO O `rotulo`. O primeiro rótulo carrega uma DATA, e rótulo com
 * data é reescrito: um CHECK sobre o texto passaria a recusar as linhas antigas.
 */
const MOTIVOS = [
  { id: 'analise_anterior',
    rotulo: 'Já estava em análise por outro analista antes de 01/08/2026',
    subtexto: 'trabalho iniciado na planilha, antes do sistema',
    exigeIndicado: true },
  { id: 'impedimento',        rotulo: 'Impedimento ou suspeição' },
  { id: 'falta_documentacao', rotulo: 'Falta de documentação no processo' },
  { id: 'afastamento',        rotulo: 'Afastamento ou férias' },
  { id: 'redistribuicao',     rotulo: 'Redistribuição pedida pela coordenação' },
  { id: 'outro',              rotulo: 'Outro' },
];

const IDS = MOTIVOS.map(m => m.id);
const JUSTIFICATIVA_MIN = 10;
const JUSTIFICATIVA_MAX = 500;
const DECISAO_MIN = 10;

/** O texto de um motivo, para o sino e para a tela de aprovação. */
function motivoTexto(id) {
  const m = MOTIVOS.find(x => x.id === id);
  return m ? m.rotulo : (id || '—');
}

/**
 * Para onde a TR vai quando o pedido é APROVADO.
 *
 * ⚠️ O MOTIVO 1 NÃO PASSA PELO ESTOQUE — decisão do Richard, 13/08/2026. Mandar ao estoque
 * uma TR que tem destino conhecido é entregá-la a quem chegar primeiro, e o motivo 1 existe
 * justamente porque ela já era de outra pessoa. Nos outros cinco, estoque.
 */
function destinoAprovacao(motivo) {
  return motivo === 'analise_anterior' ? 'indicado' : 'estoque';
}

/**
 * O indicado pode receber a TR? Devolve a mensagem do impedimento, ou null.
 *
 * ⚠️ O LIMITE NÃO É CONFERIDO — decisão do Richard. A trava de 10/08 vale no ATO DE ASSUMIR,
 * e aqui ninguém está assumindo: a TR está VOLTANDO para quem já a analisava. Medido em
 * 13/08: 29 dos 44 analistas já estão no limite de 6 ou acima. Conferir aqui faria o motivo 1
 * nascer inútil. Quem decide olhando a carga é o coordenador, e por isso ela vai no cartão.
 *
 * ⚠️ O QUE BLOQUEIA É NÃO HAVER PARA QUEM TRANSFERIR. Sem cadastro ativo, a alternativa
 * seria mandar ao estoque em silêncio — que é exatamente o defeito que o motivo 1 corrige.
 */
function impedimentoIndicado(pedido, indicado) {
  if (destinoAprovacao(pedido.motivo) !== 'indicado') return null;

  const nome = (pedido.indicado_nome || '').trim();
  if (!indicado)
    return `"${nome || 'o analista indicado'}" não tem cadastro no sistema. `
         + 'Cadastre a pessoa ou recuse o pedido — a TR não pode ir ao estoque neste motivo, '
         + 'porque ela tem destino.';
  if (indicado.ativo === false)
    return `${indicado.nome} está com o cadastro INATIVO e não pode receber a TR. `
         + 'Reative o cadastro ou recuse o pedido.';
  if (indicado.id === pedido.analista_id)
    return 'O analista indicado é o próprio solicitante — não há para quem transferir.';
  return null;
}

/**
 * Valida o pedido que a tela manda. Devolve a mensagem de erro, ou null.
 *
 * A justificativa é obrigatória em TODOS os motivos — decisão do Richard. Um motivo de lista
 * fechada diz a categoria; quem vai decidir precisa do caso.
 */
function validarPedido(b) {
  if (!b) return 'Nada informado.';
  if (!b.tr || !String(b.tr).trim()) return 'tr é obrigatório.';
  if (!b.analista_id) return 'analista_id é obrigatório.';
  if (!b.motivo) return 'Selecione o motivo do pedido.';
  if (!IDS.includes(b.motivo)) return 'Motivo inválido.';

  const j = (b.justificativa ?? '').toString().trim();
  if (!j) return 'Escreva a justificativa — quem decide vai ler.';
  if (j.length < JUSTIFICATIVA_MIN) return `A justificativa precisa de ao menos ${JUSTIFICATIVA_MIN} caracteres.`;
  if (j.length > JUSTIFICATIVA_MAX) return `A justificativa passa de ${JUSTIFICATIVA_MAX} caracteres.`;

  // ⚠️ NO MOTIVO 1, "QUEM JÁ ANALISAVA" É OBRIGATÓRIO. Sem ele a TR volta ao estoque para
  // qualquer um pegar, quando deveria ir para quem já estava com ela. O banco também recusa
  // (CHECK sd_indicado_no_motivo_1) — esta é a mensagem legível.
  const m = MOTIVOS.find(x => x.id === b.motivo);
  if (m && m.exigeIndicado) {
    const nome = (b.indicado_nome ?? '').toString().trim();
    if (!b.indicado_id && !nome)
      return 'Informe quem já analisava esta TR — sem isso ela voltaria ao estoque para qualquer um pegar.';
  }
  return null;
}

/** Valida a decisão do coordenador. Devolve a mensagem de erro, ou null. */
function validarDecisao(b) {
  if (!b) return 'Nada informado.';
  if (b.status !== 'aprovada' && b.status !== 'negada') return "status deve ser 'aprovada' ou 'negada'.";
  const m = (b.motivo_decisao ?? '').toString().trim();
  // Nos DOIS casos o analista é avisado pelo sino COM O MOTIVO ESCRITO — decisão do Richard.
  // Recusa sem motivo é o que fazia a TR sumir da planilha sem explicação.
  if (!m) return 'Escreva o motivo da decisão — o analista recebe este texto no sino.';
  if (m.length < DECISAO_MIN) return `O motivo precisa de ao menos ${DECISAO_MIN} caracteres.`;
  return null;
}

/**
 * Quem pode decidir: COORDENADOR DO GRUPO do analista, ou SUPERADMIN.
 *
 * ⚠️ Coordenador de OUTRO grupo não decide. É a mesma fronteira das outras telas de
 * coordenação, e sem ela um coordenador tiraria TR de equipe que não é a dele.
 */
function podeDecidir(quem, grupoDoAnalista) {
  if (!quem) return false;
  if (quem.perfil === 'superadmin') return true;
  if (quem.perfil !== 'coordenador') return false;
  return String(quem.grupo ?? '') === String(grupoDoAnalista ?? '') && String(quem.grupo ?? '') !== '';
}

/**
 * O impedimento do PEDIDO, calculado sobre a mesma foto da devolução do superadmin.
 *
 * ⚠️ PARCIAL NO CONTROLE INTERNO BLOQUEIA O PEDIDO ATÉ O RETORNO — decisão do Richard. É a
 * mesma trava da devolução direta, pelo mesmo motivo: devolver com o C.I. aberto deixa a
 * resposta sem dono. Reusar `devolucao.impedimento` é o que garante que a tela do analista e
 * a do superadmin digam a MESMA coisa sobre a MESMA TR.
 */
function impedimentoPedido(pcs) {
  const r = devolucao.resumir(pcs);
  return { resumo: r, impedimento: devolucao.impedimento(r) };
}

/**
 * O aviso que o modal mostra ANTES de enviar.
 *
 * ⚠️ Fala das PARCIAIS BAIXADAS que ficam no nome dele — não das que voltam. É a pergunta
 * que a pessoa faz ao clicar ("perco o que já baixei?"), e a resposta é não.
 */
function avisoPedido(pcs) {
  const r = devolucao.resumir(pcs);
  return {
    total: r.total,
    voltam: r.devolver,
    ficam_baixadas: r.baixadas,
    no_ci: r.no_ci,
    // ⚠️ O plural de "parcial" é "parciaIS", não "parcial" + "is". A primeira versão escrevia
    // "2 parcialis" na tela do analista.
    texto_baixadas: r.baixadas > 0
      ? `${r.baixadas} ${r.baixadas > 1 ? 'parciais baixadas permanecem' : 'parcial baixada permanece'} `
        + 'no seu nome — a produtividade não é afetada.'
      : 'Nenhuma parcial baixada nesta TR.',
    texto_ci: r.no_ci > 0
      ? `${r.no_ci} ${r.no_ci > 1 ? 'parciais no Controle Interno BLOQUEIAM' : 'parcial no Controle Interno BLOQUEIA'} `
        + 'o pedido até o retorno.'
      : null,
  };
}

const SQL_CRIAR = `
  INSERT INTO solicitacao_devolucao
    (analista_id, tr, setorial_id, motivo, justificativa, indicado_id, indicado_nome,
     pcs_total, pcs_voltam, pcs_ficam_baixadas)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING *`;

// A fila da coordenação. O grupo vem do usuário, não da PC: é ele que decide quem pode ver.
//
// ⚠️ A CARGA DO INDICADO VEM JUNTO, e é o que o cartão mostra ("Marisa: 8 TRs, limite 6").
// Ela NÃO barra nada — quem decide é o coordenador. Vai na mesma consulta porque uma segunda
// ida ao banco por cartão traria um número de outro instante.
const SQL_LISTAR = `
  SELECT s.*, u.nome AS analista_nome, u.grupo AS analista_grupo,
         i.nome AS indicado_nome_cadastro, i.ativo AS indicado_ativo, i.grupo AS indicado_grupo,
         (SELECT COUNT(DISTINCT p.tr) FROM prestacoes_contas p
           WHERE p.analista_id = s.indicado_id AND p.baixada = false)::int AS indicado_ocupadas,
         d.nome AS decidido_por_nome
    FROM solicitacao_devolucao s
    LEFT JOIN usuarios u ON u.id = s.analista_id
    LEFT JOIN usuarios i ON i.id = s.indicado_id
    LEFT JOIN usuarios d ON d.id = s.decidido_por
   WHERE ($1::text IS NULL OR s.status = $1::text)
     AND ($2::int  IS NULL OR s.analista_id = $2::int)
     AND ($3::text IS NULL OR u.grupo = $3::text)
   ORDER BY s.criado_em DESC`;

// ⚠️ A trava do "um pendente por TR" é do índice único parcial, não deste UPDATE. E o
// `WHERE status = 'pendente'` é o que impede duas decisões sobre o mesmo pedido: quem chegar
// depois encontra zero linhas e leva o 409.
const SQL_DECIDIR = `
  UPDATE solicitacao_devolucao
     SET status = $2, decidido_por = $3, decidido_em = NOW(), motivo_decisao = $4
   WHERE id = $1 AND status = 'pendente'
  RETURNING *`;

module.exports = {
  MOTIVOS, IDS, JUSTIFICATIVA_MIN, JUSTIFICATIVA_MAX, DECISAO_MIN,
  SQL_CRIAR, SQL_LISTAR, SQL_DECIDIR,
  motivoTexto, validarPedido, validarDecisao, podeDecidir, impedimentoPedido, avisoPedido,
  destinoAprovacao, impedimentoIndicado,
};
