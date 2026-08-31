// CAMINHO: sigpc-api/migracao_engenharia_20260831.js
//
// AS TRES COLUNAS DO PARECER DA ENGENHARIA — FCEE/DIAD/SEENG.
// PADRAO = DRY-RUN. So grava com `--gravar`.
//
//   eng_situacao    varchar(20)  NULL   'na_engenharia' ou NULL
//   eng_enviada_em  timestamp    NULL   quando o analista registrou o envio
//   eng_retorno_em  timestamp    NULL   quando registrou o retorno
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ `ADD COLUMN IF NOT EXISTS`, NUNCA `CREATE TABLE IF NOT EXISTS` — armadilha 2 do projeto:
// aquele nao altera tabela que ja existe, e a migracao passaria em silencio sem criar nada.
//
// ⚠️ IDEMPOTENTE DE VERDADE: rodar duas vezes nao quebra e nao duplica. A segunda rodada acha
// as tres colunas ja presentes, diz isso e sai — sem ALTER e sem foto nova.
//
// ⚠️ AS CONFERENCIAS SAO CONTRA A FOTO, nunca contra numero literal. Um `=== 16479` cravado
// aqui viraria mentira na primeira PC inserida, e o script passaria a acusar erro que nao
// existe — ou pior, a aprovar o que deveria recusar.
//
// ⚠️ E A COMPARACAO DE CONTEUDO E SO SOBRE AS COLUNAS QUE JA EXISTIAM. Depois do ALTER a linha
// tem tres campos a mais, entao `md5(p::text)` difere estruturalmente da foto em TODAS as
// linhas — compararia o formato, nao o dado. A lista de colunas sai da propria foto.
//
// USO
//   node migracao_engenharia_20260831.js            dry-run: mostra e faz ROLLBACK
//   node migracao_engenharia_20260831.js --gravar   idem, com COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const FOTO = '_backup_pre_engenharia_20260831';
const REVERSAO = path.join(__dirname, 'reverter_engenharia_20260831.json');

const COLUNAS = [
  { nome: 'eng_situacao',   tipo: 'varchar(20)' },
  { nome: 'eng_enviada_em', tipo: 'timestamp' },
  { nome: 'eng_retorno_em', tipo: 'timestamp' },
];

