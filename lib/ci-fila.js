// CAMINHO: sigpc-api/lib/ci-fila.js
//
// A FILA DE TRABALHO DO CONTROLE INTERNO — quem está com qual TR.  (24/08/2026)
//
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA
//
// Os três técnicos do C.I. olhavam a MESMA fila. Medido em 24/08: 1.144 PCs `na_fila`, em
// 725 parcelas de 214 TRs. Nada no banco dizia quem estava com o quê — dois podiam abrir a
// mesma TR ao mesmo tempo, ou nenhum abrir, cada um supondo que o outro já tinha pegado.
//
// A unidade de trabalho aqui é a TR, e não a parcela: é a TR que a pessoa abre e analisa.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ QUEM É TÉCNICO DO C.I. TEM UMA FONTE SÓ: `usuarios.perfil = 'controle_interno'`.
// É a mesma que o `POST /ci/responder` já usava para avisar o C.I., a mesma do
// `contaProdutividade` da tela e a mesma da regra dos três ids do CLAUDE.md. Uma lista
// paralela aqui — por id, por nome, por flag nova — seria uma segunda resposta para a
// pergunta "quem é do C.I.", e um dia as duas divergiriam sem erro nenhum.

const papel = require('./papel');

const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;

// ⚠️ SÓ AS TRs QUE ESTÃO NA FILA. `ci_situacao = 'na_fila'` é o mesmo filtro do `ci.fila`, e
// não `enviado_ci` — as duas colunas respondem perguntas diferentes: `enviado_ci` diz "foi ao
// C.I." e sustenta a baixa; `ci_situacao` diz onde está no ciclo. Confundi-las foi o defeito
// que o ciclo do C.I. corrigiu em 12/08.
const SQL_FILA = `
  SELECT p.tr,
         MAX(p.entidade)                                   AS entidade,
         COUNT(*)::int                                     AS pcs,
         COUNT(DISTINCT p.parcial_num)::int                AS parcelas,
         MAX(p.analista_nome)                              AS analista_nome,
         MAX(p.analista_id)                                AS analista_id,
         MIN(p.dt_envio_ci)                                AS enviada_em,
         MAX(p.setorial_id)                                AS setorial_id,
         r.tecnico_id, r.tecnico_nome, r.assumida_em
    FROM prestacoes_contas p
    LEFT JOIN ci_responsavel r ON r.tr = p.tr AND r.setorial_id = p.setorial_id
   WHERE p.ci_situacao = 'na_fila'
   GROUP BY p.tr, r.tecnico_id, r.tecnico_nome, r.assumida_em
   ORDER BY MIN(p.dt_envio_ci) NULLS LAST, p.tr`;

const SQL_TECNICOS = `
  SELECT id, nome FROM usuarios
   WHERE perfil = 'controle_interno' AND ativo = true ORDER BY nome`;

/**
 * Dias de espera desde o encaminhamento, em DIAS CIVIS.
 *
 * ⚠️ A CONTA É SOBRE A DATA DO CALENDÁRIO, NUNCA SOBRE O INSTANTE — e isto custou uma
 * checagem vermelha antes de existir. A primeira versão fazia `new Date(String(valor))` e
 * subtraía: com o texto ISO `2026-07-30T00:00:00.000Z`, o `Z` é lido como UTC, em Brasília
 * vira 29/07 às 21h, e a espera dava 26 dias em vez de 25. É a mesma família das armadilhas
 * 18 e 25 do CLAUDE.md — `dt_envio_ci` é `timestamp WITHOUT time zone` guardando UTC, e o
 * driver entrega ora `Date`, ora texto, conforme o caminho.
 *
 * Comparando só ano/mês/dia, os dois caminhos dão a mesma resposta, que é a que o técnico
 * lê na etiqueta: "há quantos dias esta TR está parada".
 */
function partesData(v) {
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return [v.getFullYear(), v.getMonth(), v.getDate()];
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return [+m[1], +m[2] - 1, +m[3]];
  const d = new Date(String(v));
  return isNaN(d) ? null : [d.getFullYear(), d.getMonth(), d.getDate()];
}

function diasEspera(enviadaEm, hoje) {
  if (!enviadaEm) return null;
  const a = partesData(enviadaEm);
  if (!a) return null;
  const b = partesData(hoje instanceof Date ? hoje : new Date());
  if (!b) return null;
  return Math.round((Date.UTC(b[0], b[1], b[2]) - Date.UTC(a[0], a[1], a[2])) / 86400000);
}

