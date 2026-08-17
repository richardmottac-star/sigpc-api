// CAMINHO: sigpc-api/atualizar_aviso_id6.js
//
// TROCA O TEXTO DO AVISO id 6 E ESTENDE O FIM DO PERÍODO. PADRÃO = DRY-RUN.
//
// O Richard colou o texto curto no chat em 16/08/2026; o que está no banco termina com uma
// frase a mais. E em 17/08 ele mandou estender o fim para **31/08/2026** — o aviso estava
// marcado para sair do ar em 18/08, dois dias depois de entrar.
//
// ⚠️ ESTE ARQUIVO MUDOU DE ESCOPO EM 17/08/2026. Até então ele trocava **uma** coluna e o
// cabeçalho dizia, com todas as letras, que não encostava em `fim`. Agora são **duas**
// colunas, na MESMA transação — e é de propósito: duas escritas separadas na mesma linha
// deixariam uma janela em que o aviso está com o texto novo e o prazo velho.
//
// ⚠️ VAI POR SCRIPT E NÃO POR `psql` DE PROPÓSITO: o texto tem travessão, acento e cedilha,
// e o parâmetro `$1` do `pg` entrega a string byte a byte. Colar SQL com acento no terminal
// do Windows é como se perde um "ç" sem ninguém ver.
//
// ⚠️ NÃO TOCA em `escopo`, `ativo`, `grupo`, `inicio` nem `ordem`. O aviso continua
// `urgente` e ativo — trocar o texto e o prazo não pode mudar QUEM o vê.
//
// ⚠️ `fim` É `DATE`, E O `pg` DEVOLVE `DATE` COMO OBJETO `Date` — armadilha 25. Por isso toda
// leitura de data aqui sai do banco já como texto ISO (`to_char`), e nenhuma comparação
// passa por `String(new Date(...))`, que daria "Sun Aug 31 2026 ...".
//
// ⚠️ O `fim` É INCLUSIVO: `lib/faixa.js` filtra `fim >= HOJE_BR`. Com 31/08 o aviso passa o
// dia 31 inteiro e some em 01/09.
//
//   node atualizar_aviso_id6.js              dry-run: mostra o antes e o depois
//   node atualizar_aviso_id6.js --gravar     grava

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const ID = 6;

const TEXTO_NOVO =
  'SISTEMA AJUSTADO E ATUALIZADO EM 16/08/2026 — Numeração das parciais corrigida e '
  + 'Controle Interno regularizado. Dê Ctrl+F5 para carregar a versão nova. '
  + 'Leia o recado no seu grupo.';

const FIM_NOVO = '2026-08-31';

