// CAMINHO: sigpc-api/teste_invalidar_20260902.js
//
// A PROVA DA FASE 3 — as rotas POST /pc/:codigo_pc/invalidar e /desinvalidar.
// SOMENTE LEITURA NO FIM: tudo o que escreve roda dentro de BEGIN e termina em ROLLBACK.
//
// ⚠️ POR QUE NAO PASSA PELO HTTP NA PARTE QUE ESCREVE. As rotas gerenciam a propria
// transacao (BEGIN/COMMIT la dentro), e a armadilha 11 do CLAUDE.md proibe rodar contra o
// banco real uma funcao assim: o COMMIT dela CONFIRMA a transacao externa, e o ROLLBACK do
// teste nao tem mais o que desfazer. Em 12/08 isso gravou 7 PCs em producao num teste que
// parecia isolado.
//
// Entao a prova e em duas camadas, e cada uma responde o que a outra nao pode:
//
//   A. HTTP — so o que NAO grava: as recusas (400/401/403/404). Prova a guarda de verdade,
//      com o Express de pe e o perfil lido do banco.
//   B. SQL  — o caminho feliz, executando as MESMAS constantes da lib que a rota cola, dentro
//      de uma transacao que este arquivo controla e reverte.
//
// USO
//   node teste_invalidar_20260902.js
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const inval = require('./lib/invalidada');
const sigef = require('./lib/sigef');
const assumir = require('./lib/assumir');

const PORTA = 3978;
const PC = '2021PC002840';
const TR = '2021TR002375';
const SUPER = 4;      // Richard, superadmin
const ANALISTA = 35;  // Tanimeri, a dona da TR

