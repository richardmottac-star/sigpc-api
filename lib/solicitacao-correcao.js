// CAMINHO: sigpc-api/lib/solicitacao-correcao.js
//
// O ANALISTA PEDE A CORREÇÃO AO COORDENADOR (frente D).
// Especificação do Richard, 18/08/2026.
//
// Quando a baixa (A) ou o encaminhamento ao C.I. (B) foi feito por OUTRA PESSOA
// IDENTIFICADA, o analista não corrige sozinho: abre um pedido para o **coordenador do grupo
// dele** — Nayara (G1), Zadir (G2), Gustavo (G3) — aprovar ou negar, com motivo.
// **Aprovada, a ação é executada na mesma transação.**
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ TABELA PRÓPRIA, E NÃO A `solicitacao_devolucao`.
//
// É a mesma lição que separou a `solicitacao_devolucao` da `solicitacao_vaga`, e ela já custou
// caro uma vez: sete consultas de `lib/limite-tr.js` leem `solicitacao_vaga` SEM FILTRO
// NENHUM. Aqui os estragos seriam outros três, todos silenciosos:
//
//   1. `devolucao-pedido.SQL_LISTAR` traria pedidos de correção para a fila de DEVOLUÇÃO,
//      com `pcs_voltam`/`pcs_ficam_baixadas` zerados e sem sentido no cartão;
//   2. o índice `idx_sd_um_pendente_por_tr` é por **TR** — um pedido de correção de uma PC
//      bloquearia um pedido de DEVOLUÇÃO da mesma TR, e vice-versa;
//   3. `PATCH /solicitacao_devolucao/:id` aprovaria devolvendo a TR ao estoque, que não é
//      nem de longe o que "corrigir a situação de uma parcial" quer dizer.
//
// O que se REAPROVEITA é o DESENHO, não a tabela: motivo de decisão obrigatório, um pendente
// por chave garantido por índice único parcial, recorte da fila feito no SERVIDOR pelo perfil
// lido no BANCO, e a decisão executando a ação na mesma transação.
//
// ⚠️ A CHAVE É `codigo_pc`. NUNCA `parcial_num` — decisão do Richard. A PC final tem QUATRO
// grafias de `parcial_num` no banco, e em 5 casos ela divide o '1' com a parcial 1 da TR.

const ACOES = ['corrigir_situacao', 'puxar_ci'];

const ACAO_ROTULO = {
  corrigir_situacao: 'Corrigir a situação da parcial',
  puxar_ci: 'Puxar de volta do Controle Interno',
};

const MOTIVO_MIN = 10;
const DECISAO_MIN = 10;

/** O texto de uma ação, para o sino e para o cartão da fila. */
function acaoTexto(id) { return ACAO_ROTULO[id] || id || '—'; }

/**
 * Valida o pedido que a tela manda. Devolve a mensagem de erro, ou null.
 *
 * O motivo é obrigatório em TODAS as ações — quem vai decidir precisa do caso, não da
 * categoria. É a mesma regra da justificativa do pedido de devolução.
 */
