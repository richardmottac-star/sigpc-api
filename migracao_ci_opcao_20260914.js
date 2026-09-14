// CAMINHO: sigpc-api/migracao_ci_opcao_20260914.js
//
// A OPCAO DO C.I. NA MENSAGEM — uma coluna em `ci_mensagem`. Nenhum dado existente muda.
// PADRAO = DRY-RUN: cria, confere e desfaz. So da COMMIT com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE — Richard, 14/09/2026
//
// A decisao e a reabertura do C.I. passam a usar as MESMAS duas opcoes: "De acordo" e "Com
// pendencia". O cartao da analista mostra a pilula da opcao escolhida. Na decisao a opcao sai do
// estado (de acordo encerra, com pendencia devolve), mas a REABERTURA leva as duas ao mesmo
// `com_analista` — sem guardar a opcao, o cartao nao teria como saber qual pilula mostrar.
//
// `opcao` e nula nas mensagens antigas e nas do analista. O CHECK aceita so os dois valores.
//
// USO
//   railway run -s Postgres node migracao_ci_opcao_20260914.js            dry-run
//   railway run -s Postgres node migracao_ci_opcao_20260914.js --gravar   COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = path.join(__dirname, GRAVAR
  ? 'reverter_ci_opcao_20260914.json'
  : 'reverter_ci_opcao_20260914_DRYRUN.json');

const T = 'ci_mensagem';
const COL = 'opcao';
const CK = 'ci_msg_opcao';
const CK_DDL = `CHECK (opcao IS NULL OR opcao IN ('de_acordo', 'com_pendencia'))`;
const COMENTARIO = 'Opcao do C.I. nesta mensagem: de_acordo ou com_pendencia. Nula nas do analista e nas anteriores a 14/09/2026.';

const ok = [], mal = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false }, max: 1 });
pool.on('error', (e) => log(`   (aviso: conexao ociosa caiu — ${e.message})`));

async function colunas(cli) {
  const { rows } = await cli.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [T]);
  return rows;
}

// A foto: o total e o md5 das colunas de ANTES do ALTER, linha a linha, na ordem do id.
async function medir(cli, antigas) {
  const lista = antigas.map((c) => `m."${c}"`).join(', ');
  const { rows: [r] } = await cli.query(`
    SELECT COUNT(*)::int AS total,
           md5(COALESCE(string_agg(md5(row(${lista})::text), '' ORDER BY m.id), '')) AS h
      FROM ${T} m`);
  return { total: r.total, md5: r.h };
}

