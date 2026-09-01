// CAMINHO: sigpc-api/corrigir_analista_nome.js
//
// AS 10 PCs EM QUE `analista_nome` CONTRADIZ `analista_id`.  (01/09/2026)
//
// O `analista_id` MANDA — armadilha 1 do projeto. O `analista_nome` é rótulo, e um rótulo que
// contradiz a chave é pior que rótulo nenhum: a tela mostra o NOME em vários pontos, e foi
// exatamente assim que a Juliana (id 45) viu o próprio nome numa PC da Graciane (id 41) e
// reportou cinco TRs que não eram dela.
//
// ⚠️ QUEM DIZ QUAL É O APELIDO É A `nomeCurto` DE `lib/assumir.js`, e não este arquivo. Ela lê o
// `MAPA_NOME`, que é a única fonte de "Sandra Cezária Ronchi Rocha" → "Sandra Rocha". Escrever
// aqui uma segunda regra — "o primeiro nome" — reprovaria 832 PCs corretas de 4 analistas
// (ids 19, 51, 23 e 40) cujo apelido legítimo não é o primeiro nome ou perde acento. Foi essa
// exatamente a divergência entre as duas medições do levantamento: 842 contra 10, e o certo
// é 10.
//
// USO:
//   node corrigir_analista_nome.js            # DRY-RUN, não grava nada
//   node corrigir_analista_nome.js --gravar   # grava, em UMA transação
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ SÓ A COLUNA `analista_nome`. O `analista_id` não é tocado — é ele que está certo, e é a
// chave por onde tudo se filtra. Mexer nele trocaria o DONO da PC, que é o oposto do conserto.
//
// ⚠️ E SÓ AS 10, POR LISTA EXPLÍCITA DE `codigo_pc`. Armadilha 11: `WHERE` derivado de condição
// já custou caro neste banco — em 12/08 uma reversão por `ci_rodada <> 1` pegou 14.639 linhas
// em vez de 7. A lista é capturada ANTES e o UPDATE entra com `= ANY($1)`.
//
// ⚠️ IDEMPOTENTE: a segunda execução encontra 0 a corrigir e sai sem abrir transação.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { nomeCurto } = require('./lib/assumir');

const GRAVAR = process.argv.includes('--gravar');
const TOTAL_ESPERADO = 16479;   // o acervo em 01/09/2026, conferido antes de escrever isto

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

/** Acento não pode decidir se um nome "contradiz": "Janaina" e "Janaína" são a mesma pessoa. */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** O que o nome DEVERIA ser, dado o id. Null quando não dá para dizer. */
function esperado(nomeCadastro) {
  return nomeCadastro ? nomeCurto(nomeCadastro) : null;
}

const SQL_FOTO = `
  SELECT p.codigo_pc, p.tr, p.analista_id, p.analista_nome, u.nome AS nome_cadastro
    FROM prestacoes_contas p
    LEFT JOIN usuarios u ON u.id = p.analista_id
   WHERE p.analista_id IS NOT NULL
   ORDER BY p.codigo_pc`;

/** As que contradizem, a partir da foto. Uma definição só, usada antes e depois. */
function contradizem(linhas) {
  return linhas.filter((r) => {
    const esp = esperado(r.nome_cadastro);
    if (!esp) return false;              // id sem cadastro: outro problema, não este
    if (r.analista_nome == null) return false;
    return norm(r.analista_nome) !== norm(esp);
  });
}