function validarPedido(b) {
  if (!b) return 'Nada informado.';
  if (!b.codigo_pc || !String(b.codigo_pc).trim()) return 'codigo_pc é obrigatório.';
  if (!b.analista_id) return 'analista_id é obrigatório.';
  if (!ACOES.includes(b.acao)) return `acao deve ser uma de: ${ACOES.join(', ')}.`;

  const m = (b.motivo ?? '').toString().trim();
  if (!m) return 'Escreva o motivo — o coordenador vai ler.';
  if (m.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;

  // O banco também recusa (CHECK sc_destino_na_correcao) — esta é a mensagem legível.
  if (b.acao === 'corrigir_situacao' && !(b.situacao_destino ?? '').toString().trim())
    return 'Escolha para qual situação a parcial deve ir.';
  return null;
}

/** Valida a decisão do coordenador. Devolve a mensagem de erro, ou null. */
function validarDecisao(b) {
  if (!b) return 'Nada informado.';
  if (b.status !== 'aprovada' && b.status !== 'negada') return "status deve ser 'aprovada' ou 'negada'.";
  const m = (b.motivo_decisao ?? '').toString().trim();
  // Nos DOIS casos o analista recebe este texto no sino. Recusa sem motivo é o que fazia a
  // parcial mudar de estado — ou não mudar — sem ninguém saber por quê.
  if (!m) return 'Escreva o motivo da decisão — o analista recebe este texto no sino.';
  if (m.length < DECISAO_MIN) return `O motivo precisa de ao menos ${DECISAO_MIN} caracteres.`;
  return null;
}

/**
 * Quem decide: COORDENADOR DO GRUPO do analista, ou SUPERADMIN.
 *
 * ⚠️ Coordenador de OUTRO grupo não decide — é a mesma fronteira de `devolucao-pedido.js`,
 * e sem ela um coordenador mexeria no trabalho de equipe que não é a dele.
 *
 * ⚠️ O SOLICITANTE NÃO DECIDE O PRÓPRIO PEDIDO. Exceção: o superadmin, porque não há ninguém
 * acima dele — e aí o histórico ganha a marca de autodecidido. Sem a exceção, o Richard
 * abriria pedidos que ninguém poderia decidir: ele não é coordenador de ninguém.
 *
 * @param quem   o usuário decidindo, lido do BANCO (com `perfil` já efetivo)
 * @param pedido a linha, com `analista_id` e `analista_grupo`
 */
function podeDecidir(quem, pedido, perfilEfetivo) {
  if (!quem || !pedido) return false;
  const perfil = perfilEfetivo || quem.perfil;
  const proprio = String(pedido.analista_id ?? '') === String(quem.id ?? '');
  if (perfil === 'superadmin') return true;
  if (proprio) return false;
  if (perfil !== 'coordenador') return false;
  return String(quem.grupo ?? '') === String(pedido.analista_grupo ?? '')
      && String(quem.grupo ?? '') !== '';
}

/**
 * Quem pediu e quem decidiu são a MESMA pessoa?
 *
 * Não é coluna: sai de `decidido_por = analista_id`, que o banco já guarda. Coluna separada
 * seria uma segunda fonte para a mesma resposta — o mesmo motivo de `devolucao-pedido.js`.
 */
function autodecidido(pedido) {
  if (!pedido || pedido.decidido_por == null) return false;
  return String(pedido.decidido_por) === String(pedido.analista_id);
}

const MARCA_AUTODECIDIDO = 'AUTODECIDIDO — quem pediu e quem decidiu sao a mesma pessoa';

const SQL_CRIAR = `
  INSERT INTO solicitacao_correcao
    (analista_id, codigo_pc, tr, setorial_id, acao, situacao_destino, motivo,
     pcs_afetadas, autor_original_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  RETURNING *`;

// A fila da coordenação. O grupo vem do USUÁRIO, não da PC: é ele que decide quem pode ver.
//
// ⚠️ A PC vem junto, com o estado de AGORA — é o que o cartão mostra. Entre o pedido e a
// decisão a parcial pode ter mudado, e o coordenador precisa decidir sobre o que existe
// hoje, não sobre a foto de ontem.
const SQL_LISTAR = `
  SELECT s.*, u.nome AS analista_nome_completo, u.grupo AS analista_grupo,
         d.nome AS decidido_por_nome,
         a.nome AS autor_original_nome,
         p.entidade, p.parcial_num, p.tipo, p.baixada, p.status AS status_atual,
         p.situacao_atual, p.enviado_ci, p.parecer_tipo, p.valor
    FROM solicitacao_correcao s
    LEFT JOIN usuarios u ON u.id = s.analista_id
    LEFT JOIN usuarios d ON d.id = s.decidido_por
    LEFT JOIN usuarios a ON a.id = s.autor_original_id
    LEFT JOIN prestacoes_contas p ON p.codigo_pc = s.codigo_pc
   WHERE ($1::text IS NULL OR s.status = $1::text)
     AND ($2::int  IS NULL OR s.analista_id = $2::int)
     AND ($3::text IS NULL OR u.grupo = $3::text)
   ORDER BY s.criado_em DESC`;

// ⚠️ A trava do "um pendente por (codigo_pc, acao)" é do ÍNDICE ÚNICO PARCIAL, não deste
// UPDATE. E o `WHERE status = 'pendente'` é o que impede duas decisões sobre o mesmo pedido:
// quem chegar depois encontra zero linhas e leva o 409.
const SQL_DECIDIR = `
  UPDATE solicitacao_correcao
     SET status = $2, decidido_por = $3, decidido_em = NOW(), motivo_decisao = $4
   WHERE id = $1 AND status = 'pendente'
  RETURNING *`;

const SQL_LER_PARA_DECIDIR = `
  SELECT s.*, u.grupo AS analista_grupo, u.nome AS analista_nome_completo
    FROM solicitacao_correcao s
    LEFT JOIN usuarios u ON u.id = s.analista_id
   WHERE s.id = $1
   FOR UPDATE OF s`;

module.exports = {
  ACOES, ACAO_ROTULO, MOTIVO_MIN, DECISAO_MIN, MARCA_AUTODECIDIDO,
  acaoTexto, validarPedido, validarDecisao, podeDecidir, autodecidido,
  SQL_CRIAR, SQL_LISTAR, SQL_DECIDIR, SQL_LER_PARA_DECIDIR,
};
