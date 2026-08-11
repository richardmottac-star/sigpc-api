// CAMINHO: sigpc-api/lib/notificacao.js
//
// NOTIFICAÇÕES — gravadas no MOMENTO DO EVENTO, nunca calculadas na leitura.
//
// A diferença importa: calculada na leitura, a notificação some quando a condição deixa de
// valer, e o analista nunca fica sabendo do que aconteceu enquanto ele estava fora. Gravada,
// ela é o registro do fato — continua lá depois de resolvida, e some só quando ele lê.
//
// ⚠️ DEDUPE É O QUE MANTÉM O SINO VIVO.
// O alerta de prazo é reavaliado de hora em hora pelo job. Sem dedupe, a mesma PC vencida
// vira 24 notificações por dia, o sino enche de lixo e ninguém olha mais — o recurso morre
// de excesso, não de falta. A chave é `destinatario_id + tipo + ref_id`.
//
// Não há índice único para isso (exigiria ALTER TABLE, e a tabela é do Richard), então a
// condição vive DENTRO do INSERT. Conferir antes e inserir depois deixaria a fresta de duas
// execuções simultâneas do job passarem as duas.

const TIPOS = ['aprovacao', 'prazo', 'diligencia', 'recado'];

/**
 * Grava uma notificação. Devolve a linha criada, ou `null` quando o dedupe barrou.
 *
 * `ref_id` nulo desliga o dedupe de propósito: dois recados diferentes no mesmo dia são dois
 * recados, não uma repetição.
 */
async function criar(db, n) {
  if (!n || !n.destinatario_id || !n.titulo) return null;
  try {
    const { rows } = await db.query(
      // Os `::` em todos os usos não são enfeite: sem eles o Postgres deduz tipos diferentes
      // para o mesmo parâmetro entre a inserção e a condição, e recusa o comando inteiro
      // ("inconsistent types deduced for parameter"). Aconteceu em 10/08, em produção.
      `INSERT INTO notificacao
         (destinatario_id, tipo, titulo, mensagem, link, ref_tipo, ref_id, urgente, setorial_id)
       SELECT $1::int, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::boolean, $9::text
        WHERE $7::text IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM notificacao x
              WHERE x.destinatario_id = $1::int
                AND x.tipo            = $2::text
                AND x.ref_id          = $7::text)
       RETURNING *`,
      [parseInt(n.destinatario_id), n.tipo || 'recado', String(n.titulo),
       n.mensagem || null, n.link || null, n.ref_tipo || null,
       n.ref_id != null ? String(n.ref_id) : null, !!n.urgente, n.setorial_id || null]);
    return rows[0] || null;
  } catch (e) {
    // Notificação nunca pode derrubar a ação que a originou: aprovar um pedido tem de
    // funcionar mesmo que o sino esteja quebrado.
    return null;
  }
}

/** Grava para várias pessoas. Devolve quantas foram de fato criadas (o dedupe pode barrar). */
async function criarVarios(db, destinatarios, base) {
  let n = 0;
  for (const id of destinatarios || []) {
    if (await criar(db, { ...base, destinatario_id: id })) n++;
  }
  return n;
}

/**
 * Lista as mais recentes. Urgentes primeiro — o que é urgente não pode ficar na página 2.
 *
 * `apenasNaoLidas` é o que o sino usa. A lida sai da vista no instante em que é marcada:
 * antes ela só mudava de cor e continuava ocupando a lista para sempre, então o sino de quem
 * usa o sistema todo dia só crescia e deixava de ser lido.
 * A tela "ver todas" chama sem esse filtro — some da vista, não do registro.
 */
async function listar(db, destinatarioId, limite, apenasNaoLidas) {
  const lim = Math.min(Math.max(parseInt(limite) || 15, 1), 200);
  const { rows } = await db.query(
    `SELECT * FROM notificacao
      WHERE destinatario_id = $1
        AND ($3::boolean IS NOT TRUE OR lida_em IS NULL)
      ORDER BY (lida_em IS NULL AND urgente) DESC, criado_em DESC
      LIMIT $2`, [parseInt(destinatarioId), lim, !!apenasNaoLidas]);
  return rows;
}

/**
 * Apaga notificação LIDA passada do prazo. O prazo vem de fora (`job_notificacoes.js`), para
 * ficar ao lado do CORTE_PRAZO, num lugar só.
 *
 * ⚠️ `lida_em IS NOT NULL` é a trava que importa: notificação NÃO LIDA nunca é apagada, por
 * mais antiga que seja. Quem passou um mês fora encontra tudo o que perdeu.
 *
 * E o relógio conta a partir da LEITURA, não da criação — senão quem volta de férias leria
 * hoje um aviso que sumiria amanhã.
 */
async function limparLidas(db, dias) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM notificacao
        WHERE lida_em IS NOT NULL
          AND lida_em < NOW() - (INTERVAL '1 day' * $1::int)`, [parseInt(dias)]);
    return rowCount || 0;
  } catch (e) { return 0; }
}

async function contarNaoLidas(db, destinatarioId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int n FROM notificacao
      WHERE destinatario_id = $1 AND lida_em IS NULL`, [parseInt(destinatarioId)]);
  return rows[0].n;
}

/**
 * Marca uma como lida. O `destinatario_id` entra no WHERE, e não numa leitura antes: assim
 * ninguém marca a notificação de outro sabendo só o id.
 *
 * `lida_em IS NULL` evita que reler mude a hora da primeira leitura.
 */
async function marcarLida(db, id, destinatarioId) {
  const { rows } = await db.query(
    `UPDATE notificacao SET lida_em = NOW()
      WHERE id = $1 AND destinatario_id = $2 AND lida_em IS NULL
      RETURNING *`, [parseInt(id), parseInt(destinatarioId)]);
  return rows[0] || null;
}

async function marcarTodas(db, destinatarioId) {
  const { rowCount } = await db.query(
    `UPDATE notificacao SET lida_em = NOW()
      WHERE destinatario_id = $1 AND lida_em IS NULL`, [parseInt(destinatarioId)]);
  return rowCount || 0;
}

/**
 * Quem recebe o aviso no lugar do coordenador do grupo.
 *
 * O Grupo 3 não tem coordenador cadastrado em `usuarios` (o Gustavo nunca foi criado). Sem
 * este cai-para-o-superadmin, todo aviso do Grupo 3 — o maior, com 17 analistas — sumiria
 * sem erro nenhum, e ninguém descobriria.
 */
async function coordenadoresDoGrupo(db, grupo) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM usuarios WHERE perfil = 'coordenador' AND grupo = $1`, [String(grupo || '')]);
    if (rows.length) return rows.map(r => r.id);
    const sup = await db.query(`SELECT id FROM usuarios WHERE perfil = 'superadmin'`);
    return sup.rows.map(r => r.id);
  } catch (e) { return []; }
}

module.exports = {
  TIPOS, criar, criarVarios, listar, contarNaoLidas, limparLidas,
  marcarLida, marcarTodas, coordenadoresDoGrupo,
};
