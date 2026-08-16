// CAMINHO: sigpc-api/encaminhar_ci_simone.js
//
// ENCAMINHAR AO C.I. as parciais que a Simone relata já terem ido pelo SIGEF/SGPe e que a
// planilha do Controle Interno não trouxe. PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// Autorizado pelo Richard em 16/08/2026.
//
// ⚠️ A LOCALIZAÇÃO É PELO PROCESSO, NÃO PELO NÚMERO DA PARCIAL. Os números foram
// renumerados HOJE (2.432 PCs), e o relato da Simone é anterior. O processo SGPe é estável;
// o número não era. A lista de `codigo_pc` abaixo saiu dessa busca e está explícita (regra 12).
//
// ⚠️ SÓ AS BAIXADAS. `enviado_ci` sustenta a baixa, e o C.I. vem DEPOIS do parecer — é a
// mesma regra que tirou as 39 da frente 3 e que virou `AND baixada = true` na rota hoje.
//
// ⚠️ `dt_envio_ci = NOW()`, E ISSO É DELIBERADO. A data real do encaminhamento no SIGEF não
// existe em lugar nenhum do sistema — ela está no SIGEF. Herdar `data_baixa` foi o que
// deixou 1.684 PCs mostrando "no C.I. desde 30/06/2026", que é a data da CARGA. `NOW()` diz
// a verdade que temos: **a data em que o sistema registrou**. A tela passa a dizer
// "registrado em", não "enviado em".

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const D = __dirname + '/';
const BK = '_backup_ci_simone_20260816';

// Os 33 `codigo_pc`, achados pelo processo que a Simone informou.
// 2020TR000646 (Itaiópolis) · 2020TR000765 (Sangão) · 2021TR000702 (Tubarão)
// 2020TR000672 (São Francisco do Sul) · 2021TR002253 (Sombrio, a PC final)
const CODIGOS = [
  '2020PC000909','2020PC000569','2020PC000516','2020PC001413','2020PC002952',
  '2020PC002953','2020PC001522',
  '2020PC000822','2020PC001547','2020PC000823','2020PC000935','2020PC001439',
  '2020PC001913','2020PC002266','2020PC003650','2020PC003154','2020PC002582',
  '2021PC000417','2021PC001240','2021PC001461',
  '2021PC000745',
  '2021PC001109','2021PC000319','2021PC000684','2021PC001050','2021PC001869',
  '2021PC001870','2021PC001358','2020PC000871','2020PC002140','2020PC002936',
  '2020PC001376',
  '2021TR002253-PFINAL',
];

// ⚠️ NÃO ACHADO, e fica registrado: `SCC 19203/2021` na `2021TR000702`. O processo não existe
// em lugar nenhum da base — é o mesmo que o qa-banco já tinha sinalizado naquela TR (o banco
// tem `SCC 00019108/2022`). A parcial correspondente NÃO entra: resolve pelo lápis, depois de
// a Simone conferir no SGPe qual é o número certo.
const NAO_ACHADOS = ['2021TR000702 · SCC 19203/2021'];

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

    // ── o estado ANTES, por PC ────────────────────────────────────────────────
    const { rows: antes } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, baixada, parecer_tipo IS NOT NULL tp, enviado_ci
         FROM prestacoes_contas WHERE codigo_pc = ANY($1) ORDER BY tr, codigo_pc`, [CODIGOS]);
    nl(`\n── OS ${CODIGOS.length} INFORMADOS ─────────────────────────────`);
    nl(`   achados no banco ...... ${antes.length}`);
    nl(`   baixadas .............. ${antes.filter(p => p.baixada).length}`);
    nl(`   com parecer ........... ${antes.filter(p => p.tp).length}`);
    nl(`   JA no C.I. ............ ${antes.filter(p => p.enviado_ci).length}`);
    const marcar = antes.filter(p => p.baixada && !p.enviado_ci).map(p => p.codigo_pc);
    const recusadas = antes.filter(p => !p.baixada);
    nl(`   >> A MARCAR ........... ${marcar.length}`);
    if (recusadas.length) {
      nl(`   ⚠️ NAO baixadas, fora: ${recusadas.map(p => p.codigo_pc).join(', ')}`);
    }
    if (antes.length !== CODIGOS.length) {
      const faltam = CODIGOS.filter(c => !antes.some(a => a.codigo_pc === c));
      throw new Error(`codigo_pc nao encontrado no banco: ${faltam.join(', ')}`);
    }
    NAO_ACHADOS.forEach(x => nl(`   ⚠️ processo informado e NAO achado na base: ${x}`));

    if (!marcar.length) { await cli.query('ROLLBACK'); nl('\nNada a marcar.'); return; }

    const { rowCount } = await cli.query(
      `UPDATE prestacoes_contas
          SET enviado_ci = true,
              dt_envio_ci = NOW(),
              ci_situacao = COALESCE(ci_situacao, 'encerrado'),
              ci_rodada = GREATEST(COALESCE(ci_rodada, 0), 1),
              atualizado_em = NOW()
        WHERE codigo_pc = ANY($1) AND baixada = true AND enviado_ci = false`, [marcar]);
    if (rowCount !== marcar.length)
      throw new Error(`esperava ${marcar.length}, o UPDATE pegou ${rowCount}`);
    nl(`\n>> ${rowCount} PCs marcadas como encaminhadas ao C.I.`);

    // ── o rastro, UMA linha por parcela ───────────────────────────────────────
    // O encaminhamento é por PARCELA, e o histórico é chaveado por (tr, parcial_num).
    const parcelas = [...new Set(antes.filter(p => marcar.includes(p.codigo_pc))
                                      .map(p => `${p.tr}|${p.parcial_num}`))];
    for (const k of parcelas) {
      const [tr, num] = k.split('|');
      const n = marcar.filter(c => antes.find(a => a.codigo_pc === c && a.tr === tr && a.parcial_num === num)).length;
      await cli.query(
        `INSERT INTO parcela_historico
           (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
            observacao, criado_em)
         VALUES ($1, $2, 'FCEE', 'ci', NULL, 'enviado_ci = true', NULL, $3, NOW())`,
        [tr, num,
         `REGISTRO RETROATIVO 16/08/2026 — ${n} PC${n > 1 ? 's' : ''}. A analista informou que ` +
         `o encaminhamento foi feito no SIGEF/SGPe e a planilha do C.I. nao trouxe. ` +
         `A DATA E DE REGISTRO NO SISTEMA, nao a do envio real, que so o SIGEF tem.`]);
    }
    nl(`>> ${parcelas.length} linhas de historico, uma por parcela`);

    // ── CONFERÊNCIA ───────────────────────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.baixada,b.data_baixa,b.parecer_tipo,b.valor,b.parcial_num,b.analista_id)
         IS DISTINCT FROM (p.baixada,p.data_baixa,p.parecer_tipo,p.valor,p.parcial_num,p.analista_id)`);
    const c2 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE b.enviado_ci IS DISTINCT FROM p.enviado_ci AND NOT (p.codigo_pc = ANY($1))`, [marcar]);
    const c3 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE enviado_ci = true AND baixada = false`);
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);

    const checks = [
      ['baixa/parecer/valor/dono intactos', c1.n === 0, c1.n],
      ['enviado_ci mexido fora da lista',   c2.n === 0, c2.n],
      ['nenhuma PC no C.I. sem baixa',      c3.n === 0, c3.n],
      ['nenhuma PC criada nem apagada',     c4.n === bk.n, `${bk.n} -> ${c4.n}`],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(36)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_ci_simone_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup: BK, marcadas: marcar }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
