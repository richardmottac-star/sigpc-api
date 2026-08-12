// CAMINHO: sigpc-api/lib/ci.js
//
// CONTROLE INTERNO — a fila, a conversa e as duas saídas.
//
// O FLUXO, como o Richard descreveu em 12/08/2026:
//
//   O analista faz o parecer no SIGEF e encaminha ao CI. Isso JÁ CONTA COMO BAIXA, e a
//   baixa NUNCA é estornada, qualquer que seja o desfecho.
//
//   O técnico do CI pega o encaminhamento e decide entre duas:
//     1. 'de_acordo' — encaminha para a baixa do Secretário. Encerra e vai para o
//        histórico. NÃO some.
//     2. 'ressalva'  — devolve ao analista para corrigir ou argumentar. Depois de
//        respondida, volta ao CI. Pode ir e voltar quantas vezes for preciso.
//
// ⚠️ NADA AQUI TOCA NA BAIXA. `baixada`, `data_baixa` e `enviado_ci` ficam como estão em
// todo o ciclo. É regra de negócio, não detalhe: se a baixa caísse na devolução, o analista
// perderia produtividade por um ajuste de forma. Há teste que falha se um UPDATE daqui
// mencionar qualquer uma das três.
//
// ⚠️ A CONVERSA É POR PC (decisão do Richard). Mas o encaminhamento é por PARCELA:
// `POST /parcela/ci` marca todas as PCs de uma (tr, parcial_num) de uma vez, e há parcelas
// com 7 PCs na fila de hoje. Então a tela agrupa por parcela e o técnico escreve UMA vez;
// aqui isso vira **uma mensagem por PC**, com o mesmo texto e a mesma rodada. O banco
// guarda fiel, a tela não cobra sete vezes o mesmo texto.
//
// ⚠️ A DEVOLUÇÃO VAI PARA O DONO ATUAL da PC (`analista_id`), não para quem encaminhou —
// decisão do Richard em 12/08. Se a PC trocou de mãos, quem responde é quem está com ela.

const SITUACOES = ['na_fila', 'com_analista', 'encerrado'];
const DECISOES  = ['de_acordo', 'ressalva'];
const DIRECOES  = ['ci_para_analista', 'analista_para_ci'];

const TEXTO_MAX = 4000;
const TEXTO_MIN = 10;

/**
 * A fila do CI numa situação. Devolve as PCs cruas — quem agrupa por parcela é a tela.
 *
 * `enviado_ci` não entra no WHERE: quem manda é `ci_situacao`. As duas colunas respondem
 * perguntas diferentes, e é por confundi-las que a devolução, antes, apagava a passagem
 * pelo CI.
 */
async function fila(db, situacao) {
  const s = SITUACOES.includes(situacao) ? situacao : 'na_fila';
  const { rows } = await db.query(
    `SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.processo_pc, p.processo_mae,
            p.codigo_nl, p.valor, p.parecer_tipo, p.analista_id, p.analista_nome, p.grupo,
            p.dt_envio_ci, p.ci_situacao, p.ci_rodada, p.ci_encerrado_em,
            u.nome AS analista_nome_completo,
            e.nome AS encerrado_por_nome,
            (SELECT COUNT(*)::int FROM ci_mensagem m WHERE m.codigo_pc = p.codigo_pc) AS msgs
       FROM prestacoes_contas p
       LEFT JOIN usuarios u ON u.id = p.analista_id
       LEFT JOIN usuarios e ON e.id = p.ci_encerrado_por
      WHERE p.ci_situacao = $1
      ORDER BY p.dt_envio_ci, p.tr, p.parcial_num, p.codigo_pc`, [s]);
  return rows;
}

/** Quantas há em cada situação — alimenta os números das três abas. */
async function contagens(db) {
  const { rows } = await db.query(
    `SELECT ci_situacao, COUNT(*)::int AS n FROM prestacoes_contas
      WHERE ci_situacao IS NOT NULL GROUP BY ci_situacao`);
  const out = { na_fila: 0, com_analista: 0, encerrado: 0 };
  rows.forEach(r => { if (r.ci_situacao in out) out[r.ci_situacao] = r.n; });
  return out;
}

/** A conversa de uma ou mais PCs, mais antiga primeiro. */
async function mensagens(db, codigosPc) {
  const lista = (Array.isArray(codigosPc) ? codigosPc : [codigosPc]).filter(Boolean);
  if (!lista.length) return [];
  const { rows } = await db.query(
    `SELECT * FROM ci_mensagem WHERE codigo_pc = ANY($1) ORDER BY criado_em, id`, [lista]);
  return rows;
}

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (!Array.isArray(b.codigos_pc) || !b.codigos_pc.length)
    return 'Selecione ao menos uma PC.';
  if (b.decisao !== undefined && !DECISOES.includes(b.decisao))
    return `decisao deve ser uma de: ${DECISOES.join(', ')}`;

  const texto = (b.texto ?? '').toString().trim();
  // ⚠️ 'de_acordo' NÃO exige texto — decisão do Richard: o CI pode encerrar sem escrever
  // nada. 'ressalva' exige, porque devolver sem dizer por quê deixa o analista sem o que
  // fazer. É a mesma regra da justificativa do estorno.
  if (b.decisao === 'ressalva' || b.exigeTexto) {
    if (!texto) return 'Escreva o que precisa ser verificado.';
    if (texto.length < TEXTO_MIN) return `Escreva ao menos ${TEXTO_MIN} caracteres.`;
  }
  if (texto.length > TEXTO_MAX) return `O texto passa de ${TEXTO_MAX} caracteres.`;
  return null;
}

