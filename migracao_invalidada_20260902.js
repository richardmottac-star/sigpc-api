// CAMINHO: sigpc-api/migracao_invalidada_20260902.js
//
// FASE 1 DO DESENHO_INVALIDACAO_PC.md — SO AS COLUNAS.
// PADRAO = DRY-RUN. So grava com `--gravar`.
//
//   invalidada          boolean NOT NULL DEFAULT false   o estado
//   invalidada_em       timestamp                        quando — preserva o passado nos relatorios
//   invalidada_por      integer                          usuarios.id, SEM foreign key
//   motivo_invalidacao  text                             minimo 15 caracteres, como o estorno
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ ESTA FASE NAO MUDA NUMERO NENHUM. Nenhuma das 64 consultas que leem
// `prestacoes_contas` sem filtro e tocada, e a coluna nasce `false` em todas as linhas —
// entao Dashboard, Produtividade, Estoque, fila do C.I. e a trava do `lib/limite-tr.js`
// continuam devolvendo exatamente o que devolvem hoje. A fase 2 (o filtro, consulta a
// consulta) e outra rodada, e depende das seis decisoes no fim do desenho.
//
// ⚠️ `ADD COLUMN IF NOT EXISTS`, NUNCA `CREATE TABLE IF NOT EXISTS` — armadilha 2 do projeto:
// aquele nao altera tabela que ja existe, e a migracao passaria em silencio sem criar nada.
//
// ⚠️ IDEMPOTENTE DE VERDADE: rodar duas vezes nao quebra e nao duplica. A segunda rodada acha
// as quatro colunas ja presentes, diz isso e sai em 0 — sem ALTER, sem foto nova e sem
// sobrescrever a reversao (ver `lib/reversao.js`, armadilha 26).
//
// ⚠️ AS CONFERENCIAS SAO CONTRA A FOTO, nunca contra numero literal. Um `=== 16479` cravado
// aqui viraria mentira na primeira PC inserida.
//
// ⚠️ E A COMPARACAO DE CONTEUDO E SO SOBRE AS COLUNAS QUE JA EXISTIAM. Depois do ALTER a linha
// tem quatro campos a mais, entao `md5(p::text)` difere estruturalmente da foto em TODAS as
// linhas — compararia o formato, nao o dado. A lista de colunas sai da propria foto.
//
// ⚠️ `NOT NULL DEFAULT false` NUMA TABELA VIVA. No PostgreSQL 11+ isso e operacao de
// METADADO: o default constante fica no catalogo e nenhuma das 16.479 linhas e reescrita. O
// script imprime a versao do servidor e avisa se ela for anterior a 11, caso em que HAVERIA
// reescrita da tabela inteira e a janela deixaria de ser instantanea.
//
// ⚠️ `lock_timeout` DE 5s, e nao espera indefinida. O ALTER pede ACCESS EXCLUSIVE, e o sistema
// esta ABERTO com a equipe dentro. Sem o timeout, uma consulta longa em curso faria este
// script esperar segurando a fila — e todo mundo pararia atras dele. Com o timeout ele
// desiste, faz ROLLBACK e diz para tentar de novo. E `SET LOCAL`: morre com a transacao.
//
// USO
//   node migracao_invalidada_20260902.js            dry-run: mostra e faz ROLLBACK
//   node migracao_invalidada_20260902.js --gravar   idem, com COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');
const FOTO = '_backup_pre_invalidada_20260902';
const REVERSAO = path.join(__dirname, 'reverter_invalidada_20260902.json');

// ⚠️ A ORDEM IMPORTA SO PARA A LEITURA. `invalidada` vem primeiro porque e ela que os
// `WHERE` da fase 2 vao usar; as outras tres sao a auditoria que o desenho exige.
const COLUNAS = [
  { nome: 'invalidada',         tipo: 'boolean NOT NULL DEFAULT false', nulo: 'NO'  },
  { nome: 'invalidada_em',      tipo: 'timestamp',                      nulo: 'YES' },
  { nome: 'invalidada_por',     tipo: 'integer',                        nulo: 'YES' },
  { nome: 'motivo_invalidacao', tipo: 'text',                           nulo: 'YES' },
];

