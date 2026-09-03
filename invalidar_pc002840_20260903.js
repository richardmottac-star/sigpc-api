// CAMINHO: sigpc-api/invalidar_pc002840_20260903.js
//
// INVALIDA A 2021PC002840 PELA ROTA — a primeira invalidacao real do sistema.
// PADRAO = DRY-RUN. So grava com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// O CASO
//
// A 2021PC002840 (TR 2021TR002375) nasceu com `processo_pc = '-1'`, recebeu por engano o SCC
// da FINAL em 14/08 e a renumeracao de 16/08 a fundiu na parcela 1. A analista Tanimeri
// conferiu no SIGEF em 02/09/2026: aquela TR tem DUAS prestacoes — parcial SCC 19123/2022 e
// final SCC 19273/2022 — e os 96.298,77 foram prestados de uma vez. Nao existe prestacao de
// 763,58. Ela impede a TR de ir para as concluidas.
//
// ⚠️ A ROTA COMMITA SOZINHA, e por isso NAO ha BEGIN/ROLLBACK em volta dela. E a armadilha 11:
// envolver uma funcao que gerencia a propria transacao nao protege nada — o COMMIT dela
// confirma tudo. A protecao aqui e outra: a foto e tirada ANTES, as conferencias rodam DEPOIS
// e, se alguma falhar, o script chama `desinvalidar` na hora para devolver o estado.
//
// ⚠️ E POR ISSO A REVERSAO E TRIVIAL, ao contrario das migracoes: desfazer e uma chamada a
// `POST /pc/2021PC002840/desinvalidar`. O JSON guarda a foto e o comando.
//
// USO
//   node invalidar_pc002840_20260903.js            dry-run: so a foto e o que seria feito
//   node invalidar_pc002840_20260903.js --gravar   chama a rota e confere
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');
const inval = require('./lib/invalidada');
const sigef = require('./lib/sigef');

const GRAVAR = process.argv.includes('--gravar');
const PORTA = 3979;
const PC = '2021PC002840';
const TR = '2021TR002375';
const NL = '2021NL021001';
const SUPER = 4;       // Richard, superadmin
const TANIMERI = 35;
const REVERSAO = path.join(__dirname, 'reverter_invalidar_pc002840_20260903.json');

const MOTIVO = 'Residuo de carga inicial. A analista Tanimeri conferiu no SIGEF em 02/09/2026: '
  + 'a TR 2021TR002375 tem apenas duas prestacoes, parcial SCC 19123/2022 e final SCC 19273/2022, '
  + 'e os 96.298,77 foram prestados de uma vez. Nao existe prestacao de 763,58.';

const ok = [], mal = [];
const conf = (c, m) => { (c ? ok : mal).push(m); console.log(`   ${c ? '✓' : '✗'} ${m}`); };
const log = (s) => console.log(s);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('error', (e) => log(`   (aviso: conexao ociosa caiu — ${e.message})`));

function post(caminho, corpo) {
  const d = JSON.stringify(corpo);
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORTA, path: caminho, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      p => { let b = ''; p.on('data', c => b += c);
             p.on('end', () => { try { res({ st: p.statusCode, j: JSON.parse(b) }); }
                                 catch (e) { rej(new Error(b.slice(0, 200))); } }); });
    r.on('error', rej); r.write(d); r.end();
  });
}

