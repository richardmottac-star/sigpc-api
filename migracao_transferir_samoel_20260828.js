// CAMINHO: sigpc-api/migracao_transferir_samoel_20260828.js
//
// TRANSFERIR AS 32 PCs ABERTAS DO SAMOEL (id 48) PARA O RICHARD (id 4).
// Autorizada pelo Richard em 28/08/2026. AÇÃO PONTUAL — não é rotina, e não vira rotina.
//
//   node migracao_transferir_samoel_20260828.js              (DRY-RUN — nao grava nada)
//   node migracao_transferir_samoel_20260828.js --gravar     (grava)
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE MUDA, E O QUE NAO MUDA
//
// Muda em cada uma das 32: `analista_id` -> 4, `analista_nome` -> o rotulo do id 4,
// `dt_assumida` -> agora. E uma linha em `parcela_historico` por PC.
//
// NAO muda: `dt_inicio_analise` (o prazo do estoque continua correndo desde o inicio),
// `status`, `baixada`, `enviado_ci`, `parecer_tipo`, `data_baixa`, e as quatro colunas do
// SIGEF. As 9 PCs BAIXADAS do Samoel nas mesmas TRs NAO se movem — ficam com ele, e a
// conferencia 4 prova.
//
// ⚠️ O `analista_nome` GRAVADO E "Richard", E NAO "Richard Motta Coelho". Isto NAO e desvio
// do pedido — e o pedido cumprido pela regra do sistema. `prestacoes_contas.analista_nome`
// guarda o nome CURTO, e quem traduz o nome do cadastro para ele e `assumir.nomeCurto()`, a
// mesma funcao que o `POST /tr/assumir` usa. `MAPA_NOME['Richard Motta Coelho'] = 'Richard'`,
// e o acervo do id 4 ja tem 440 PCs dizendo "Richard".
//
// Gravar "Richard Motta Coelho" cru daria ao id 4 DOIS rotulos no proprio acervo — que e
// exatamente a pendencia 6-B registrada no `SESSAO.md` hoje, sobre os ids 41, 45, 47 e 48.
// Seria criar o defeito que acabamos de documentar, no mesmo dia.
//
// ⚠️ A TRAVA DE LIMITE DE TRs E IGNORADA, por ordem expressa. O destino vai de 56 para 76 TRs
// (o limite configurado e 6). E o mesmo tratamento da aprovacao de devolucao por
// `analise_anterior`: a TR esta indo para quem vai analisa-la, e quem decidiu foi o superadmin.
//
// ⚠️ E NAO SE TOCA EM MAIS NINGUEM. Os outros seis dispensados, o cadastro de usuarios e as
// tabelas `substituicao` e `metas_analistas` ficam como estao. As conferencias 9, 11 e 12
// provam cada uma delas por md5.

const { Pool } = require('pg');
const assumir = require('./lib/assumir');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');

const DE = 48;   // Samoel
const PARA = 4;  // Richard Motta Coelho
const ESPERADAS = 32;

const MOTIVO = 'Analista dispensado em 14/05/2026 pela Portaria 95/2026. Transferência '
  + 'determinada pelo técnico do sistema para retomada da análise — 11 TRs em diligência há '
  + 'mais de três meses.';

const ARQ_REVERSAO = GRAVAR
  ? 'reverter_transferir_samoel_20260828.json'
  : 'reverter_transferir_samoel_20260828_DRYRUN.json';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const linha = (t) => console.log(t);
const passo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

