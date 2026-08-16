// CAMINHO: sigpc-api/executar_15_trs.js
//
// AS 15 TRs QUE FICARAM FORA DO LOTE — renumeração pelo mesmo mapa da CGE.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// Autorizado pelo Richard em 16/08/2026: *"As 15 TRs entram. As colisões que sobraram não
// impedem: aplica o número do SIGEF, e onde duas parciais virarem uma, mantém o parecer e a
// baixa de cada PC como estão — a renumeração não desfaz trabalho."*
//
// ⚠️ POR QUE ELAS TINHAM FICADO DE FORA. Não era o split (um processo em várias parciais,
// que foi medido e aceito). Era a direção CONTRÁRIA: nelas o número do SIGEF junta processos
// hoje separados dentro de uma parcela só. Medido: **38 parcelas passam a ter 2+ processos**.
//
// ⚠️ E O QUE ISSO DEIXA PARA TRÁS, que o Richard precisa ver: **3 parcelas ficam MISTAS** —
// PC baixada e PC aberta no mesmo número. Isso importa porque `POST /parcela/parecer` faz
// `UPDATE ... WHERE tr AND parcial_num` **sem `baixada = false`**, e o 409 só dispara quando
// TODAS já estão baixadas. Um parecer futuro numa dessas três reescreveria `data_baixa`,
// `origem_baixa` e `parecer_tipo` das PCs que já estavam fechadas.
//
// A renumeração em si não desfaz nada — é o que ele decidiu, e é verdade. O risco é do
// PRÓXIMO parecer, e por isso as três saem nomeadas no fim.
//
// USO:
//   node executar_15_trs.js            dry-run: escreve, confere e faz ROLLBACK
//   node executar_15_trs.js --gravar   idem, com COMMIT — liga e desliga a manutenção

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const FORCAR = process.argv.includes('--forcar');
const D = __dirname + '/';
const BK_PC = '_backup_15trs_pc_20260816';
const BK_HIST = '_backup_15trs_hist_20260816';

const AS_15 = [
  '2022TR000941', '2020TR000823', '2020TR000830', '2022TR001248', '2020TR000683',
  '2020TR000699', '2020TR000648', '2020TR000665', '2020TR000704', '2020TR000761',
  '2020TR000766', '2020TR000793', '2020TR000816', '2021TR002375', '2022TR000927',
];

const PROTEGIDAS = ['baixada', 'data_baixa', 'parecer_tipo', 'parecer_ci', 'valor',
                    'enviado_ci', 'dt_envio_ci', 'ci_situacao', 'ci_rodada',
                    'ci_encerrado_em', 'ci_encerrado_por', 'analista_id', 'processo_pc'];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');
const p4 = (s, n = 4) => String(s).padStart(n);

