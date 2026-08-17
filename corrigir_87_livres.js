// CAMINHO: sigpc-api/corrigir_87_livres.js
//
// AS 87 PCs SEM DONO QUE FICARAM COM `status = 'analise'`. PADRÃO = DRY-RUN.
//
// Autorizado pelo Richard em 16/08/2026.
//
// ⚠️ O DEFEITO NA TELA. Seis TRs aparecem como "Livre" no Estoque e recusam com "Nenhuma PC
// livre nesta TR" ao assumir. A listagem deriva o status de `!analista_nome`; o assumir exige
// `status = 'livre' AND analista_id IS NULL`. Sem dono E com `status='analise'` cai no vão.
//
//   2020TR000620 (77 PCs) · 2020TR000896 (3) · 2020TR000933 (2)
//   2020TR001235 (2) · 2020TR001590 (2) · 2020TR001160 (1)
//
// ⚠️ SÃO AS ÚNICAS DO ACERVO. Das PCs sem dono, 6.081 estão `livre` e estas 87 estão
// `analise`. Não há terceiro caso — conferido, e o script aborta se aparecer mais.
//
// A ORIGEM, medida: o `atualizado_em` delas é 10/08/2026 entre 10:40:53 e 10:47:13, uma a uma,
// TR por TR — o padrão de um PATCH por PC vindo do navegador, que era como a devolução
// funcionava antes de 13/08. `PATCH /prestacoes_contas/:codigo_pc` aceita `analista_id` sem
// `status`, e é isso que deixa a metade para trás. O caminho de hoje não erra:
// `lib/devolucao.js` grava `status`, `analista_id` e `analista_nome` JUNTOS, numa transação.
//
// ⚠️ ISTO CORRIGE O DADO, NÃO O VÃO. Enquanto a listagem e o assumir usarem regras
// diferentes, um novo caminho que esqueça o `status` recria o problema. A proposta para
// unificar está separada, e é decisão do Richard.
//
// USO:
//   node corrigir_87_livres.js            dry-run: escreve, confere e faz ROLLBACK
//   node corrigir_87_livres.js --gravar   idem, com COMMIT

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const D = __dirname + '/';
const BK = '_backup_87livres_20260816';
const ESPERADO = 87;
const TRS_ESPERADAS = 6;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);
    await cli.query(`CREATE TABLE ${BK} AS SELECT * FROM prestacoes_contas`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK}`);
    nl(`── BACKUP ${BK}: ${bk.n} linhas`);

    // ── a LISTA EXPLÍCITA, capturada ANTES de escrever (regra 12) ─────────────
    const { rows: alvo } = await cli.query(`
      SELECT codigo_pc, tr, parcial_num, status, baixada, parecer_tipo
        FROM prestacoes_contas
       WHERE setorial_id = 'FCEE' AND analista_id IS NULL AND status = 'analise'
       ORDER BY tr, codigo_pc
       FOR UPDATE`);
    const codigos = alvo.map(r => r.codigo_pc);
    const trs = [...new Set(alvo.map(r => r.tr))];

    nl(`\n── O ALVO ────────────────────────────────────────────────`);
    nl(`   PCs sem dono e com status='analise': ${codigos.length}`);
    trs.forEach(t => nl(`      ${t}  ${alvo.filter(r => r.tr === t).length} PCs`));

    // ⚠️ O ESCOPO É CRAVADO. Se o número mudou desde a medição, alguém mexeu no meio e a
    // lista já não é a que foi analisada — parar é mais barato que gravar sobre o desconhecido.
    if (codigos.length !== ESPERADO || trs.length !== TRS_ESPERADAS)
      throw new Error(`esperava ${ESPERADO} PCs em ${TRS_ESPERADAS} TRs, achei ${codigos.length} em ${trs.length}`);
    // e nenhuma pode ter trabalho feito — se tiver, `livre` apagaria o estado dela
    const sujas = alvo.filter(r => r.baixada || r.parecer_tipo);
    if (sujas.length)
      throw new Error(`${sujas.length} tem baixa ou parecer — nao sao livres: ${sujas.map(s => s.codigo_pc).join(', ')}`);

    const { rowCount } = await cli.query(
      `UPDATE prestacoes_contas SET status = 'livre', atualizado_em = NOW()
        WHERE codigo_pc = ANY($1)`, [codigos]);
    if (rowCount !== codigos.length)
      throw new Error(`esperava ${codigos.length}, o UPDATE pegou ${rowCount}`);
    nl(`\n>> ${rowCount} PCs passaram para status = 'livre'`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER ────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    // nada além de `status` e `atualizado_em` pode ter mudado, em linha nenhuma
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.analista_id, b.analista_nome, b.baixada, b.data_baixa, b.parecer_tipo, b.valor,
             b.parcial_num, b.enviado_ci, b.ci_situacao, b.situacao_atual)
         IS DISTINCT FROM
            (p.analista_id, p.analista_nome, p.baixada, p.data_baixa, p.parecer_tipo, p.valor,
             p.parcial_num, p.enviado_ci, p.ci_situacao, p.situacao_atual)`);
    // e o `status` só nas 87
    const c2 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE b.status IS DISTINCT FROM p.status AND NOT (p.codigo_pc = ANY($1))`, [codigos]);
    const c3 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);
    // o defeito acabou: ninguém mais sem dono fora de 'livre'
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE analista_id IS NULL AND status <> 'livre'`);
    // e as 6 TRs passam a ser assumíveis pela MESMA regra do lib/assumir.js
    const c5 = await un(`SELECT COUNT(DISTINCT tr)::int n FROM prestacoes_contas
      WHERE tr = ANY($1) AND status = 'livre' AND analista_id IS NULL`, [trs]);

    const checks = [
      ['nenhuma coluna alem de status mexida', c1.n === 0, c1.n],
      ['status mexido fora das 87',            c2.n === 0, c2.n],
      ['nenhuma PC criada nem apagada',        c3.n === bk.n, `${bk.n} -> ${c3.n}`],
      ['sem dono e fora de livre: zerou',      c4.n === 0, c4.n],
      ['as 6 TRs viraram assumiveis',          c5.n === TRS_ESPERADAS, `${c5.n}/${TRS_ESPERADAS}`],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(38)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_87livres_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup: BK, codigos }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   reversao: UPDATE prestacoes_contas SET status='analise' WHERE codigo_pc = ANY(<codigos>);`);
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