let confOk = 0, confFalhou = 0;
function conferir(nome, cond, detalhe) {
  if (cond) { confOk++; linha(`   OK    ${nome}`); }
  else { confFalhou++; linha(`   FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
  return cond;
}

// ⚠️ `md5_intocaveis` cobre as colunas que esta rodada promete nao tocar, em TODAS as 14.658
// linhas — inclusive `dt_inicio_analise`, que e a que mais interessa: se ela se mover, o prazo
// do estoque reinicia e ninguem percebe olhando a tela.
// ⚠️ `md5_donos_fora` cobre o dono de TODA PC menos as 32 — e a prova de que nenhuma outra PC
// do acervo trocou de analista.
const SQL_FOTO = (codigos) => `
  SELECT
    (SELECT COUNT(*)::int FROM prestacoes_contas)                                AS n_pcs,
    (SELECT COUNT(*)::int FROM prestacoes_contas WHERE analista_id = ${DE})      AS n_samoel,
    (SELECT COUNT(*)::int FROM prestacoes_contas
      WHERE analista_id = ${DE} AND baixada IS NOT TRUE)                         AS n_samoel_aberta,
    (SELECT COUNT(*)::int FROM prestacoes_contas WHERE analista_id = ${PARA})    AS n_richard,
    (SELECT COUNT(DISTINCT tr)::int FROM prestacoes_contas
      WHERE analista_id = ${PARA})                                               AS trs_richard,
    (SELECT COUNT(*)::int FROM parcela_historico)                                AS n_hist,
    (SELECT COUNT(*)::int FROM prestacoes_contas WHERE dt_inicio_analise IS NOT NULL) AS n_com_inicio,
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), codigo_pc, status, baixada, enviado_ci, parecer_tipo, data_baixa,
                  dt_inicio_analise, data_baixa_sigef, sigef_status, sigef_registro_em,
                  sigef_declaracao, grupo, setorial_id, tr, parcial_num, tipo),
        chr(30) ORDER BY codigo_pc), '')) FROM prestacoes_contas)                AS md5_intocaveis,
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), codigo_pc, analista_id, analista_nome),
        chr(30) ORDER BY codigo_pc), ''))
       FROM prestacoes_contas WHERE NOT (codigo_pc = ANY(${codigos})))           AS md5_donos_fora,
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), id, nome, perfil, grupo, ativo, portaria, data_saida),
        chr(30) ORDER BY id), '')) FROM usuarios)                                AS md5_usuarios,
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), id, dispensado_id, substituto_id, portaria),
        chr(30) ORDER BY id), '')) FROM substituicao)                            AS md5_substituicao,
    (SELECT COUNT(*)::int FROM prestacoes_contas p
       JOIN usuarios u ON u.id = p.analista_id
      WHERE u.data_saida IS NOT NULL AND u.id <> ${DE})                          AS n_outros_dispensados`;

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha('  TRANSFERIR AS 32 PCs ABERTAS DO SAMOEL (48) PARA O RICHARD (4)');
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    await cli.query('BEGIN');

    // ── 1. QUEM SAI E QUEM ENTRA ─────────────────────────────────────────────
    passo('1. OS DOIS CADASTROS');
    const { rows: us } = await cli.query(
      `SELECT id, nome, perfil, grupo, ativo, data_saida::text FROM usuarios WHERE id = ANY($1)
        ORDER BY id`, [[DE, PARA]]);
    const uDe = us.find((u) => u.id === DE);
    const uPara = us.find((u) => u.id === PARA);
    if (!uDe || !uPara) throw new Error('um dos dois cadastros nao existe — nada foi gravado');
    // ⚠️ O rotulo sai de `assumir.nomeCurto`, a MESMA funcao do POST /tr/assumir.
    const nomeNovo = assumir.nomeCurto(uPara.nome);
    linha(`   DE   id ${uDe.id} "${uDe.nome}" · ${uDe.perfil} · grupo ${uDe.grupo}`
      + ` · data_saida ${uDe.data_saida || '—'}`);
    linha(`   PARA id ${uPara.id} "${uPara.nome}" · ${uPara.perfil} · grupo ${uPara.grupo}`);
    linha('');
    linha(`   analista_nome que sera gravado: "${nomeNovo}"`);
    linha('   ⚠️  E o nome CURTO, vindo de assumir.nomeCurto() — a mesma funcao do assumir.');
    linha(`       O acervo do id ${PARA} ja usa esse rotulo. Gravar o nome completo cru daria`);
    linha('       a ele DOIS rotulos, que e a pendencia 6-B do SESSAO.md.');
    conferir('0. o de-quem esta mesmo dispensado', !!uDe.data_saida, 'sem data_saida');

    // ── 2. AS 32, CAPTURADAS ANTES DE ESCREVER ───────────────────────────────
    passo('2. AS PCs ABERTAS DO SAMOEL');
    // ⚠️ A LISTA E CAPTURADA COM `FOR UPDATE` E VIRA CHAVE EXPLICITA (armadilha 12). O UPDATE
    // nao repete a condicao `baixada IS NOT TRUE`: se outra sessao baixasse uma delas entre a
    // leitura e a escrita, a condicao deixaria de casar e o numero de linhas mudaria em
    // silencio. Com a lista, ou escreve nas 32, ou a conferencia acusa.
    const { rows: alvo } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, tipo, status, analista_id, analista_nome,
              dt_assumida::text, dt_inicio_analise::text, setorial_id, baixada, enviado_ci,
              parecer_tipo
         FROM prestacoes_contas
        WHERE analista_id = $1 AND baixada IS NOT TRUE
        ORDER BY tr, parcial_num, codigo_pc
          FOR UPDATE`, [DE]);
    const codigos = alvo.map((p) => p.codigo_pc);
    linha(`   PCs abertas do Samoel ......... ${alvo.length}`);
    linha(`   TRs envolvidas ................ ${new Set(alvo.map((p) => p.tr)).size}`);
    linha(`   parciais ...................... ${alvo.filter((p) => p.tipo === 'parcial').length}`);
    linha(`   finais ........................ ${alvo.filter((p) => p.tipo === 'final').length}`);
    const porStatus = {};
    alvo.forEach((p) => { porStatus[p.status] = (porStatus[p.status] || 0) + 1; });
    linha(`   por status .................... ${JSON.stringify(porStatus)}`);
    conferir(`1. sao exatamente ${ESPERADAS} PCs`, alvo.length === ESPERADAS,
      `achei ${alvo.length}`);
    if (alvo.length !== ESPERADAS) throw new Error('a contagem mudou desde a medicao — nada foi gravado');
    // ⚠️ Nenhuma pode estar baixada, nem ter parecer: sao as ABERTAS.
    conferir('2. nenhuma das 32 esta baixada ou tem parecer',
      alvo.every((p) => p.baixada !== true && !p.parecer_tipo),
      JSON.stringify(alvo.filter((p) => p.baixada === true || p.parecer_tipo).map((p) => p.codigo_pc)));

    const { rows: a } = await cli.query(SQL_FOTO('$1'), [codigos]);
    const antes = a[0];
    linha('');
    linha(`   Samoel tem hoje ............... ${antes.n_samoel} PCs (${antes.n_samoel_aberta} abertas)`);
    linha(`   Richard tem hoje .............. ${antes.n_richard} PCs em ${antes.trs_richard} TRs`);
    linha(`   linhas em parcela_historico ... ${antes.n_hist}`);
    linha(`   md5 das colunas intocaveis .... ${antes.md5_intocaveis}`);
    linha(`   md5 dos donos FORA das 32 ..... ${antes.md5_donos_fora}`);

    // ── 3. A ESCRITA ─────────────────────────────────────────────────────────
    passo('3. O COMANDO');
    linha('   UPDATE prestacoes_contas');
    linha(`      SET analista_id = ${PARA}, analista_nome = '${nomeNovo}', dt_assumida = NOW()`);
    linha('    WHERE codigo_pc = ANY($1)');
    linha('');
    linha('   ⚠️  TRES colunas no SET. `dt_inicio_analise`, `status`, `baixada`, `enviado_ci`,');
    linha('       `parecer_tipo`, `data_baixa` e as do SIGEF nao aparecem.');
    const SQL_TRANSFERIR = `
      UPDATE prestacoes_contas
         SET analista_id = $2, analista_nome = $3, dt_assumida = NOW()
       WHERE codigo_pc = ANY($1)
         AND (analista_id IS DISTINCT FROM $2 OR analista_nome IS DISTINCT FROM $3)
      RETURNING codigo_pc`;
    const res = await cli.query(SQL_TRANSFERIR, [codigos, PARA, nomeNovo]);
    linha(`   PCs transferidas .............. ${res.rowCount}`);

    // ── 4. O HISTORICO ───────────────────────────────────────────────────────
    passo('4. UMA LINHA POR PC EM parcela_historico');
    // ⚠️ `analista_id` do historico e o DONO (o novo), e `executado_por` fica NULO porque o
    // dono e quem executou — e a regra de `lib/autoria.js`. Quem saiu esta em `valor_anterior`,
    // e o `estado_anterior` guarda a foto de cada PC: e por ela que se volta.
    const SQL_HIST = `
      INSERT INTO parcela_historico
        (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
         observacao, executado_por, estado_anterior)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                           $6::text[], $7::int[], $8::text[], $9::int[], $10::jsonb[])
      RETURNING id`;
    const n = alvo.length;
    const rep = (v) => Array(n).fill(v);
    const resHist = await cli.query(SQL_HIST, [
      alvo.map((p) => p.tr),
      alvo.map((p) => p.parcial_num),
      alvo.map((p) => p.setorial_id),
      rep('transferencia_dispensa'),
      alvo.map(() => `${DE} · ${uDe.nome}`),
      alvo.map(() => `${PARA} · ${nomeNovo}`),
      rep(PARA),
      alvo.map((p) => `${p.codigo_pc} — transferida de ${uDe.nome} (id ${DE}) para `
        + `${uPara.nome} (id ${PARA}). ${MOTIVO}`),
      rep(null),
      alvo.map((p) => JSON.stringify({
        codigo_pc: p.codigo_pc, analista_id: p.analista_id, analista_nome: p.analista_nome,
        dt_assumida: p.dt_assumida, dt_inicio_analise: p.dt_inicio_analise, status: p.status,
      })),
    ]);
    linha(`   linhas de historico ........... ${resHist.rowCount}`);
    linha(`   evento ........................ transferencia_dispensa`);
    linha(`   valor_anterior ................ ${DE} · ${uDe.nome}`);
    linha(`   valor_novo .................... ${PARA} · ${nomeNovo}`);
    linha(`   estado_anterior ............... a foto de cada PC (5 campos)`);

    // ── 5. CONFERENCIAS ──────────────────────────────────────────────────────
    passo('5. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO('$1'), [codigos]);
    const depois = d[0];

    conferir(`3. as ${ESPERADAS} mudaram de dono`, res.rowCount === ESPERADAS,
      `${res.rowCount} linhas`);
    conferir('4. o Samoel ficou com as 9 BAIXADAS, e so com elas',
      depois.n_samoel === antes.n_samoel - ESPERADAS && depois.n_samoel_aberta === 0,
      `${antes.n_samoel} -> ${depois.n_samoel} (abertas ${depois.n_samoel_aberta})`);
    conferir('5. o Richard ganhou exatamente 32',
      depois.n_richard === antes.n_richard + ESPERADAS,
      `${antes.n_richard} -> ${depois.n_richard}`);
    linha(`         TRs do Richard: ${antes.trs_richard} -> ${depois.trs_richard}`
      + '   (a trava de limite foi ignorada, por ordem)');

    // ⚠️ AS DUAS QUE FECHAM A PORTA.
    conferir('6. md5 das colunas INTOCAVEIS identico — status, baixada, enviado_ci, parecer_tipo, data_baixa, dt_inicio_analise, SIGEF',
      depois.md5_intocaveis === antes.md5_intocaveis,
      `${antes.md5_intocaveis} -> ${depois.md5_intocaveis}`);
    conferir('7. md5 dos donos FORA das 32 identico — nenhuma outra PC trocou de analista',
      depois.md5_donos_fora === antes.md5_donos_fora,
      `${antes.md5_donos_fora} -> ${depois.md5_donos_fora}`);
    conferir('8. dt_inicio_analise nao foi tocada em ninguem',
      depois.n_com_inicio === antes.n_com_inicio,
      `${antes.n_com_inicio} -> ${depois.n_com_inicio}`);

    const { rows: chk } = await cli.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE analista_nome = $2)::int AS com_nome,
              COUNT(*) FILTER (WHERE dt_assumida::date = CURRENT_DATE)::int AS assumida_hoje,
              COUNT(*) FILTER (WHERE analista_id = $3)::int AS do_richard
         FROM prestacoes_contas WHERE codigo_pc = ANY($1)`, [codigos, nomeNovo, PARA]);
    conferir(`9. as 32 estao com analista_id ${PARA} e analista_nome "${nomeNovo}"`,
      chk[0].do_richard === ESPERADAS && chk[0].com_nome === ESPERADAS, JSON.stringify(chk[0]));
    conferir('10. as 32 receberam dt_assumida de hoje',
      chk[0].assumida_hoje === ESPERADAS, `${chk[0].assumida_hoje} de ${ESPERADAS}`);

    conferir('11. os outros seis dispensados nao perderam PC nenhuma',
      depois.n_outros_dispensados === antes.n_outros_dispensados,
      `${antes.n_outros_dispensados} -> ${depois.n_outros_dispensados}`);
    conferir('12. usuarios e substituicao intactas',
      depois.md5_usuarios === antes.md5_usuarios
      && depois.md5_substituicao === antes.md5_substituicao,
      'md5 mudou');
    conferir('13. entraram exatamente 32 linhas de historico',
      depois.n_hist === antes.n_hist + ESPERADAS && resHist.rowCount === ESPERADAS,
      `${antes.n_hist} -> ${depois.n_hist}`);
    conferir('14. o total de PCs do sistema nao mudou',
      depois.n_pcs === antes.n_pcs, `${antes.n_pcs} -> ${depois.n_pcs}`);

    const res2 = await cli.query(SQL_TRANSFERIR, [codigos, PARA, nomeNovo]);
    conferir('15. rodar o UPDATE de novo afeta ZERO linhas (idempotente)',
      res2.rowCount === 0, `afetou ${res2.rowCount}`);

    // ── 6. REVERSAO ──────────────────────────────────────────────────────────
    passo('6. JSON DE REVERSAO');
    const reversao = {
      script: 'migracao_transferir_samoel_20260828.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 28/08/2026',
      de: { id: DE, nome: uDe.nome, data_saida: uDe.data_saida },
      para: { id: PARA, nome: uPara.nome, analista_nome_gravado: nomeNovo },
      motivo: MOTIVO,
      resumo: {
        transferidas: res.rowCount,
        linhas_historico: resHist.rowCount,
        samoel_antes: antes.n_samoel, samoel_depois: depois.n_samoel,
        richard_antes: antes.n_richard, richard_depois: depois.n_richard,
        trs_richard_antes: antes.trs_richard, trs_richard_depois: depois.trs_richard,
      },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      // ⚠️ A LISTA DAS 32 COM O ESTADO ANTERIOR DE CADA UMA — e por ela que se volta, e nunca
      // por `WHERE analista_id = 4` (armadilha 12): o Richard tem 440 PCs, e a condicao
      // derivada arrastaria as 408 que sempre foram dele.
      pcs: alvo.map((p) => ({
        codigo_pc: p.codigo_pc, tr: p.tr, parcial_num: p.parcial_num, tipo: p.tipo,
        status: p.status,
        de: { analista_id: p.analista_id, analista_nome: p.analista_nome, dt_assumida: p.dt_assumida },
        para: { analista_id: PARA, analista_nome: nomeNovo },
      })),
      reverter_com:
        `UPDATE prestacoes_contas SET analista_id = ${DE}, analista_nome = '${uDe.nome}', `
        + 'dt_assumida = v.dt::timestamp FROM (VALUES ...) AS v(codigo_pc, dt) '
        + 'WHERE prestacoes_contas.codigo_pc = v.codigo_pc  '
        + '-- monte o VALUES a partir de `pcs` deste arquivo (dt_assumida era NULL em todas)',
      aviso_reversao:
        'Reverter devolve as 32 ao Samoel, que esta DISPENSADO — e o estado de antes, nao um '
        + 'estado bom. E as 32 linhas de parcela_historico NAO se apagam: a trilha registra que '
        + 'a transferencia aconteceu, e apagar historico seria pior que manter o registro de '
        + 'algo desfeito. Abra uma linha nova dizendo que voltou.',
    };
    const escrito = escreverReversao(ARQ_REVERSAO, reversao);
    linha(`   escrito: ${escrito.caminho}`);
    linha(`   ${reversao.pcs.length} PCs com o estado anterior de cada uma`);
    if (escrito.preservou) linha(`   ⚠️  ${escrito.preservou} FOI PRESERVADO — ${escrito.motivo}.`);

    // ── 7. DESFECHO ──────────────────────────────────────────────────────────
    passo('7. DESFECHO');
    linha(`   conferencias: ${confOk} passaram · ${confFalhou} falharam`);

    if (confFalhou > 0) {
      await cli.query('ROLLBACK');
      linha('\n   X ROLLBACK — alguma conferencia falhou. Nada foi gravado.');
      process.exitCode = 1;
      return;
    }
    if (!GRAVAR) {
      await cli.query('ROLLBACK');
      linha('\n   ROLLBACK — DRY-RUN. Nada foi gravado.');
      linha('   Para gravar: node migracao_transferir_samoel_20260828.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha(`\n   OK COMMIT — ${res.rowCount} PCs transferidas, ${resHist.rowCount} linhas de historico.`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   As 32 aparecem na Minha Planilha do Richard na proxima carga da tela.');
      linha('   As 9 baixadas do Samoel continuam com ele, e a produtividade dele nao mudou.');
    }
  }
})();
