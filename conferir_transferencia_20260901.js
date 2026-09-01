// CAMINHO: sigpc-api/conferir_transferencia_20260901.js
//
// AS SEIS CONFERÊNCIAS DA ROTA DE TRANSFERÊNCIA, contra o Postgres de verdade.
//
// ⚠️ TUDO DENTRO DE UM `BEGIN ... ROLLBACK`, E NADA É COMMITADO. Este script exercita o SQL
// REAL da rota — as mesmas constantes de `lib/transferencia.js`, os mesmos parâmetros — mas a
// transação inteira é desfeita no fim. Rodar isto NÃO transfere nada em produção.
//
// ⚠️ E É ASSIM POR CAUSA DA ARMADILHA 11, que custou caro em 12/08/2026: "NUNCA testar contra
// o banco real uma função que gerencia a própria transação — o COMMIT interno dela confirma a
// transação externa, e o ROLLBACK do teste não tem mais o que desfazer". Naquele dia isso
// gravou 7 PCs como `encerrado` e 14 mensagens em produção, num teste que parecia isolado.
//
// A rota `POST /transferencia` gerencia a própria transação. Chamá-la aqui e "desfazer no
// fim" seria repetir aquele erro: o desfazer seria uma SEGUNDA escrita, não um rollback, e
// entre uma e outra o acervo de um analista real teria mudado de dono em produção com a
// equipe trabalhando. O CLAUDE.md dá a saída, e é a que este script toma: "ou se testa a
// função com dublê de banco, ou se testa o SQL cru dentro de BEGIN/ROLLBACK — nunca as duas
// coisas misturadas". O dublê está em `teste_transferencia.js`; o SQL cru está aqui.
//
// USO: node conferir_transferencia_20260901.js

const { Pool } = require('pg');
const transf = require('./lib/transferencia');
const assumir = require('./lib/assumir');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

