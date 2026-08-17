// CAMINHO: sigpc-api/atualizar_aviso_id6.js
//
// TROCA O TEXTO DO AVISO id 6 PELO TEXTO CURTO. PADRÃO = DRY-RUN.
//
// O Richard colou o texto curto no chat em 16/08/2026; o que está no banco termina com uma
// frase a mais. Este script troca **uma coluna de uma linha** — `texto` — e nada além.
//
// ⚠️ VAI POR SCRIPT E NÃO POR `psql` DE PROPÓSITO: o texto tem travessão, acento e cedilha,
// e o parâmetro `$1` do `pg` entrega a string byte a byte. Colar SQL com acento no terminal
// do Windows é como se perde um "ç" sem ninguém ver.
//
// ⚠️ NÃO TOCA em `escopo`, `ativo`, `grupo`, `inicio`, `fim` nem `ordem`. O aviso continua
// `urgente` e ativo — trocar o texto não pode mudar quem o vê.
//
//   node atualizar_aviso_id6.js              dry-run: mostra o antes e o depois
//   node atualizar_aviso_id6.js --gravar     grava

const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const ID = 6;

const TEXTO_NOVO =
  'SISTEMA AJUSTADO E ATUALIZADO EM 16/08/2026 — Numeração das parciais corrigida e '
  + 'Controle Interno regularizado. Dê Ctrl+F5 para carregar a versão nova. '
  + 'Leia o recado no seu grupo.';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '15s'");

    const { rows: [antes] } = await cli.query(
      'SELECT * FROM faixa_aviso WHERE id = $1 FOR UPDATE', [ID]);
    if (!antes) throw new Error(`o aviso id ${ID} nao existe`);

    nl('── ANTES ─────────────────────────────────────────────────');
    nl(`   escopo "${antes.escopo}" · ativo ${antes.ativo} · grupo ${antes.grupo ?? 'todos'} · ordem ${antes.ordem}`);
    nl(`   ${antes.texto.length} caracteres`);
    nl(`   "${antes.texto}"`);

    nl('\n── DEPOIS ────────────────────────────────────────────────');
    nl(`   ${TEXTO_NOVO.length} caracteres  (${TEXTO_NOVO.length - antes.texto.length})`);
    nl(`   "${TEXTO_NOVO}"`);

    // O que sai, em uma linha — para conferir que é só a cauda da frase.
    const comum = (() => { let i = 0; while (i < Math.min(antes.texto.length, TEXTO_NOVO.length)
      && antes.texto[i] === TEXTO_NOVO[i]) i++; return i; })();
    nl(`\n   os primeiros ${comum} caracteres sao IDENTICOS`);
    nl(`   sai:  "${antes.texto.slice(comum)}"`);
    nl(`   entra: "${TEXTO_NOVO.slice(comum)}"`);

    if (antes.texto === TEXTO_NOVO) {
      await cli.query('ROLLBACK');
      nl('\n>> O texto ja e esse. Nada a fazer.');
      return;
    }

    const { rowCount } = await cli.query(
      'UPDATE faixa_aviso SET texto = $2, atualizado_em = NOW() WHERE id = $1', [ID, TEXTO_NOVO]);
    if (rowCount !== 1) throw new Error(`esperava tocar 1 linha, toquei ${rowCount}`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ───────────────────
    const { rows: [dep] } = await cli.query('SELECT * FROM faixa_aviso WHERE id = $1', [ID]);
    const { rows: [outras] } = await cli.query(
      'SELECT COUNT(*)::int n FROM faixa_aviso WHERE id <> $1', [ID]);

    const checks = [
      ['o texto e exatamente o novo',   dep.texto === TEXTO_NOVO, `${dep.texto.length} car`],
      ['o escopo nao mudou',            dep.escopo === antes.escopo, `${antes.escopo} -> ${dep.escopo}`],
      ['o ativo nao mudou',             dep.ativo === antes.ativo, `${antes.ativo} -> ${dep.ativo}`],
      ['o grupo nao mudou',             String(dep.grupo) === String(antes.grupo), `${antes.grupo} -> ${dep.grupo}`],
      ['a ordem nao mudou',             dep.ordem === antes.ordem, `${antes.ordem} -> ${dep.ordem}`],
      ['o periodo nao mudou',           String(dep.inicio) === String(antes.inicio)
                                     && String(dep.fim) === String(antes.fim), `${dep.inicio} / ${dep.fim}`],
      ['nenhum outro aviso foi tocado', outras.n === 1, `${outras.n} outros avisos`],
    ];

    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) {
      if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(32)} ${v}`);
    }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl('   Para desfazer, o texto antigo esta impresso acima em "ANTES".');
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
