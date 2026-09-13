// CAMINHO: sigpc-api/baixar_34trs_sigef_20260913.js
//
// ASSUME E BAIXA AS PCs ABERTAS DE 34 TRs EM NOME DO RICHARD (id 4) — pareceres ja emitidos no
// SIGEF, parte ANTES e parte DEPOIS do inicio do GT (12/08/2025).
// PADRAO = DRY-RUN: faz tudo numa transacao, roda as conferencias e da ROLLBACK.
// So da COMMIT com `--gravar`, e so se TODAS as conferencias passarem.
//
// ─────────────────────────────────────────────────────────────────────────────
// O CASO — decisao do Richard, 13/09/2026. Segunda operacao, separada da de 13 TRs
// (`baixar_13trs_sigef_20260913.js`, commit 2c07868).
//
// As 34 TRs sao as que a tabela por TR marcou como "parte": a pilula "Baixada no SIGEF, aberta
// aqui" em PCs com `data_baixa_sigef` dos DOIS lados do corte do GT. Fica fora a 2022TR000860,
// que tem todas as datas antes do GT.
//
// ⚠️ DUAS DATAS DE BAIXA, conforme o parecer do SIGEF:
//   · `data_baixa_sigef >= 12/08/2025` -> `data_baixa` = HOJE. Conta produtividade.
//   · `data_baixa_sigef <  12/08/2025` -> `data_baixa` = a propria `data_baixa_sigef`. NAO conta:
//     cai antes do corte do GT (SQL_PRE_GT, que le `data_baixa_sigef`). E o efeito pretendido —
//     o trabalho anterior ao GT nao e do Richard; as duas baixas existem para a TR concluir.
//
// ⚠️ A DATA DO SIGEF VAI COMO MEIA-NOITE DE BRASILIA, gravada em UTC como toda `data_baixa`
// (NOW() num servidor em UTC). Gravar a meia-noite UTC faria a tela, que converte para
// Brasilia, mostrar o dia ANTERIOR.
//
// ⚠️ O MESMO CAMINHO DA OPERACAO DE 13 TRs: numa transacao so, o codigo das rotas
// (`limiteTr.podeAssumirTr`, `assumir.SQL_LIVRES`/`SQL_ASSUMIR`, e o UPDATE e o
// `registrarHistorico` de `POST /parcela/parecer`, copiados). Depois do UPDATE da rota, dois
// ajustes por lista explicita de chaves: a `origem_baixa` ('secretario' quando o sigef_status e
// de Secretario) e a `data_baixa` das PCs anteriores ao GT.
//
// ⚠️ `parecer_tipo` DERIVADO do `sigef_status`, sem inventar; NAO VAI AO CONTROLE INTERNO, e o
// motivo vai na observacao do evento `parecer`.
//
// USO
//   node baixar_34trs_sigef_20260913.js            dry-run: faz, confere e desfaz
//   node baixar_34trs_sigef_20260913.js --gravar   faz, confere e so entao COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');
const assumir = require('./lib/assumir');
const limiteTr = require('./lib/limite-tr');
const inval = require('./lib/invalidada');
const sigef = require('./lib/sigef');
const { HOJE_BR } = require('./lib/datas');

const GRAVAR = process.argv.includes('--gravar');
const SUPER = 4;           // Richard, superadmin — o dono das PCs
const SETORIAL = 'FCEE';
const REVERSAO = path.join(__dirname, GRAVAR
  ? 'reverter_baixar_34trs_sigef_20260913.json'
  : 'reverter_baixar_34trs_sigef_20260913_DRYRUN.json');

// TR -> a parcial aberta dela. A final de cada uma e `${tr}-PFINAL`.
// ⚠️ LISTA EXPLICITA DE CHAVES (armadilha 11): o criterio e recalculado na foto e tem de dar
// EXATAMENTE estas 68; se divergir, o script para antes de escrever.
const PARCIAL_DA_TR = {
  '2021TR002344': '2021PC002566', '2021TR001774': '2021PC002524', '2021TR002408': '2022PC000005',
  '2021TR002114': '2021PC002305', '2021TR002180': '2021PC002456', '2021TR002405': '2022PC000020',
  '2021TR001562': '2021PC002033', '2021TR002237': '2021PC002460', '2021TR001559': '2021PC002050',
  '2022TR000279': '2022PC000318', '2021TR002184': '2021PC002379', '2022TR000303': '2022PC000255',
  '2022TR000302': '2022PC000254', '2021TR002089': '2021PC002303', '2021TR002181': '2021PC002457',
  '2022TR000227': '2022PC000257', '2021TR001560': '2021PC002051', '2021TR002017': '2021PC002201',
  '2022TR000224': '2022PC000139', '2022TR000017': '2022PC000068', '2022TR000226': '2022PC000249',
  '2021TR001832': '2022PC000001', '2021TR001880': '2021PC002377', '2021TR002075': '2021PC002304',
  '2022TR000361': '2022PC000768', '2021TR002220': '2021PC002452', '2021TR001558': '2021PC002000',
  '2021TR002342': '2022PC000004', '2022TR000018': '2022PC000069', '2021TR002179': '2021PC002375',
  '2021TR002347': '2022PC000021', '2021TR001881': '2021PC002378', '2022TR000420': '2022PC000763',
  '2022TR000421': '2022PC000764',
};
const TRS = Object.keys(PARCIAL_DA_TR);
const ALVO = TRS.flatMap((tr) => [PARCIAL_DA_TR[tr], `${tr}-PFINAL`]);
const ESPERADO = { pcs: 68, finais: 34, parciais: 34, trs: 34 };
const FORA = '2022TR000860';   // todas as datas antes do GT — nao entra

// O periodo do Quadro 2 do CGE: o `value` padrao do campo Data Inicial (`cgeDtInicio`, index.html)
// ate o fim de hoje.
const CGE_INICIO = '2025-08-01';

// Copia de `PARECERES_VALIDOS` do server.js (la nao e exportada).
const PARECERES_VALIDOS = ['Parecer Regular', 'Parecer Regular com Ressalvas', 'Parecer Irregular'];

