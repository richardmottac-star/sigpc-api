// CAMINHO: sigpc-api/lib/limite-tr.js
//
// TRAVA DE TRs POR ANALISTA — quantas TRs alguém pode ter em análise ao mesmo tempo.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, decidida em 10/08/2026:
//
// 1. A trava é conferida SÓ NO ATO DE ASSUMIR. Quem já está acima do limite não devolve
//    nada — apenas não pega TR nova enquanto não cair abaixo. Sem isso, ligar a trava
//    tiraria TRs de 32 dos 44 analistas de uma vez.
//
// 2. A vaga é liberada quando a TR INTEIRA é baixada (`liberacao = 'tr'`). A opção
//    'parcial' existe na configuração e libera a vaga na primeira parcial baixada, mas não
//    é a escolhida.
//
// 3. SUPERADMIN NUNCA TEM LIMITE. É verificado antes de tudo, e não depende de exceção
//    cadastrada — se dependesse, apagar a exceção por engano travaria quem administra.
// ─────────────────────────────────────────────────────────────────────────────
//
// `limite = null` significa SEM LIMITE em toda parte (config e exceção). `0` é diferente:
// é bloqueio total, ninguém pega TR nova.

// Prazo da reserva. Fixo aqui por decisão do Richard em 10/08 — vira campo de tela quando as
// abas 2 e 3 de Configurações entrarem. NÃO virou coluna: `config_limite_tr` não tem onde
// guardar, e criar exigiria ALTER TABLE.
const RESERVA_DIAS = 3;

const notificacao = require('./notificacao');
const inval = require('./invalidada');

const CONFIG_PADRAO = {
  limite_padrao: null, liberacao: 'tr', pedido_ativo: true, pedido_aprovador: 'coordenador',
};

/** Configuração global. Devolve o padrão se a tabela ainda não existir. */
async function lerConfig(db) {
  try {
    const { rows } = await db.query(`SELECT * FROM config_limite_tr WHERE id = 1`);
    return rows[0] || { ...CONFIG_PADRAO };
  } catch (e) {
    return { ...CONFIG_PADRAO };
  }
}

/**
 * Quantas TRs do analista ocupam vaga agora.
 *
 * 'tr'      — a TR ocupa enquanto tiver QUALQUER PC não baixada.
 * 'parcial' — a TR deixa de ocupar assim que a primeira parcial fecha.
 */
async function contarOcupadas(db, analistaId, liberacao) {
  if (liberacao === 'parcial') {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int n FROM (
         SELECT tr FROM prestacoes_contas
          WHERE analista_id = $1 AND ${inval.ativa('')}
          GROUP BY tr
         HAVING COUNT(*) FILTER (WHERE baixada) = 0
       ) x`, [analistaId]);
    return rows[0].n;
  }
  // ⚠️ ESTA É A ÚNICA DA FASE 2 QUE É TRAVA DE ESCRITA, e não número de tela. Sem o filtro, a
  // TR continua ocupando vaga por causa de uma PC que não existe, e a pessoa é RECUSADA ao
  // clicar Assumir — não apenas vê um número errado. Medido em 02/09: Noici 9 → 8, Miriam
  // 4 → 3 e Tanimeri 4 → 3 TRs ocupadas.
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT tr)::int n FROM prestacoes_contas
      WHERE analista_id = $1 AND baixada = false AND ${inval.ativa('')}`, [analistaId]);
  return rows[0].n;
}

