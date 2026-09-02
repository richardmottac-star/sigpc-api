// CAMINHO: sigpc-api/prova_fase2_invalidada_20260902.js
//
// A PROVA DA FASE 2 — o filtro de `invalidada` em 28 pontos.
// SOMENTE LEITURA. Nao existe `--gravar`: a fase 2 e mudanca de CODIGO, nao de banco.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ POR QUE DUAS PARTES, E NAO SO A DE IDENTIDADE
//
// A conferencia pedida e "nenhum numero mudou". Mas ela sozinha e satisfeita por um filtro
// QUEBRADO: uma clausula que nunca casa tambem deixa tudo identico. Entao:
//
//   PARTE 1 — INERCIA. Com zero PC invalidada, cada consulta modificada tem de devolver
//             exatamente o mesmo que a forma ANTIGA (sem filtro). Prova que nao regrediu.
//
//   PARTE 2 — LIGACAO. Dentro de BEGIN, marca UMA PC como invalidada e confere que cada
//             numero se move pelo delta ESPERADO. Depois ROLLBACK. Prova que o filtro existe.
//
// Sem a parte 2, um `AND 1=0` invertido passaria na parte 1 e ninguem veria.
//
// ⚠️ A PARTE 1 SOBE O EXPRESS E BATE NAS ROTAS DE VERDADE. `node --check` nao pega erro de
// SQL — so a execucao pega. Foi o que achou os quatro defeitos de 10–11/08 que os 220 testes
// com duble deixaram passar. As libs sao exercitadas pelas rotas que as usam.
//
// ⚠️ A PARTE 2 NAO PODE PASSAR PELO HTTP: ela roda dentro de uma transacao aberta aqui, e o
// servidor tem conexoes proprias que nao enxergam o que ela ainda nao confirmou. Por isso ela
// executa as EXPRESSOES DA LIB direto, que e o que as rotas colam.
//
// USO
//   node prova_fase2_invalidada_20260902.js
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const inval = require('./lib/invalidada');
const sigef = require('./lib/sigef');
const assumir = require('./lib/assumir');
const ciFila = require('./lib/ci-fila');

const PORTA = 3977;                  // porta propria, para nao brigar com um server ja de pe
const PC_COBAIA = '2021PC002840';    // a PC do caso que abriu a frente
const EU = 4;

const ok = [], mal = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const um = async (sql, p) => (await pool.query(sql, p)).rows[0];