// sigef_status -> parecer_tipo. Uma entrada para cada valor de `sigef.SIGEF_BAIXA`, conferido no
// inicio: valor novo na lista sem entrada aqui para o script.
const REG = 'Parecer Regular';
const RES = 'Parecer Regular com Ressalvas';
const PARECER_DO_SIGEF = {
  'AV': REG, 'AT': REG, 'AS': REG,
  'BAIXA REGULAR': REG, 'REGULAR': REG, 'REGULAR - TÉCNICO': REG, 'REGULAR - SECRETÁRIO': REG,
  'SV': RES, 'ST': RES, 'SS': RES,
  'BAIXA REGULAR RESSALVA': RES, 'REGULAR COM RESSALVAS': RES,
  'REGULAR COM RESSALVAS - TÉCNICO': RES, 'REGULAR COM RESSALVAS - SECRETÁRIO': RES,
};
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const parecerDe = (s) => PARECER_DO_SIGEF[norm(s)] || null;

// sigef_status de SECRETARIO -> origem_baixa 'secretario' (o valor exato do Quadro 2 do CGE).
const ORIGEM_SECRETARIO = 'secretario';
const ORIGEM_ROTA = 'sistema';
const SIGEF_SECRETARIO = ['REGULAR - SECRETÁRIO', 'REGULAR COM RESSALVAS - SECRETÁRIO',
  'BAIXA REGULAR', 'BAIXA REGULAR RESSALVA'];
const origemDe = (s) => (SIGEF_SECRETARIO.includes(norm(s)) ? ORIGEM_SECRETARIO : ORIGEM_ROTA);

// A regra da data: antes do GT leva a data do SIGEF, o resto leva hoje.
const ehPreGt = (j) => j.data_baixa_sigef != null && String(j.data_baixa_sigef).slice(0, 10) < sigef.INICIO_GT;

// As colunas que os SQLs escrevem. Todo o resto das linhas-alvo tem de sair igual a foto.
const TOCADAS = new Set(['analista_id', 'analista_nome', 'status', 'dt_assumida', 'dt_inicio_analise',
  'atualizado_em', 'baixada', 'data_baixa', 'origem_baixa', 'parecer_tipo', 'registrado_por',
  'baixado_por', 'situacao_atual', 'estornada', 'data_estorno']);

const br = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const motivoCi = (j) => 'Não encaminhado ao Controle Interno: parecer emitido no SIGEF antes de o '
  + 'Controle Interno existir no sistema, não há o que submeter. '
  + `Parecer tomado do SIGEF: ${j.sigef_status}, em ${br(j.data_baixa_sigef)}.`
  + (ehPreGt(j) ? ' Parecer anterior ao início do GT (12/08/2025): baixa registrada com a data do SIGEF, '
                  + 'fora da produtividade.' : '');

const ok = [], mal = [], avisos = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);
const num = (p) => (/^[0-9]+$/.test(String(p || '')) ? parseInt(p, 10) : 999999);
const statusDerivado = (t) => (t.abertas_com_dono === 0 && t.pcs_livres > 0) ? 'livre'
  : t.baixadas >= t.total_pcs ? 'baixada'
  : t.status.includes('reanalise') ? 'reanalise'
  : t.status.includes('diligencia') ? 'diligencia' : 'analise';

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false }, max: 1 });
pool.on('error', (e) => log(`   (aviso: conexao ociosa caiu — ${e.message})`));

// ── o codigo das rotas ──────────────────────────────────────────────────────
// Copia de `carregarParcela` (server.js).
async function carregarParcela(cli, tr, parcial_num, setorial_id) {
  const { rows } = await cli.query(
    `SELECT * FROM prestacoes_contas
      WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3
      ORDER BY codigo_pc
      FOR UPDATE`,
    [setorial_id, tr, String(parcial_num)]);
  return rows;
}

// Copia do UPDATE de `POST /parcela/parecer` — sem os comentarios, SQL identico.
const SQL_PARECER = `
  UPDATE prestacoes_contas
     SET baixada = true,
         status = 'baixada',
         data_baixa = NOW(),
         origem_baixa = 'sistema',
         parecer_tipo = $1,
         analista_id = COALESCE($2, analista_id),
         registrado_por = $3,
         baixado_por = $7,
         situacao_atual = NULL,
         estornada = false,
         data_estorno = NULL,
         atualizado_em = NOW()
   WHERE setorial_id = $4 AND tr = $5 AND parcial_num = $6
     AND baixada = false
   RETURNING codigo_pc`;

// Ajuste 1 — a origem, por lista explicita. So troca o que a rota acabou de gravar.
const SQL_ORIGEM = `
  UPDATE prestacoes_contas
     SET origem_baixa = $2
   WHERE codigo_pc = ANY($1) AND baixada = true AND origem_baixa = '${ORIGEM_ROTA}'
   RETURNING codigo_pc`;

// Ajuste 2 — a data das anteriores ao GT: meia-noite de Brasilia do dia do SIGEF, em UTC naive.
// A condicao repete a regra (`data_baixa_sigef < INICIO_GT`) como trava: uma chave posterior ao
// GT que entrasse na lista por engano nao teria a data trocada.
const SQL_DATA_SIGEF = `
  UPDATE prestacoes_contas
     SET data_baixa = (data_baixa_sigef::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC'
   WHERE codigo_pc = ANY($1) AND baixada = true
     AND data_baixa_sigef IS NOT NULL AND data_baixa_sigef < DATE '${sigef.INICIO_GT}'
   RETURNING codigo_pc`;