const log = (s) => console.log(s);

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` MIGRACAO — colunas do parecer da engenharia    ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (ROLLBACK no fim)'}`);
  log(`${'═'.repeat(78)}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();

  try {
    // ── quais ja existem? ────────────────────────────────────────────────────
    const { rows: jaTem } = await cli.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name = ANY($1)`,
      [COLUNAS.map(c => c.nome)]);
    const presentes = new Set(jaTem.map(r => r.column_name));
    const faltando = COLUNAS.filter(c => !presentes.has(c.nome));

    log(`\n── 1. ESTADO ATUAL ───────────────────────────────────────────────────────`);
    for (const c of COLUNAS) {
      const r = jaTem.find(x => x.column_name === c.nome);
      log(`   ${c.nome.padEnd(16)} ${r ? `JA EXISTE (${r.data_type}${r.character_maximum_length ? '(' + r.character_maximum_length + ')' : ''}, nullable ${r.is_nullable})` : 'falta'}`);
    }
    if (!faltando.length) {
      // ⚠️ IDEMPOTENCIA: nada a fazer NAO e erro. Sai em 0 para o script poder ser reexecutado
      // sem derrubar um pipeline.
      log(`\n   As tres colunas ja existem. Nada a fazer — a migracao e idempotente.\n`);
      cli.release(); await pool.end(); process.exit(0);
    }

    await cli.query('BEGIN');

    // ── 2. FOTO ──────────────────────────────────────────────────────────────
    const antes = (await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas')).rows[0].n;
    await cli.query(`DROP TABLE IF EXISTS ${FOTO}`);
    await cli.query(`CREATE TABLE ${FOTO} AS SELECT * FROM prestacoes_contas`);
    const nFoto = (await cli.query(`SELECT COUNT(*)::int n FROM ${FOTO}`)).rows[0].n;
    log(`\n── 2. FOTO ───────────────────────────────────────────────────────────────`);
    log(`   linhas antes ............... ${antes}`);
    log(`   foto ....................... ${FOTO} (${nFoto} linhas)`);

    // A lista de colunas da FOTO — é ela que define o que comparar depois do ALTER.
    const { rows: colsFoto } = await cli.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position`, [FOTO]);
    const lista = colsFoto.map(r => `"${r.column_name}"`).join(', ');

    // ── 3. ALTER ─────────────────────────────────────────────────────────────
    log(`\n── 3. ALTER ──────────────────────────────────────────────────────────────`);
    for (const c of faltando) {
      await cli.query(`ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS ${c.nome} ${c.tipo}`);
      log(`   ADD COLUMN IF NOT EXISTS ${c.nome} ${c.tipo}`);
    }

    // ── 4. CONFERENCIAS, CONTRA A FOTO ───────────────────────────────────────
    log(`\n── 4. CONFERENCIAS (contra a foto, nunca contra numero literal) ──────────`);
    const depois = (await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas')).rows[0].n;
    const sumidas = (await cli.query(
      `SELECT COUNT(*)::int n FROM ${FOTO} f
        WHERE NOT EXISTS (SELECT 1 FROM prestacoes_contas p WHERE p.id = f.id)`)).rows[0].n;
    const novas = (await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas p
        WHERE NOT EXISTS (SELECT 1 FROM ${FOTO} f WHERE f.id = p.id)`)).rows[0].n;
    // ⚠️ SO AS COLUNAS DA FOTO entram no md5 — ver o cabecalho.
    const alteradas = (await cli.query(
      `SELECT COUNT(*)::int n FROM ${FOTO} f JOIN prestacoes_contas p USING (id)
        WHERE md5(ROW(${lista.split(', ').map(c => 'f.' + c).join(', ')})::text)
           IS DISTINCT FROM md5(ROW(${lista.split(', ').map(c => 'p.' + c).join(', ')})::text)`)).rows[0].n;
    const { rows: agora } = await cli.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name = ANY($1)
        ORDER BY column_name`, [COLUNAS.map(c => c.nome)]);
    const preenchidas = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE eng_situacao IS NOT NULL)::int s,
              COUNT(*) FILTER (WHERE eng_enviada_em IS NOT NULL)::int e,
              COUNT(*) FILTER (WHERE eng_retorno_em IS NOT NULL)::int r
         FROM prestacoes_contas`)).rows[0];

    const ok = [], mal = [];
    (depois === nFoto ? ok : mal).push(`contagem: foto ${nFoto} == depois ${depois}`);
    (sumidas === 0 ? ok : mal).push(`linhas da foto SUMIDAS: ${sumidas} (tem de ser 0)`);
    (novas === 0 ? ok : mal).push(`linhas NOVAS que a foto nao tem: ${novas} (tem de ser 0)`);
    (alteradas === 0 ? ok : mal).push(`linhas com conteudo ALTERADO nas colunas antigas: ${alteradas} (tem de ser 0)`);
    (agora.length === 3 ? ok : mal).push(`as tres colunas existem: ${agora.length} de 3`);
    (agora.every(c => c.is_nullable === 'YES') ? ok : mal).push('as tres aceitam NULL');
    const sit = agora.find(c => c.column_name === 'eng_situacao');
    ((sit && sit.character_maximum_length === 20) ? ok : mal).push(`eng_situacao e varchar(${sit ? sit.character_maximum_length : '?'}) — esperado 20`);
    ((preenchidas.s + preenchidas.e + preenchidas.r) === 0 ? ok : mal).push(
      `nenhuma linha foi preenchida: situacao ${preenchidas.s}, enviada ${preenchidas.e}, retorno ${preenchidas.r}`);
    ok.forEach(m => log(`   ✓ ${m}`));
    mal.forEach(m => log(`   ✗ ${m}`));

    // ⚠️ O JSON DE REVERSAO E ESCRITO ANTES DE TERMINAR, e desfaz por nome de coluna — DDL nao
    // tem "lista de chaves", mas tem nome, que e igualmente explicito. A foto fica de pe.
    fs.writeFileSync(GRAVAR && !mal.length ? REVERSAO : REVERSAO.replace('.json', '_DRYRUN.json'),
      JSON.stringify({
        quando: new Date().toISOString(),
        script: 'migracao_engenharia_20260831.js',
        gravado: GRAVAR && !mal.length,
        foto: FOTO,
        colunas_criadas: faltando.map(c => c.nome),
        desfazer: faltando.map(c => `ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ${c.nome};`),
        aviso: 'DROP COLUMN apaga o que estiver gravado nelas — conferir antes se ja ha registro de engenharia.',
      }, null, 1));

    if (mal.length) {
      await cli.query('ROLLBACK');
      log(`\n   ⛔ CONFERENCIA FALHOU — ROLLBACK. Nada foi gravado.\n`);
      cli.release(); await pool.end(); process.exit(1);
    }
    if (GRAVAR) {
      await cli.query('COMMIT');
      log(`\n   ✅ COMMIT — ${faltando.length} coluna(s) criada(s).`);
      log(`   foto em ${FOTO} · reversao em ${REVERSAO}\n`);
    } else {
      await cli.query('ROLLBACK');
      log(`\n   ↩ ROLLBACK (dry-run). NADA foi gravado — nem a foto.`);
      log(`   para gravar: node migracao_engenharia_20260831.js --gravar\n`);
    }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch (_) {}
    console.error(`\n   ⛔ ERRO — ROLLBACK. Nada foi gravado.\n   ${e.message}\n`);
    cli.release(); await pool.end(); process.exit(1);
  }
  cli.release(); await pool.end();
})();
