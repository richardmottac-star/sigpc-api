// CAMINHO: sigpc-api/migracao_assunto_situacao_20260831.js
//
// ACRESCENTA `assunto varchar(120) NULL` A `sgpe_situacao`.  (31/08/2026)
//
// Motivo: a faixa de vinculação do modal do SGPe mostra o assunto de cada processo, e ele
// NUNCA FOI GRAVADO. O modal lê o assunto AO VIVO do portal (`lib/sgpe-portal.js`, campo
// `nmAssunto`), e nada o persistia — medido em 31/08: nenhuma coluna `assunto`, `titulo` ou
// `interessado` existe nas tabelas do SGPe.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DRY-RUN POR PADRÃO. Sem `--executar` nada é commitado: o ALTER roda dentro da transação,
// as conferências rodam contra ele, e no fim vem `ROLLBACK`. É assim que se vê o resultado
// ANTES de aceitá-lo.
//
//   node migracao_assunto_situacao_20260831.js              # mostra e desfaz
//   node migracao_assunto_situacao_20260831.js --executar   # grava
//
// ⚠️ NADA É DERRUBADO. `ADD COLUMN IF NOT EXISTS` só acrescenta, e a coluna nasce NULL em
// todas as 7.768 linhas — nenhum valor existente é tocado. Rodar duas vezes não faz nada na
// segunda: é o que torna o script idempotente.
//
// ⚠️ AS CONFERÊNCIAS SÃO CONTRA A FOTO, E DEPOIS DE GRAVAR — não antes. Conferir só antes
// prova o que se esperava, não o que aconteceu. Qualquer uma que falhe derruba a transação.
//
// ⚠️ A REVERSÃO VAI PARA UM JSON, e ela é um `DROP COLUMN` — destrutivo por natureza, porque
// desfazer um acréscimo é remover. O arquivo é REGISTRO, não gatilho: nada aqui o executa.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const EXECUTAR = process.argv.includes('--executar');
const TABELA = 'sgpe_situacao';
const COLUNA = 'assunto';
const TIPO = 'varchar(120)';
const ARQ_REVERSAO = path.join(__dirname, `reverter_assunto_situacao_20260831${EXECUTAR ? '' : '_DRYRUN'}.json`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const log = (...a) => console.log(...a);
const falhas = [];
const conf = (passou, rotulo, detalhe) => {
  log(`  ${passou ? '✔' : '✘'}  ${rotulo}${passou || detalhe === undefined ? '' : `   [${detalhe}]`}`);
  if (!passou) falhas.push(rotulo);
};

async function colunaExiste(cli) {
  const { rows } = await cli.query(
    `SELECT data_type, character_maximum_length AS tam, is_nullable
       FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [TABELA, COLUNA]);
  return rows[0] || null;
}

(async () => {
  const cli = await pool.connect();
  try {
    log(`\n${'═'.repeat(72)}`);
    log(`  ${TABELA}.${COLUNA} ${TIPO} NULL`);
    log(`  modo: ${EXECUTAR ? 'EXECUTAR (vai gravar)' : 'DRY-RUN (desfaz no fim)'}`);
    log(`${'═'.repeat(72)}`);

    await cli.query('BEGIN');

    // ── A FOTO, antes de tocar em nada ───────────────────────────────────────
    const { rows: [f] } = await cli.query(
      `SELECT COUNT(*)::int AS linhas,
              COUNT(situacao_portal)::int AS com_situacao,
              COUNT(*) FILTER (WHERE resultado = 'OK')::int AS ok
         FROM ${TABELA}`);
    const antes = await colunaExiste(cli);
    log('\n── FOTO ANTES ──');
    log(`  linhas em ${TABELA} ........ ${f.linhas}`);
    log(`  com situacao_portal ......... ${f.com_situacao}`);
    log(`  resultado = 'OK' ............ ${f.ok}`);
    log(`  a coluna ${COLUNA} já existe? ${antes ? 'SIM — ' + antes.data_type + '(' + antes.tam + ')' : 'não'}`);

    // ── IDEMPOTENTE: já existindo, não há o que fazer ────────────────────────
    if (antes) {
      log('\n  A coluna já existe. Nada a fazer — o script é idempotente.');
      await cli.query('ROLLBACK');
      log(`\n${'═'.repeat(72)}\n  NADA FOI ALTERADO.\n${'═'.repeat(72)}\n`);
      return;
    }

    // ── O COMANDO, NA TELA, ANTES DE RODAR ───────────────────────────────────
    const SQL = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COLUNA} ${TIPO}`;
    log('\n── O COMANDO ──');
    log(`  ${SQL}`);

    await cli.query(SQL);

    // ── CONFERÊNCIAS, DEPOIS DE GRAVAR, CONTRA A FOTO ────────────────────────
    log('\n── CONFERÊNCIAS (depois do ALTER, contra a foto) ──');
    const { rows: [d] } = await cli.query(
      `SELECT COUNT(*)::int AS linhas,
              COUNT(situacao_portal)::int AS com_situacao,
              COUNT(*) FILTER (WHERE resultado = 'OK')::int AS ok,
              COUNT(${COLUNA})::int AS com_assunto
         FROM ${TABELA}`);
    const depois = await colunaExiste(cli);

    conf(d.linhas === f.linhas, `a contagem de linhas não mudou (${f.linhas})`, `${f.linhas} -> ${d.linhas}`);
    conf(d.com_situacao === f.com_situacao, 'nenhuma situacao_portal foi tocada', `${f.com_situacao} -> ${d.com_situacao}`);
    conf(d.ok === f.ok, "os resultados 'OK' seguem os mesmos", `${f.ok} -> ${d.ok}`);
    conf(!!depois, 'a coluna passou a existir');
    conf(depois && depois.data_type === 'character varying', 'e é varchar', depois && depois.data_type);
    conf(depois && depois.tam === 120, 'de 120', depois && depois.tam);
    conf(depois && depois.is_nullable === 'YES', 'e aceita null', depois && depois.is_nullable);
    // ⚠️ A COLUNA NASCE VAZIA EM TODAS AS LINHAS, e isso é o esperado: quem a preenche é o
    // `job_sgpe_situacao`, no rodízio. Até ele passar, a faixa mostra "ainda não sincronizado".
    conf(d.com_assunto === 0, 'e nasce NULL em todas as linhas', d.com_assunto);

    // ── A REVERSÃO, EM JSON ──────────────────────────────────────────────────
    fs.writeFileSync(ARQ_REVERSAO, JSON.stringify({
      gerado_em: new Date().toISOString(),
      modo: EXECUTAR ? 'EXECUTAR' : 'DRY-RUN',
      o_que_foi_feito: SQL,
      foto_antes: f,
      para_reverter: `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COLUNA}`,
      aviso: 'Reverter APAGA a coluna e tudo o que o job tiver gravado nela. Este arquivo é ' +
             'registro, não gatilho: nada neste repositório o executa.',
    }, null, 2));
    log(`\n  reversão registrada em ${path.basename(ARQ_REVERSAO)}`);

    // ── COMMIT ou ROLLBACK ───────────────────────────────────────────────────
    if (falhas.length) {
      await cli.query('ROLLBACK');
      log(`\n${'═'.repeat(72)}`);
      log(`  ${falhas.length} CONFERÊNCIA(S) FALHARAM — ROLLBACK. Nada foi gravado.`);
      log(`${'═'.repeat(72)}\n`);
      process.exitCode = 1;
      return;
    }
    if (EXECUTAR) {
      await cli.query('COMMIT');
      log(`\n${'═'.repeat(72)}\n  COMMIT. A coluna existe.\n${'═'.repeat(72)}\n`);
    } else {
      await cli.query('ROLLBACK');
      log(`\n${'═'.repeat(72)}`);
      log('  DRY-RUN — ROLLBACK. Nada foi gravado.');
      log('  Para valer:  node migracao_assunto_situacao_20260831.js --executar');
      log(`${'═'.repeat(72)}\n`);
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
