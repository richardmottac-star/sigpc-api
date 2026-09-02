// CAMINHO: sigpc-api/limpar_lixo_teste_20260902.js
//
// APAGA AS DUAS LINHAS DE AUDITORIA QUE O TESTE DA FASE 3 DEIXOU.
// PADRAO = DRY-RUN. So apaga com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ACONTECEU
//
// A primeira versao do `teste_invalidar_20260902.js` tinha um caso — "motivo no limite (15)"
// — que batia em `POST /pc/:codigo_pc/invalidar` com SUPERADMIN e motivo valido. A rota
// gerencia a propria transacao e fez COMMIT: invalidou a PC de verdade. O teste desfez na
// hora pela propria rota, mas as DUAS linhas de trilha ficaram, com o nome do Richard e o
// motivo `aaaaaaaaaaaaaaa`.
//
// E a armadilha 11 do CLAUDE.md, na forma que o proprio cabecalho daquele teste descrevia e
// que o codigo nao seguiu: o COMMIT da rota confirma a transacao, e o ROLLBACK do teste nao
// tem mais o que desfazer. O teste ja foi corrigido — o caso do limite usa a ANALISTA, e o
// 403 prova que o motivo passou sem conceder escrita.
//
// ⚠️ A PC NAO PRECISA DE CONSERTO. `2021PC002840` esta com `invalidada = false`, as quatro
// colunas nulas, `baixada` e `status` intactos. O que sobrou e lixo na trilha, so isso.
//
// ⚠️ O ALVO E POR LISTA EXPLICITA DE ID (regra 12 do CLAUDE.md), e cada id tem de casar com a
// DESCRICAO antes de qualquer escrita. Apagar por condicao derivada — "todo evento
// pc_invalidada" — apagaria uma invalidacao de verdade no dia em que houver uma.
//
// USO
//   node limpar_lixo_teste_20260902.js            dry-run: confere e faz ROLLBACK
//   node limpar_lixo_teste_20260902.js --gravar   idem, com COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');
const inval = require('./lib/invalidada');

const GRAVAR = process.argv.includes('--gravar');
const IDS = [2544, 2545];
const PC = '2021PC002840';
const TR = '2021TR002375';
const MARCA = 'aaaaaaaaaaaaaaa';
// ⚠️ 1, E NAO 3 — e a primeira versao deste script trazia 3, que a conferencia recusou.
//
// O "3 linhas" que eu reportei como foto da trilha veio do teste da fase 3, e aquela foto foi
// tirada DEPOIS de o lixo ja existir: a parte A gravou as duas linhas antes de a parte B
// medir. A trilha de verdade desta TR e UMA linha — id 701, evento `processo_pc`, de
// 14/08/2026, quando o `-1` virou `SCC 19273/2022`.
//
// A licao e a armadilha 21 do CLAUDE.md com outra roupa: foto tirada no meio da rodada mede o
// que a rodada ja fez. E foi a propria conferencia que pegou — se ela comparasse com "3"
// cegamente, o DELETE teria passado com a trilha em 1 e ninguem veria.
const HIST_ESPERADO = 1;   // id 701, `processo_pc`, 14/08/2026 — a unica linha real da TR
const REVERSAO = path.join(__dirname, 'reverter_lixo_teste_20260902.json');

const log = (s) => console.log(s);