const ARQ_REVERSAO = `reverter_aviso_id6_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

// Todas as colunas da linha, com as datas já em texto ISO. É esta consulta que evita a
// armadilha 25 — nenhum `Date` do `pg` chega a ser comparado.
const SEL_LINHA = `
  SELECT id, texto, escopo, ativo, grupo, ordem,
         to_char(inicio, 'YYYY-MM-DD') AS inicio_iso,
         to_char(fim,    'YYYY-MM-DD') AS fim_iso
    FROM faixa_aviso WHERE id = $1`;

// A impressão digital de TODOS os outros avisos. Contar não bastaria: a contagem continuaria
// 1 se um UPDATE largo tivesse reescrito o texto do vizinho.
const SEL_OUTROS = `
  SELECT COUNT(*)::int AS n,
         COALESCE(md5(string_agg(
           id || '|' || texto || '|' || escopo || '|' || ativo || '|' ||
           COALESCE(grupo, '-') || '|' || ordem || '|' ||
           COALESCE(to_char(inicio, 'YYYY-MM-DD'), '-') || '|' ||
           COALESCE(to_char(fim, 'YYYY-MM-DD'), '-'), ',' ORDER BY id)), 'vazio') AS marca
    FROM faixa_aviso WHERE id <> $1`;

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '15s'");

    const { rows: [antes] } = await cli.query(`${SEL_LINHA} FOR UPDATE`, [ID]);
    if (!antes) throw new Error(`o aviso id ${ID} nao existe`);
    const { rows: [outrasAntes] } = await cli.query(SEL_OUTROS, [ID]);

    nl('── ANTES ─────────────────────────────────────────────────');
    nl(`   escopo "${antes.escopo}" · ativo ${antes.ativo} · grupo ${antes.grupo ?? 'todos'} · ordem ${antes.ordem}`);
    nl(`   periodo ${antes.inicio_iso ?? 'sem inicio'} -> ${antes.fim_iso ?? 'sem fim'}`);
    nl(`   ${antes.texto.length} caracteres`);
    nl(`   "${antes.texto}"`);

    nl('\n── DEPOIS ────────────────────────────────────────────────');
    nl(`   periodo ${antes.inicio_iso ?? 'sem inicio'} -> ${FIM_NOVO}`);
    nl(`   ${TEXTO_NOVO.length} caracteres  (${TEXTO_NOVO.length - antes.texto.length})`);
    nl(`   "${TEXTO_NOVO}"`);

    // O que sai, em uma linha — para conferir que é só a cauda da frase.
    const comum = (() => { let i = 0; while (i < Math.min(antes.texto.length, TEXTO_NOVO.length)
      && antes.texto[i] === TEXTO_NOVO[i]) i++; return i; })();
    nl(`\n   os primeiros ${comum} caracteres sao IDENTICOS`);
    nl(`   sai:  "${antes.texto.slice(comum)}"`);
    nl(`   entra: "${TEXTO_NOVO.slice(comum)}"`);
    nl(`   e o fim vai de ${antes.fim_iso ?? 'sem fim'} para ${FIM_NOVO}`);

    if (antes.texto === TEXTO_NOVO && antes.fim_iso === FIM_NOVO) {
      await cli.query('ROLLBACK');
      nl('\n>> O texto e o fim ja sao esses. Nada a fazer.');
      return;
    }

    const { rowCount } = await cli.query(
      'UPDATE faixa_aviso SET texto = $2, fim = $3::date, atualizado_em = NOW() WHERE id = $1',
      [ID, TEXTO_NOVO, FIM_NOVO]);
    if (rowCount !== 1) throw new Error(`esperava tocar 1 linha, toquei ${rowCount}`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ───────────────────
    const { rows: [dep] } = await cli.query(SEL_LINHA, [ID]);
    const { rows: [outrasDep] } = await cli.query(SEL_OUTROS, [ID]);

    const checks = [
      ['o texto e exatamente o novo',    dep.texto === TEXTO_NOVO, `${dep.texto.length} car`],
      ['o fim e exatamente 31/08',       dep.fim_iso === FIM_NOVO, `${antes.fim_iso} -> ${dep.fim_iso}`],
      ['o INICIO nao mudou',             dep.inicio_iso === antes.inicio_iso, `${antes.inicio_iso} -> ${dep.inicio_iso}`],
      ['o fim e >= o inicio',            !dep.inicio_iso || dep.fim_iso >= dep.inicio_iso, `${dep.inicio_iso} .. ${dep.fim_iso}`],
      ['o escopo nao mudou',             dep.escopo === antes.escopo, `${antes.escopo} -> ${dep.escopo}`],
      ['o ativo nao mudou',              dep.ativo === antes.ativo, `${antes.ativo} -> ${dep.ativo}`],
      ['o grupo nao mudou',              String(dep.grupo) === String(antes.grupo), `${antes.grupo} -> ${dep.grupo}`],
      ['a ordem nao mudou',              dep.ordem === antes.ordem, `${antes.ordem} -> ${dep.ordem}`],
      ['nenhum outro aviso foi tocado',  outrasDep.n === outrasAntes.n
                                      && outrasDep.marca === outrasAntes.marca,
                                         `${outrasDep.n} outros, marca ${outrasDep.marca === outrasAntes.marca ? 'igual' : 'DIFERENTE'}`],
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
      // A lista de reversão é gravada ANTES do COMMIT: se o disco recusar, a transação cai
      // junto e não fica escrita sem como desfazer.
      fs.writeFileSync(ARQ_REVERSAO, JSON.stringify({
        quando: new Date().toISOString(),
        tabela: 'faixa_aviso',
        antes: [{ id: ID, texto: antes.texto, fim: antes.fim_iso, inicio: antes.inicio_iso }],
        depois: [{ id: ID, texto: TEXTO_NOVO, fim: FIM_NOVO }],
      }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   Para desfazer: ${ARQ_REVERSAO} (e o texto antigo tambem esta em "ANTES", acima).`);
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
