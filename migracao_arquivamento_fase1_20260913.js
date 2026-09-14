// CAMINHO: sigpc-api/migracao_arquivamento_fase1_20260913.js
//
// ARQUIVAMENTO — FASE 1: SO AS COLUNAS. Nenhuma consulta existente muda.
// PADRAO = DRY-RUN: cria, confere e desfaz. So da COMMIT com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE E O ARQUIVAMENTO — definicao do Richard, 13/09/2026
//
// Depois que o Controle Interno devolve a parcial SEM pedir diligencia — de acordo, ou com
// ajuste simples no SIGEF —, o analista ARQUIVA. Arquivar encerra a parcial e todas as PCs
// dela.
//
// ⚠️ ARQUIVAR NAO CONTA PRODUTIVIDADE. A PC ja contou quando foi encaminhada ao C.I.
// (baixada OU enviado_ci). Arquivar e limpeza e fecho, nao trabalho novo — nenhuma
// expressao de produtividade pode passar a olhar `arquivada`.
//
// ⚠️ A FINAL SO ARQUIVA DEPOIS DE TODAS AS PARCIAIS DA TR ARQUIVADAS, e exige a data da
// baixa do Secretario no SIGEF, digitada pelo analista. Arquivar a final encerra a TR.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTA FASE FAZ
//
// Em `prestacoes_contas`: arquivada (NOT NULL DEFAULT false), arquivada_em, arquivada_por
// (sem FK) e obs_arquivamento.
//
// A data da baixa do Secretario e POR TR. Dois modos, escolhidos por `--secretario=`:
//   final  (padrao) — as tres colunas em `prestacoes_contas`, preenchidas SO na PC final,
//                     com um CHECK que recusa valor em linha que nao seja `tipo = 'final'`;
//   tabela          — tabela propria `tr_baixa_secretario`, uma linha por TR.
//
// ⚠️ O ALTER TRAVA `prestacoes_contas` ATE O FIM DA TRANSACAO, e a equipe esta usando o
// sistema. Por isso: a foto pesada roda ANTES do ALTER, o `lock_timeout` e de 5 s (um ALTER
// esperando na fila tambem trava quem chega depois), e o tempo de trava e medido e impresso.
//
// USO
//   node migracao_arquivamento_fase1_20260913.js                      dry-run, modo final
//   node migracao_arquivamento_fase1_20260913.js --secretario=tabela  dry-run, modo tabela
//   ... --gravar                                                      COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');
const sigef = require('./lib/sigef');
const inval = require('./lib/invalidada');

const GRAVAR = process.argv.includes('--gravar');
const MODO = ((process.argv.find((a) => a.startsWith('--secretario=')) || '--secretario=final').split('=')[1]);
const REVERSAO = path.join(__dirname, GRAVAR
  ? `reverter_arquivamento_fase1_20260913_${MODO}.json`
  : `reverter_arquivamento_fase1_20260913_${MODO}_DRYRUN.json`);

const T = 'prestacoes_contas';
const COLS_ARQ = [
  { nome: 'arquivada', tipo: 'boolean', nulo: 'NO', ddl: 'boolean NOT NULL DEFAULT false', padrao: 'false',
    comentario: 'Parcial (e todas as PCs dela) encerrada pelo analista depois que o C.I. devolveu sem diligencia. NAO conta produtividade.' },
  { nome: 'arquivada_em', tipo: 'timestamp without time zone', nulo: 'YES', ddl: 'timestamp',
    comentario: 'Quando foi arquivada. NOW() de um servidor em UTC, como data_baixa.' },
  { nome: 'arquivada_por', tipo: 'integer', nulo: 'YES', ddl: 'integer',
    comentario: 'usuarios.id de quem arquivou. Sem FK, como os outros *_por.' },
  { nome: 'obs_arquivamento', tipo: 'text', nulo: 'YES', ddl: 'text',
    comentario: 'Observacao livre do analista ao arquivar.' },
];
const COLS_SEC = [
  { nome: 'baixa_secretario_em', tipo: 'date', nulo: 'YES', ddl: 'date',
    comentario: 'Data da baixa do Secretario no SIGEF, digitada pelo analista ao arquivar a final. Por TR.' },
  { nome: 'baixa_secretario_por', tipo: 'integer', nulo: 'YES', ddl: 'integer',
    comentario: 'usuarios.id de quem registrou a data do Secretario. Sem FK.' },
  { nome: 'baixa_secretario_registrada_em', tipo: 'timestamp without time zone', nulo: 'YES', ddl: 'timestamp',
    comentario: 'Quando a data do Secretario foi registrada no sistema.' },
];
const CK = 'ck_pc_baixa_secretario_so_final';
const CK_DDL = `CHECK ((baixa_secretario_em IS NULL AND baixa_secretario_por IS NULL
                  AND baixa_secretario_registrada_em IS NULL) OR tipo = 'final')`;