/** Vagas extras aprovadas e ainda não gastas. */
async function contarVagasExtras(db, analistaId) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int n FROM solicitacao_vaga
        WHERE analista_id = $1 AND status = 'aprovada'`, [analistaId]);
    return rows[0].n;
  } catch (e) { return 0; }
}

/**
 * Situação completa do analista. É o que a tela usa para decidir o que mostrar, e o que a
 * trava usa para decidir se deixa assumir.
 *
 * @returns {{limite, limiteBase, origem, extras, ocupadas, podeAssumir, semLimite, liberacao, pedidoAtivo}}
 */
async function situacao(db, usuario) {
  const cfg = await lerConfig(db);
  const base = {
    liberacao: cfg.liberacao || 'tr',
    pedidoAtivo: cfg.pedido_ativo !== false,
    pedidoAprovador: cfg.pedido_aprovador || 'coordenador',
  };

  // Superadmin antes de tudo — nem consulta exceção.
  if (usuario && usuario.perfil === 'superadmin') {
    const ocupadas = await contarOcupadas(db, usuario.id, base.liberacao);
    return { ...base, limite: null, limiteBase: null, origem: 'superadmin',
             extras: 0, ocupadas, semLimite: true, podeAssumir: true };
  }

  let limiteBase = cfg.limite_padrao;
  let origem = 'padrao';
  try {
    const { rows } = await db.query(
      `SELECT limite FROM limite_tr_excecao WHERE analista_id = $1`, [usuario.id]);
    if (rows.length) { limiteBase = rows[0].limite; origem = 'excecao'; }
  } catch (e) { /* tabela ausente: segue no padrão */ }

  const ocupadas = await contarOcupadas(db, usuario.id, base.liberacao);
  const extras = await contarVagasExtras(db, usuario.id);

  // `null` em qualquer nível = sem limite. `0` NÃO é null: bloqueia.
  if (limiteBase === null || limiteBase === undefined) {
    return { ...base, limite: null, limiteBase: null, origem,
             extras, ocupadas, semLimite: true, podeAssumir: true };
  }

  // ⚠️ `extras` NÃO entra na conta — vai junto só para a tela poder mostrar.
  //
  // Somar era o defeito encontrado em 10/08: quem estava exatamente no limite (5 de 5, o
  // caso normal) passava por AQUI ao ser aprovado, e não pelo caminho da autorização. Três
  // consequências, e a terceira é a grave:
  //   1. `podeAssumirTr` devolvia `autorizacao: null`, então o modal não avisava nada;
  //   2. o PATCH não tinha o que marcar como 'usada';
  //   3. a aprovação ficava 'aprovada' PARA SEMPRE — +1 permanente no limite da pessoa,
  //      que ninguém decidiu dar. Duas aprovações e o limite dela virava 7 em definitivo.
  //
  // Com a soma fora, o único caminho que uma aprovação abre é `autorizacaoAprovada()`, que
  // devolve a autorização, faz o modal avisar e faz o PATCH consumir.
  const limite = limiteBase;
  return { ...base, limite, limiteBase, origem, extras, ocupadas,
           semLimite: false, podeAssumir: ocupadas < limite };
}

/**
 * RESERVA — enquanto houver pedido PENDENTE para uma TR, ela é dela.
 *
 * Sem isto o pedido não serviria para nada: o analista pede, espera a aprovação, e um colega
 * que estava abaixo do limite leva a TR nesse meio-tempo.
 *
 * Devolve o pedido pendente mais antigo da TR, com o nome de quem pediu — o nome sai de
 * `usuarios` por JOIN, nunca copiado (armadilha 1 do CLAUDE.md).
 */
async function reservaPendente(db, tr) {
  if (!tr) return null;
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.analista_id, s.criado_em, u.nome
         FROM solicitacao_vaga s
         LEFT JOIN usuarios u ON u.id = s.analista_id
        WHERE s.tr = $1 AND s.status = 'pendente'
          AND s.criado_em > NOW() - (INTERVAL '1 day' * $2)
        ORDER BY s.criado_em
        LIMIT 1`, [tr, RESERVA_DIAS]);
    return rows[0] || null;
  } catch (e) { return null; }
}