const SETORIAL = 'FCEE';
let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    // ── O ALVO, escolhido pelo que ele prova ─────────────────────────────────
    // Uma TR com PC aberta E PC baixada na mesma TR — é a única forma de provar, na mesma
    // linha de teste, que as abertas se movem e as baixadas não.
    const { rows: cand } = await cli.query(`
      SELECT p.tr, p.analista_id, MAX(u.nome) nome,
             count(*) FILTER (WHERE NOT p.baixada)::int abertas,
             count(*) FILTER (WHERE p.baixada)::int baixadas
        FROM prestacoes_contas p JOIN usuarios u ON u.id = p.analista_id
       WHERE p.setorial_id = $1
       GROUP BY p.tr, p.analista_id
      HAVING count(*) FILTER (WHERE NOT p.baixada) > 0 AND count(*) FILTER (WHERE p.baixada) > 0
       ORDER BY count(*) FILTER (WHERE NOT p.baixada) ASC, p.tr
       LIMIT 1`, [SETORIAL]);
    if (!cand.length) throw new Error('não achei TR com aberta e baixada juntas');
    const alvo = cand[0];

    const { rows: destino } = await cli.query(`
      SELECT id, nome FROM usuarios
       WHERE perfil = 'analista' AND ativo AND data_saida IS NULL AND id <> $1
       ORDER BY id LIMIT 1`, [alvo.analista_id]);
    if (!destino.length) throw new Error('não achei analista ativo de destino');
    const PARA = destino[0];
    const EXECUTOR = 4;   // o superadmin, para o `executado_por`

    console.log(`\nALVO: ${alvo.tr} — de ${alvo.nome} (id ${alvo.analista_id}) para ${PARA.nome} (id ${PARA.id})`);
    console.log(`      ${alvo.abertas} aberta(s) · ${alvo.baixadas} baixada(s)`);

    // ── 5 (parte 1). O acervo ANTES ──────────────────────────────────────────
    const totalAntes = (await cli.query(`SELECT count(*)::int n FROM prestacoes_contas`)).rows[0].n;
    const histAntes = (await cli.query(
      `SELECT count(*)::int n FROM parcela_historico WHERE evento = $1`, [transf.EVENTO])).rows[0].n;

    await cli.query('BEGIN');

    // ── A MESMA SEQUÊNCIA DA ROTA, com o SQL da mesma lib ────────────────────
    const trs = transf.trsLimpas([alvo.tr]);
    const { rows: foto } = await cli.query(transf.SQL_FOTO, [SETORIAL, trs]);
    const previstas = transf.pcsQueMovem(foto, alvo.analista_id);
    const ficam = transf.pcsQueFicam(foto, alvo.analista_id);

    // ⚠️ ESTA CONFERÊNCIA RODA ANTES DO UPDATE, e a ordem não é estilo — é a correção de um
    // defeito deste próprio script, pego na primeira execução. Medida DEPOIS, ela reprovava
    // as duas TRs: o UPDATE já tinha movido a aberta do alvo, então nem a TR dele "pertencia"
    // mais ao `de_id`. A recusa por TR alheia é uma pergunta sobre o estado de ANTES, e é
    // nesse estado que a rota também a faz — antes de escrever qualquer coisa.
    S('3. TR DE OUTRO ANALISTA É RECUSADA, COM A LISTA');
    const { rows: deOutro } = await cli.query(`
      SELECT tr FROM prestacoes_contas
       WHERE setorial_id = $1 AND NOT baixada AND analista_id IS NOT NULL AND analista_id <> $2
       LIMIT 1`, [SETORIAL, alvo.analista_id]);
    const trAlheia = deOutro.length ? deOutro[0].tr : null;
    if (trAlheia) {
      const pedidas = transf.trsLimpas([alvo.tr, trAlheia]);
      const { rows: fotoMista } = await cli.query(transf.SQL_FOTO, [SETORIAL, pedidas]);
      const alheias = transf.trsAlheias(pedidas, fotoMista, alvo.analista_id);
      conf(alheias.length === 1 && alheias[0] === trAlheia,
           `a ${trAlheia} é recusada, e a lista diz qual`, alheias.join(', '));
      conf(!alheias.includes(alvo.tr), `e a ${alvo.tr}, que é dele, não entra na recusa`);
    } else { conf(false, 'não achei TR de outro analista para o teste'); }

    const { rows: movidas } = await cli.query(transf.SQL_MOVER,
      [SETORIAL, trs, alvo.analista_id, PARA.id, assumir.nomeCurto(PARA.nome)]);

    const { rowCount: nHist } = await cli.query(transf.SQL_HIST, transf.paramsHistorico({
      movidas, foto, deId: alvo.analista_id, paraId: PARA.id,
      deNome: alvo.nome, paraNome: PARA.nome, usuarioId: EXECUTOR,
      motivo: 'Conferência automática — esta transação será desfeita.',
    }));

    const { rows: depois } = await cli.query(transf.SQL_FOTO, [SETORIAL, trs]);

    S('1. AS ABERTAS MUDARAM DE DONO, AS BAIXADAS NÃO');
    const porCod = new Map(depois.map((l) => [l.codigo_pc, l]));
    const abertasOk = previstas.every((a) => (porCod.get(a.codigo_pc) || {}).analista_id === PARA.id);
    conf(abertasOk, `as ${previstas.length} abertas estão com o id ${PARA.id}`,
         previstas.map((a) => a.codigo_pc).join(', '));
    const baixadasOk = ficam.every((a) => (porCod.get(a.codigo_pc) || {}).analista_id === alvo.analista_id);
    conf(baixadasOk, `e as ${ficam.length} baixadas continuam com o id ${alvo.analista_id}`,
         ficam.map((a) => a.codigo_pc).join(', '));
    // ⚠️ A PRODUTIVIDADE É A PC BAIXADA. Esta é a checagem que protege o número de quem saiu.
    conf(ficam.every((a) => (porCod.get(a.codigo_pc) || {}).baixada === true),
         'e continuam baixadas — a produtividade não se moveu');

    S('2. A TR MUDOU DE DONO');
    // ⚠️ NÃO HÁ TABELA DE TR: o dono da TR é derivado do `analista_id` das PCs abertas dela.
    // Mover as abertas É mover a TR — e é isto que esta conferência mede.
    const donosAbertas = [...new Set(depois.filter((l) => !l.baixada).map((l) => l.analista_id))];
    conf(donosAbertas.length === 1 && donosAbertas[0] === PARA.id,
         `as PCs abertas da ${alvo.tr} têm um dono só, e é o novo`, donosAbertas.join(', '));

    S('4. para_id IGUAL AO de_id É RECUSADO');
    // ⚠️ Sem esta recusa o UPDATE rodaria contra ele mesmo, gravaria histórico de uma
    // transferência que não aconteceu, e devolveria "N PCs transferidas" com todas paradas
    // no mesmo lugar — um sucesso mentiroso.
    conf(transf.validar({ de_id: 40, para_id: 40, trs: ['X'], usuario_id: 4 }) !== null,
         'o mesmo id nas duas pontas é recusado',
         transf.validar({ de_id: 40, para_id: 40, trs: ['X'], usuario_id: 4 }));
    conf(transf.validar({ de_id: 40, para_id: 41, trs: ['X'], usuario_id: 4 }) === null,
         'e ids diferentes passam');

    S('5. O ACERVO NÃO MUDOU DE TAMANHO');
    const totalDepois = (await cli.query(`SELECT count(*)::int n FROM prestacoes_contas`)).rows[0].n;
    conf(totalDepois === totalAntes, `${totalAntes} PCs antes e ${totalDepois} depois`,
         totalAntes === totalDepois ? null : `${totalAntes} -> ${totalDepois}`);
    conf(foto.length === depois.length, 'e as TRs tocadas têm as mesmas linhas', `${foto.length}`);

    S('6. O HISTÓRICO: UMA LINHA POR PC MOVIDA, COM executado_por');
    conf(nHist === movidas.length, `${nHist} linhas para ${movidas.length} PCs movidas`);
    const { rows: h } = await cli.query(`
      SELECT evento, valor_anterior, valor_novo, analista_id, executado_por,
             estado_anterior IS NOT NULL AS tem_foto
        FROM parcela_historico WHERE evento = $1 AND executado_por = $2
       ORDER BY id DESC LIMIT $3`, [transf.EVENTO, EXECUTOR, movidas.length]);
    conf(h.length === movidas.length, 'e todas são recuperáveis pelo evento', h.length);
    conf(h.every((x) => x.executado_por === EXECUTOR), 'executado_por preenchido em todas');
    conf(h.every((x) => x.analista_id === PARA.id), 'e o analista_id do histórico é o NOVO dono');
    conf(h.every((x) => x.valor_anterior === transf.rotulo(alvo.analista_id, alvo.nome)),
         'valor_anterior traz quem saiu', h[0] && h[0].valor_anterior);
    conf(h.every((x) => x.valor_novo === transf.rotulo(PARA.id, PARA.nome)),
         'valor_novo traz quem recebeu', h[0] && h[0].valor_novo);
    // ⚠️ `estado_anterior` É O QUE PERMITE DESFAZER. Sem ela a transferência é de mão única.
    conf(h.every((x) => x.tem_foto), 'e cada linha guarda a foto da PC, por onde se desfaz');

    S('7. AS CONFERÊNCIAS DA PRÓPRIA ROTA, contra a foto');
    const problemas = transf.conferir({ foto, depois, movidas, deId: alvo.analista_id, paraId: PARA.id });
    conf(problemas.length === 0, 'a `conferir` da lib não achou problema', problemas.join(' | '));

    S('8. O QUE A ROTA NÃO PODE TOCAR');
    // ⚠️ ORDEM DO RICHARD: `situacao_atual`, `ci_*`, `eng_*` e `sigef_declaracao` ficam como
    // estavam. Medido contra a foto, coluna a coluna, nas linhas movidas.
    const { rows: intactas } = await cli.query(`
      SELECT count(*)::int n FROM prestacoes_contas
       WHERE setorial_id = $1 AND tr = ANY($2::text[])`, [SETORIAL, trs]);
    conf(intactas[0].n === foto.length, 'nenhuma linha a mais ou a menos nas TRs tocadas');
    const naoToca = ['situacao_atual', 'ci_situacao', 'ci_rodada', 'ci_encerrado_em',
      'ci_tecnico_id', 'eng_situacao', 'eng_enviada_em', 'eng_retorno_em', 'sigef_declaracao',
      'dt_inicio_analise', 'baixada', 'data_baixa', 'parecer_tipo', 'enviado_ci'];
    conf(!naoToca.some((c) => new RegExp('\\b' + c + '\\s*=').test(transf.SQL_MOVER)),
         'e o UPDATE não menciona nenhuma delas',
         naoToca.filter((c) => new RegExp('\\b' + c + '\\s*=').test(transf.SQL_MOVER)).join(', '));

    // ── O DESFAZER ───────────────────────────────────────────────────────────
    await cli.query('ROLLBACK');
    console.log('\n── ROLLBACK dado. Nada foi gravado.');

    S('9. E O BANCO VOLTOU AO QUE ERA');
    const totalFim = (await cli.query(`SELECT count(*)::int n FROM prestacoes_contas`)).rows[0].n;
    conf(totalFim === totalAntes, `${totalFim} PCs, as mesmas do começo`);
    const { rows: donoFim } = await cli.query(
      `SELECT DISTINCT analista_id FROM prestacoes_contas
        WHERE setorial_id = $1 AND tr = $2 AND NOT baixada`, [SETORIAL, alvo.tr]);
    conf(donoFim.length === 1 && donoFim[0].analista_id === alvo.analista_id,
         `a ${alvo.tr} voltou para ${alvo.nome}`, donoFim.map((x) => x.analista_id).join(', '));
    const histFim = (await cli.query(
      `SELECT count(*)::int n FROM parcela_historico WHERE evento = $1`, [transf.EVENTO])).rows[0].n;
    conf(histFim === histAntes, `e o histórico tem as mesmas ${histAntes} linhas de '${transf.EVENTO}'`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO: ' + e.message);
    falhou++;
  } finally {
    cli.release();
    await pool.end();
  }
  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
  console.log(commitou ? 'ATENÇÃO: houve COMMIT.' : 'Nada foi gravado — a transação foi desfeita.');
  process.exit(falhou ? 1 : 0);
})();