const TAB = 'tr_baixa_secretario';

const ok = [], mal = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);
const git = (dir, args) => (spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout || '').trim();

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false }, max: 1 });
pool.on('error', (e) => log(`   (aviso: conexao ociosa caiu — ${e.message})`));

async function colunas(cli) {
  const { rows } = await cli.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [T]);
  return rows;
}

// A foto. `antigas` e a lista de colunas de ANTES do ALTER — o md5 e sempre sobre elas, para
// que as colunas novas nao mudem a impressao digital por existirem.
async function medir(cli, antigas) {
  const { rows: [n] } = await cli.query(`SELECT COUNT(*)::int AS total FROM ${T}`);
  const { rows: bx } = await cli.query(`
    SELECT COALESCE(analista_id::text, '(sem dono)') AS a, COUNT(*) FILTER (WHERE baixada)::int AS n
      FROM ${T} GROUP BY 1 ORDER BY 1`);
  const { rows: rc } = await cli.query(`
    SELECT COALESCE(p.analista_id::text, '(sem dono)') AS a,
           COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int AS n
      FROM ${T} p GROUP BY 1 ORDER BY 1`);
  const lista = antigas.map((c) => `p."${c}"`).join(', ');
  const { rows: [h] } = await cli.query(`
    SELECT md5(string_agg(md5(row(${lista})::text), '' ORDER BY p.codigo_pc)) AS h FROM ${T} p`);
  return {
    total: n.total,
    baixadas: Object.fromEntries(bx.map((r) => [r.a, r.n])),
    regraC: Object.fromEntries(rc.map((r) => [r.a, r.n])),
    regraCTotal: rc.reduce((s, r) => s + r.n, 0),
    md5: h.h,
  };
}