(async () => {
  log(`\n${'═'.repeat(78)}`);
  log(` LIMPEZA — as 2 linhas de trilha do teste da fase 3   ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (ROLLBACK no fim)'}`);
  log(`${'═'.repeat(78)}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  const ok = [], mal = [];
  const conf = (c, m) => { (c ? ok : mal).push(m); log(`   ${c ? '✓' : '✗'} ${m}`); };

  try {
    await cli.query('BEGIN');

    // ── 1. O ALVO, TRAVADO ───────────────────────────────────────────────────
    const { rows: alvo } = await cli.query(
      `SELECT id, tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo,
              analista_id, executado_por, observacao, estado_anterior,
              to_char(criado_em, 'YYYY-MM-DD HH24:MI:SS') AS quando
         FROM parcela_historico WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [IDS]);

    log(`\n── 1. AS LINHAS ALVO ─────────────────────────────────────────────────────`);
    alvo.forEach(r => {
      log(`   id ${r.id} · ${r.evento} · ${r.tr} parcela ${r.parcial_num} · ${r.quando}`);
      log(`      ${String(r.observacao || '').slice(0, 108)}`);
    });
    if (!alvo.length) log(`   (nenhuma das ids ${IDS.join(', ')} existe — talvez ja tenham sido apagadas)`);

    // ── 2. CADA UMA TEM DE CASAR COM A DESCRICAO ────────────────────────────
    log(`\n── 2. CONFERENCIA ANTES DE APAGAR ────────────────────────────────────────`);
    conf(alvo.length === IDS.length, `as ${IDS.length} ids existem: achadas ${alvo.length}`);

    const EVENTOS = [inval.EVENTO_INVALIDAR, inval.EVENTO_DESFAZER];
    for (const r of alvo) {
      const obs = String(r.observacao || '');
      conf(EVENTOS.includes(r.evento), `id ${r.id}: evento e de invalidacao (${r.evento})`);
      conf(obs.includes(PC), `id ${r.id}: a observacao cita a PC ${PC}`);
      // ⚠️ A MARCA ESTA NAS DUAS: na primeira como motivo, na segunda como "motivo anterior".
      // E ela que distingue o lixo do teste de uma invalidacao de verdade.
      conf(obs.includes(MARCA), `id ${r.id}: a observacao carrega a marca "${MARCA}"`);
      conf(r.tr === TR, `id ${r.id}: e da TR ${TR}`);
    }

    // ⚠️ E NAO PODE HAVER OUTRO evento de invalidacao no banco: se houver, alguem invalidou
    // de verdade e este script nao e mais seguro — a lista de ids deixaria de cobrir o caso.
    const { rows: [tot] } = await cli.query(
      `SELECT COUNT(*)::int n FROM parcela_historico WHERE evento = ANY($1)`, [EVENTOS]);
    conf(tot.n === IDS.length,
      `nao ha outro evento de invalidacao no banco: ${tot.n} no total, esperado ${IDS.length}`);

    const { rows: [antes] } = await cli.query(
      `SELECT (SELECT COUNT(*)::int FROM parcela_historico WHERE tr = $1)   AS hist_tr,
              (SELECT COUNT(*)::int FROM parcela_historico)                 AS hist_total,
              (SELECT COUNT(*) FILTER (WHERE invalidada)::int
                 FROM prestacoes_contas)                                    AS invalidadas`, [TR]);
    log(`   · trilha da TR ${TR}: ${antes.hist_tr} linhas (esperado voltar a ${HIST_ESPERADO})`);

    if (mal.length) {
      await cli.query('ROLLBACK');
      log(`\n   ⛔ ALGUMA LINHA NAO BATE COM A DESCRICAO — ROLLBACK. Nada foi apagado.`);
      log(`      Confira as linhas acima antes de rodar de novo.\n`);
      cli.release(); await pool.end(); process.exit(1);
    }

    // ── 3. O DELETE, POR LISTA EXPLICITA ────────────────────────────────────
    log(`\n── 3. DELETE ─────────────────────────────────────────────────────────────`);
    const del = await cli.query(`DELETE FROM parcela_historico WHERE id = ANY($1)`, [IDS]);
    log(`   DELETE FROM parcela_historico WHERE id = ANY('{${IDS.join(',')}}')  ->  ${del.rowCount} linha(s)`);

    // ── 4. CONFERENCIA DEPOIS ───────────────────────────────────────────────
    log(`\n── 4. CONFERENCIA DEPOIS DE APAGAR ───────────────────────────────────────`);
    const { rows: [dps] } = await cli.query(
      `SELECT (SELECT COUNT(*)::int FROM parcela_historico WHERE tr = $1)        AS hist_tr,
              (SELECT COUNT(*)::int FROM parcela_historico)                      AS hist_total,
              (SELECT COUNT(*)::int FROM parcela_historico WHERE evento = ANY($2)) AS eventos,
              (SELECT COUNT(*) FILTER (WHERE invalidada)::int
                 FROM prestacoes_contas)                                         AS invalidadas`,
      [TR, EVENTOS]);
    const { rows: [pc] } = await cli.query(
      `SELECT invalidada, invalidada_em, invalidada_por, motivo_invalidacao, baixada, status
         FROM prestacoes_contas WHERE codigo_pc = $1`, [PC]);

    conf(del.rowCount === IDS.length, `apagou exatamente ${IDS.length}: ${del.rowCount}`);
    conf(dps.hist_tr === HIST_ESPERADO,
      `a trilha da TR ${TR} voltou a ${HIST_ESPERADO} linhas: ${antes.hist_tr} -> ${dps.hist_tr}`);
    conf(dps.hist_total === antes.hist_total - IDS.length,
      `a trilha inteira caiu exatamente ${IDS.length}: ${antes.hist_total} -> ${dps.hist_total}`);
    conf(dps.eventos === 0, `nenhum evento de invalidacao restou: ${dps.eventos}`);
    conf(dps.invalidadas === antes.invalidadas && dps.invalidadas === 0,
      `nenhuma PC invalidada, antes e depois: ${antes.invalidadas} -> ${dps.invalidadas}`);
    conf(pc.invalidada === false && pc.invalidada_em === null && pc.invalidada_por === null
      && pc.motivo_invalidacao === null,
      `a PC ${PC} segue limpa: as quatro colunas nulas`);
    conf(pc.baixada === false && pc.status === 'livre',
      `e intacta no resto: baixada ${pc.baixada}, status ${pc.status}`);

    // ⚠️ A REVERSAO GUARDA AS LINHAS INTEIRAS, e nao so os ids: DELETE nao tem "valor
    // anterior" para reler depois. Sem isto o caminho de volta seria reconstruir a mao.
    const modo = (GRAVAR && !mal.length) ? 'gravacao' : 'dry-run';
    const escrito = escreverReversao(
      modo === 'gravacao' ? REVERSAO : REVERSAO.replace('.json', '_DRYRUN.json'), {
        quando: new Date().toISOString(),
        modo,
        script: 'limpar_lixo_teste_20260902.js',
        motivo: 'lixo do teste da fase 3 — a rota fez COMMIT proprio e o ROLLBACK do teste nao alcancou',
        ids_apagados: IDS,
        linhas: alvo,
        desfazer: alvo.map(r =>
          `INSERT INTO parcela_historico (id, tr, parcial_num, setorial_id, evento, valor_anterior,`
          + ` valor_novo, analista_id, executado_por, observacao) VALUES (${r.id}, `
          + [r.tr, r.parcial_num, r.setorial_id, r.evento, r.valor_anterior, r.valor_novo].map(
              v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`).join(', ')
          + `, ${r.analista_id ?? 'NULL'}, ${r.executado_por ?? 'NULL'}, `
          + `'${String(r.observacao || '').replace(/'/g, "''")}');`),
        conferencias_ok: ok,
        conferencias_falhas: mal,
      });
    log(`\n   reversao (${modo}) em ${path.basename(escrito.caminho)}`);
    if (escrito.preservou) log(`   ⚠️ preservado ${path.basename(escrito.preservou)} — ${escrito.motivo}`);

    if (mal.length) {
      await cli.query('ROLLBACK');
      log(`\n   ⛔ CONFERENCIA FALHOU — ROLLBACK. Nada foi apagado.\n`);
      cli.release(); await pool.end(); process.exit(1);
    }
    if (GRAVAR) {
      await cli.query('COMMIT');
      log(`\n   ✅ COMMIT — ${del.rowCount} linha(s) apagada(s). A trilha da TR voltou a ${dps.hist_tr}.\n`);
    } else {
      await cli.query('ROLLBACK');
      log(`\n   ↩ ROLLBACK (dry-run). NADA foi apagado.`);
      log(`   para apagar: node limpar_lixo_teste_20260902.js --gravar\n`);
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error(`\n   ⛔ ERRO — ROLLBACK. Nada foi apagado.\n   ${e.message}\n`);
    cli.release(); await pool.end(); process.exit(1);
  }
  cli.release(); await pool.end();
})();