const ok = [], mal = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function post(caminho, corpo) {
  const dados = JSON.stringify(corpo || {});
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORTA, path: caminho, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } },
      resp => { let b = ''; resp.on('data', c => b += c);
        resp.on('end', () => { try { res({ st: resp.statusCode, j: JSON.parse(b) }); }
                               catch (e) { rej(new Error(`${caminho}: ${b.slice(0,150)}`)); } }); });
    r.on('error', rej); r.write(dados); r.end();
  });
}

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` FASE 3 — as rotas de invalidacao      (tudo em BEGIN/ROLLBACK, nada e gravado)`);
  log(`${'═'.repeat(78)}`);

  const est = (await pool.query(`SELECT COUNT(*) FILTER (WHERE invalidada)::int n FROM prestacoes_contas`)).rows[0].n;
  // ⚠️ A LINHA DE BASE DA TRILHA. A parte C compara com ela, e nao com zero: se uma rodada
  // anterior deixou evento gravado, o teste tem de acusar o que ELE acrescentou, nao o que
  // ja estava — senao passa a falhar para sempre por causa do passado.
  const baseHist = (await pool.query(`SELECT COUNT(*)::int n FROM parcela_historico WHERE evento IN ($1,$2)`,
    [inval.EVENTO_INVALIDAR, inval.EVENTO_DESFAZER])).rows[0].n;
  log(`\n   PCs invalidadas no acervo agora: ${est}`);
  if (est !== 0) { log(`\n   ⛔ Ha PC invalidada — a prova espera partir de zero.\n`); await pool.end(); process.exit(1); }

  // ── A. AS RECUSAS, PELO HTTP ──────────────────────────────────────────────
  log(`\n── A. AS GUARDAS (HTTP, e nenhuma delas grava) ───────────────────────────`);
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORTA) }, stdio: ['ignore','pipe','pipe'] });
  let boot = ''; srv.stdout.on('data', d => boot += d); srv.stderr.on('data', d => boot += d);
  await new Promise(r => { const t0 = Date.now();
    const b = setInterval(() => { if (/rodando na porta/.test(boot) || Date.now()-t0 > 25000) { clearInterval(b); r(); } }, 300); });

  try {
    if (!/rodando na porta/.test(boot)) { conf(false, `o servidor NAO subiu: ${boot.slice(0,300)}`); }
    else {
      const casos = [
        ['sem motivo → 400',            { usuario_id: SUPER },                                      400],
        ['motivo curto (14) → 400',     { usuario_id: SUPER, motivo: 'a'.repeat(14) },              400],
        // ⚠️ COM ANALISTA, E NAO COM SUPERADMIN. A ordem das guardas e motivo(400) ->
        // usuario(401) -> perfil(403): um 403 aqui prova que o motivo de 15 PASSOU, sem
        // conceder a escrita. A primeira versao usava SUPER e a rota GRAVOU DE VERDADE —
        // duas linhas em parcela_historico que o ROLLBACK da parte B nao alcanca, porque a
        // rota gerencia a propria transacao (armadilha 11).
        ['motivo no limite (15) passa da validacao', { usuario_id: ANALISTA, motivo: 'a'.repeat(15) }, 403],
        ['sem usuario_id → 401',        { motivo: 'motivo suficientemente longo' },                 401],
        ['usuario inexistente → 401',   { usuario_id: 999999, motivo: 'motivo suficientemente longo' }, 401],
        ['ANALISTA → 403',              { usuario_id: ANALISTA, motivo: 'motivo suficientemente longo' }, 403],
      ];
      for (const [nome, corpo, esperado] of casos) {
        const r = await post(`/pc/${PC}/invalidar`, corpo);
        if (esperado === null) conf(r.st !== 400, `${nome}: HTTP ${r.st} (nao e 400)`);
        else conf(r.st === esperado, `${nome}: HTTP ${r.st}`);
      }
      const r404 = await post('/pc/NAO_EXISTE_PC/invalidar', { usuario_id: SUPER, motivo: 'motivo suficientemente longo' });
      conf(r404.st === 404, `PC inexistente → 404: HTTP ${r404.st}`);

      const rDes = await post(`/pc/${PC}/desinvalidar`, { usuario_id: ANALISTA, motivo: 'motivo suficientemente longo' });
      conf(rDes.st === 403, `desinvalidar por ANALISTA → 403: HTTP ${rDes.st}`);

      // A PC nao pode ter mudado: NENHUMA das guardas acima grava.
      const dep = (await pool.query(`SELECT invalidada FROM prestacoes_contas WHERE codigo_pc = $1`, [PC])).rows[0];
      conf(dep.invalidada === false, 'nenhuma guarda gravou nada — a PC segue ativa');
    }
  } finally { srv.kill(); }

  // ── B. O CAMINHO FELIZ, EM SQL, DENTRO DE BEGIN/ROLLBACK ─────────────────
  log(`\n── B. INVALIDAR → CONFERIR → DESINVALIDAR → CONFERIR → ROLLBACK ──────────`);
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const medir = async () => (await cli.query(`
      SELECT (SELECT COUNT(*)::int FROM prestacoes_contas p WHERE p.tr=$1 AND ${inval.ativa('p')})            AS pcs_tr,
             (SELECT COUNT(*) FILTER (WHERE p.baixada)::int FROM prestacoes_contas p
               WHERE p.tr=$1 AND ${inval.ativa('p')})                                                        AS bx_tr,
             (SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int
                FROM prestacoes_contas p WHERE p.analista_id=$2)                                             AS regra_c,
             (SELECT COUNT(DISTINCT tr)::int FROM prestacoes_contas
               WHERE analista_id=$2 AND baixada=false AND ${inval.ativa('')})                                AS trs_ocupadas,
             (SELECT COUNT(*) FILTER (WHERE ${assumir.PC_LIVRE_SQL})::int FROM prestacoes_contas WHERE tr=$1) AS livres_tr,
             (SELECT COUNT(*)::int FROM prestacoes_contas p WHERE p.tr=$1 AND ${inval.ativa('p')}
                AND ${sigef.SQL_NL_RESIDUAL})                                                                AS nl_res,
             (SELECT COUNT(*)::int FROM prestacoes_contas WHERE codigo_pc=$3 AND baixada)                    AS pc_baixada,
             (SELECT status FROM prestacoes_contas WHERE codigo_pc=$3)                                       AS pc_status,
             (SELECT COUNT(*)::int FROM parcela_historico WHERE tr=$1)                                       AS hist_tr
      `, [TR, ANALISTA, PC])).rows[0];

    const foto = await medir();
    log(`   foto → TR ${TR}: ${foto.pcs_tr} PCs · ${foto.bx_tr} baixadas · NL residual ${foto.nl_res}`);
    log(`          Tanimeri: regra C ${foto.regra_c} · TRs ocupadas ${foto.trs_ocupadas} · historico da TR ${foto.hist_tr} linhas`);
    conf(foto.bx_tr < foto.pcs_tr, `de partida a TR NAO e concluida: ${foto.bx_tr} >= ${foto.pcs_tr} e falso`);

    // ── invalidar, pelas constantes que a rota cola ────────────────────────
    const alvo = (await cli.query(inval.SQL_ALVO, [PC])).rows[0];
    conf(!!alvo && alvo.invalidada === false, `alvo travado com FOR UPDATE, e esta ativa`);

    const inv = await cli.query(inval.SQL_INVALIDAR, [PC, SUPER, 'residuo de carga sem correspondencia no SIGEF']);
    conf(inv.rowCount === 1, `SQL_INVALIDAR gravou 1 linha`);
    await cli.query(
      `INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
         valor_novo, analista_id, observacao, executado_por)
       VALUES ($1,$2,$3,$4,'ativa','invalidada',$5,$6,$7)`,
      [alvo.tr, alvo.parcial_num, alvo.setorial_id, inval.EVENTO_INVALIDAR,
       alvo.analista_id, `teste: invalidou ${PC}`, SUPER]);

    const dps = await medir();
    log(`   depois → TR ${TR}: ${dps.pcs_tr} PCs · ${dps.bx_tr} baixadas · NL residual ${dps.nl_res}`);
    log(`            Tanimeri: regra C ${dps.regra_c} · TRs ocupadas ${dps.trs_ocupadas} · historico ${dps.hist_tr} linhas`);

    conf(dps.pcs_tr === 2, `a TR passa a ter 2 PCs: ${foto.pcs_tr} -> ${dps.pcs_tr}`);
    conf(dps.bx_tr === foto.bx_tr, `baixadas da TR nao mudam: ${foto.bx_tr} -> ${dps.bx_tr}`);
    conf(dps.bx_tr >= dps.pcs_tr, `A TR VIRA CONCLUIDA: ${dps.bx_tr} >= ${dps.pcs_tr}`);
    conf(dps.regra_c === foto.regra_c,
      `produtividade da Tanimeri NAO muda (a PC nunca foi baixada): ${foto.regra_c} -> ${dps.regra_c}`);
    conf(dps.trs_ocupadas === foto.trs_ocupadas - 1, `TRs ocupadas caem 1: ${foto.trs_ocupadas} -> ${dps.trs_ocupadas}`);
    conf(dps.nl_res === foto.nl_res - 1, `a pilula de NL residual some: ${foto.nl_res} -> ${dps.nl_res}`);
    conf(dps.hist_tr === foto.hist_tr + 1, `uma linha nova na trilha: ${foto.hist_tr} -> ${dps.hist_tr}`);

    // O que NAO pode ter mudado na propria PC
    const pcDep = (await cli.query(
      `SELECT invalidada, invalidada_por, motivo_invalidacao, baixada, status, enviado_ci,
              parecer_tipo, estornada, data_estorno
         FROM prestacoes_contas WHERE codigo_pc = $1`, [PC])).rows[0];
    conf(pcDep.invalidada === true, `invalidada = true`);
    conf(pcDep.invalidada_por === SUPER, `invalidada_por = ${SUPER}`);
    conf(!!pcDep.motivo_invalidacao, `motivo_invalidacao gravado`);
    conf(pcDep.baixada === alvo.baixada, `baixada NAO foi zerada: ${alvo.baixada} -> ${pcDep.baixada}`);
    conf(pcDep.status === alvo.status, `status NAO mudou: ${alvo.status} -> ${pcDep.status}`);
    conf(pcDep.enviado_ci === alvo.enviado_ci, `enviado_ci NAO mudou`);
    conf(pcDep.estornada === false && pcDep.data_estorno === null, `NAO criou evento de estorno`);

    // ── idempotencia ───────────────────────────────────────────────────────
    const emAntes = (await cli.query(`SELECT invalidada_em FROM prestacoes_contas WHERE codigo_pc=$1`, [PC])).rows[0].invalidada_em;
    const inv2 = await cli.query(inval.SQL_INVALIDAR, [PC, SUPER, 'segunda tentativa, nao pode regravar']);
    conf(inv2.rowCount === 0, `invalidar de novo NAO grava (rowCount ${inv2.rowCount})`);
    const emDepois = (await cli.query(`SELECT invalidada_em FROM prestacoes_contas WHERE codigo_pc=$1`, [PC])).rows[0].invalidada_em;
    conf(String(emAntes) === String(emDepois), `invalidada_em NAO se moveu — o passado nao foi reescrito`);

    // ── desinvalidar ───────────────────────────────────────────────────────
    const des = await cli.query(inval.SQL_DESINVALIDAR, [PC]);
    conf(des.rowCount === 1, `SQL_DESINVALIDAR gravou 1 linha`);
    await cli.query(
      `INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
         valor_novo, analista_id, observacao, executado_por)
       VALUES ($1,$2,$3,$4,'invalidada','ativa',$5,$6,$7)`,
      [alvo.tr, alvo.parcial_num, alvo.setorial_id, inval.EVENTO_DESFAZER,
       alvo.analista_id, `teste: desfez a invalidacao de ${PC}`, SUPER]);

    const volta = await medir();
    log(`   volta  → TR ${TR}: ${volta.pcs_tr} PCs · ${volta.bx_tr} baixadas · NL residual ${volta.nl_res}`);
    conf(volta.pcs_tr === foto.pcs_tr, `total_pcs volta a foto: ${volta.pcs_tr} == ${foto.pcs_tr}`);
    conf(volta.bx_tr === foto.bx_tr, `baixadas voltam a foto: ${volta.bx_tr} == ${foto.bx_tr}`);
    conf(volta.regra_c === foto.regra_c, `regra C volta a foto: ${volta.regra_c} == ${foto.regra_c}`);
    conf(volta.trs_ocupadas === foto.trs_ocupadas, `TRs ocupadas voltam: ${volta.trs_ocupadas} == ${foto.trs_ocupadas}`);
    conf(volta.nl_res === foto.nl_res, `NL residual volta: ${volta.nl_res} == ${foto.nl_res}`);
    conf(volta.livres_tr === foto.livres_tr, `pcs_livres volta: ${volta.livres_tr} == ${foto.livres_tr}`);
    conf(volta.bx_tr < volta.pcs_tr, `a TR volta a NAO ser concluida: ${volta.bx_tr} >= ${volta.pcs_tr} e falso`);

    const pcFim = (await cli.query(
      `SELECT invalidada, invalidada_em, invalidada_por, motivo_invalidacao, baixada, status
         FROM prestacoes_contas WHERE codigo_pc = $1`, [PC])).rows[0];
    conf(pcFim.invalidada === false && pcFim.invalidada_em === null
      && pcFim.invalidada_por === null && pcFim.motivo_invalidacao === null,
      `as quatro colunas zeradas`);
    conf(pcFim.baixada === alvo.baixada && pcFim.status === alvo.status,
      `baixada e status seguem como na foto`);
    conf(volta.hist_tr === foto.hist_tr + 2, `as DUAS linhas ficam na trilha: ${foto.hist_tr} -> ${volta.hist_tr}`);

    const des2 = await cli.query(inval.SQL_DESINVALIDAR, [PC]);
    conf(des2.rowCount === 0, `desinvalidar de novo NAO grava (rowCount ${des2.rowCount})`);

    await cli.query('ROLLBACK');
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    conf(false, `parte B falhou: ${e.message}`);
  } finally { cli.release(); }

  // ── C. O BANCO FICOU INTACTO ──────────────────────────────────────────────
  log(`\n── C. DEPOIS DO ROLLBACK ─────────────────────────────────────────────────`);
  const fim = (await pool.query(`
    SELECT (SELECT COUNT(*) FILTER (WHERE invalidada)::int FROM prestacoes_contas)      AS invalidadas,
           (SELECT COUNT(*)::int FROM prestacoes_contas WHERE tr=$1)                    AS pcs_tr,
           (SELECT COUNT(*)::int FROM parcela_historico WHERE tr=$1)                    AS hist,
           (SELECT COUNT(*)::int FROM parcela_historico
             WHERE evento IN ($2,$3))                                                   AS eventos_novos
  `, [TR, inval.EVENTO_INVALIDAR, inval.EVENTO_DESFAZER])).rows[0];
  conf(fim.invalidadas === 0, `nenhuma PC invalidada no acervo: ${fim.invalidadas}`);
  conf(fim.pcs_tr === 3, `a TR ${TR} segue com 3 PCs: ${fim.pcs_tr}`);
  conf(fim.eventos_novos === baseHist,
    `esta rodada NAO acrescentou evento na trilha: ${fim.eventos_novos} == base ${baseHist}`);
  if (baseHist > 0) log(`   ⚠️ ha ${baseHist} evento(s) de rodada ANTERIOR na trilha — ver o relatorio.`);

  log(`\n${'─'.repeat(78)}`);
  log(`   ${ok.length} conferencias passaram, ${mal.length} falharam.`);
  log(mal.length ? `\n   ⛔ FASE 3 REPROVADA\n` : `\n   ✅ FASE 3 APROVADA — e o banco esta como estava.\n`);
  await pool.end();
  process.exit(mal.length ? 1 : 0);
})().catch(async e => { console.error('\n   ⛔ ERRO:', e.message, '\n'); try { await pool.end(); } catch (_) {} process.exit(1); });