// A foto: tudo o que as conferencias vao comparar.
async function medir() {
  const { rows: [n] } = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM prestacoes_contas p WHERE p.tr=$1 AND ${inval.ativa('p')})            AS pcs_tr,
           (SELECT COUNT(*) FILTER (WHERE p.baixada)::int FROM prestacoes_contas p
             WHERE p.tr=$1 AND ${inval.ativa('p')})                                                        AS bx_tr,
           (SELECT COUNT(*) FILTER (WHERE ${sigef.SQL_CONTA_PRODUTIVIDADE})::int
              FROM prestacoes_contas p WHERE p.analista_id=$2)                                             AS regra_c,
           (SELECT COUNT(DISTINCT tr)::int FROM prestacoes_contas
             WHERE analista_id=$2 AND baixada=false AND ${inval.ativa('')})                                AS trs_ocupadas,
           (SELECT COUNT(*)::int FROM prestacoes_contas p WHERE p.tr=$1 AND ${inval.ativa('p')}
              AND ${sigef.SQL_NL_RESIDUAL})                                                                AS nl_res,
           (SELECT COUNT(*)::int FROM prestacoes_contas)                                                   AS acervo,
           -- ⚠️ A IMPRESSAO DIGITAL DE TODAS AS OUTRAS PCs. Contar linhas nao prova que elas
           -- nao mudaram — e a licao do aviso id 6, em 17/08. O md5 do agregado prova.
           (SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
              SELECT codigo_pc || ':' || baixada || ':' || COALESCE(status,'') || ':'
                     || COALESCE(processo_pc,'') || ':' || COALESCE(parecer_tipo,'') || ':'
                     || COALESCE(data_baixa::text,'') || ':' || invalidada AS t
                FROM prestacoes_contas WHERE codigo_pc <> $3) x)                                           AS md5_outras
  `, [TR, TANIMERI, PC]);

  const { rows: pcs } = await pool.query(
    `SELECT codigo_pc, tipo, parcial_num, processo_pc, codigo_nl, status, baixada, enviado_ci,
            parecer_tipo, to_char(data_baixa,'YYYY-MM-DD') AS data_baixa, valor,
            invalidada, invalidada_em, invalidada_por, motivo_invalidacao
       FROM prestacoes_contas WHERE tr = $1 ORDER BY tipo DESC, codigo_pc`, [TR]);
  return { n, pcs };
}

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` INVALIDAR ${PC}   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (nada e chamado)'}`);
  log(`${'═'.repeat(78)}`);

  let srv = null;
  try {
    // ── 1. A FOTO, ANTES ────────────────────────────────────────────────────
    const antes = await medir();
    log(`\n── 1. A FOTO, ANTES ──────────────────────────────────────────────────────`);
    antes.pcs.forEach(p => log(`   ${p.codigo_pc.padEnd(21)} ${String(p.tipo).padEnd(7)} parc ${String(p.parcial_num).padEnd(5)}`
      + ` ${String(p.processo_pc || '—').padEnd(19)} baixada ${String(p.baixada).padEnd(5)}`
      + ` ${p.data_baixa || '—'}  ${p.invalidada ? 'INVALIDADA' : ''}`));
    log(`   TR: ${antes.n.pcs_tr} PCs ativas · ${antes.n.bx_tr} baixadas · concluida? `
      + `${antes.n.bx_tr >= antes.n.pcs_tr ? 'SIM' : 'NAO'} · NL residual ${antes.n.nl_res}`);
    log(`   Tanimeri: regra C ${antes.n.regra_c} · TRs ocupadas ${antes.n.trs_ocupadas}`);
    log(`   acervo ${antes.n.acervo} PCs · md5 das outras ${String(antes.n.md5_outras).slice(0,16)}…`);

    const alvo = antes.pcs.find(p => p.codigo_pc === PC);
    if (!alvo) throw new Error(`${PC} nao existe na TR ${TR}`);
    if (alvo.invalidada) { log(`\n   ${PC} JA ESTA INVALIDADA. Nada a fazer.\n`); return; }

    log(`\n── 2. O QUE SERA FEITO ───────────────────────────────────────────────────`);
    log(`   POST /pc/${PC}/invalidar   usuario_id=${SUPER} (superadmin)`);
    log(`   motivo (${MOTIVO.length} caracteres, minimo ${inval.MOTIVO_MIN}):`);
    MOTIVO.match(/.{1,72}(\s|$)/g).forEach(l => log(`     ${l.trim()}`));

    if (!GRAVAR) {
      log(`\n   ↩ DRY-RUN. A rota NAO foi chamada.`);
      log(`   para gravar: node invalidar_pc002840_20260903.js --gravar\n`);
      return;
    }

    // ── 3. A CHAMADA ────────────────────────────────────────────────────────
    log(`\n── 3. A CHAMADA ──────────────────────────────────────────────────────────`);
    srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORTA) }, stdio: ['ignore','pipe','pipe'] });
    let boot = ''; srv.stdout.on('data', d => boot += d); srv.stderr.on('data', d => boot += d);
    await new Promise(r => { const t0 = Date.now();
      const b = setInterval(() => { if (/rodando na porta/.test(boot) || Date.now()-t0 > 25000) { clearInterval(b); r(); } }, 300); });
    if (!/rodando na porta/.test(boot)) throw new Error(`o servidor nao subiu: ${boot.slice(0,300)}`);

    const r = await post(`/pc/${PC}/invalidar`, { usuario_id: SUPER, motivo: MOTIVO });
    log(`   HTTP ${r.st}`);
    log(`   ${JSON.stringify(r.j.data || r.j.error)}`);
    conf(r.st === 200, `a rota respondeu 200`);
    conf(r.j.data && r.j.data.invalidada === true, `devolveu invalidada = true`);
    conf(r.j.data && r.j.data.ja_estava === false, `e nao era idempotencia — gravou agora`);
    conf(r.j.data && r.j.data.baixa_preservada === true, `a resposta afirma que a baixa foi preservada`);

    // ── 4. AS CONFERENCIAS, CONTRA A FOTO ───────────────────────────────────
    log(`\n── 4. CONFERENCIAS (contra a foto, nunca contra numero literal) ──────────`);
    const dps = await medir();

    conf(dps.n.pcs_tr === 2, `a TR passa a ter 2 PCs ativas: ${antes.n.pcs_tr} -> ${dps.n.pcs_tr}`);
    conf(dps.n.bx_tr >= dps.n.pcs_tr,
      `e VIRA CONCLUIDA: ${dps.n.bx_tr} >= ${dps.n.pcs_tr} (antes ${antes.n.bx_tr} >= ${antes.n.pcs_tr} era falso)`);

    // As duas restantes, campo a campo contra a foto.
    const restantes = dps.pcs.filter(p => p.codigo_pc !== PC);
    conf(restantes.length === 2, `restaram 2 PCs na TR: ${restantes.length}`);
    for (const d of restantes) {
      const a = antes.pcs.find(x => x.codigo_pc === d.codigo_pc);
      conf(d.baixada === true && a.baixada === true, `${d.codigo_pc}: segue baixada`);
      conf(d.processo_pc === a.processo_pc, `${d.codigo_pc}: processo intacto (${d.processo_pc})`);
      conf(d.parecer_tipo === a.parecer_tipo, `${d.codigo_pc}: parecer intacto (${d.parecer_tipo})`);
      conf(d.data_baixa === a.data_baixa, `${d.codigo_pc}: data_baixa intacta (${d.data_baixa})`);
      conf(d.invalidada === false, `${d.codigo_pc}: NAO foi invalidada`);
    }

    conf(dps.n.regra_c === antes.n.regra_c,
      `a produtividade da Tanimeri NAO muda: ${antes.n.regra_c} -> ${dps.n.regra_c}`);
    conf(dps.n.nl_res === 0 && antes.n.nl_res > 0,
      `a NL residual da ${NL} desapareceu: ${antes.n.nl_res} -> ${dps.n.nl_res}`);
    conf(dps.n.trs_ocupadas === antes.n.trs_ocupadas - 1,
      `a trava de TRs cai 1: ${antes.n.trs_ocupadas} -> ${dps.n.trs_ocupadas} ocupadas`);
    conf(dps.n.acervo === antes.n.acervo, `nenhuma linha foi apagada: ${antes.n.acervo} -> ${dps.n.acervo}`);
    conf(dps.n.md5_outras === antes.n.md5_outras,
      `NENHUMA outra PC foi tocada (md5 do agregado igual)`);

    // A propria PC: o que mudou, e o que nao podia mudar.
    const a0 = alvo, d0 = dps.pcs.find(p => p.codigo_pc === PC);
    conf(d0.invalidada === true, `${PC}: invalidada = true`);
    conf(d0.invalidada_por === SUPER, `${PC}: invalidada_por = ${SUPER}`);
    conf(d0.motivo_invalidacao === MOTIVO, `${PC}: o motivo gravado e exatamente o informado`);
    conf(!!d0.invalidada_em, `${PC}: invalidada_em preenchida`);
    conf(d0.baixada === a0.baixada, `${PC}: baixada NAO foi zerada (${a0.baixada})`);
    conf(d0.status === a0.status, `${PC}: status NAO mudou (${a0.status})`);
    conf(d0.enviado_ci === a0.enviado_ci, `${PC}: enviado_ci NAO mudou`);
    conf(d0.processo_pc === a0.processo_pc, `${PC}: processo_pc NAO mudou`);

    // A trilha ganhou UMA linha, do evento certo.
    const { rows: [h] } = await pool.query(
      `SELECT COUNT(*)::int n FROM parcela_historico WHERE tr=$1 AND evento=$2`, [TR, inval.EVENTO_INVALIDAR]);
    conf(h.n === 1, `a trilha ganhou 1 linha de ${inval.EVENTO_INVALIDAR}: ${h.n}`);

    // ── 5. SE ALGO FALHOU, DESFAZ NA HORA ───────────────────────────────────
    if (mal.length) {
      log(`\n   ⛔ ${mal.length} conferencia(s) falharam — DESFAZENDO pela rota.`);
      const rv = await post(`/pc/${PC}/desinvalidar`, { usuario_id: SUPER, motivo: 'conferencia da invalidacao falhou — revertido automaticamente' });
      log(`   POST /desinvalidar → HTTP ${rv.st}`);
      const fim = await medir();
      log(`   estado devolvido: TR com ${fim.n.pcs_tr} PCs, invalidada = ${fim.pcs.find(p=>p.codigo_pc===PC).invalidada}`);
    }

    // ── 6. A REVERSAO ───────────────────────────────────────────────────────
    const modo = mal.length ? 'dry-run' : 'gravacao';
    const escrito = escreverReversao(
      modo === 'gravacao' ? REVERSAO : REVERSAO.replace('.json', '_FALHOU.json'), {
        quando: new Date().toISOString(), modo,
        script: 'invalidar_pc002840_20260903.js',
        codigo_pc: PC, tr: TR, motivo: MOTIVO, invalidada_por: SUPER,
        foto_antes: antes, foto_depois: dps,
        desfazer_pela_rota: `POST /pc/${PC}/desinvalidar  body { usuario_id: ${SUPER}, motivo: "..." }`,
        desfazer_em_sql: `UPDATE prestacoes_contas SET invalidada = false, invalidada_em = NULL,`
          + ` invalidada_por = NULL, motivo_invalidacao = NULL WHERE codigo_pc = '${PC}';`,
        conferencias_ok: ok, conferencias_falhas: mal,
      });
    log(`\n   reversao (${modo}) em ${path.basename(escrito.caminho)}`);
    if (escrito.preservou) log(`   ⚠️ preservado ${path.basename(escrito.preservou)} — ${escrito.motivo}`);

    log(`\n${'─'.repeat(78)}`);
    log(`   ${ok.length} conferencias passaram, ${mal.length} falharam.`);
    log(mal.length ? `\n   ⛔ REVERTIDO — a PC voltou a ser ativa.\n`
                   : `\n   ✅ ${PC} INVALIDADA. A TR ${TR} esta concluida.\n`);
    if (mal.length) process.exitCode = 1;
  } catch (e) {
    console.error(`\n   ⛔ ERRO: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    if (srv) srv.kill();
    try { await pool.end(); } catch (e) { log(`   (aviso: ao fechar o pool — ${e.message})`); }
  }
})();