(async () => {
  const cli = await pool.connect();
  const t0 = Date.now();
  try {
    console.log('═'.repeat(78));
    console.log('CORRIGIR analista_nome  —  ' + (GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (nada será gravado)'));
    console.log('═'.repeat(78));

    // ── 1. O TOTAL, ANTES ────────────────────────────────────────────────
    const { rows: t1 } = await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas');
    console.log('\nPCs no acervo ANTES: ' + t1[0].n
      + (t1[0].n === TOTAL_ESPERADO ? '  (bate com o esperado)' : '  *** DIFERE do esperado ' + TOTAL_ESPERADO + ' ***'));

    // ── 2. A FOTO, e quais contradizem ───────────────────────────────────
    const { rows: foto } = await cli.query(SQL_FOTO);
    const alvo = contradizem(foto);
    console.log('PCs com analista_id: ' + foto.length);
    console.log('PCs em que o nome contradiz o id: ' + alvo.length);

    if (!alvo.length) {
      // ⚠️ IDEMPOTÊNCIA: nada a fazer é sucesso, não erro. Sem transação, sem JSON.
      console.log('\nNada a corrigir. (A execução anterior já resolveu, ou o banco está limpo.)');
      return;
    }

    console.log('\nAS ' + alvo.length + ' — length: ' + alvo.length);
    alvo.forEach((r) => console.log('  ' + r.codigo_pc.padEnd(21) + ' · TR ' + r.tr
      + ' · analista_id=' + String(r.analista_id).padStart(3)
      + ' · nome ANTES: "' + r.analista_nome + '"'
      + ' · nome DEPOIS: "' + esperado(r.nome_cadastro) + '"'
      + '   (cadastro: ' + r.nome_cadastro + ')'));

    // ── 3. O JSON DE REVERSÃO, ANTES DE QUALQUER ESCRITA ─────────────────
    //
    // ⚠️ ANTES, NÃO DEPOIS. Gravado depois do UPDATE, ele descreveria o estado novo — e não
    // haveria para onde voltar. É a mesma razão da foto: conferir só depois prova o que se
    // esperava, não o que aconteceu.
    const rev = {
      gerado_em: new Date().toISOString(),
      modo: GRAVAR ? 'gravar' : 'dry-run',
      tabela: 'prestacoes_contas',
      coluna: 'analista_nome',
      total_acervo_antes: t1[0].n,
      // ⚠️ A REVERSÃO ENTRA POR `codigo_pc`, lista explícita — nunca por condição derivada.
      linhas: alvo.map((r) => ({
        codigo_pc: r.codigo_pc, tr: r.tr, analista_id: r.analista_id,
        analista_nome_antes: r.analista_nome,
        analista_nome_depois: esperado(r.nome_cadastro),
        nome_cadastro: r.nome_cadastro,
      })),
      sql_reversao: 'UPDATE prestacoes_contas SET analista_nome = $2 WHERE codigo_pc = $1',
    };
    const arq = path.join(__dirname,
      'reverter_analista_nome_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
      (GRAVAR ? '' : '_DRYRUN') + '.json');
    fs.writeFileSync(arq, JSON.stringify(rev, null, 2), 'utf8');
    console.log('\nJSON de reversão gravado: ' + path.basename(arq));

    if (!GRAVAR) {
      console.log('\n' + '─'.repeat(78));
      console.log('DRY-RUN encerrado. Nada foi gravado.');
      console.log('Para gravar:  node corrigir_analista_nome.js --gravar');
      return;
    }

    // ── 4. A TRANSAÇÃO ───────────────────────────────────────────────────
    await cli.query('BEGIN');

    const codigos = alvo.map((r) => r.codigo_pc);
    const novos = alvo.map((r) => esperado(r.nome_cadastro));

    // ⚠️ UMA COLUNA, LISTA EXPLÍCITA, E O `unnest` CASANDO CÓDIGO COM NOME. Um UPDATE com
    // CASE/WHEN faria o mesmo, e erraria em silêncio se um código ficasse de fora do CASE:
    // a linha seria escrita com NULL. Aqui, código sem par simplesmente não entra.
    const { rows: mexidas } = await cli.query(`
      UPDATE prestacoes_contas p
         SET analista_nome = v.nome
        FROM unnest($1::text[], $2::text[]) AS v(codigo_pc, nome)
       WHERE p.codigo_pc = v.codigo_pc
      RETURNING p.codigo_pc, p.analista_id, p.analista_nome`, [codigos, novos]);

    // ── 5. AS CONFERÊNCIAS, contra a foto e DENTRO da transação ──────────
    const problemas = [];
    if (mexidas.length !== alvo.length) {
      problemas.push('o UPDATE mexeu em ' + mexidas.length + ' linhas para ' + alvo.length + ' previstas');
    }

    const { rows: depois } = await cli.query(SQL_FOTO);
    const antesPorCod = new Map(foto.map((r) => [r.codigo_pc, r]));
    const depoisPorCod = new Map(depois.map((r) => [r.codigo_pc, r]));

    // (a) as 10, uma a uma
    console.log('\n' + '─'.repeat(78));
    console.log('AS ' + alvo.length + ', ANTES E DEPOIS — length: ' + alvo.length);
    for (const a of alvo) {
      const d = depoisPorCod.get(a.codigo_pc);
      if (!d) { problemas.push(a.codigo_pc + ' sumiu da base'); continue; }
      console.log('  ' + a.codigo_pc.padEnd(21) + ' · analista_id=' + String(d.analista_id).padStart(3)
        + ' · "' + a.analista_nome + '"  ->  "' + d.analista_nome + '"');
      if (d.analista_nome !== esperado(a.nome_cadastro)) {
        problemas.push(a.codigo_pc + ' ficou com "' + d.analista_nome + '", esperado "' + esperado(a.nome_cadastro) + '"');
      }
    }

    // (b) o total
    const { rows: t2 } = await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas');
    console.log('\nPCs no acervo — ANTES: ' + t1[0].n + ' · DEPOIS: ' + t2[0].n
      + (t1[0].n === t2[0].n ? '  (igual)' : '  *** MUDOU ***'));
    if (t1[0].n !== t2[0].n) problemas.push('o acervo mudou de tamanho: ' + t1[0].n + ' -> ' + t2[0].n);
    if (t2[0].n !== TOTAL_ESPERADO) problemas.push('o total depois (' + t2[0].n + ') difere do esperado ' + TOTAL_ESPERADO);

    // (c) a medição de contradição, de novo
    const aindaRuins = contradizem(depois);
    console.log('PCs em que o nome AINDA contradiz o id: ' + aindaRuins.length
      + (aindaRuins.length ? '  *** DEVERIA SER ZERO ***' : '  (zero)'));
    aindaRuins.forEach((r) => console.log('    ' + r.codigo_pc + ' · id=' + r.analista_id
      + ' · "' + r.analista_nome + '"'));
    if (aindaRuins.length) problemas.push(aindaRuins.length + ' PCs ainda contradizem depois do UPDATE');

    // (d) nenhum analista_id mudou — em NENHUMA das 16.479, não só nas 10
    //
    // ⚠️ A CONFERÊNCIA É SOBRE O ACERVO INTEIRO, e não sobre as 10. O que se quer provar é que
    // o UPDATE não vazou: uma linha fora da lista que tivesse mudado de dono não apareceria
    // numa conferência restrita às 10 — e é justamente essa que ninguém veria.
    let idsMudados = 0, foraDaLista = 0;
    const naLista = new Set(codigos);
    for (const a of foto) {
      const d = depoisPorCod.get(a.codigo_pc);
      if (!d) { problemas.push(a.codigo_pc + ' sumiu da base'); continue; }
      if (d.analista_id !== a.analista_id) {
        idsMudados++;
        problemas.push(a.codigo_pc + ': analista_id mudou de ' + a.analista_id + ' para ' + d.analista_id);
      }
      if (!naLista.has(a.codigo_pc) && d.analista_nome !== a.analista_nome) {
        foraDaLista++;
        problemas.push(a.codigo_pc + ': analista_nome mudou fora da lista das ' + alvo.length);
      }
    }
    console.log('analista_id alterados: ' + idsMudados + (idsMudados ? '  *** DEVERIA SER ZERO ***' : '  (zero)'));
    console.log('nomes alterados fora da lista: ' + foraDaLista
      + (foraDaLista ? '  *** DEVERIA SER ZERO ***' : '  (zero)'));
    if (foto.length !== depois.length) {
      problemas.push('o conjunto com analista_id mudou de tamanho: ' + foto.length + ' -> ' + depois.length);
    }

    // ── 6. COMMIT, ou ROLLBACK se qualquer conferência falhou ────────────
    if (problemas.length) {
      await cli.query('ROLLBACK');
      console.log('\n' + '═'.repeat(78));
      console.log('ROLLBACK — as conferências não bateram. NADA foi gravado.');
      console.log('problemas — length: ' + problemas.length);
      problemas.forEach((p) => console.log('  · ' + p));
      process.exitCode = 1;
      return;
    }

    await cli.query('COMMIT');
    console.log('\n' + '═'.repeat(78));
    console.log('COMMIT — ' + mexidas.length + ' PCs corrigidas em ' + ((Date.now() - t0) / 1000).toFixed(1) + 's.');
    console.log('Reversão: ' + path.basename(arq));
    console.log('═'.repeat(78));
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    console.error('\nERRO — ROLLBACK feito, nada gravado: ' + e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