(async () => {
  const cli = await pool.connect();
  let manutencaoLigada = false;
  const sairLimpo = async (sinal) => {
    console.error(`\n🔴 ${sinal} recebido.`);
    if (manutencaoLigada) {
      try {
        await pool.query(`UPDATE config_sistema SET modo_manutencao = false,
          mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        console.error('   >> manutencao DESLIGADA.');
      } catch (e) { console.error('   🔴 DESLIGUE PELA TELA: Configurações -> Modo manutenção.'); }
    }
    process.exit(130);
  };
  process.on('SIGINT', () => sairLimpo('SIGINT'));
  process.on('SIGTERM', () => sairLimpo('SIGTERM'));

  try {
    const onlineSql = `SELECT COUNT(*)::int n FROM usuarios
       WHERE ultimo_acesso >= NOW() - INTERVAL '30 minutes'
         AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso) AND perfil <> 'superadmin'`;
    nl(`── online agora: ${(await cli.query(onlineSql)).rows[0].n}`);

    if (GRAVAR) {
      await cli.query('BEGIN');
      await cli.query(`UPDATE config_sistema SET modo_manutencao = true,
        mensagem_manutencao = 'Renumeração das 15 TRs — 16/08/2026. Volta em minutos.',
        atualizado_em = NOW() WHERE id = 1`);
      const { rowCount: d } = await cli.query(
        `UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'`);
      await cli.query('COMMIT');
      manutencaoLigada = true;
      nl(`\n── MANUTENÇÃO LIGADA. ${d} sessões encerradas.`);

      // ⚠️ ESPERAR UM CICLO DO POLLING ANTES DE MEDIR. A manutenção tem TRÊS mecanismos
      // (CLAUDE.md), e o terceiro é o polling de `config_sistema` **de 20 em 20 segundos**,
      // que é o que derruba a TELA de quem já está dentro. O `sessao_fim` sozinho não fecha
      // a aba: a pessoa pode fazer mais uma requisição no segundo seguinte.
      //
      // Foi o que aconteceu na primeira tentativa: a Andressa teve `ultimo_acesso` 19:30:21
      // contra `sessao_fim` 19:30:20 — **1 segundo depois** —, e a trava recusou. A trava
      // estava certa em recusar; errado era medir antes de o mecanismo ter tido tempo.
      const ESPERA = 30000, TENTATIVAS = 4;
      let ainda = 0;
      for (let t = 1; t <= TENTATIVAS; t++) {
        await new Promise(r => setTimeout(r, ESPERA));
        ainda = (await cli.query(onlineSql)).rows[0].n;
        nl(`   depois de ${t * ESPERA / 1000}s: ${ainda} online`);
        if (ainda === 0) break;
        // quem insistir leva outro carimbo — a tela dele já caiu, é requisição em voo
        await cli.query(`UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'`);
      }
      if (ainda > 0 && !FORCAR)
        throw new Error(`${ainda} continuam online depois de ${TENTATIVAS * ESPERA / 1000}s. Nao gravo.`);
    }

    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);
    await cli.query(`CREATE TABLE ${BK_PC} AS SELECT * FROM prestacoes_contas`);
    await cli.query(`CREATE TABLE ${BK_HIST} AS SELECT * FROM parcela_historico`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK_PC}`);
    const { rows: [bkh] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK_HIST}`);
    nl(`\n── BACKUP ${BK_PC}: ${bk.n} · ${BK_HIST}: ${bkh.n}`);

    // ── o mapa ────────────────────────────────────────────────────────────────
    const linhas = fs.readFileSync(D + 'MAPA_PARCIAL_SIGEF.csv', 'utf8')
      .replace(/\r/g, '').split('\n').filter(Boolean);
    const cab = linhas[0].split(',');
    const mapa = linhas.slice(1).map(l => {
      const v = l.split(','); return Object.fromEntries(cab.map((k, i) => [k, v[i]]));
    });
    await cli.query(`CREATE TEMP TABLE _mapa (codigo_pc text PRIMARY KEY, parcial_sigef text)
                     ON COMMIT DROP`);
    for (let i = 0; i < mapa.length; i += 500) {
      const lote = mapa.slice(i, i + 500);
      await cli.query(
        `INSERT INTO _mapa VALUES ${lote.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',')}`,
        lote.flatMap(m => [m.codigo_pc, m.parcial_sigef]));
    }

    const { rows: alvo } = await cli.query(`
      SELECT p.codigo_pc, p.tr, p.parcial_num AS antes, m.parcial_sigef AS depois, p.baixada
        FROM _mapa m JOIN prestacoes_contas p ON p.codigo_pc = m.codigo_pc
       WHERE p.tr = ANY($1) AND p.parcial_num IS DISTINCT FROM m.parcial_sigef
       ORDER BY p.tr, p.codigo_pc`, [AS_15]);
    const codigos = alvo.map(r => r.codigo_pc);
    nl(`\n── O QUE MUDA ────────────────────────────────────────────`);
    nl(`   PCs ................... ${codigos.length}`);
    nl(`   parciais .............. ${new Set(alvo.map(r => `${r.tr}|${r.antes}|${r.depois}`)).size}`);
    nl(`   TRs ................... ${new Set(alvo.map(r => r.tr)).size}`);
    nl(`   das quais baixadas .... ${alvo.filter(r => r.baixada).length}`);
    if (!codigos.length) { await cli.query('ROLLBACK'); nl('\nNada a fazer.'); return; }

    // ── histórico: destino da PARCELA INTEIRA, duplicando quando ela se parte ──
    const { rows: histBruto } = await cli.query(`
      WITH proj AS (
        SELECT p.tr, p.setorial_id, p.parcial_num AS num_antigo,
               CASE WHEN p.codigo_pc = ANY($1) THEN m.parcial_sigef ELSE p.parcial_num END AS destino
          FROM prestacoes_contas p LEFT JOIN _mapa m ON m.codigo_pc = p.codigo_pc
         WHERE p.setorial_id = 'FCEE' AND p.tipo <> 'final'),
      dest AS (SELECT tr, setorial_id, num_antigo,
                      ARRAY_AGG(DISTINCT destino ORDER BY destino) AS destinos
                 FROM proj GROUP BY tr, setorial_id, num_antigo)
      SELECT h.id, h.tr, h.parcial_num AS antes, d.destinos, h.evento, h.setorial_id,
             h.valor_anterior, h.valor_novo, h.analista_id, h.observacao, h.criado_em,
             h.executado_por
        FROM parcela_historico h
        JOIN dest d ON d.tr = h.tr AND d.setorial_id = h.setorial_id AND d.num_antigo = h.parcial_num
       WHERE h.tr = ANY($2)
       ORDER BY h.tr, h.id`, [codigos, AS_15]);
    const hist = histBruto.filter(h => !(h.destinos.length === 1 && h.destinos[0] === h.antes));
    const partidas = hist.filter(h => h.destinos.length > 1);
    const copiasPrev = partidas.reduce((n, h) => n + h.destinos.length - 1, 0);
    nl(`   historico ............. ${hist.length} mudam (${partidas.length} partidas -> +${copiasPrev} copias)`);

    const { rowCount: renum } = await cli.query(
      `UPDATE prestacoes_contas p SET parcial_num = m.parcial_sigef, atualizado_em = NOW()
         FROM _mapa m WHERE p.codigo_pc = m.codigo_pc AND p.codigo_pc = ANY($1)`, [codigos]);
    if (renum !== codigos.length) throw new Error(`esperava ${codigos.length}, peguei ${renum}`);

    const histIds = hist.map(h => h.id);
    let movidas = 0;
    if (histIds.length) {
      const r = await cli.query(
        `UPDATE parcela_historico h SET parcial_num = m.novo
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS novo) m
          WHERE h.id = m.id AND h.id = ANY($1::int[])`,
        [histIds, hist.map(h => h.destinos[0])]);
      movidas = r.rowCount;
    }
    if (movidas !== histIds.length) throw new Error(`historico: esperava ${histIds.length}, peguei ${movidas}`);

    const idsCopias = [];
    for (const h of partidas) {
      for (const destino of h.destinos.slice(1)) {
        const nota = `[renumeracao SIGEF 16/08/2026 — as 15 TRs] a parcela ${h.antes} desta TR ` +
          `virou ${h.destinos.join(' e ')}; copia do evento original (id ${h.id}), que valia ` +
          `para todas as PCs da parcela.`;
        const { rows: [ins] } = await cli.query(
          `INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
             valor_novo, analista_id, observacao, criado_em, executado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [h.tr, destino, h.setorial_id, h.evento, h.valor_anterior, h.valor_novo,
           h.analista_id, (h.observacao ? h.observacao + ' · ' : '') + nota,
           h.criado_em, h.executado_por]);
        idsCopias.push(ins.id);
      }
    }
    if (idsCopias.length !== copiasPrev) throw new Error('copias divergem do previsto');
    nl(`   >> ${renum} PCs · ${movidas} movidas · ${idsCopias.length} copias`);

    // ── CONFERÊNCIA ───────────────────────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const div = [];
    for (const col of PROTEGIDAS) {
      const d = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
        JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
        WHERE b.${col} IS DISTINCT FROM p.${col}`);
      if (d.n > 0) div.push(`${col}=${d.n}`);
    }
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE p.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (p.codigo_pc = ANY($1))`, [codigos]);
    const c2 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);
    const c3 = await un(`SELECT COUNT(*)::int n FROM parcela_historico`);
    const c4 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
      JOIN ${BK_HIST} b ON b.id = h.id
      WHERE (h.tr,h.setorial_id,h.evento,h.valor_anterior,h.valor_novo,h.analista_id,h.criado_em)
         IS DISTINCT FROM (b.tr,b.setorial_id,b.evento,b.valor_anterior,b.valor_novo,b.analista_id,b.criado_em)`);
    const c5 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
      JOIN ${BK_HIST} b ON b.id = h.id
      WHERE h.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (h.id = ANY($1::int[]))`,
      [histIds.length ? histIds : [-1]]);
    const c6 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
      WHERE h.id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM prestacoes_contas p
        WHERE p.setorial_id=h.setorial_id AND p.tr=h.tr AND p.parcial_num=h.parcial_num
          AND p.tipo <> 'final')`, [idsCopias.length ? idsCopias : [-1]]);

    const checks = [
      ['as 13 protegidas intactas',        div.length === 0, div.join(' ') || '0'],
      ['PC fora da lista renumerada',      c1.n === 0, c1.n],
      ['nenhuma PC criada nem apagada',    c2.n === bk.n, `${bk.n} -> ${c2.n}`],
      ['historico = antes + copias',       c3.n === bkh.n + idsCopias.length, `${bkh.n}+${idsCopias.length}=${c3.n}`],
      ['historico: campo alheio mexido',   c4.n === 0, c4.n],
      ['historico fora da lista alterado', c5.n === 0, c5.n],
      ['copia aponta p/ parcela existente', c6.n === 0, c6.n],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(38)} ${v}`); }

    // ── ⚠️ AS PARCELAS MISTAS QUE NASCEM AQUI — medidas, nomeadas, não bloqueiam
    //
    // Decisão do Richard: a renumeração não desfaz trabalho, e não desfaz mesmo. O risco é do
    // PRÓXIMO parecer: `POST /parcela/parecer` faz `UPDATE ... WHERE tr AND parcial_num` sem
    // `baixada = false`, e o 409 só dispara quando TODAS já estão baixadas.
    const { rows: mistas } = await cli.query(`
      SELECT tr, parcial_num, COUNT(*)::int pcs, COUNT(*) FILTER (WHERE baixada)::int baix,
             string_agg(DISTINCT processo_pc, ' | ') procs
        FROM prestacoes_contas WHERE tr = ANY($1) AND tipo <> 'final'
       GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE baixada) > 0
                       AND COUNT(*) FILTER (WHERE NOT baixada) > 0
       ORDER BY 1,2`, [AS_15]);
    nl(`\n── ⚠️ PARCELAS MISTAS CRIADAS: ${mistas.length} (nao bloqueiam — ver cabecalho)`);
    mistas.forEach(m => nl(`   ${m.tr} p${m.parcial_num}  ${m.pcs} PCs (${m.baix} baixadas)  ${m.procs}`));
    const { rows: [fus] } = await cli.query(`SELECT COUNT(*)::int n FROM (
      SELECT tr, parcial_num FROM prestacoes_contas WHERE tr = ANY($1) AND tipo <> 'final'
       GROUP BY 1,2 HAVING COUNT(DISTINCT processo_pc) > 1) t`, [AS_15]);
    nl(`   parcelas com 2+ processos: ${fus.n}`);

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_15trs_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup_pc: BK_PC, backup_hist: BK_HIST,
          renumeradas: codigos, copias: idsCopias,
          mistas: mistas.map(m => `${m.tr}|${m.parcial_num}`) }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    if (manutencaoLigada) {
      try {
        await cli.query(`UPDATE config_sistema SET modo_manutencao = false,
          mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        nl('\n── MANUTENÇÃO DESLIGADA. Equipe liberada.');
      } catch (e) { console.error('🔴 DESLIGUE PELA TELA: Configurações -> Modo manutenção.'); }
    }
    cli.release(); await pool.end();
  }
})();