(async () => {
  let cli = null, emTransacao = false;
  const t0 = Date.now();
  log(`\n${'═'.repeat(78)}`);
  log(` OPCAO DO C.I. EM ci_mensagem   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (cria, confere e desfaz)'}`);
  log(`${'═'.repeat(78)}`);
  try {
    cli = await pool.connect();
    await cli.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    emTransacao = true;
    await cli.query(`SET LOCAL lock_timeout = '5s'`);
    await cli.query(`SET LOCAL statement_timeout = '60s'`);

    // ── 1. O ESTADO E A FOTO ────────────────────────────────────────────────
    const colsAntes = await colunas(cli);
    const existe = colsAntes.some((c) => c.column_name === COL);
    const antigas = colsAntes.map((c) => c.column_name).filter((c) => c !== COL);
    const { rows: [ckRow] } = await cli.query(
      `SELECT COUNT(*)::int n FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = $1`, [CK]);
    log(`\n── 1. O ESTADO E A FOTO ──────────────────────────────────────────────────`);
    const antes = await medir(cli, antigas);
    log(`   ${T}: ${antes.total} mensagens · ${colsAntes.length} colunas · md5 ${String(antes.md5).slice(0, 16)}…`);
    log(`   coluna ${COL}: ${existe ? 'ja existe' : 'nao existe'} · CHECK ${CK}: ${ckRow.n ? 'sim' : 'nao'}`);

    // ── 2. O PLANO ──────────────────────────────────────────────────────────
    const ddl = [];
    if (!existe) {
      ddl.push(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${COL} text`);
      ddl.push(`COMMENT ON COLUMN ${T}.${COL} IS '${COMENTARIO.replace(/'/g, "''")}'`);
    }
    if (!ckRow.n) ddl.push(`ALTER TABLE ${T} ADD CONSTRAINT ${CK} ${CK_DDL}`);
    log(`\n── 2. O PLANO ────────────────────────────────────────────────────────────`);
    if (!ddl.length) {
      log(`   tudo ja existe. NADA A FAZER.`);
      await cli.query('ROLLBACK'); emTransacao = false;
      return;
    }
    ddl.forEach((s) => log(`   ${s};`));

    // ── 3. A MUDANCA ────────────────────────────────────────────────────────
    log(`\n── 3. A MUDANCA (dentro da transacao) ────────────────────────────────────`);
    const t0Trava = Date.now();
    for (const s of ddl) await cli.query(s);
    log(`   ${ddl.length} comando(s) executado(s)`);

    // ── 4. AS CONFERENCIAS, CONTRA A FOTO ───────────────────────────────────
    log(`\n── 4. CONFERENCIAS (contra a foto, nunca contra numero literal) ──────────`);
    const dps = await medir(cli, antigas);
    const def = (await colunas(cli)).find((c) => c.column_name === COL);
    conf(dps.total === antes.total, `total de mensagens inalterado: ${antes.total} -> ${dps.total}`);
    conf(dps.md5 === antes.md5, `nenhum dado mudou: md5 das ${antigas.length} colunas anteriores igual`);
    conf(!!def && def.data_type === 'text' && def.is_nullable === 'YES' && def.column_default == null,
      `coluna ${COL}: ${def ? `${def.data_type}, ${def.is_nullable === 'YES' ? 'nula' : 'NOT NULL'}, padrao ${def.column_default ?? '—'}` : 'NAO EXISTE'}`);
    const { rows: [nn] } = await cli.query(`SELECT COUNT(*) FILTER (WHERE ${COL} IS NOT NULL)::int n FROM ${T}`);
    conf(nn.n === 0, `${COL} vazia em todas as ${dps.total} mensagens: ${nn.n} preenchidas`);
    const { rows: [ck] } = await cli.query(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = $1`, [CK]);
    conf(!!ck && ck.convalidated, `CHECK ${CK} existe e foi validado contra as ${dps.total} linhas`);
    if (dps.total > 0) {
      // O CHECK recusa de fato? Tenta gravar um valor fora dos dois, num SAVEPOINT, e desfaz.
      await cli.query('SAVEPOINT prova');
      let recusou = false;
      try {
        await cli.query(`UPDATE ${T} SET ${COL} = 'qualquer' WHERE id = (SELECT MIN(id) FROM ${T})`);
      } catch (e) { recusou = /check constraint/i.test(e.message); }
      await cli.query('ROLLBACK TO SAVEPOINT prova');
      conf(recusou, `o CHECK recusa um valor fora de de_acordo/com_pendencia (provado e desfeito)`);
      await cli.query('SAVEPOINT prova2');
      let aceitou = true;
      try {
        await cli.query(`UPDATE ${T} SET ${COL} = 'com_pendencia' WHERE id = (SELECT MIN(id) FROM ${T})`);
      } catch (e) { aceitou = false; }
      await cli.query('ROLLBACK TO SAVEPOINT prova2');
      conf(aceitou, `e aceita os valores validos (provado e desfeito)`);
    }
    const dps2 = await medir(cli, antigas);
    conf(dps2.md5 === antes.md5, 'depois das provas, o md5 continua igual a foto');

    // ── 5. A REVERSAO, ANTES DE TERMINAR ────────────────────────────────────
    // Nada e derrubado: a coluna sai por RENAME com sufixo _backup, e o CHECK e retirado.
    const desfazer = ['BEGIN;'];
    if (!ckRow.n) desfazer.push(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${CK};`);
    if (!existe) desfazer.push(`ALTER TABLE ${T} RENAME COLUMN ${COL} TO ${COL}_backup_20260914;`);
    desfazer.push('COMMIT;');
    const modoRev = GRAVAR && !mal.length ? 'gravacao' : 'dry-run';
    const eu = path.basename(__filename);
    const escrito = escreverReversao(mal.length ? REVERSAO.replace('.json', '_FALHOU.json') : REVERSAO, {
      quando: new Date().toISOString(), modo: modoRev, script: eu,
      ddl_executado: ddl,
      foto_antes: antes, foto_depois: dps2,
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
      log(`\n   ✅ COMMIT. Coluna ${T}.${COL} gravada.\n`);
    } else {
      await cli.query('ROLLBACK'); emTransacao = false;
      log(`   tabela ${T} travada por ${Date.now() - t0Trava} ms (ALTER ate o ROLLBACK)`);
      if (mal.length) { log(`\n   ⛔ ROLLBACK — conferencia falhou. Nada foi gravado.\n`); process.exitCode = 1; }
      else log(`\n   ↩ DRY-RUN: ROLLBACK. Nada foi gravado.\n   para gravar: railway run -s Postgres node ${eu} --gravar\n`);
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