(async () => {
  let cli = null, emTransacao = false, t0Trava = null;
  const t0 = Date.now();
  log(`\n${'═'.repeat(78)}`);
  log(` ARQUIVAMENTO — FASE 1 (colunas)   modo --secretario=${MODO}   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (cria, confere e desfaz)'}`);
  log(`${'═'.repeat(78)}`);
  try {
    if (!['final', 'tabela'].includes(MODO)) throw new Error(`--secretario deve ser "final" ou "tabela", veio "${MODO}"`);
    // git ANTES: nenhum arquivo versionado pode estar alterado nos dois repositorios.
    const gitApiAntes = git(__dirname, ['diff', '--name-only', 'HEAD']);
    const gitGtAntes = git(path.join(__dirname, '..', 'sigpc-gt'), ['diff', '--name-only', 'HEAD']);

    cli = await pool.connect();
    await cli.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    emTransacao = true;
    await cli.query(`SET LOCAL lock_timeout = '5s'`);
    await cli.query(`SET LOCAL statement_timeout = '120s'`);

    // ── 1. O ESTADO E A FOTO ────────────────────────────────────────────────
    const colsAntes = await colunas(cli);
    const nomesNovos = [...COLS_ARQ, ...COLS_SEC].map((c) => c.nome);
    const antigas = colsAntes.map((c) => c.column_name).filter((c) => !nomesNovos.includes(c));
    const existe = new Set(colsAntes.map((c) => c.column_name));
    const { rows: [ckRow] } = await cli.query(
      `SELECT COUNT(*)::int n FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = $1`, [CK]);
    const { rows: [tabRow] } = await cli.query(`SELECT to_regclass('public.${TAB}') IS NOT NULL AS existe`);

    log(`\n── 1. O ESTADO E A FOTO ──────────────────────────────────────────────────`);
    const antes = await medir(cli, antigas);
    log(`   ${T}: ${antes.total} PCs · ${colsAntes.length} colunas · md5 ${String(antes.md5).slice(0, 16)}…`);
    log(`   baixadas: ${Object.values(antes.baixadas).reduce((s, n) => s + n, 0)} em ${Object.keys(antes.baixadas).length} donos`
      + ` · regra C: ${antes.regraCTotal}`);
    log(`   ja existem: ${nomesNovos.filter((c) => existe.has(c)).join(', ') || 'nenhuma das 7 colunas'}`
      + ` · CHECK ${CK}: ${ckRow.n ? 'sim' : 'nao'} · tabela ${TAB}: ${tabRow.existe ? 'sim' : 'nao'}`);

    // O que pesa na escolha do lugar da data do Secretario — medido, nao presumido.
    const { rows: [fin] } = await cli.query(`
      WITH f AS (SELECT tr, COUNT(*) FILTER (WHERE tipo = 'final')::int nf
                   FROM ${T} p WHERE ${inval.ativa('p')} GROUP BY tr)
      SELECT COUNT(*)::int trs,
             COUNT(*) FILTER (WHERE nf = 0)::int sem_final,
             COUNT(*) FILTER (WHERE nf = 1)::int uma_final,
             COUNT(*) FILTER (WHERE nf > 1)::int duas_ou_mais,
             (SELECT string_agg(tr || ' (' || nf || ')', ', ') FROM f WHERE nf > 1) AS quais
        FROM f`);
    const { rows: [sec] } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE tipo = 'final')::int finais,
             COUNT(*) FILTER (WHERE tipo = 'final' AND (btrim(upper(sigef_status)) LIKE '%SECRETÁRIO'
                                OR btrim(upper(sigef_status)) IN ('AS', 'SS')))::int finais_sigef_secretario,
             COUNT(*) FILTER (WHERE tipo = 'final' AND (btrim(upper(sigef_status)) LIKE '%SECRETÁRIO'
                                OR btrim(upper(sigef_status)) IN ('AS', 'SS')) AND data_baixa_sigef IS NOT NULL)::int com_data
        FROM ${T} p WHERE ${inval.ativa('p')}`);
    log(`\n   para decidir onde mora a data do Secretario (PCs ativas):`);
    log(`     ${fin.trs} TRs · ${fin.uma_final} com UMA final · ${fin.sem_final} SEM final · ${fin.duas_ou_mais} com DUAS ou mais`);
    if (fin.quais) log(`     com duas ou mais: ${fin.quais}`);
    log(`     ${sec.finais} finais · ${sec.finais_sigef_secretario} ja com sigef_status de Secretario no SIGEF`
      + ` (${sec.com_data} com data_baixa_sigef)`);

    // ── 2. O PLANO ──────────────────────────────────────────────────────────
    const ddl = [];
    const criadas = [];
    for (const c of COLS_ARQ) if (!existe.has(c.nome)) {
      ddl.push(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${c.nome} ${c.ddl}`);
      ddl.push(`COMMENT ON COLUMN ${T}.${c.nome} IS '${c.comentario.replace(/'/g, "''")}'`);
      criadas.push(c.nome);
    }
    if (MODO === 'final') {
      for (const c of COLS_SEC) if (!existe.has(c.nome)) {
        ddl.push(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${c.nome} ${c.ddl}`);
        ddl.push(`COMMENT ON COLUMN ${T}.${c.nome} IS '${c.comentario.replace(/'/g, "''")}'`);
        criadas.push(c.nome);
      }
      if (!ckRow.n) ddl.push(`ALTER TABLE ${T} ADD CONSTRAINT ${CK} ${CK_DDL}`);
    } else if (!tabRow.existe) {
      ddl.push(`CREATE TABLE IF NOT EXISTS ${TAB} (
        tr varchar PRIMARY KEY,
        setorial_id varchar NOT NULL DEFAULT 'FCEE',
        baixa_secretario_em date NOT NULL,
        baixa_secretario_por integer,
        baixa_secretario_registrada_em timestamp NOT NULL DEFAULT NOW())`);
      ddl.push(`COMMENT ON TABLE ${TAB} IS 'Data da baixa do Secretario no SIGEF, por TR. Registrada ao arquivar a PC final, que encerra a TR.'`);
    }
    log(`\n── 2. O PLANO ────────────────────────────────────────────────────────────`);
    if (!ddl.length) {
      log(`   tudo ja existe. NADA A FAZER.`);
      await cli.query('ROLLBACK'); emTransacao = false;
      return;
    }
    ddl.forEach((s) => log(`   ${s.replace(/\s+/g, ' ')};`));

    // ── 3. A MUDANCA ────────────────────────────────────────────────────────
    log(`\n── 3. A MUDANCA (dentro da transacao) ────────────────────────────────────`);
    t0Trava = Date.now();
    for (const s of ddl) await cli.query(s);
    log(`   ${ddl.length} comando(s) executado(s)`);

    // ── 4. AS CONFERENCIAS, CONTRA A FOTO ───────────────────────────────────
    log(`\n── 4. CONFERENCIAS (contra a foto, nunca contra numero literal) ──────────`);
    const dps = await medir(cli, antigas);
    const colsDepois = await colunas(cli);
    const def = new Map(colsDepois.map((c) => [c.column_name, c]));

    conf(dps.total === antes.total, `total de PCs inalterado: ${antes.total} -> ${dps.total}`);
    const { rows: [arq] } = await cli.query(`SELECT COUNT(*) FILTER (WHERE arquivada)::int n, COUNT(*)::int t FROM ${T}`);
    conf(arq.n === 0, `nenhuma PC com arquivada = true depois do ALTER: ${arq.n} de ${arq.t}`);
    const { rows: [vaz] } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE arquivada_em IS NOT NULL OR arquivada_por IS NOT NULL OR obs_arquivamento IS NOT NULL)::int n FROM ${T}`);
    conf(vaz.n === 0, `arquivada_em, arquivada_por e obs_arquivamento vazias em todas: ${vaz.n} preenchidas`);
    for (const c of (MODO === 'final' ? [...COLS_ARQ, ...COLS_SEC] : COLS_ARQ)) {
      const d = def.get(c.nome);
      const bate = d && d.data_type === c.tipo && d.is_nullable === c.nulo
        && (c.padrao === undefined ? d.column_default == null : String(d.column_default) === c.padrao);
      conf(bate, `coluna ${c.nome}: ${d ? `${d.data_type}, ${d.is_nullable === 'NO' ? 'NOT NULL' : 'nula'}, padrao ${d.column_default ?? '—'}` : 'NAO EXISTE'}`);
    }
    conf(JSON.stringify(dps.baixadas) === JSON.stringify(antes.baixadas),
      `baixadas por analista identicas a foto (${Object.keys(antes.baixadas).length} donos)`);
    conf(JSON.stringify(dps.regraC) === JSON.stringify(antes.regraC) && dps.regraCTotal === antes.regraCTotal,
      `regra C identica a foto, analista por analista: total ${antes.regraCTotal} -> ${dps.regraCTotal}`);
    conf(dps.md5 === antes.md5, `nenhum dado mudou: md5 das ${antigas.length} colunas anteriores igual`);
    if (MODO === 'final') {
      const { rows: [ck] } = await cli.query(
        `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = $1`, [CK]);
      conf(!!ck && ck.convalidated, `CHECK ${CK} existe e foi validado contra as ${dps.total} linhas`);
      const { rows: [sv] } = await cli.query(`
        SELECT COUNT(*) FILTER (WHERE baixa_secretario_em IS NOT NULL OR baixa_secretario_por IS NOT NULL
                                OR baixa_secretario_registrada_em IS NOT NULL)::int n FROM ${T}`);
      conf(sv.n === 0, `as tres colunas do Secretario vazias em todas: ${sv.n} preenchidas`);
      // O CHECK recusa de fato? Tenta gravar numa parcial, dentro de um SAVEPOINT, e desfaz.
      await cli.query('SAVEPOINT prova');
      let recusou = false;
      try {
        await cli.query(`UPDATE ${T} SET baixa_secretario_em = CURRENT_DATE
                          WHERE codigo_pc = (SELECT codigo_pc FROM ${T} WHERE tipo = 'parcial' LIMIT 1)`);
      } catch (e) { recusou = /check constraint/i.test(e.message); }
      await cli.query('ROLLBACK TO SAVEPOINT prova');
      conf(recusou, `o CHECK recusa a data do Secretario numa PC parcial (provado e desfeito)`);
    } else {
      const { rows: [tb] } = await cli.query(`SELECT COUNT(*)::int n FROM ${TAB}`);
      conf(tb.n === 0, `tabela ${TAB} criada e vazia`);
    }
    const tTrava = Date.now() - t0Trava;

    const gitApi = git(__dirname, ['diff', '--name-only', 'HEAD']);
    const gitGt = git(path.join(__dirname, '..', 'sigpc-gt'), ['diff', '--name-only', 'HEAD']);
    const eu = path.basename(__filename);
    const novo = git(__dirname, ['status', '--porcelain', '--', eu]);
    conf(!gitApiAntes && !gitApi && !gitGtAntes && !gitGt && novo.startsWith('??'),
      `git: nenhum arquivo versionado alterado nos dois repositorios; o unico novo e ${eu}`
      + (gitApi || gitGt ? ` — ALTERADOS: ${[gitApi, gitGt].filter(Boolean).join(' | ')}` : ''));

    // ── 5. A REVERSAO, ANTES DE TERMINAR ────────────────────────────────────
    // ⚠️ Desfazer e tirar SO o que esta rodada criou, e SO se continuar vazio. Tabela sai por
    // RENAME com sufixo _backup, nunca por DROP (regra do projeto). As colunas novas nascem
    // vazias e nao guardam nada que precise de backup.
    const desfazer = ['BEGIN;'];
    if (MODO === 'final') {
      desfazer.push(`-- conferir antes: SELECT COUNT(*) FROM ${T} WHERE arquivada OR baixa_secretario_em IS NOT NULL;  -- tem de dar 0`);
      if (!ckRow.n) desfazer.push(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${CK};`);
    } else {
      desfazer.push(`-- conferir antes: SELECT COUNT(*) FROM ${T} WHERE arquivada;  -- tem de dar 0`);
      if (!tabRow.existe) desfazer.push(`ALTER TABLE ${TAB} RENAME TO ${TAB}_backup_20260913;`);
    }
    criadas.forEach((c) => desfazer.push(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${c};`));
    desfazer.push('COMMIT;');
    const modoRev = GRAVAR && !mal.length ? 'gravacao' : 'dry-run';
    const escrito = escreverReversao(mal.length ? REVERSAO.replace('.json', '_FALHOU.json') : REVERSAO, {
      quando: new Date().toISOString(), modo: modoRev, script: eu, secretario: MODO,
      ddl_executado: ddl, colunas_criadas: criadas,
      foto_antes: { total: antes.total, md5: antes.md5, regraCTotal: antes.regraCTotal, baixadas: antes.baixadas, regraC: antes.regraC },
      foto_depois: { total: dps.total, md5: dps.md5, regraCTotal: dps.regraCTotal },
      desfazer_em_sql: desfazer, conferencias_ok: ok, conferencias_falhas: mal,
    });
    log(`\n   reversao (${modoRev}) em ${path.basename(escrito.caminho)}`);
    if (escrito.preservou) log(`   ⚠️ preservado ${path.basename(escrito.preservou)} — ${escrito.motivo}`);

    // ── 6. COMMIT OU ROLLBACK ───────────────────────────────────────────────
    log(`\n${'─'.repeat(78)}`);
    log(`   ${ok.length} conferencias passaram, ${mal.length} falharam.`);
    if (GRAVAR && !mal.length) {
      await cli.query('COMMIT'); emTransacao = false;
      log(`   tabela ${T} travada por ${Date.now() - t0Trava} ms`);
      log(`\n   ✅ COMMIT. Fase 1 do arquivamento gravada (modo ${MODO}).\n`);
    } else {
      await cli.query('ROLLBACK'); emTransacao = false;
      log(`   tabela ${T} travada por ${Date.now() - t0Trava} ms (ALTER ate o ROLLBACK; conferencias: ${tTrava} ms)`);
      if (mal.length) { log(`\n   ⛔ ROLLBACK — conferencia falhou. Nada foi gravado.\n`); process.exitCode = 1; }
      else log(`\n   ↩ DRY-RUN: ROLLBACK. Nada foi gravado.\n   para gravar: node ${eu} --secretario=${MODO} --gravar\n`);
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
