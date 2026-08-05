// Teste end-to-end das rotas de parcela contra o banco real.
// Faz SNAPSHOT das PCs tocadas, exercita as rotas e RESTAURA tudo no fim.
// Nao deixa residuo: tambem apaga as linhas de parcela_historico criadas.
const API = process.env.API_TESTE || 'http://localhost:3999';
const TR = '2018TR000093';
const PROC = 'FCEE3924/2018';
const PARCIAL = '9001';            // numero de teste, fora da faixa real
const SETORIAL = 'FCEE';

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

const COLS = ['baixada', 'status', 'data_baixa', 'origem_baixa', 'parecer_tipo', 'analista_id',
  'registrado_por', 'situacao_atual', 'estornada', 'data_estorno', 'motivo_estorno', 'estornado_por',
  'parcial_num', 'prazo_diligencia', 'qtd_diligencias', 'dt_situacao', 'obs_situacao',
  'enviado_ci', 'dt_envio_ci', 'parecer_ci'];

let passou = 0, falhou = 0;
function ok(nome, cond, extra) {
  if (cond) { passou++; console.log(`   OK   ${nome}`); }
  else { falhou++; console.log(`   FALHA ${nome}${extra ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

async function post(rota, body) {
  const r = await fetch(`${API}${rota}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json() };
}

(async () => {
  const cli = await pool.connect();
  let snap = [];
  try {
    // ── snapshot ──────────────────────────────────────────────────
    const { rows } = await cli.query(
      `SELECT id, ${COLS.join(', ')} FROM prestacoes_contas
        WHERE setorial_id=$1 AND tr=$2 AND processo_pc=$3`, [SETORIAL, TR, PROC]);
    snap = rows;
    if (!snap.length) throw new Error('nada para testar — ajuste TR/PROC');
    console.log(`snapshot: ${snap.length} PCs de ${TR} / ${PROC}\n`);

    // prepara: da um parcial_num de teste a essas PCs
    await cli.query(
      `UPDATE prestacoes_contas SET parcial_num=$1
        WHERE setorial_id=$2 AND tr=$3 AND processo_pc=$4`, [PARCIAL, SETORIAL, TR, PROC]);

    // ── T3 situacao ───────────────────────────────────────────────
    console.log('T3 — POST /parcela/situacao');
    let r = await post('/parcela/situacao', { tr: TR, parcial_num: PARCIAL, situacao: 'Diligência', setorial_id: SETORIAL });
    ok('Diligência sem prazo -> 400', r.status === 400, r.json);

    r = await post('/parcela/situacao', { tr: TR, parcial_num: PARCIAL, situacao: 'Bagunça', setorial_id: SETORIAL });
    ok('situacao inválida -> 400', r.status === 400);

    r = await post('/parcela/situacao', {
      tr: TR, parcial_num: PARCIAL, situacao: 'Diligência', prazo_diligencia: '2026-09-30',
      qtd_diligencias: 2, observacao: 'teste automatizado', setorial_id: SETORIAL
    });
    ok('Diligência com prazo -> 200', r.status === 200 && r.json.count === snap.length, r.json);

    let db = (await cli.query(`SELECT situacao_atual, status, prazo_diligencia, baixada FROM prestacoes_contas WHERE setorial_id=$1 AND tr=$2 AND parcial_num=$3`, [SETORIAL, TR, PARCIAL])).rows;
    ok('gravou situacao_atual + status', db.every(x => x.situacao_atual === 'Diligência' && x.status === 'diligencia'), db[0]);
    ok('situacao NAO baixa', db.every(x => x.baixada === false));

    // ── T4 CI antes do parecer ────────────────────────────────────
    console.log('\nT4 — POST /parcela/ci (sem parecer)');
    r = await post('/parcela/ci', { tr: TR, parcial_num: PARCIAL, setorial_id: SETORIAL });
    ok('CI sem parecer -> 409 "CI exige parecer prévio"', r.status === 409 && /parecer prévio/.test(r.json.error.message), r.json);

    // ── T2 parecer ────────────────────────────────────────────────
    console.log('\nT2 — POST /parcela/parecer');
    r = await post('/parcela/parecer', { tr: TR, parcial_num: PARCIAL, parecer_tipo: 'Encaminhado ao Controle Interno', setorial_id: SETORIAL });
    ok('parecer "Encaminhado ao CI" -> 400 (D2)', r.status === 400, r.json);

    r = await post('/parcela/parecer', {
      tr: TR, parcial_num: PARCIAL, parecer_tipo: 'Parecer Regular com Ressalvas',
      observacao: 'teste', setorial_id: SETORIAL
    });
    ok('parecer válido -> 200', r.status === 200 && r.json.count === snap.length, r.json);

    db = (await cli.query(`SELECT baixada, status, parecer_tipo, data_baixa, situacao_atual FROM prestacoes_contas WHERE setorial_id=$1 AND tr=$2 AND parcial_num=$3`, [SETORIAL, TR, PARCIAL])).rows;
    ok('baixou TODAS as PCs da parcial', db.every(x => x.baixada === true && x.status === 'baixada'), db[0]);
    ok('parecer_tipo gravado', db.every(x => x.parecer_tipo === 'Parecer Regular com Ressalvas'));
    ok('D1: data_baixa = agora', db.every(x => x.data_baixa && (Date.now() - new Date(x.data_baixa)) < 120000));
    ok('situacao_atual limpa na baixa', db.every(x => x.situacao_atual === null));

    r = await post('/parcela/parecer', { tr: TR, parcial_num: PARCIAL, parecer_tipo: 'Parecer Regular', setorial_id: SETORIAL });
    ok('parecer em parcial já baixada -> 409', r.status === 409, r.json);

    r = await post('/parcela/situacao', { tr: TR, parcial_num: PARCIAL, situacao: 'Em análise', setorial_id: SETORIAL });
    ok('situacao em parcial baixada -> 409', r.status === 409);

    // ── T4 CI depois do parecer ───────────────────────────────────
    console.log('\nT4 — POST /parcela/ci (com parecer)');
    r = await post('/parcela/ci', { tr: TR, parcial_num: PARCIAL, observacao: 'teste CI', setorial_id: SETORIAL });
    ok('CI com parecer -> 200', r.status === 200 && r.json.count === snap.length, r.json);

    db = (await cli.query(`SELECT enviado_ci, dt_envio_ci, parecer_tipo FROM prestacoes_contas WHERE setorial_id=$1 AND tr=$2 AND parcial_num=$3`, [SETORIAL, TR, PARCIAL])).rows;
    ok('enviado_ci = true', db.every(x => x.enviado_ci === true));
    ok('D2: CI NAO apagou parecer_tipo', db.every(x => x.parecer_tipo === 'Parecer Regular com Ressalvas'));

    r = await post('/parcela/ci', { tr: TR, parcial_num: PARCIAL, setorial_id: SETORIAL });
    ok('CI repetido -> 409', r.status === 409);

    // ── T5 estorno ────────────────────────────────────────────────
    console.log('\nT5 — POST /parcela/estornar');
    r = await post('/parcela/estornar', { tr: TR, parcial_num: PARCIAL, motivo: 'motivo suficientemente longo', perfil: 'analista', setorial_id: SETORIAL });
    ok('analista -> 403', r.status === 403);

    r = await post('/parcela/estornar', { tr: TR, parcial_num: PARCIAL, motivo: 'curto', perfil: 'superadmin', setorial_id: SETORIAL });
    ok('motivo curto -> 400', r.status === 400);

    r = await post('/parcela/estornar', {
      tr: TR, parcial_num: PARCIAL, motivo: 'estorno de teste automatizado', perfil: 'superadmin',
      usuario_nome: 'teste', setorial_id: SETORIAL
    });
    ok('superadmin -> 200', r.status === 200 && r.json.count === snap.length, r.json);

    db = (await cli.query(`SELECT baixada, status, estornada, data_baixa FROM prestacoes_contas WHERE setorial_id=$1 AND tr=$2 AND parcial_num=$3`, [SETORIAL, TR, PARCIAL])).rows;
    ok('estorno: baixada=false, status=livre', db.every(x => x.baixada === false && x.status === 'livre'), db[0]);
    ok('estorno preserva data_baixa (produtividade cumulativa)', db.every(x => x.data_baixa !== null));

    // ── historico ─────────────────────────────────────────────────
    console.log('\nHistórico');
    const h = await fetch(`${API}/parcela/historico?tr=${TR}&parcial_num=${PARCIAL}`).then(x => x.json());
    const eventos = (h.data || []).map(x => x.evento);
    ok('D3: 4 eventos registrados (situacao, parecer, ci, estorno)',
      ['situacao', 'parecer', 'ci', 'estorno'].every(e => eventos.includes(e)), eventos);

    // ── 404 ───────────────────────────────────────────────────────
    r = await post('/parcela/parecer', { tr: 'INEXISTENTE', parcial_num: '1', parecer_tipo: 'Parecer Regular' });
    ok('parcial inexistente -> 404', r.status === 404);

  } catch (e) {
    console.error('\nERRO NO TESTE: ' + e.message);
    falhou++;
  } finally {
    // ── restauracao ───────────────────────────────────────────────
    if (snap.length) {
      for (const s of snap) {
        const sets = COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await cli.query(`UPDATE prestacoes_contas SET ${sets} WHERE id = $1`, [s.id, ...COLS.map(c => s[c])]);
      }
      await cli.query(`DELETE FROM parcela_historico WHERE tr=$1 AND parcial_num=$2`, [TR, PARCIAL]);
      const conf = (await cli.query(
        `SELECT COUNT(*) FILTER (WHERE parcial_num=$1)::int sobrou_parcial,
                COUNT(*) FILTER (WHERE baixada)::int baixadas
           FROM prestacoes_contas WHERE setorial_id=$2 AND tr=$3 AND processo_pc=$4`,
        [PARCIAL, SETORIAL, TR, PROC])).rows[0];
      const hist = (await cli.query(`SELECT COUNT(*)::int n FROM parcela_historico WHERE tr=$1 AND parcial_num=$2`, [TR, PARCIAL])).rows[0];
      console.log(`\nrestauracao: parcial_num de teste restante=${conf.sobrou_parcial}, baixadas=${conf.baixadas}, historico restante=${hist.n}`);
    }
    cli.release(); await pool.end();
    console.log(`\n${'='.repeat(50)}\nPASSOU: ${passou}   FALHOU: ${falhou}\n${'='.repeat(50)}`);
    process.exitCode = falhou ? 1 : 0;
  }
})();
