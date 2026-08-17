// CAMINHO: sigpc-api/atribuir_soltas.js
//
// AS PCs SOLTAS DENTRO DE TR QUE JÁ TEM DONO. PADRÃO = DRY-RUN.
//
// Autorizado pelo Richard em 16/08/2026: *"a TR tem dono, o trabalho é dele.
// Não toca em baixada nem em parecer."*
//
//   2020TR000632  Aline        66 de 70 PCs soltas   ← não é borda: quase a TR inteira
//   2020TR000723  Noici         9 de 32 (14 baixadas)
//   2022TR002068  Juliana       1 de 3
//   2020TR000940  Ana Claudia   1 de 2
//
// ⚠️ É O CASO INVERSO DAS 87. Lá era PC sem dono em TR sem dono, com `status` errado; aqui é
// PC sem dono em TR COM dono. A regra unificada (`assumir.PC_LIVRE_SQL`) não as oferece no
// Estoque — TR com dono nunca é Livre —, então elas não contavam para ninguém.
//
// ⚠️ `dt_assumida` E `dt_inicio_analise` SÃO HERDADAS DAS IRMÃS, NÃO `NOW()`.
// Carimbar hoje diria que a Aline pegou a TR em 16/08, o que é falso — ela já a tinha. E
// `dt_inicio_analise` é o relógio do prazo: reiniciá-lo daria prazo novo a trabalho antigo.
// Herdar da PC que já é dela é a única resposta verdadeira que o banco tem.
//
// ⚠️ NÃO TOCA em `baixada`, `data_baixa`, `parecer_tipo`, `parecer_ci`, `valor`, `enviado_ci`
// nem `ci_*`. Atribuir é sobre quem analisa, não sobre o que já foi analisado.

const fs = require('fs');
const { Pool } = require('pg');
const assumir = require('./lib/assumir');

const GRAVAR = process.argv.includes('--gravar');
const D = __dirname + '/';
const BK = '_backup_soltas_20260816';
const TRS_ESPERADAS = 5;
const PCS_ESPERADAS = 78;

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

    // ── quem é o dono de cada TR, e desde quando ──────────────────────────────
    // ⚠️ Só entra TR com UM dono. Duas pessoas na mesma TR e não há "o dono" para herdar.
    const { rows: alvo } = await cli.query(`
      WITH dono AS (
        SELECT tr, MIN(analista_id) id, MIN(analista_nome) nome,
               MIN(dt_assumida) dt_ass, MIN(dt_inicio_analise) dt_ini,
               COUNT(DISTINCT analista_id) quantos
          FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND analista_id IS NOT NULL
         GROUP BY tr)
      -- ⚠️ O NOME PODE VIR DO CADASTRO, e numa TR ele PRECISA.
      --
      -- A 2022TR001328 tem a PFINAL com analista_id = 41 e analista_nome NULL — o inverso do
      -- caso da 2022TR001687, onde o nome contradiz o id. Sao 18 PCs em 5 TRs assim no
      -- acervo. Copiar o NULL propagaria o defeito; o COALESCE busca em usuarios, e o
      -- nomeCurto do lib/assumir.js e quem decide como o nome e escrito (armadilha 1).
      SELECT p.codigo_pc, p.tr, d.id, COALESCE(d.nome, u.nome) AS nome, d.dt_ass, d.dt_ini
        FROM prestacoes_contas p JOIN dono d ON d.tr = p.tr
        LEFT JOIN usuarios u ON u.id = d.id
       WHERE p.setorial_id='FCEE' AND d.quantos = 1 AND ${assumir.PC_LIVRE_SQL}
       ORDER BY p.tr, p.codigo_pc
       FOR UPDATE OF p`);
    const codigos = alvo.map(r => r.codigo_pc);
    const trs = [...new Set(alvo.map(r => r.tr))];

    nl(`\n── O ALVO ────────────────────────────────────────────────`);
    trs.forEach(t => { const l = alvo.filter(r => r.tr === t);
      nl(`   ${t}  ${String(l.length).padStart(2)} PCs -> ${l[0].nome} (id ${l[0].id})` +
         `   assumida ${l[0].dt_ass ? String(l[0].dt_ass).slice(0,10) : '(sem data)'}`); });
    nl(`   total: ${codigos.length} PCs em ${trs.length} TRs`);

    if (codigos.length !== PCS_ESPERADAS || trs.length !== TRS_ESPERADAS)
      throw new Error(`esperava ${PCS_ESPERADAS} PCs em ${TRS_ESPERADAS} TRs, achei ${codigos.length} em ${trs.length}`);

    // ── a escrita, uma por TR (o dono e as datas mudam por TR) ────────────────
    let tocadas = 0;
    for (const tr of trs) {
      const l = alvo.filter(r => r.tr === tr);
      const { rowCount } = await cli.query(
        `UPDATE prestacoes_contas
            SET analista_id = $2, analista_nome = $3, status = 'analise',
                dt_assumida = COALESCE($4, dt_assumida),
                dt_inicio_analise = COALESCE(dt_inicio_analise, $5),
                atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`,
        [l.map(r => r.codigo_pc), l[0].id, assumir.nomeCurto(l[0].nome), l[0].dt_ass, l[0].dt_ini]);
      tocadas += rowCount;
    }
    if (tocadas !== codigos.length) throw new Error(`esperava ${codigos.length}, peguei ${tocadas}`);
    nl(`\n>> ${tocadas} PCs atribuidas ao dono da TR`);

    // ── CONFERÊNCIA ───────────────────────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.baixada,b.data_baixa,b.parecer_tipo,b.parecer_ci,b.valor,b.parcial_num,
             b.enviado_ci,b.ci_situacao,b.dt_envio_ci)
         IS DISTINCT FROM
            (p.baixada,p.data_baixa,p.parecer_tipo,p.parecer_ci,p.valor,p.parcial_num,
             p.enviado_ci,p.ci_situacao,p.dt_envio_ci)`);
    const c2 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.analista_id, b.status) IS DISTINCT FROM (p.analista_id, p.status)
        AND NOT (p.codigo_pc = ANY($1))`, [codigos]);
    // ⚠️ nenhuma TR pode ter ganhado um SEGUNDO dono
    const c3 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM prestacoes_contas WHERE analista_id IS NOT NULL
       GROUP BY tr HAVING COUNT(DISTINCT analista_id) > 1) t`);
    const { rows: [c3b] } = await cli.query(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM ${BK} WHERE analista_id IS NOT NULL
       GROUP BY tr HAVING COUNT(DISTINCT analista_id) > 1) t`);
    // e o caso inverso zerou
    const c4 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY tr
       HAVING MAX(analista_nome) IS NOT NULL
          AND COUNT(*) FILTER (WHERE ${assumir.PC_LIVRE_SQL}) > 0) t`);
    const c5 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);

    const checks = [
      ['baixa, parecer, valor e C.I. intactos', c1.n === 0, c1.n],
      ['dono/status mexidos fora da lista',     c2.n === 0, c2.n],
      ['nenhuma TR ganhou 2o dono',             c3.n <= c3b.n, `${c3b.n} -> ${c3.n}`],
      ['TR com dono e PC solta: zerou',         c4.n === 0, c4.n],
      ['nenhuma PC criada nem apagada',         c5.n === bk.n, `${bk.n} -> ${c5.n}`],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(38)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_soltas_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup: BK, codigos }, null, 1));
      await cli.query('COMMIT'); nl('\n>> COMMIT. Gravado.');
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