const log = (s) => console.log(s);

/** As 64 consultas continuam intactas? Pergunta ao git, nao ao banco. */
function gitLimpo() {
  try {
    // Arquivos RASTREADOS modificados. O script novo e nao-rastreado e nao aparece aqui.
    const sujos = execSync('git diff --name-only HEAD', { cwd: __dirname, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    return { ok: sujos.length === 0, sujos };
  } catch (e) {
    return { ok: false, sujos: [`(git indisponivel: ${e.message})`] };
  }
}

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` MIGRACAO — colunas de INVALIDACAO de PC (fase 1)   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (ROLLBACK no fim)'}`);
  log(`${'═'.repeat(78)}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();

  try {
    // ── 0. AMBIENTE ──────────────────────────────────────────────────────────
    const ver = (await cli.query('SHOW server_version')).rows[0].server_version;
    const maior = parseInt(String(ver).split('.')[0], 10);
    log(`\n── 0. AMBIENTE ───────────────────────────────────────────────────────────`);
    log(`   PostgreSQL ................. ${ver}`);
    log(maior >= 11
      ? `   NOT NULL DEFAULT false ..... metadado, sem reescrita da tabela (PG >= 11)`
      : `   ⚠️ PG < 11 — o ALTER REESCREVE as linhas todas. Rodar em janela de manutencao.`);

    const g = gitLimpo();
    log(`   git (arquivos rastreados) .. ${g.ok ? 'limpo — nenhuma das 64 consultas tocada' : 'SUJO: ' + g.sujos.join(', ')}`);

    // ── 1. ESTADO ATUAL ──────────────────────────────────────────────────────
    const { rows: jaTem } = await cli.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name = ANY($1)`,
      [COLUNAS.map(c => c.nome)]);
    const presentes = new Set(jaTem.map(r => r.column_name));
    const faltando = COLUNAS.filter(c => !presentes.has(c.nome));

    log(`\n── 1. ESTADO ATUAL ───────────────────────────────────────────────────────`);
    for (const c of COLUNAS) {
      const r = jaTem.find(x => x.column_name === c.nome);
      log(`   ${c.nome.padEnd(20)} ${r
        ? `JA EXISTE (${r.data_type}, nullable ${r.is_nullable}, default ${r.column_default || 'nenhum'})`
        : 'falta'}`);
    }
    if (!faltando.length) {
      // ⚠️ IDEMPOTENCIA: nada a fazer NAO e erro. Sai em 0, e NAO escreve reversao — nao houve
      // rodada nova para registrar, e escrever aqui e o defeito da armadilha 26.
      log(`\n   As quatro colunas ja existem. Nada a fazer — a migracao e idempotente.\n`);
      cli.release(); await pool.end(); process.exit(0);
    }

    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '5s'`);

    // ── 2. FOTO ──────────────────────────────────────────────────────────────
    const antes = (await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas')).rows[0].n;
    await cli.query(`DROP TABLE IF EXISTS ${FOTO}`);
    await cli.query(`CREATE TABLE ${FOTO} AS SELECT * FROM prestacoes_contas`);
    const nFoto = (await cli.query(`SELECT COUNT(*)::int n FROM ${FOTO}`)).rows[0].n;

    // ⚠️ A FOTO DAS BAIXADAS POR ANALISTA — exigida no pedido, e e a que prova que nenhum
    // numero de produtividade se moveu. Fica na propria transacao, como tabela temporaria:
    // ela morre no COMMIT e no ROLLBACK, e nao deixa lixo no banco em nenhum dos dois casos.
    await cli.query(`
      CREATE TEMP TABLE _foto_bx_analista ON COMMIT DROP AS
        SELECT COALESCE(analista_id, -1) AS analista_id,
               COUNT(*) FILTER (WHERE baixada)::int          AS baixadas,
               COUNT(*) FILTER (WHERE status = 'baixada')::int AS status_baixada,
               COUNT(*)::int                                  AS total
          FROM prestacoes_contas GROUP BY 1`);
    const nAn = (await cli.query('SELECT COUNT(*)::int n FROM _foto_bx_analista')).rows[0].n;
    const somaBx = (await cli.query('SELECT COALESCE(SUM(baixadas),0)::int n FROM _foto_bx_analista')).rows[0].n;

    log(`\n── 2. FOTO ───────────────────────────────────────────────────────────────`);
    log(`   linhas antes ............... ${antes}`);
    log(`   foto da tabela ............. ${FOTO} (${nFoto} linhas)`);
    log(`   foto baixadas/analista ..... _foto_bx_analista (${nAn} analistas, ${somaBx} baixadas)`);

    // A lista de colunas da FOTO — e ela que define o que comparar depois do ALTER.
    const { rows: colsFoto } = await cli.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position`, [FOTO]);
    const lista = colsFoto.map(r => `"${r.column_name}"`);

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
        WHERE md5(ROW(${lista.map(c => 'f.' + c).join(', ')})::text)
           IS DISTINCT FROM md5(ROW(${lista.map(c => 'p.' + c).join(', ')})::text)`)).rows[0].n;

    const { rows: agora } = await cli.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name = ANY($1)
        ORDER BY column_name`, [COLUNAS.map(c => c.nome)]);

    const marcadas = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE invalidada IS TRUE)::int  AS t,
              COUNT(*) FILTER (WHERE invalidada IS NULL)::int  AS nulo,
              COUNT(invalidada_em)::int                        AS em,
              COUNT(invalidada_por)::int                       AS por,
              COUNT(motivo_invalidacao)::int                   AS motivo
         FROM prestacoes_contas`)).rows[0];

    // ⚠️ POR ANALISTA, LINHA A LINHA. Um `SUM` igual dos dois lados esconderia duas trocas que
    // se anulam; o FULL JOIN acha analista que sumiu, que apareceu, e que mudou de numero.
    const difAn = (await cli.query(`
      SELECT COUNT(*)::int n FROM (
        SELECT COALESCE(analista_id, -1) AS analista_id,
               COUNT(*) FILTER (WHERE baixada)::int          AS baixadas,
               COUNT(*) FILTER (WHERE status = 'baixada')::int AS status_baixada,
               COUNT(*)::int                                  AS total
          FROM prestacoes_contas GROUP BY 1) d
      FULL JOIN _foto_bx_analista f USING (analista_id)
      WHERE f.analista_id IS NULL OR d.analista_id IS NULL
         OR d.baixadas IS DISTINCT FROM f.baixadas
         OR d.status_baixada IS DISTINCT FROM f.status_baixada
         OR d.total IS DISTINCT FROM f.total`)).rows[0].n;

    const gDepois = gitLimpo();

    const ok = [], mal = [];
    (depois === nFoto ? ok : mal).push(`total de PCs inalterado: foto ${nFoto} == depois ${depois}`);
    (sumidas === 0 ? ok : mal).push(`linhas da foto SUMIDAS: ${sumidas} (tem de ser 0)`);
    (novas === 0 ? ok : mal).push(`linhas NOVAS que a foto nao tem: ${novas} (tem de ser 0)`);
    (alteradas === 0 ? ok : mal).push(`conteudo ALTERADO nas colunas antigas: ${alteradas} (tem de ser 0)`);
    (agora.length === COLUNAS.length ? ok : mal).push(`as quatro colunas existem: ${agora.length} de ${COLUNAS.length}`);
    for (const c of COLUNAS) {
      const r = agora.find(x => x.column_name === c.nome);
      ((r && r.is_nullable === c.nulo) ? ok : mal).push(
        `${c.nome}: nullable ${r ? r.is_nullable : '(ausente)'} — esperado ${c.nulo}`);
    }
    const inv = agora.find(c => c.column_name === 'invalidada');
    ((inv && /false/i.test(inv.column_default || '')) ? ok : mal).push(
      `invalidada tem DEFAULT false: ${inv ? (inv.column_default || 'nenhum') : '(ausente)'}`);
    (marcadas.t === 0 ? ok : mal).push(`nenhuma PC com invalidada = true: ${marcadas.t} (tem de ser 0)`);
    (marcadas.nulo === 0 ? ok : mal).push(`nenhuma PC com invalidada NULA: ${marcadas.nulo} (tem de ser 0)`);
    ((marcadas.em + marcadas.por + marcadas.motivo) === 0 ? ok : mal).push(
      `auditoria vazia: em ${marcadas.em}, por ${marcadas.por}, motivo ${marcadas.motivo}`);
    (difAn === 0 ? ok : mal).push(`baixadas por analista identicas a foto: ${difAn} analista(s) com diferenca`);
    (gDepois.ok ? ok : mal).push(
      `nenhuma das 64 consultas alterada (git diff HEAD vazio)${gDepois.ok ? '' : ': ' + gDepois.sujos.join(', ')}`);

    ok.forEach(m => log(`   ✓ ${m}`));
    mal.forEach(m => log(`   ✗ ${m}`));

    // ⚠️ O JSON DE REVERSAO E ESCRITO ANTES DE TERMINAR, e desfaz por NOME DE COLUNA — DDL nao
    // tem "lista de chaves", mas tem nome, que e igualmente explicito.
    // ⚠️ E PASSA POR `lib/reversao.js`: se ja existir ali a reversao de uma GRAVACAO, ela e
    // preservada e esta rodada escreve ao lado. Idempotente no banco nao e idempotente no
    // disco — armadilha 26.
    const modo = (GRAVAR && !mal.length) ? 'gravacao' : 'dry-run';
    const escrito = escreverReversao(
      modo === 'gravacao' ? REVERSAO : REVERSAO.replace('.json', '_DRYRUN.json'), {
        quando: new Date().toISOString(),
        modo,
        script: 'migracao_invalidada_20260902.js',
        fase: '1 de 2 — so as colunas; nenhuma das 64 consultas foi tocada',
        foto: FOTO,
        linhas_na_foto: nFoto,
        colunas_criadas: faltando.map(c => `${c.nome} ${c.tipo}`),
        desfazer: faltando.map(c => `ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ${c.nome};`),
        conferencias_ok: ok,
        conferencias_falhas: mal,
        aviso: 'DROP COLUMN apaga o que estiver gravado nelas. Conferir antes se ja ha PC invalidada: '
             + 'SELECT COUNT(*) FROM prestacoes_contas WHERE invalidada = true;',
      });
    log(`\n   reversao (${modo}) em ${path.basename(escrito.caminho)}`);
    if (escrito.preservou) log(`   ⚠️ preservado ${path.basename(escrito.preservou)} — ${escrito.motivo}`);

    if (mal.length) {
      await cli.query('ROLLBACK');
      log(`\n   ⛔ CONFERENCIA FALHOU — ROLLBACK. Nada foi gravado.\n`);
      cli.release(); await pool.end(); process.exit(1);
    }
    if (GRAVAR) {
      await cli.query('COMMIT');
      log(`\n   ✅ COMMIT — ${faltando.length} coluna(s) criada(s).`);
      log(`   foto em ${FOTO} · reversao em ${path.basename(escrito.caminho)}\n`);
    } else {
      await cli.query('ROLLBACK');
      log(`\n   ↩ ROLLBACK (dry-run). NADA foi gravado — nem a foto, nem as colunas.`);
      log(`   para gravar: node migracao_invalidada_20260902.js --gravar\n`);
    }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch (_) {}
    const dica = /lock_timeout|canceling statement/i.test(e.message)
      ? '\n   (o ALTER nao conseguiu o lock em 5s — ha consulta longa em curso. Tentar de novo.)'
      : '';
    console.error(`\n   ⛔ ERRO — ROLLBACK. Nada foi gravado.\n   ${e.message}${dica}\n`);
    cli.release(); await pool.end(); process.exit(1);
  }
  cli.release(); await pool.end();
})();