/**
 * A faixa de espera. Três, e são as mesmas cores da tela.
 *
 * ⚠️ AS BORDAS MORAM AQUI, num lugar só. Enquanto a etiqueta, o chip "Mais de 30 dias" e o
 * card do painel tivessem cada um a sua comparação, bastava mexer numa para a linha ficar
 * âmbar e sumir do chip que deveria contá-la.
 */
function faixaEspera(dias) {
  if (dias === null || dias === undefined) return null;
  if (dias > 30) return 'critica';
  if (dias > 15) return 'atencao';
  return 'ok';
}

/**
 * Quem pode mexer na fila do C.I.?
 *
 * ⚠️ Os três técnicos podem TODAS as três ações, inclusive sobre TR de outro — foi decisão
 * do Richard, e é o que faz o "passar a outro" existir. O superadmin entra pelo
 * `perfilEfetivo`, que é a regra única das rotas desde 14/08: no papel analista ele É
 * analista, e não passa aqui.
 */
function podeAgir(u) {
  if (!u) return false;
  const p = papel.perfilEfetivo(u);
  return p === 'controle_interno' || p === 'superadmin';
}

/** O motivo serve? Devolve a mensagem de erro, ou null. */
function validarMotivo(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return 'O motivo é obrigatório.';
  if (t.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;
  if (t.length > MOTIVO_MAX) return `O motivo passa de ${MOTIVO_MAX} caracteres.`;
  return null;
}

/**
 * Monta os números que a tela desenha: os chips e a distribuição da equipe.
 *
 * ⚠️ CALCULADO AQUI, e não no SQL, de propósito: os cinco chips e os quatro cards são
 * recortes da MESMA lista que já veio. Somá-los no banco seria repetir a consulta cinco
 * vezes e abrir a porta para o chip dizer 12 e a lista mostrar 11 — fotos de instantes
 * diferentes. Ver o comentário do `GET /prestacoes_contas/painel`.
 */
function resumir(linhas, tecnicos, meuId) {
  const eu = parseInt(meuId) || 0;
  const chips = {
    todas:     linhas.length,
    livres:    linhas.filter(l => !l.tecnico_id).length,
    minhas:    linhas.filter(l => l.tecnico_id === eu).length,
    outros:    linhas.filter(l => l.tecnico_id && l.tecnico_id !== eu).length,
    mais30:    linhas.filter(l => faixaEspera(l.dias_espera) === 'critica').length,
  };
  // Um card por técnico, na ordem em que os técnicos vieram — a COR sai da posição, na tela.
  // Fixar cor por nome quebraria no dia em que a equipe mudasse, e ela já mudou uma vez.
  const equipe = (tecnicos || []).map(t => ({
    tecnico_id: t.id, nome: t.nome,
    trs: linhas.filter(l => l.tecnico_id === t.id).length,
    pcs: linhas.filter(l => l.tecnico_id === t.id).reduce((s, l) => s + (l.pcs || 0), 0),
  }));
  equipe.push({
    tecnico_id: null, nome: 'Sem responsável',
    trs: chips.livres,
    pcs: linhas.filter(l => !l.tecnico_id).reduce((s, l) => s + (l.pcs || 0), 0),
  });
  return { chips, equipe,
           total_trs: linhas.length,
           total_pcs: linhas.reduce((s, l) => s + (l.pcs || 0), 0) };
}

// ── As três escritas ────────────────────────────────────────────────────────
//
// ⚠️ AS TRÊS GRAVAM NO `parcela_historico`, com `parcial_num` NULO: o responsável é da TR, e
// inventar uma parcela para caber na tabela faria a linha aparecer no histórico de UMA
// parcela e sumir do das outras. O histórico da TR lê por `tr`, então a linha aparece inteira.
//
// A autoria segue a convenção de 14/08: `analista_id` é o DONO do trabalho e `executado_por`
// é QUEM CLICOU, nulo quando são a mesma pessoa.

const SQL_HIST = `
  INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo,
                                 analista_id, executado_por, observacao, criado_em)
  VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, NOW())`;

/**
 * Assumir. Sem motivo — é o ato normal, e exigir justificativa para trabalhar seria atrito
 * sem resposta a dar.
 *
 * ⚠️ A TRAVA É O `WHERE NOT EXISTS`, DENTRO DO INSERT, e não uma leitura antes. Dois cliques
 * simultâneos passariam os dois por uma conferência feita fora do comando; aqui o segundo
 * não encontra linha para inserir e devolve `jaTem`. É a mesma escolha do dedupe do sino.
 */
async function assumir(db, { tr, setorial_id, quem }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(
      `INSERT INTO ci_responsavel (tr, setorial_id, tecnico_id, tecnico_nome)
       SELECT $1::text, $2::text, $3::int, $4::text
        WHERE NOT EXISTS (SELECT 1 FROM ci_responsavel WHERE tr = $1::text AND setorial_id = $2::text)
       RETURNING *`, [tr, setorial_id, quem.id, quem.nome]);
    if (!r.rows.length) {
      await cli.query('ROLLBACK');
      const dono = await db.query(
        `SELECT tecnico_id, tecnico_nome FROM ci_responsavel WHERE tr = $1 AND setorial_id = $2`,
        [tr, setorial_id]);
      return { ok: false, jaTem: dono.rows[0] || null };
    }
    await cli.query(SQL_HIST, [tr, setorial_id, 'ci_assumiu', null, quem.nome,
                               quem.id, null, `${quem.nome} assumiu a demanda do Controle Interno.`]);
    await cli.query('COMMIT');
    return { ok: true, linha: r.rows[0] };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/** Devolver à fila. Motivo obrigatório — a TR volta a ficar livre para qualquer um. */
async function devolver(db, { tr, setorial_id, quem, motivo }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(
      `DELETE FROM ci_responsavel WHERE tr = $1 AND setorial_id = $2 RETURNING *`, [tr, setorial_id]);
    if (!r.rows.length) { await cli.query('ROLLBACK'); return { ok: false, semDono: true }; }
    const antigo = r.rows[0];
    // O DONO da linha é quem estava com a TR; o EXECUTOR é quem clicou, e some quando são o
    // mesmo. É a linha em que os dois diferem que interessa achar depois.
    const executor = antigo.tecnico_id === quem.id ? null : quem.id;
    await cli.query(SQL_HIST, [tr, setorial_id, 'ci_devolveu', antigo.tecnico_nome, null,
                               antigo.tecnico_id, executor,
                               `Devolvida à fila do Controle Interno` +
                               (executor ? ` por ${quem.nome}` : '') + `. Motivo: ${String(motivo).trim()}`]);
    await cli.query('COMMIT');
    return { ok: true, antigo };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * Passar a outro técnico. Motivo obrigatório.
 *
 * ⚠️ É UM `INSERT ... ON CONFLICT`, e não delete-e-insere: a TR nunca fica sem dono no meio
 * da operação. Entre um DELETE e um INSERT, mesmo na mesma transação, uma falha deixaria a
 * demanda órfã sem ninguém perceber — e órfã é exatamente o estado que esta tela existe para
 * acabar.
 */
async function passar(db, { tr, setorial_id, quem, destino, motivo }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const antes = await cli.query(
      `SELECT * FROM ci_responsavel WHERE tr = $1 AND setorial_id = $2 FOR UPDATE`, [tr, setorial_id]);
    const antigo = antes.rows[0] || null;
    const r = await cli.query(
      `INSERT INTO ci_responsavel (tr, setorial_id, tecnico_id, tecnico_nome)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tr, setorial_id) DO UPDATE
          SET tecnico_id = EXCLUDED.tecnico_id, tecnico_nome = EXCLUDED.tecnico_nome,
              atualizado_em = NOW()
       RETURNING *`, [tr, setorial_id, destino.id, destino.nome]);
    // O novo dono é o `analista_id`; quem clicou fica no `executado_por` quando não é ele.
    const executor = destino.id === quem.id ? null : quem.id;
    await cli.query(SQL_HIST, [tr, setorial_id, 'ci_passou',
                               antigo ? antigo.tecnico_nome : null, destino.nome,
                               destino.id, executor,
                               `${quem.nome} passou a demanda para ${destino.nome}. ` +
                               `Motivo: ${String(motivo).trim()}`]);
    await cli.query('COMMIT');
    return { ok: true, antigo, linha: r.rows[0] };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * O rótulo de cada evento no histórico da TR. Vem do Richard, e é frase, não código:
 * quem abre a trilha meses depois precisa entender sem manual.
 */
const ROTULO_EVENTO = {
  ci_assumiu:  'assumiu a demanda',
  ci_devolveu: 'devolveu à fila',
  ci_passou:   'passou a demanda',
};

module.exports = {
  MOTIVO_MIN, MOTIVO_MAX, SQL_FILA, SQL_TECNICOS, ROTULO_EVENTO,
  diasEspera, faixaEspera, podeAgir, validarMotivo, resumir, assumir, devolver, passar,
};