/**
 * Grava a mesma mensagem para várias PCs, na rodada de cada uma.
 *
 * A rodada é lida da PC e não recebida da tela: a tela pode estar velha, e duas mensagens
 * na rodada errada embaralhariam a conversa.
 */
async function gravarMensagem(db, codigosPc, { direcao, texto, autor }) {
  const t = (texto ?? '').toString().trim();
  if (!t) return 0;
  const { rows } = await db.query(
    `INSERT INTO ci_mensagem (codigo_pc, rodada, direcao, texto, autor_id, autor_nome, autor_perfil)
     SELECT p.codigo_pc, GREATEST(p.ci_rodada, 1), $2::text, $3::text, $4::int, $5::text, $6::text
       FROM prestacoes_contas p
      WHERE p.codigo_pc = ANY($1)
     RETURNING id`,
    [codigosPc, direcao, t, autor?.id ?? null, autor?.nome ?? null, autor?.perfil ?? null]);
  return rows.length;
}

/**
 * A decisão do técnico do CI. Devolve as PCs afetadas, para a rota notificar.
 *
 * Tudo numa transação: a mensagem sem a mudança de situação deixaria o analista com um
 * recado e a PC parada na fila do CI; a mudança sem a mensagem, o contrário.
 */
async function decidir(db, { codigos_pc, decisao, texto, autor }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');

    // Só decide sobre o que está REALMENTE na fila. Sem isto, um clique duplo encerraria
    // duas vezes e a segunda contaria uma rodada a mais.
    const alvo = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, analista_id, entidade, ci_rodada
         FROM prestacoes_contas
        WHERE codigo_pc = ANY($1) AND ci_situacao = 'na_fila'
        FOR UPDATE`, [codigos_pc]);
    if (!alvo.rows.length) {
      await cli.query('ROLLBACK');
      return { pcs: [], jaDecidido: true };
    }
    const codigos = alvo.rows.map(r => r.codigo_pc);

    await gravarMensagem(cli, codigos, { direcao: 'ci_para_analista', texto, autor });

    if (decisao === 'de_acordo') {
      // ⚠️ NÃO mexe em baixada, data_baixa nem enviado_ci. A PC encerra no CI e a baixa
      // segue exatamente como estava.
      await cli.query(
        `UPDATE prestacoes_contas
            SET ci_situacao = 'encerrado', ci_encerrado_em = NOW(), ci_encerrado_por = $2::int,
                atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [codigos, autor?.id ?? null]);
    } else {
      // Devolve. A rodada sobe AQUI, e é ela que faz o sino avisar de novo na próxima volta.
      await cli.query(
        `UPDATE prestacoes_contas
            SET ci_situacao = 'com_analista', ci_rodada = GREATEST(ci_rodada, 1) + 1,
                atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [codigos]);
    }

    await cli.query('COMMIT');
    return { pcs: alvo.rows, jaDecidido: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/**
 * A resposta do analista. Volta a PC para a fila do CI.
 *
 * A rodada NÃO sobe aqui: uma ida e volta é uma rodada. Subir dos dois lados dobraria a
 * contagem e o "rodada 2" da tela deixaria de bater com o que aconteceu.
 */
async function responder(db, { codigos_pc, texto, autor }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const alvo = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, entidade, ci_rodada
         FROM prestacoes_contas
        WHERE codigo_pc = ANY($1) AND ci_situacao = 'com_analista'
        FOR UPDATE`, [codigos_pc]);
    if (!alvo.rows.length) {
      await cli.query('ROLLBACK');
      return { pcs: [], jaRespondido: true };
    }
    const codigos = alvo.rows.map(r => r.codigo_pc);

    await gravarMensagem(cli, codigos, { direcao: 'analista_para_ci', texto, autor });
    await cli.query(
      `UPDATE prestacoes_contas SET ci_situacao = 'na_fila', atualizado_em = NOW()
        WHERE codigo_pc = ANY($1)`, [codigos]);

    await cli.query('COMMIT');
    return { pcs: alvo.rows, jaRespondido: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/**
 * Uma notificação POR ENCAMINHAMENTO, não por PC.
 *
 * A parcela 1 da 2020TR000657 tem 7 PCs. Sem este agrupamento, devolvê-la encheria o sino
 * da Claudia com 7 avisos idênticos — e um sino que enche de repetição para de ser lido.
 */
function agruparPorParcela(pcs) {
  const mapa = new Map();
  pcs.forEach(p => {
    const k = `${p.tr}|${p.parcial_num}`;
    if (!mapa.has(k)) mapa.set(k, { tr: p.tr, parcial_num: p.parcial_num, entidade: p.entidade,
                                    analista_id: p.analista_id, rodada: p.ci_rodada, pcs: [] });
    mapa.get(k).pcs.push(p.codigo_pc);
  });
  return [...mapa.values()];
}

module.exports = {
  SITUACOES, DECISOES, DIRECOES, TEXTO_MIN, TEXTO_MAX,
  fila, contagens, mensagens, validar, gravarMensagem, decidir, responder, agruparPorParcela,
};