/** Todas as TRs reservadas agora — é o que a tela do Estoque usa para desenhar a tag. */
async function reservasPendentes(db) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (s.tr) s.tr, s.id, s.analista_id, s.criado_em, u.nome
         FROM solicitacao_vaga s
         LEFT JOIN usuarios u ON u.id = s.analista_id
        WHERE s.status = 'pendente' AND s.tr IS NOT NULL
          AND s.criado_em > NOW() - (INTERVAL '1 day' * $1)
        ORDER BY s.tr, s.criado_em`, [RESERVA_DIAS]);
    return rows;
  } catch (e) { return []; }
}

/**
 * EXPIRAÇÃO — pedido pendente há mais de RESERVA_DIAS vira 'expirada' e solta a TR.
 *
 * Sem job novo: roda quando ALGUÉM LÊ as solicitações. A linha permanece na tabela, e é essa
 * permanência que dá ao analista com que cobrar depois — "pedi dia 5 e ninguém respondeu".
 *
 * ⚠️ Isto aqui NÃO é o que faz a reserva cair. Quem faz é o `criado_em > NOW() - N dias` das
 * duas consultas acima, que já ignora o pedido velho mesmo que este UPDATE ainda não tenha
 * rodado. Fosse só o UPDATE, a hora da expiração dependeria de alguém abrir uma tela: uma TR
 * ficaria reservada por uma semana só porque ninguém entrou no sistema no fim de semana.
 * Este UPDATE existe para o ESTADO GRAVADO alcançar a realidade, não para criá-la.
 *
 * @returns {number} quantos expiraram agora
 */
async function expirarPendentes(db) {
  try {
    const { rows } = await db.query(
      `UPDATE solicitacao_vaga SET status = 'expirada'
        WHERE status = 'pendente'
          AND criado_em <= NOW() - (INTERVAL '1 day' * $1)
        RETURNING id, analista_id, tr`, [RESERVA_DIAS]);

    // A notificação sai do RETURNING, e não de uma consulta depois. Esta função roda em TODA
    // leitura, várias vezes por minuto: uma consulta separada faria duas execuções
    // simultâneas notificarem o mesmo pedido duas vezes. O UPDATE encontra cada linha como
    // 'pendente' uma única vez — quem ganhou a corrida leva as linhas, o outro leva zero.
    for (const r of rows) {
      await notificacao.criar(db, {
        destinatario_id: r.analista_id,
        tipo: 'aprovacao',
        titulo: 'Pedido de vaga expirou',
        mensagem: `Seu pedido${r.tr ? ` da TR ${r.tr}` : ''} ficou ${RESERVA_DIAS} dias sem decisão. `
                + `A TR voltou ao estoque — você pode pedir de novo.`,
        ref_tipo: 'solicitacao_vaga', ref_id: String(r.id),
      });
    }
    return rows;
  } catch (e) { return []; }
}

/** Existe pedido APROVADO e não usado que autorize esta TR? */
async function autorizacaoAprovada(db, analistaId, tr) {
  try {
    const { rows } = await db.query(
      `SELECT id, tr FROM solicitacao_vaga
        WHERE analista_id = $1 AND status = 'aprovada'
          AND (tr IS NOT DISTINCT FROM $2 OR tr IS NULL)
        ORDER BY (tr IS DISTINCT FROM $2), criado_em
        LIMIT 1`, [analistaId, tr]);
    return rows[0] || null;
  } catch (e) { return null; }
}

/**
 * Pode assumir ESTA TR?
 *
 * Três caminhos liberam:
 *   1. está abaixo do limite;
 *   2. a TR JÁ É DELE — o front manda um PATCH por PC, e sem isto a segunda PC da mesma TR
 *      seria barrada como se fosse TR nova;
 *   3. há pedido APROVADO para esta TR (ou aprovado sem TR específica).
 *
 * ⚠️ O caminho 3 autoriza a TR, e não soma +1 ao limite. A diferença aparece em quem está
 * MUITO acima: a Grazielly tem 54 TRs num limite de 5 — um "+1" a deixaria em 6 e ela
 * continuaria travada, tornando o pedido inútil justamente para quem precisa dele. Como
 * quem aprova sabe quantas TRs ela já tem (a tela de aprovação mostra), a decisão é de
 * quem aprova, não da aritmética.
 */
async function podeAssumirTr(db, usuario, tr) {
  const s = await situacao(db, usuario);

  // A RESERVA VEM ANTES DA CONTA DO LIMITE, e não dentro dela: são coisas independentes.
  // Quem tem 1 TR de 5 está longe do limite e mesmo assim não pode furar a fila de quem já
  // pediu esta TR. Se ficasse depois, o caminho `s.podeAssumir` sairia antes e a reserva
  // valeria só para quem já estivesse travado — ou seja, quase nunca.
  //
  // Não barra: o superadmin, e o próprio solicitante (o pedido é dele).
  if (!usuario || usuario.perfil !== 'superadmin') {
    const reserva = await reservaPendente(db, tr);
    if (reserva && Number(reserva.analista_id) !== Number(usuario.id)) {
      const quem = (reserva.nome || 'outro analista').split(' ')[0];
      return { ...s, pode: false, jaMinha: false, autorizacao: null, reserva,
               motivo: `TR reservada: há um pedido de ${quem} aguardando aprovação. ` +
                       `Se for negado ou expirar em ${RESERVA_DIAS} dias, ela volta ao estoque.` };
    }
  }

  if (s.podeAssumir) return { ...s, pode: true, jaMinha: false, autorizacao: null };

  // ⚠️ O FILTRO ENTRA AQUI PELA COERÊNCIA COM `contarOcupadas`, logo acima: se a PC invalidada
  // não ocupa vaga, ela também não faz a TR "já ser minha" — e "já é minha" é o que libera
  // assumir acima do limite. Sem isto, o mesmo arquivo responderia duas coisas sobre a mesma
  // PC. Hoje não muda nada (nenhuma PC está invalidada); passa a valer quando alguma estiver.
  // ⚠️ NUMA LINHA SÓ, de propósito: `teste_limite_tr.js` casa esta consulta com uma regex
  // sensível a espaço em branco. Quebrar a linha não muda o SQL e derruba o teste — e um
  // teste que cai por formatação some no ruído quando cair por regra.
  const { rows } = await db.query(
    `SELECT 1 FROM prestacoes_contas WHERE tr = $1 AND analista_id = $2 AND ${inval.ativa('')} LIMIT 1`,
    [tr, usuario.id]);
  const jaMinha = rows.length > 0;
  if (jaMinha) return { ...s, pode: true, jaMinha: true, autorizacao: null };

  const autorizacao = await autorizacaoAprovada(db, usuario.id, tr);
  if (autorizacao) return { ...s, pode: true, jaMinha: false, autorizacao };

  return { ...s, pode: false, jaMinha: false, autorizacao: null,
           motivo: `Limite de ${s.limite} TR${s.limite === 1 ? '' : 's'} em análise atingido (você tem ${s.ocupadas}).` };
}

/**
 * Gasta uma vaga extra ao assumir. Prefere a solicitação feita para ESTA TR; se não houver,
 * gasta a mais antiga aprovada. Sem isso, uma aprovação viraria +1 permanente.
 */
async function consumirVagaExtra(db, analistaId, tr) {
  try {
    const { rows } = await db.query(
      `UPDATE solicitacao_vaga SET status = 'usada'
        WHERE id = (
          SELECT id FROM solicitacao_vaga
           WHERE analista_id = $1 AND status = 'aprovada'
           ORDER BY (tr IS DISTINCT FROM $2), criado_em
           LIMIT 1)
        RETURNING id`, [analistaId, tr]);
    return rows.length ? rows[0].id : null;
  } catch (e) { return null; }
}

module.exports = {
  CONFIG_PADRAO, RESERVA_DIAS, lerConfig, contarOcupadas, contarVagasExtras,
  situacao, podeAssumirTr, consumirVagaExtra, autorizacaoAprovada,
  reservaPendente, reservasPendentes, expirarPendentes,
};