// Copia de `registrarHistorico` (server.js).
function registrarHistorico(cli, h) {
  return cli.query(
    `INSERT INTO parcela_historico
       (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
        observacao, executado_por, estado_anterior)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [h.tr, h.parcial_num, h.setorial_id, h.evento,
     h.valor_anterior ?? null, h.valor_novo ?? null, h.analista_id ?? null, h.observacao ?? null,
     h.executado_por ?? null,
     h.estado_anterior == null ? null : JSON.stringify(h.estado_anterior)]);
}

// ── a foto ──────────────────────────────────────────────────────────────────
async function medir(cli, cortes) {
  // row_to_json: o texto do Postgres, sem o Date do JS no meio (armadilha 25).
  const { rows: pcs } = await cli.query(`
    SELECT row_to_json(p) AS j,
           (${sigef.SQL_TAG}) AS sigef_tag,
           (${assumir.PC_LIVRE_SQL}) AS livre,
           ${sigef.SQL_PRE_GT} AS pre_gt,
           (${sigef.SQL_CONTA_PRODUTIVIDADE}) AS sigef_conta,
           (p.data_baixa AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS baixa_br
      FROM prestacoes_contas p WHERE p.tr = ANY($1)
     ORDER BY p.tr, p.parcial_num, p.codigo_pc`, [TRS]);

  // O mesmo agregado da `resumo_tr`, com a invalidada fora, como la.
  const { rows: trs } = await cli.query(`
    SELECT tr, COUNT(*)::int AS total_pcs,
           COUNT(*) FILTER (WHERE baixada)::int AS baixadas,
           COUNT(*) FILTER (WHERE NOT baixada AND analista_id IS NOT NULL)::int AS abertas_com_dono,
           COUNT(*) FILTER (WHERE ${assumir.PC_LIVRE_SQL})::int AS pcs_livres,
           array_agg(DISTINCT status) AS status
      FROM prestacoes_contas p WHERE tr = ANY($1) AND ${inval.ativa('p')}
     GROUP BY tr`, [TRS]);

  // A regra C — a mesma expressao do `regra_c` dos scripts de 03/09 e da operacao de 13 TRs.
  // O CARD e o `sigef_conta` que GET /prestacoes_contas devolve (com a invalidada fora) somado.
  const { rows: [prod] } = await cli.query(`
    SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int AS regra_c,
           COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE} AND ${inval.ativa('p')})::int AS card,
           COUNT(*) FILTER (WHERE ${sigef.SQL_BASE_PRODUTIVIDADE})::int AS base
      FROM prestacoes_contas p WHERE p.analista_id = $1`, [SUPER]);

  // A cumulativa — o SQL de GET /prestacoes_contas/produtividade, em tres cortes.
  const cumul = async (corte) => (await cli.query(`
    SELECT COUNT(*) FILTER (WHERE ${sigef.sqlContaAte('$1')})::int AS total,
           COUNT(*) FILTER (WHERE ${sigef.sqlBaseAte('$1')})::int AS bruto
      FROM prestacoes_contas p
     WHERE (p.estornada = false OR p.data_estorno > $1) AND ${inval.ativaAte('$1', 'p')}
       AND p.analista_id = $2`, [corte, SUPER])).rows[0];
  const cumulPre = await cumul(cortes.pre);
  const cumulOntem = await cumul(cortes.ontem);
  const cumulHoje = await cumul(cortes.hoje);

  const { rows: [nomes] } = await cli.query(`
    SELECT array_agg(DISTINCT analista_nome) AS nomes FROM prestacoes_contas
     WHERE analista_id = $1 AND codigo_pc <> ALL($2)`, [SUPER, ALVO]);

  // A IMPRESSAO DIGITAL DE TODAS AS OUTRAS PCs, linha inteira.
  const { rows: [outras] } = await cli.query(`
    SELECT COUNT(*)::int AS n,
           md5(string_agg(md5(row_to_json(p)::text), '' ORDER BY p.codigo_pc)) AS h
      FROM prestacoes_contas p WHERE p.codigo_pc <> ALL($1)`, [ALVO]);

  const { rows: [hist] } = await cli.query(`
    SELECT COALESCE(MAX(id), 0)::int AS max_id, COUNT(*)::int AS n,
           md5(string_agg(md5(row_to_json(h)::text), '' ORDER BY id)) AS h
      FROM parcela_historico h`);

  const { rows: [vaga] } = await cli.query(`
    SELECT COUNT(*)::int AS n, md5(string_agg(md5(row_to_json(s)::text), '' ORDER BY id)) AS h
      FROM solicitacao_vaga s`);

  // O QUADRO 2 DO CGE — a conta do `cgeAgregar` (index.html), em SQL:
  //   · as PCs sao as de GET /prestacoes_contas?setorial_id=FCEE, que tira a invalidada;
  //   · entram os usuarios do setorial com perfil 'analista', e o superadmin que tem PC;
  //   · conta a PC baixada com `data_baixa` no periodo; 'secretario' e Secretario, o resto Tecnico.
  // ⚠️ E NAO APLICA O CORTE DO GT — o Quadro 2 conta pela `data_baixa`. E por isso que ele e medido
  // a parte: uma PC anterior ao GT com `data_baixa` dentro do periodo aparece nele.
  const { rows: q2rows } = await cli.query(`
    WITH pcs AS (
      SELECT p.analista_id, p.baixada, p.data_baixa, p.origem_baixa
        FROM prestacoes_contas p WHERE p.setorial_id = $1 AND ${inval.ativa('p')}
    ), el AS (
      SELECT u.id FROM usuarios u
       WHERE u.setorial_id = $1
         AND (u.perfil = 'analista'
              OR (u.perfil = 'superadmin' AND EXISTS (SELECT 1 FROM pcs WHERE pcs.analista_id = u.id)))
    )
    SELECT (pcs.analista_id = $4) AS richard,
           COUNT(*) FILTER (WHERE pcs.origem_baixa = '${ORIGEM_SECRETARIO}')::int AS sec,
           COUNT(*) FILTER (WHERE pcs.origem_baixa IS DISTINCT FROM '${ORIGEM_SECRETARIO}')::int AS tec
      FROM pcs JOIN el ON el.id = pcs.analista_id
     WHERE pcs.baixada = true AND pcs.data_baixa >= $2 AND pcs.data_baixa <= $3
     GROUP BY 1`, [SETORIAL, cortes.cge_ini, cortes.hoje, SUPER]);
  const q2 = { sec: 0, tec: 0, secR: 0, tecR: 0 };
  for (const r of q2rows) {
    q2.sec += r.sec; q2.tec += r.tec;
    if (r.richard) { q2.secR += r.sec; q2.tecR += r.tec; }
  }

  return { pcs, trs, prod, cumulPre, cumulOntem, cumulHoje, nomes: nomes.nomes || [], outras, hist, vaga, q2 };
}

(async () => {
  let cli = null, emTransacao = false;
  const t0 = Date.now();
  log(`\n${'═'.repeat(78)}`);
  log(` ASSUMIR E BAIXAR AS PCs DE 34 TRs   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (faz, confere e desfaz)'}`);
  log(`${'═'.repeat(78)}`);
  try {
    const faltaNoMapa = sigef.SIGEF_BAIXA.filter((v) => !PARECER_DO_SIGEF[v]);
    if (faltaNoMapa.length) throw new Error(`sigef_status sem parecer no mapa: ${faltaNoMapa.join(', ')}`);
    if (new Set(ALVO).size !== ESPERADO.pcs || TRS.length !== ESPERADO.trs) throw new Error('a lista ALVO nao tem 68 chaves distintas em 34 TRs');
    if (TRS.includes(FORA)) throw new Error(`${FORA} nao pode estar na lista`);

    cli = await pool.connect();
    await cli.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    emTransacao = true;

    const { rows: [quem] } = await cli.query(
      `SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [SUPER]);
    if (!quem) throw new Error(`usuario ${SUPER} nao encontrado`);
    const nome = assumir.nomeCurto(quem.nome);

    // Os cortes, em Brasilia, no formato naive-UTC em que `data_baixa` e gravada:
    //   pre   = fim do dia do parecer mais recente ANTERIOR ao GT, entre as 68
    //   ontem = fim de ontem · hoje = fim de hoje · cge_ini = inicio do periodo padrao do CGE
    const fmt = `'YYYY-MM-DD HH24:MI:SS.US'`;
    const { rows: [cortes] } = await cli.query(`
      SELECT to_char(ini - INTERVAL '1 microsecond', ${fmt}) AS ontem,
             to_char(ini + INTERVAL '1 day' - INTERVAL '1 microsecond', ${fmt}) AS hoje,
             ${HOJE_BR}::text AS hoje_br,
             to_char((DATE '${CGE_INICIO}'::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC', ${fmt}) AS cge_ini,
             (SELECT to_char(((MAX(data_baixa_sigef) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
                             AT TIME ZONE 'UTC' - INTERVAL '1 microsecond', ${fmt})
                FROM prestacoes_contas WHERE codigo_pc = ANY($1)
                 AND data_baixa_sigef < DATE '${sigef.INICIO_GT}') AS pre,
             (SELECT MAX(data_baixa_sigef)::text FROM prestacoes_contas WHERE codigo_pc = ANY($1)
                 AND data_baixa_sigef < DATE '${sigef.INICIO_GT}') AS pre_dia
        FROM (SELECT ((${HOJE_BR})::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC' AS ini) x`, [ALVO]);
    if (!cortes.pre) throw new Error('nenhuma das 68 tem data anterior ao GT — nao e o caso descrito');

    // ── 1. A FOTO, ANTES ────────────────────────────────────────────────────
    const antes = await medir(cli, cortes);
    const porCod = new Map(antes.pcs.map((r) => [r.j.codigo_pc, r]));
    log(`\n── 1. A FOTO, ANTES ──────────────────────────────────────────────────────`);
    log(`   hoje (Brasilia) ${br(cortes.hoje_br)} · usuario ${quem.id} ${quem.nome} (${quem.perfil}, papel ${quem.papel_ativo}) · rotulo "${nome}"`);
    log(`   Richard: regra C ${antes.prod.regra_c} · card ${antes.prod.card} · base ${antes.prod.base}`);
    log(`   cumulativa: ate ${br(cortes.pre_dia)} ${antes.cumulPre.total} · ate ontem ${antes.cumulOntem.total} · ate hoje ${antes.cumulHoje.total}`);
    log(`   acervo: ${antes.outras.n} outras PCs · md5 ${String(antes.outras.h).slice(0, 16)}…`
      + ` · historico ${antes.hist.n} linhas (max id ${antes.hist.max_id})`);

    // ── 2. A CONTAGEM, CONFIRMADA ANTES DE ESCREVER ─────────────────────────
    log(`\n── 2. A CONTAGEM — o criterio recalculado tem de dar a lista ──────────────`);
    const ativas = antes.pcs.filter((r) => !r.j.invalidada);
    const criterio = ativas.filter((r) => r.j.baixada === false && r.j.analista_id == null
      && sigef.ehBaixaSigef(r.j.sigef_status));
    const codCrit = new Set(criterio.map((r) => r.j.codigo_pc));

    // IDEMPOTENCIA: se as 68 ja estao baixadas em nome do Richard, nao ha nada a fazer.
    const jaFeitas = ALVO.filter((c) => porCod.get(c) && porCod.get(c).j.baixada === true
      && porCod.get(c).j.analista_id === SUPER);
    if (jaFeitas.length === ESPERADO.pcs) {
      log(`   as ${ESPERADO.pcs} ja estao baixadas em nome do id ${SUPER}. NADA A FAZER.`);
      await cli.query('ROLLBACK'); emTransacao = false;
      return;
    }

    const finais = criterio.filter((r) => r.j.tipo === 'final').length;
    const trsCrit = new Set(criterio.map((r) => r.j.tr)).size;
    log(`   pelo criterio: ${criterio.length} PCs (${finais} finais · ${criterio.length - finais} parciais) em ${trsCrit} TRs`);
    const divergencias = [];
    if (criterio.length !== ESPERADO.pcs) divergencias.push(`PCs ${criterio.length} != ${ESPERADO.pcs}`);
    if (finais !== ESPERADO.finais) divergencias.push(`finais ${finais} != ${ESPERADO.finais}`);
    if (criterio.length - finais !== ESPERADO.parciais) divergencias.push(`parciais ${criterio.length - finais} != ${ESPERADO.parciais}`);
    if (trsCrit !== ESPERADO.trs) divergencias.push(`TRs ${trsCrit} != ${ESPERADO.trs}`);
    const sobra = [...codCrit].filter((c) => !ALVO.includes(c));
    const falta = ALVO.filter((c) => !codCrit.has(c));
    if (sobra.length) divergencias.push(`no criterio e fora da lista: ${sobra.join(', ')}`);
    if (falta.length) divergencias.push(`na lista e fora do criterio: ${falta.join(', ')}`);
    const outrasAbertas = ativas.filter((r) => r.j.baixada === false && !ALVO.includes(r.j.codigo_pc));
    if (outrasAbertas.length) divergencias.push(`outras PCs abertas nessas TRs: ${outrasAbertas.map((r) => r.j.codigo_pc).join(', ')}`);
    const naoLivre = ALVO.filter((c) => porCod.get(c) && !porCod.get(c).livre);
    if (naoLivre.length) divergencias.push(`o assumir nao pegaria (nao livres): ${naoLivre.join(', ')}`);
    const semParecer = ALVO.filter((c) => porCod.get(c) && !PARECERES_VALIDOS.includes(parecerDe(porCod.get(c).j.sigef_status)));
    if (semParecer.length) divergencias.push(`sem parecer derivavel: ${semParecer.join(', ')}`);
    const semData = ALVO.filter((c) => porCod.get(c) && !porCod.get(c).j.data_baixa_sigef);
    if (semData.length) divergencias.push(`sem data_baixa_sigef: ${semData.join(', ')}`);
    const naEng = ALVO.filter((c) => porCod.get(c) && porCod.get(c).j.eng_situacao);
    if (naEng.length) divergencias.push(`na engenharia: ${naEng.join(', ')}`);
    const noCi = ALVO.filter((c) => porCod.get(c) && porCod.get(c).j.enviado_ci === true);
    if (noCi.length) divergencias.push(`ja enviadas ao C.I.: ${noCi.join(', ')}`);
    const outroSetorial = ALVO.filter((c) => porCod.get(c) && porCod.get(c).j.setorial_id !== SETORIAL);
    if (outroSetorial.length) divergencias.push(`setorial diferente de ${SETORIAL}: ${outroSetorial.join(', ')}`);
    // "parte": toda TR tem de ter datas dos DOIS lados do corte do GT.
    const semDoisLados = TRS.filter((tr) => {
      const js = ALVO.filter((c) => porCod.get(c) && porCod.get(c).j.tr === tr).map((c) => porCod.get(c).j);
      return !(js.some(ehPreGt) && js.some((j) => !ehPreGt(j)));
    });
    if (semDoisLados.length) divergencias.push(`TR sem datas dos dois lados do GT: ${semDoisLados.join(', ')}`);
    if (divergencias.length) {
      log(`   ⛔ A CONTAGEM DIVERGE — nada foi escrito:`);
      divergencias.forEach((d) => log(`      · ${d}`));
      throw new Error('contagem divergente; parado antes de escrever');
    }
    const alvoJ = ALVO.map((c) => porCod.get(c).j);
    const doSigef = alvoJ.filter(ehPreGt).map((j) => j.codigo_pc);
    const deHoje = alvoJ.filter((j) => !ehPreGt(j)).map((j) => j.codigo_pc);
    const preNoPeriodoCge = alvoJ.filter((j) => ehPreGt(j) && String(j.data_baixa_sigef) >= CGE_INICIO);
    log(`   ✓ 68 PCs = 34 finais + 34 parciais em 34 TRs — bate com a lista. Nenhuma outra PC aberta nessas TRs.`);
    log(`\n   ▶ ENTRAM COM DATA DE HOJE:     ${deHoje.length} PCs (parecer no SIGEF a partir de ${br(sigef.INICIO_GT)}) — contam produtividade`);
    log(`   ▶ ENTRAM COM A DATA DO SIGEF:  ${doSigef.length} PCs (parecer no SIGEF antes de ${br(sigef.INICIO_GT)}) — NAO contam`);
    log(`     (hoje: ${alvoJ.filter((j) => !ehPreGt(j)).filter((j) => j.tipo === 'final').length} finais · `
      + `${alvoJ.filter((j) => !ehPreGt(j)).filter((j) => j.tipo !== 'final').length} parciais   |   `
      + `SIGEF: ${alvoJ.filter(ehPreGt).filter((j) => j.tipo === 'final').length} finais · `
      + `${alvoJ.filter(ehPreGt).filter((j) => j.tipo !== 'final').length} parciais)`);

    // ── 3. O PLANO ──────────────────────────────────────────────────────────
    log(`\n── 3. O PLANO — por TR: assumir, depois um parecer por parcela ───────────`);
    const plano = TRS.map((tr) => {
      const pcs = alvoJ.filter((j) => j.tr === tr)
        .sort((a, b) => num(a.parcial_num) - num(b.parcial_num) || a.codigo_pc.localeCompare(b.codigo_pc));
      return { tr, pcs, parcelas: [...new Set(pcs.map((j) => j.parcial_num))] };
    });
    for (const p of plano) {
      log(`   ${p.tr}`);
      for (const j of p.pcs)
        log(`      ${String(j.parcial_num).padEnd(6)} ${j.codigo_pc.padEnd(20)} ${String(j.sigef_status).padEnd(35)}`
          + ` ${br(j.data_baixa_sigef)}  →  ${parecerDe(j.sigef_status).padEnd(30)} baixa em `
          + `${ehPreGt(j) ? br(j.data_baixa_sigef) + ' (SIGEF)' : 'hoje'}`);
    }

    // ── 4. A MUDANCA ────────────────────────────────────────────────────────
    log(`\n── 4. A MUDANCA (dentro da transacao) ────────────────────────────────────`);
    const inseridos = [];
    let secretario = 0, datasTrocadas = 0;
    for (const p of plano) {
      // assumir — o mesmo que POST /tr/assumir
      const chk = await limiteTr.podeAssumirTr(cli, quem, p.tr);
      if (!chk.pode) throw new Error(`${p.tr}: a trava recusou — ${chk.motivo}`);
      if (chk.autorizacao) throw new Error(`${p.tr}: a trava pediu autorizacao de vaga extra, inesperado para superadmin`);
      const { rows: livres } = await cli.query(assumir.SQL_LIVRES, [SETORIAL, p.tr]);
      const codigos = livres.map((r) => r.codigo_pc);
      const esperados = p.pcs.map((j) => j.codigo_pc).sort();
      if (JSON.stringify([...codigos].sort()) !== JSON.stringify(esperados))
        throw new Error(`${p.tr}: o assumir pegaria ${codigos.join(',')} e o alvo e ${esperados.join(',')}`);
      const { rows: feitas } = await cli.query(assumir.SQL_ASSUMIR, [codigos, quem.id, nome]);
      if (feitas.length !== codigos.length) throw new Error(`${p.tr}: assumiu ${feitas.length} de ${codigos.length}`);
      const { rows: [ha] } = await cli.query(
        `INSERT INTO parcela_historico
           (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
         VALUES ($1, NULL, $2, 'assumir_tr', 'livre', $3, $4, $5)
         RETURNING id`,
        [p.tr, SETORIAL, nome, quem.id, `${feitas.length} PCs assumidas`]);
      inseridos.push(ha.id);

      // baixar — o mesmo que POST /parcela/parecer, uma vez por parcela
      let baixadasTr = 0;
      for (const parcial_num of p.parcelas) {
        const pcs = await carregarParcela(cli, p.tr, parcial_num, SETORIAL);
        if (!pcs.length) throw new Error(`${p.tr} parcela ${parcial_num}: nao encontrada`);
        if (pcs.every((x) => x.baixada === true)) throw new Error(`${p.tr} parcela ${parcial_num}: ja baixada`);
        const donoOutro = pcs.find((x) => x.analista_id != null && String(x.analista_id) !== String(SUPER));
        if (donoOutro) throw new Error(`${p.tr} parcela ${parcial_num}: pertence ao id ${donoOutro.analista_id}`);
        const abertas = pcs.filter((x) => x.baixada === false);
        const intrusa = abertas.find((x) => !ALVO.includes(x.codigo_pc));
        if (intrusa) throw new Error(`${p.tr} parcela ${parcial_num}: ${intrusa.codigo_pc} esta aberta e fora do alvo`);
        const pareceres = [...new Set(abertas.map((x) => parecerDe(x.sigef_status)))];
        if (pareceres.length !== 1 || !PARECERES_VALIDOS.includes(pareceres[0]))
          throw new Error(`${p.tr} parcela ${parcial_num}: parecer nao derivavel de forma unica (${pareceres.join(' | ')})`);
        const parecer_tipo = pareceres[0];

        const { rows } = await cli.query(SQL_PARECER,
          [parecer_tipo, SUPER, quem.nome, SETORIAL, p.tr, String(parcial_num), SUPER]);
        if (rows.length !== abertas.length)
          throw new Error(`${p.tr} parcela ${parcial_num}: baixou ${rows.length} de ${abertas.length}`);
        baixadasTr += rows.length;

        const doSec = abertas.filter((x) => origemDe(x.sigef_status) === ORIGEM_SECRETARIO).map((x) => x.codigo_pc);
        if (doSec.length) {
          const { rows: t } = await cli.query(SQL_ORIGEM, [doSec, ORIGEM_SECRETARIO]);
          if (t.length !== doSec.length) throw new Error(`${p.tr} parcela ${parcial_num}: origem trocada em ${t.length} de ${doSec.length}`);
          secretario += t.length;
        }
        const preGt = abertas.filter((x) => ehPreGt(porCod.get(x.codigo_pc).j)).map((x) => x.codigo_pc);
        if (preGt.length) {
          const { rows: t } = await cli.query(SQL_DATA_SIGEF, [preGt]);
          if (t.length !== preGt.length) throw new Error(`${p.tr} parcela ${parcial_num}: data trocada em ${t.length} de ${preGt.length}`);
          datasTrocadas += t.length;
        }

        const { rows: [hp] } = await registrarHistorico(cli, {
          tr: p.tr, parcial_num: String(parcial_num), setorial_id: SETORIAL,
          evento: 'parecer',
          valor_anterior: pcs[0].situacao_atual || pcs[0].status || null,
          valor_novo: parecer_tipo,
          analista_id: SUPER,
          observacao: motivoCi(porCod.get(abertas[0].codigo_pc).j),
          executado_por: null,
        });
        inseridos.push(hp.id);
      }
      log(`   ${p.tr}: assumidas ${feitas.length} · baixadas ${baixadasTr} em ${p.parcelas.length} parcela(s)`);
    }
    log(`   origem_baixa: ${secretario} trocadas para '${ORIGEM_SECRETARIO}' · ${ESPERADO.pcs - secretario} ficam com '${ORIGEM_ROTA}'`);
    log(`   data_baixa: ${datasTrocadas} com a data do SIGEF · ${ESPERADO.pcs - datasTrocadas} com a de hoje`);

    // ── 5. AS CONFERENCIAS, CONTRA A FOTO ───────────────────────────────────
    log(`\n── 5. CONFERENCIAS (contra a foto, nunca contra numero literal) ──────────`);
    const dps = await medir(cli, cortes);
    const dPor = new Map(dps.pcs.map((r) => [r.j.codigo_pc, r]));
    const falham = (cods, f) => cods.filter((c) => !f(dPor.get(c), porCod.get(c)));
    const lista = (xs) => (xs.length ? ` — falham: ${xs.join(', ')}` : '');
    const nHoje = deHoje.length, nSigef = doSigef.length;
    let x;

    // as 68
    x = falham(ALVO, (d) => d.j.baixada === true && d.j.status === 'baixada');
    conf(!x.length, `as ${ESPERADO.pcs} passam a baixada = true, status 'baixada'${lista(x)}`);
    x = falham(ALVO, (d) => d.j.analista_id === SUPER);
    conf(!x.length, `as ${ESPERADO.pcs} com analista_id = ${SUPER}${lista(x)}`);
    x = falham(ALVO, (d) => d.j.analista_nome === nome);
    conf(!x.length && antes.nomes.length === 1 && antes.nomes[0] === nome,
      `analista_nome "${nome}" nas ${ESPERADO.pcs}, coerente com a chave (nas outras PCs do id ${SUPER}: ${JSON.stringify(antes.nomes)})${lista(x)}`);
    x = falham(ALVO, (d, a) => d.j.parecer_tipo === parecerDe(a.j.sigef_status) && PARECERES_VALIDOS.includes(d.j.parecer_tipo));
    conf(!x.length, `parecer_tipo preenchido e igual ao derivado do sigef_status${lista(x)}`);
    x = falham(ALVO, (d, a) => d.j.origem_baixa === origemDe(a.j.sigef_status));
    const nSec = ALVO.filter((c) => origemDe(porCod.get(c).j.sigef_status) === ORIGEM_SECRETARIO).length;
    conf(!x.length, `origem_baixa conforme o sigef_status: ${nSec} '${ORIGEM_SECRETARIO}' · ${ESPERADO.pcs - nSec} '${ORIGEM_ROTA}'${lista(x)}`);
    x = falham(ALVO, (d) => d.j.baixado_por === SUPER && d.j.registrado_por === quem.nome);
    conf(!x.length, `baixado_por ${SUPER} e registrado_por "${quem.nome}" — como a rota grava${lista(x)}`);
    x = falham(deHoje, (d) => d.baixa_br === cortes.hoje_br);
    conf(!x.length, `as ${nHoje} posteriores ao GT com data_baixa = hoje (${br(cortes.hoje_br)}, em Brasilia)${lista(x)}`);
    x = falham(doSigef, (d, a) => d.baixa_br === String(a.j.data_baixa_sigef).slice(0, 10));
    conf(!x.length, `as ${nSigef} anteriores ao GT com data_baixa = a data do SIGEF (em Brasilia)${lista(x)}`);
    x = falham(ALVO, (d, a) => d.j.enviado_ci === a.j.enviado_ci && d.j.enviado_ci !== true
      && d.j.ci_situacao === a.j.ci_situacao && d.j.dt_envio_ci === a.j.dt_envio_ci);
    conf(!x.length, `nenhuma foi ao Controle Interno (enviado_ci e ci_* intactos)${lista(x)}`);
    x = falham(ALVO, (d) => d.sigef_tag == null);
    conf(!x.length, `a pilula "Baixada no SIGEF, aberta aqui" sumiu das ${ESPERADO.pcs}${lista(x)}`);
    x = falham(ALVO, (d, a) => Object.keys(a.j).every((k) => TOCADAS.has(k) || JSON.stringify(a.j[k]) === JSON.stringify(d.j[k])));
    conf(!x.length, `nas ${ESPERADO.pcs}, so mudaram as ${TOCADAS.size} colunas que as rotas escrevem${lista(x)}`);

    // as 34 TRs
    const tA = new Map(antes.trs.map((t) => [t.tr, t]));
    const tD = new Map(dps.trs.map((t) => [t.tr, t]));
    x = TRS.filter((tr) => !(tD.get(tr).baixadas >= tD.get(tr).total_pcs && tA.get(tr).baixadas < tA.get(tr).total_pcs));
    conf(!x.length, `as ${ESPERADO.trs} TRs passam a concluidas (baixadas >= total, e antes nao eram)${lista(x)}`);
    x = TRS.filter((tr) => !(statusDerivado(tA.get(tr)) === 'livre' && statusDerivado(tD.get(tr)) === 'baixada' && tD.get(tr).pcs_livres === 0));
    conf(!x.length, `as ${ESPERADO.trs} saem do Estoque: Livre -> Baixada, zero PCs livres para assumir${lista(x)}`);

    // produtividade: sobe EXATAMENTE o numero das de hoje
    conf(dps.prod.regra_c === antes.prod.regra_c + nHoje,
      `regra C sobe exatamente ${nHoje} (as de hoje), nem uma a mais: ${antes.prod.regra_c} -> ${dps.prod.regra_c}`);
    conf(dps.prod.card === antes.prod.card + nHoje,
      `card (sigef_conta somado) sobe exatamente ${nHoje}: ${antes.prod.card} -> ${dps.prod.card}`);
    x = falham(doSigef, (d) => d.pre_gt === true && d.sigef_conta === false);
    conf(!x.length, `as ${nSigef} anteriores ao GT: SQL_PRE_GT verdadeiro e sigef_conta falso — fora do card e da regra C${lista(x)}`);
    x = falham(deHoje, (d) => d.pre_gt === false && d.sigef_conta === true);
    conf(!x.length, `as ${nHoje} de hoje: sigef_conta verdadeiro${lista(x)}`);
    conf(dps.cumulHoje.total === antes.cumulHoje.total + nHoje,
      `cumulativa ate o fim de hoje sobe exatamente ${nHoje}: ${antes.cumulHoje.total} -> ${dps.cumulHoje.total}`);
    conf(dps.cumulOntem.total === antes.cumulOntem.total,
      `cumulativa ate o fim de ontem NAO muda: ${antes.cumulOntem.total} -> ${dps.cumulOntem.total}`);
    conf(dps.cumulPre.total === antes.cumulPre.total,
      `cumulativa ate ${br(cortes.pre_dia)} (o parecer pre-GT mais recente) NAO muda: ${antes.cumulPre.total} -> ${dps.cumulPre.total}`);
    log(`     (informativo: o "total_bruto" da rota cumulativa, que NAO aplica o corte do GT, vai de `
      + `${antes.cumulHoje.bruto} a ${dps.cumulHoje.bruto} ate hoje; a base de ${antes.prod.base} a ${dps.prod.base})`);

    // o Quadro 2 do CGE — o esperado sai das PCs cuja data_baixa cai no periodo, pela origem
    const noPeriodo = alvoJ.filter((j) => !ehPreGt(j) || String(j.data_baixa_sigef) >= CGE_INICIO);
    const expSec = noPeriodo.filter((j) => origemDe(j.sigef_status) === ORIGEM_SECRETARIO).length;
    const expTec = noPeriodo.length - expSec;
    const dif = (a, b) => `${b - a >= 0 ? '+' : ''}${b - a}`;
    log(`\n   Quadro 2 do CGE — ${br(CGE_INICIO)} a ${br(cortes.hoje_br)}      antes   depois   diferenca`);
    log(`     Secretario — total do quadro       ${String(antes.q2.sec).padStart(7)} ${String(dps.q2.sec).padStart(8)}   ${dif(antes.q2.sec, dps.q2.sec)}`);
    log(`     Tecnico    — total do quadro       ${String(antes.q2.tec).padStart(7)} ${String(dps.q2.tec).padStart(8)}   ${dif(antes.q2.tec, dps.q2.tec)}`);
    log(`     Secretario — linha do Richard      ${String(antes.q2.secR).padStart(7)} ${String(dps.q2.secR).padStart(8)}   ${dif(antes.q2.secR, dps.q2.secR)}`);
    log(`     Tecnico    — linha do Richard      ${String(antes.q2.tecR).padStart(7)} ${String(dps.q2.tecR).padStart(8)}   ${dif(antes.q2.tecR, dps.q2.tecR)}`);
    log(`     de onde vem a diferenca: ${nHoje} de hoje + ${preNoPeriodoCge.length} anteriores ao GT com data do SIGEF`
      + ` dentro do periodo (a partir de ${br(CGE_INICIO)}); as outras ${nSigef - preNoPeriodoCge.length} ficam antes do periodo\n`);
    conf(dps.q2.sec === antes.q2.sec + expSec && dps.q2.tec === antes.q2.tec + expTec,
      `Quadro 2, total: Secretario ${dif(antes.q2.sec, dps.q2.sec)} (esperado +${expSec}) e Tecnico ${dif(antes.q2.tec, dps.q2.tec)} (esperado +${expTec})`);
    conf(dps.q2.secR - antes.q2.secR === dps.q2.sec - antes.q2.sec && dps.q2.tecR - antes.q2.tecR === dps.q2.tec - antes.q2.tec,
      `Quadro 2: toda a diferenca esta na linha do Richard`);
    if (preNoPeriodoCge.length) {
      const msg = `${preNoPeriodoCge.length} PC(s) ANTERIOR(ES) AO GT entram no Quadro 2 do periodo padrao, porque o `
        + `Quadro 2 conta pela data_baixa e nao aplica o corte do GT: `
        + preNoPeriodoCge.map((j) => `${j.codigo_pc} (${br(j.data_baixa_sigef)})`).join(', ');
      avisos.push(msg);
      log(`   ⚠️ ${msg}`);
    }

    // nada mais
    conf(dps.outras.n === antes.outras.n && dps.outras.h === antes.outras.h,
      `NENHUMA outra PC foi tocada: ${antes.outras.n} linhas, md5 da linha inteira igual`);
    const { rows: [histVelho] } = await cli.query(`
      SELECT COUNT(*)::int AS n, md5(string_agg(md5(row_to_json(h)::text), '' ORDER BY id)) AS h
        FROM parcela_historico h WHERE id <= $1`, [antes.hist.max_id]);
    conf(histVelho.n === antes.hist.n && histVelho.h === antes.hist.h, `o historico existente ficou intacto (md5 igual)`);
    const { rows: novos } = await cli.query(
      `SELECT id, evento FROM parcela_historico WHERE id > $1 ORDER BY id`, [antes.hist.max_id]);
    const ev = novos.reduce((m, r) => { m[r.evento] = (m[r.evento] || 0) + 1; return m; }, {});
    const nParcelas = plano.reduce((s, p) => s + p.parcelas.length, 0);
    conf(novos.length === inseridos.length && novos.every((r) => inseridos.includes(r.id))
      && ev.assumir_tr === ESPERADO.trs && ev.parecer === nParcelas,
      `o historico ganhou so as linhas deste script: ${novos.length} (assumir_tr ${ev.assumir_tr || 0} · parecer ${ev.parecer || 0})`);
    conf(dps.vaga.n === antes.vaga.n && dps.vaga.h === antes.vaga.h, `solicitacao_vaga intacta — nenhuma vaga extra gasta`);

    // ── 6. A REVERSAO, ANTES DE TERMINAR ────────────────────────────────────
    const colunas = Object.keys(porCod.get(ALVO[0]).j).filter((k) => TOCADAS.has(k));
    const desfazer = ALVO.map((c) => {
      const j = JSON.stringify(porCod.get(c).j);
      return `UPDATE prestacoes_contas t SET (${colunas.join(', ')}) = `
        + `(SELECT ${colunas.map((k) => 'r.' + k).join(', ')} FROM jsonb_populate_record(NULL::prestacoes_contas, `
        + `$rev$${j}$rev$::jsonb) r) WHERE t.codigo_pc = '${c}';`;
    });
    const modo = GRAVAR && !mal.length ? 'gravacao' : 'dry-run';
    const escrito = escreverReversao(mal.length ? REVERSAO.replace('.json', '_FALHOU.json') : REVERSAO, {
      quando: new Date().toISOString(), modo,
      script: 'baixar_34trs_sigef_20260913.js',
      analista_id: SUPER, trs: TRS, alvo: ALVO, com_data_de_hoje: deHoje, com_data_do_sigef: doSigef,
      foto_antes_das_68: ALVO.map((c) => porCod.get(c).j),
      historico_inserido_ids: inseridos,
      desfazer_em_sql: [
        'BEGIN;',
        ...desfazer,
        `DELETE FROM parcela_historico WHERE id = ANY(ARRAY[${inseridos.join(', ')}]);`,
        'COMMIT;',
      ],
      medidas: {
        antes: { regra_c: antes.prod.regra_c, card: antes.prod.card, base: antes.prod.base,
                 cumul_pre: antes.cumulPre, cumul_ontem: antes.cumulOntem, cumul_hoje: antes.cumulHoje,
                 md5_outras: antes.outras.h, hist_n: antes.hist.n, quadro2: antes.q2 },
        depois: { regra_c: dps.prod.regra_c, card: dps.prod.card, base: dps.prod.base,
                  cumul_pre: dps.cumulPre, cumul_ontem: dps.cumulOntem, cumul_hoje: dps.cumulHoje,
                  md5_outras: dps.outras.h, hist_n: dps.hist.n, quadro2: dps.q2 },
      },
      avisos, conferencias_ok: ok, conferencias_falhas: mal,
    });
    log(`\n   reversao (${modo}) em ${path.basename(escrito.caminho)}`);
    if (escrito.preservou) log(`   ⚠️ preservado ${path.basename(escrito.preservou)} — ${escrito.motivo}`);

    // ── 7. COMMIT OU ROLLBACK ───────────────────────────────────────────────
    log(`\n${'─'.repeat(78)}`);
    log(`   ${ok.length} conferencias passaram, ${mal.length} falharam.${avisos.length ? ` ${avisos.length} aviso(s).` : ''}`);
    if (GRAVAR && !mal.length) {
      await cli.query('COMMIT'); emTransacao = false;
      log(`\n   ✅ COMMIT. ${ESPERADO.pcs} PCs baixadas em nome do id ${SUPER} (${nHoje} hoje · ${nSigef} com a data do SIGEF); ${ESPERADO.trs} TRs concluidas.\n`);
    } else {
      await cli.query('ROLLBACK'); emTransacao = false;
      if (mal.length) { log(`\n   ⛔ ROLLBACK — conferencia falhou. Nada foi gravado.\n`); process.exitCode = 1; }
      else log(`\n   ↩ DRY-RUN: ROLLBACK. Nada foi gravado.\n   para gravar: node baixar_34trs_sigef_20260913.js --gravar\n`);
    }
  } catch (e) {
    console.error(`\n   ⛔ ERRO: ${e.message}\n`);
    process.exitCode = 1;
    if (emTransacao) {
      try { await cli.query('ROLLBACK'); console.error('   ROLLBACK feito. Nada foi gravado.\n'); }
      catch (e2) { console.error(`   (aviso: ROLLBACK falhou — ${e2.message})`); }
    }
  } finally {
    if (cli) cli.release();
    try { await pool.end(); } catch (e) { log(`   (aviso: ao fechar o pool — ${e.message})`); }
    log(`   (${Date.now() - t0} ms)`);
  }
})();