function get(caminho) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORTA}${caminho}`, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res({ st: r.statusCode, j: JSON.parse(b) }); } catch (e) { rej(new Error(`${caminho}: ${b.slice(0,180)}`)); } });
    }).on('error', rej);
  });
}

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` PROVA DA FASE 2 — filtro de invalidada   (SOMENTE LEITURA, sem --gravar)`);
  log(`${'═'.repeat(78)}`);

  // ── 0. O ESTADO DE PARTIDA ────────────────────────────────────────────────
  const est = await um(`SELECT COUNT(*)::int tot, COUNT(*) FILTER (WHERE invalidada)::int inv
                          FROM prestacoes_contas`);
  log(`\n── 0. ESTADO ─────────────────────────────────────────────────────────────`);
  log(`   PCs no acervo .............. ${est.tot}`);
  log(`   PCs invalidadas ............ ${est.inv}`);
  if (est.inv !== 0) {
    log(`\n   ⛔ Ha PC invalidada. A parte 1 exige zero — senao "identico" nao prova nada.\n`);
    await pool.end(); process.exit(1);
  }

  // ── 1. INERCIA, PELAS ROTAS DE VERDADE ────────────────────────────────────
  log(`\n── 1. INERCIA — as rotas, contra a forma ANTIGA (sem filtro) ─────────────`);
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORTA) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  srv.stdout.on('data', d => boot += d); srv.stderr.on('data', d => boot += d);
  await new Promise(r => {
    const t0 = Date.now();
    const bate = setInterval(() => {
      if (/rodando na porta/.test(boot) || Date.now() - t0 > 25000) { clearInterval(bate); r(); }
    }, 300);
  });

  try {
    // Cada caso: a rota, o campo, e o SQL da forma ANTIGA que tem de dar o mesmo numero.
    const casos = [
      ['GET /prestacoes_contas count (4 cards do Dashboard)',
       '/prestacoes_contas?setorial_id=FCEE&limit=1', r => r.j.count,
       `SELECT COUNT(*)::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
      ['GET /prestacoes_contas?baixada=true (card PCs baixadas)',
       '/prestacoes_contas?setorial_id=FCEE&baixada=true&limit=1', r => r.j.count,
       `SELECT COUNT(*)::int n FROM prestacoes_contas p WHERE setorial_id='FCEE' AND baixada=true`],
      ['GET /prestacoes_contas?status=livre (Painel Tecnico)',
       '/prestacoes_contas?setorial_id=FCEE&status=livre&limit=1', r => r.j.count,
       `SELECT COUNT(*)::int n FROM prestacoes_contas p WHERE setorial_id='FCEE' AND status='livre'`],
      ['resumo_tr — numero de TRs',
       '/prestacoes_contas/resumo_tr?setorial_id=FCEE', r => r.j.count,
       `SELECT COUNT(DISTINCT tr)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
      ['resumo_tr — soma de total_pcs',
       '/prestacoes_contas/resumo_tr?setorial_id=FCEE', r => (r.j.data || []).reduce((s, t) => s + Number(t.total_pcs), 0),
       `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
      ['resumo_tr — soma de baixadas',
       '/prestacoes_contas/resumo_tr?setorial_id=FCEE', r => (r.j.data || []).reduce((s, t) => s + Number(t.baixadas), 0),
       `SELECT COUNT(*) FILTER (WHERE baixada)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
      ['resumo_tr — soma de sigef_conta (produtividade regra C)',
       '/prestacoes_contas/resumo_tr?setorial_id=FCEE', r => (r.j.data || []).reduce((s, t) => s + Number(t.sigef_conta), 0),
       `SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
      ['resumo_tr — soma de pcs_livres',
       '/prestacoes_contas/resumo_tr?setorial_id=FCEE', r => (r.j.data || []).reduce((s, t) => s + Number(t.pcs_livres), 0),
       `SELECT COUNT(*) FILTER (WHERE analista_id IS NULL AND status='livre')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
      ['painel — falta_ci (Dashboard)',
       `/prestacoes_contas/painel?analista_id=${EU}&setorial_id=FCEE`, r => r.j.data.falta_ci,
       `SELECT COUNT(*) FILTER (WHERE baixada=true AND enviado_ci=false)::int n FROM prestacoes_contas WHERE analista_id=${EU} AND setorial_id='FCEE'`],
      ['painel — ci_total (centro do anel)',
       `/prestacoes_contas/painel?analista_id=${EU}&setorial_id=FCEE`, r => r.j.data.ci_total,
       `SELECT COUNT(DISTINCT (setorial_id||'|'||tr||'|'||COALESCE(parcial_num,'~')))::int n
          FROM prestacoes_contas WHERE analista_id=${EU} AND setorial_id='FCEE' AND enviado_ci=true`],
      ['painel_equipe — soma de baixadas (Ver como)',
       '/prestacoes_contas/painel_equipe?setorial_id=FCEE', r => Object.values(r.j.data).reduce((s, a) => s + a.baixadas, 0),
       `SELECT COUNT(*) FILTER (WHERE status='baixada')::int n FROM prestacoes_contas WHERE analista_id IS NOT NULL AND setorial_id='FCEE'`],
      ['painel_equipe — soma de total',
       '/prestacoes_contas/painel_equipe?setorial_id=FCEE', r => Object.values(r.j.data).reduce((s, a) => s + a.total, 0),
       `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE analista_id IS NOT NULL AND setorial_id='FCEE'`],
      ['produtividade cumulativa — total ate hoje',
       `/prestacoes_contas/produtividade?corte=${new Date().toISOString().slice(0,10)}`, r => r.j.data.total,
       `SELECT COUNT(*) FILTER (WHERE ${sigef.sqlContaAte(`'${new Date().toISOString().slice(0,10)}'`)})::int n
          FROM prestacoes_contas p WHERE (p.estornada=false OR p.data_estorno>'${new Date().toISOString().slice(0,10)}')`],
      ['alertas_prazo — importado.pcs',
       `/prestacoes_contas/alertas_prazo?analista_id=${EU}&setorial_id=FCEE`, r => r.j.data.importado.pcs,
       `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE analista_id=${EU} AND setorial_id='FCEE'
          AND status<>'baixada' AND dt_limite_pc IS NOT NULL AND dt_limite_pc < DATE '2026-08-01'`],
      ['ci/fila — card "Na fila" (parcelas)',
       '/ci/fila?usuario_id=62', r => r.j.resumo.cards.fila,
       `SELECT COUNT(DISTINCT (setorial_id||'|'||tr||'|'||COALESCE(parcial_num,'~')))::int n
          FROM prestacoes_contas WHERE ci_situacao='na_fila'`],
      ['ci/fila — total da lista (paginacao)',
       '/ci/fila?usuario_id=62', r => r.j.total,
       `SELECT COUNT(*)::int n FROM (SELECT 1 FROM prestacoes_contas WHERE ci_situacao='na_fila'
             GROUP BY setorial_id, tr, parcial_num) x`],
      ['busca_global — PCs do card',
       '/busca_global?termo=2021TR002375&usuario_id=4', r => (r.j.data.cards || []).reduce((s, c) => s + c.total_pcs, 0),
       `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE setorial_id='FCEE' AND tr='2021TR002375'`],
      // O parametro e `analista_id`, e nao `usuario_id` — a primeira versao desta prova
      // mandou o nome errado e levou um 400 que parecia falha do filtro.
      ['limite_tr/situacao — TRs ocupadas (A TRAVA)',
       `/limite_tr/situacao?analista_id=${EU}`, r => r.j.data.ocupadas,
       `SELECT COUNT(DISTINCT tr)::int n FROM prestacoes_contas WHERE analista_id=${EU} AND baixada=false`],
      ['acompanhamento — n_pcs da 1a linha',
       '/acompanhamento?usuario_id=4&tamanho=10', r => (r.j.data[0] || {}).n_pcs,
       null],
    ];

    for (const [nome, rota, extrai, sqlAntigo] of casos) {
      let r;
      try { r = await get(rota); } catch (e) { conf(false, `${nome} — ROTA FALHOU: ${e.message}`); continue; }
      if (r.st !== 200) { conf(false, `${nome} — HTTP ${r.st}: ${JSON.stringify(r.j).slice(0,120)}`); continue; }
      const v = extrai(r);
      if (sqlAntigo === null) { conf(v !== undefined && v !== null, `${nome}: rota respondeu (${v})`); continue; }
      const esp = (await um(sqlAntigo)).n;
      conf(Number(v) === Number(esp), `${nome}: rota ${v} == forma antiga ${esp}`);
    }
    // ── 1-B. AS TELAS QUE AGREGAM NO CLIENTE ────────────────────────────────
    // ⚠️ Board, Gestao Grupo, Relatorios e o Quadro 2 do CGE nao tem rota propria: as quatro
    // baixam `GET /prestacoes_contas` e somam no navegador. Entao a prova reproduz AQUI a
    // mesma agregacao que o `index.html` faz, sobre o payload da rota, e compara com a forma
    // antiga. Sem isto, "a rota devolve o mesmo count" nao diria nada sobre o que elas mostram.
    log(`\n── 1-B. TELAS QUE AGREGAM NO CLIENTE (Board · Gestao Grupo · Relatorios · CGE) ──`);
    let lista = [];
    try {
      const r = await get('/prestacoes_contas?setorial_id=FCEE&limit=99999');
      lista = r.j.data || [];
      conf(lista.length > 0, `a rota devolveu a lista inteira: ${lista.length} linhas`);
    } catch (e) { conf(false, `lista completa FALHOU: ${e.message}`); }

    if (lista.length) {
      const cli2 = [
        ['Board — Total PCs',        lista.length,
         `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Board — Concluidas (status=baixada)', lista.filter(p => p.status === 'baixada').length,
         `SELECT COUNT(*) FILTER (WHERE status='baixada')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Board — Em Analise',       lista.filter(p => p.status === 'analise').length,
         `SELECT COUNT(*) FILTER (WHERE status='analise')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Board — Diligencia',       lista.filter(p => p.status === 'diligencia').length,
         `SELECT COUNT(*) FILTER (WHERE status='diligencia')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Board — Reanalise',        lista.filter(p => p.status === 'reanalise').length,
         `SELECT COUNT(*) FILTER (WHERE status='reanalise')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Board — Ctrl. Interno (enviado_ci)', lista.filter(p => p.enviado_ci).length,
         `SELECT COUNT(*) FILTER (WHERE enviado_ci)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['Produtividade — regra C (soma de sigef_conta)', lista.filter(p => p.sigef_conta === true).length,
         `SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
        ['Produtividade — descontadas pelo SIGEF', lista.filter(p => p.sigef_descontada === true).length,
         `SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_DESCONTADA})::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
        ['Produtividade — pre-GT (12/08/2025)', lista.filter(p => p.sigef_pre_gt === true).length,
         `SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_PRE_GT})::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
        ['Relatorios Geral — Baixadas', lista.filter(p => p.status === 'baixada').length,
         `SELECT COUNT(*) FILTER (WHERE status='baixada')::int n FROM prestacoes_contas WHERE setorial_id='FCEE'`],
        ['CGE Quadro 2 — baixadas no periodo (01/08/2025 ->)',
         lista.filter(p => p.baixada === true && p.data_baixa && new Date(p.data_baixa) >= new Date('2025-08-01T00:00:00')).length,
         `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE setorial_id='FCEE'
            AND baixada=true AND data_baixa >= TIMESTAMP '2025-08-01'`],
        ['Minha Planilha / pilula — NL residual', lista.filter(p => p.nl_residual === true).length,
         `SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_NL_RESIDUAL})::int n FROM prestacoes_contas p WHERE setorial_id='FCEE'`],
      ];
      for (const [nome, v, sql] of cli2) {
        const esp = (await um(sql)).n;
        conf(Number(v) === Number(esp), `${nome}: tela ${v} == forma antiga ${esp}`);
      }

      // ⚠️ BAIXADAS POR ANALISTA, LINHA A LINHA — pedido explicito. Um total igual dos dois
      // lados esconderia duas trocas que se anulam; o FULL JOIN acha quem sumiu, quem apareceu
      // e quem mudou de numero.
      const porTela = new Map();
      lista.forEach(p => {
        const k = p.analista_id == null ? -1 : Number(p.analista_id);
        const a = porTela.get(k) || { bx: 0, st: 0, tot: 0 };
        if (p.baixada) a.bx++; if (p.status === 'baixada') a.st++; a.tot++;
        porTela.set(k, a);
      });
      const antigo = (await pool.query(
        `SELECT COALESCE(analista_id,-1)::int a, COUNT(*) FILTER (WHERE baixada)::int bx,
                COUNT(*) FILTER (WHERE status='baixada')::int st, COUNT(*)::int tot
           FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY 1`)).rows;
      let dif = 0;
      const vistos = new Set();
      for (const r of antigo) {
        vistos.add(r.a);
        const t = porTela.get(r.a);
        if (!t || t.bx !== r.bx || t.st !== r.st || t.tot !== r.tot) dif++;
      }
      for (const k of porTela.keys()) if (!vistos.has(k)) dif++;
      conf(dif === 0,
        `baixadas por analista, linha a linha: ${antigo.length} analistas, ${dif} com diferenca`);
    }
  } finally {
    srv.kill();
  }

  // ── 2. LIGACAO — o filtro move o numero quando ha PC invalidada ───────────
  log(`\n── 2. LIGACAO — invalida ${PC_COBAIA} dentro de BEGIN, confere, e faz ROLLBACK ──`);
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const alvo = (await cli.query(
      `SELECT tr, parcial_num, setorial_id, analista_id, baixada, codigo_nl
         FROM prestacoes_contas WHERE codigo_pc = $1`, [PC_COBAIA])).rows[0];
    if (!alvo) throw new Error(`${PC_COBAIA} nao existe`);

    const medir = async () => (await cli.query(`
      SELECT (SELECT COUNT(*)::int FROM prestacoes_contas p
               WHERE p.setorial_id='FCEE' AND ${inval.ativa('p')})                       AS total_fcee,
             (SELECT COUNT(*)::int FROM prestacoes_contas p
               WHERE p.tr=$1 AND ${inval.ativa('p')})                                    AS pcs_da_tr,
             (SELECT COUNT(*) FILTER (WHERE p.baixada)::int FROM prestacoes_contas p
               WHERE p.tr=$1 AND ${inval.ativa('p')})                                    AS baixadas_da_tr,
             (SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int
                FROM prestacoes_contas p WHERE p.analista_id=$2)                         AS regra_c,
             (SELECT COUNT(DISTINCT tr)::int FROM prestacoes_contas
               WHERE analista_id=$2 AND baixada=false AND ${inval.ativa('')})            AS trs_ocupadas,
             (SELECT COUNT(*) FILTER (WHERE ${assumir.PC_LIVRE_SQL})::int
                FROM prestacoes_contas WHERE tr=$1)                                      AS livres_da_tr,
             ${/* ⚠️ O `p` TAMBEM ENTRA NO FILTRO, e a primeira versao desta prova esqueceu.
                   A rota `GET /prestacoes_contas` ja filtra as LINHAS antes de calcular a
                   pilula; medir sem isso conta a propria PC invalidada como residual e a
                   conferencia acusa defeito que nao existe. */''}
             (SELECT COUNT(*)::int FROM prestacoes_contas p
               WHERE p.tr=$1 AND ${inval.ativa('p')} AND ${sigef.SQL_NL_RESIDUAL})       AS nl_residual_na_tr
      `, [alvo.tr, alvo.analista_id])).rows[0];

    const antes = await medir();
    log(`   antes  → TR ${alvo.tr}: ${antes.pcs_da_tr} PCs, ${antes.baixadas_da_tr} baixadas · `
      + `NL residual ${antes.nl_residual_na_tr} · regra C do analista ${antes.regra_c} · TRs ocupadas ${antes.trs_ocupadas}`);

    await cli.query(
      `UPDATE prestacoes_contas SET invalidada = true, invalidada_em = NOW(),
              invalidada_por = $2, motivo_invalidacao = $3
        WHERE codigo_pc = $1`,
      [PC_COBAIA, EU, 'PROVA DA FASE 2 — sera revertida por ROLLBACK, nada e gravado']);

    const dps = await medir();
    log(`   depois → TR ${alvo.tr}: ${dps.pcs_da_tr} PCs, ${dps.baixadas_da_tr} baixadas · `
      + `NL residual ${dps.nl_residual_na_tr} · regra C do analista ${dps.regra_c} · TRs ocupadas ${dps.trs_ocupadas}`);

    conf(dps.total_fcee === antes.total_fcee - 1, `acervo FCEE caiu 1: ${antes.total_fcee} -> ${dps.total_fcee}`);
    conf(dps.pcs_da_tr === antes.pcs_da_tr - 1, `total_pcs da TR caiu 1: ${antes.pcs_da_tr} -> ${dps.pcs_da_tr}`);
    conf(dps.baixadas_da_tr === antes.baixadas_da_tr,
      `baixadas da TR NAO mudou (a PC nao era baixada): ${antes.baixadas_da_tr} -> ${dps.baixadas_da_tr}`);
    conf(dps.baixadas_da_tr >= dps.pcs_da_tr,
      `A TR PASSA A SER "CONCLUIDA": ${dps.baixadas_da_tr} >= ${dps.pcs_da_tr} (antes ${antes.baixadas_da_tr} >= ${antes.pcs_da_tr} era falso)`);
    conf(dps.regra_c === antes.regra_c,
      `produtividade do analista NAO muda (a PC nao contava): ${antes.regra_c} -> ${dps.regra_c}`);
    conf(dps.trs_ocupadas === antes.trs_ocupadas - 1,
      `TRs ocupadas na TRAVA caiu 1: ${antes.trs_ocupadas} -> ${dps.trs_ocupadas}`);
    conf(dps.nl_residual_na_tr === antes.nl_residual_na_tr - 1,
      `a pilula de NL residual sumiu: ${antes.nl_residual_na_tr} -> ${dps.nl_residual_na_tr}`);

    // A produtividade CUMULATIVA de um corte ANTERIOR nao pode mudar.
    const cum = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE ${sigef.sqlContaAte('$1')} AND ${inval.ativaAte('$1','p')})::int n
         FROM prestacoes_contas p WHERE (p.estornada=false OR p.data_estorno>$1)`, ['2026-07-31'])).rows[0].n;
    const cumSem = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE ${sigef.sqlContaAte('$1')})::int n
         FROM prestacoes_contas p WHERE (p.estornada=false OR p.data_estorno>$1)`, ['2026-07-31'])).rows[0].n;
    conf(cum === cumSem,
      `relatorio de 31/07 NAO foi reescrito pela invalidacao de hoje: ${cum} == ${cumSem}`);

    await cli.query('ROLLBACK');
    const depoisRb = (await um(`SELECT COUNT(*) FILTER (WHERE invalidada)::int n FROM prestacoes_contas`)).n;
    conf(depoisRb === 0, `ROLLBACK: PCs invalidadas voltou a ${depoisRb}`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    conf(false, `parte 2 falhou: ${e.message}`);
  } finally { cli.release(); }

  log(`\n${'─'.repeat(78)}`);
  log(`   ${ok.length} conferencias passaram, ${mal.length} falharam.`);
  log(mal.length ? `\n   ⛔ FASE 2 REPROVADA\n` : `\n   ✅ FASE 2 APROVADA — nenhum numero se moveu, e o filtro esta ligado.\n`);
  await pool.end();
  process.exit(mal.length ? 1 : 0);
})().catch(async e => { console.error('\n   ⛔ ERRO:', e.message, '\n'); try { await pool.end(); } catch (_) {} process.exit(1); });
