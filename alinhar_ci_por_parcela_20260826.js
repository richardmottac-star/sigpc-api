// CAMINHO: sigpc-api/alinhar_ci_por_parcela_20260826.js
//
// O CICLO DO C.I. PASSOU A SER POR PARCELA — ESTE SCRIPT PROCURA O QUE A UNIDADE ANTIGA
// DEIXOU PARA TRAS, E ALINHA O QUE PODE SER ALINHADO SEM DECIDIR REGRA.
//
// ⚠️ DRY-RUN POR PADRAO. Sem `--gravar` a transacao termina em ROLLBACK — mas a mudanca e as
// conferencias rodam antes dele.
//
// USO
//   node alinhar_ci_por_parcela_20260826.js            dry-run
//   node alinhar_ci_por_parcela_20260826.js --gravar   GRAVA
//
// ═══ O QUE ELE PROCURA ═══
//
// Enquanto `ci.decidir` gravava por `codigo_pc` e a tela mandava UMA PC por clique, nada
// impedia que duas PCs da MESMA parcela terminassem diferentes. Duas formas disso:
//
//   A) `ci_situacao` DIVERGENTE dentro da parcela — uma PC `encerrado` e a irma `na_fila`.
//      ⚠️ **ELE NAO CONSERTA ISTO, E NAO E OMISSAO.** Qual das duas decisoes vale, ou se as
//      duas valem e a parcela deve ser redecidida, e REGRA DE NEGOCIO — e regra e do Richard.
//      Escolher "a mais recente" ou "a maioria" seria decidir por ele com cara de tecnica.
//      Achou? lista, mede, e ABORTA sem gravar nada.
//
//   B) `ci_rodada` DIVERGENTE dentro da parcela, com a situacao UNIFORME. Este ele alinha,
//      e o motivo e que a rodada deixou de ser da PC: uma ida e volta ao C.I. e um evento da
//      PARCELA. `ci.gravarMensagem` le a rodada da PC, e duas rodadas na mesma parcela
//      embaralhariam a conversa na proxima volta. Alinha pelo MAIOR — a rodada conta quantas
//      idas houve, e a maior e a que viu todas.
//
// ⚠️ NAO TOCA em `baixada`, `data_baixa`, `enviado_ci`, `parecer_tipo`, `estornada`,
// `ci_tecnico_id`, `ci_tecnico_em` nem `ci_situacao`. Ha conferencia que compara as oito
// contra a foto e faz ROLLBACK se qualquer uma mudar. A produtividade tambem e conferida.
//
// ⚠️ IDEMPOTENTE: o alvo e "parcelas com rodada divergente". Depois de alinhar, nao ha mais.
//
// ⚠️ UM DRY-RUN NUNCA SOBRESCREVE A REVERSAO DE UMA GRAVACAO — a licao de 26/08, quando um
// dry-run rodado depois do `--gravar` apagou os ids da escrita real do JSON de reversao.

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = __dirname + '/reverter_alinhar_ci_parcela_20260826.json';

const INTOCADAS = ['baixada', 'data_baixa', 'enviado_ci', 'parecer_tipo', 'estornada',
                   'ci_situacao', 'ci_tecnico_id', 'ci_tecnico_em'];

let erros = 0;
const L = [];
const say = (s = '') => { console.log(s); L.push(s); };
const conf = (ok, rot, det) => { if (!ok) erros++; say(`  ${ok ? 'OK   ' : 'FALHA'}  ${rot}${ok || !det ? '' : `   [${det}]`}`); };
const iso = (v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;

  try {
    say('═'.repeat(78));
    say(`ALINHAR O CICLO DO C.I. POR PARCELA — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN (termina em ROLLBACK)'}`);
    say('═'.repeat(78));
    say('');

    await cli.query('BEGIN');

    // ══ A FOTO ════════════════════════════════════════════════════════════════
    const F = `SELECT
        COUNT(*) FILTER (WHERE ci_situacao = 'na_fila')::int      AS na_fila,
        COUNT(*) FILTER (WHERE ci_situacao = 'com_analista')::int AS com_analista,
        COUNT(*) FILTER (WHERE ci_situacao = 'encerrado')::int    AS encerrado,
        COUNT(*) FILTER (WHERE ci_situacao IS NULL)::int          AS fora,
        COUNT(*) FILTER (WHERE baixada IS TRUE OR enviado_ci IS TRUE)::int AS produtivas,
        COUNT(*) FILTER (WHERE ci_tecnico_id IS NOT NULL)::int    AS com_tecnico,
        COUNT(*)::int AS total
      FROM prestacoes_contas`;
    const foto = (await cli.query(F)).rows[0];

    // ⚠️ A CHAVE E A MESMA DE `carregarParcela` — `(setorial_id, tr, parcial_num)`. Escrever
    // uma chave "parecida" aqui mediria uma coisa e a rota faria outra.
    const SQL_DIVERGENTES = `
      SELECT setorial_id, tr, parcial_num,
             COUNT(*)::int                                          AS pcs,
             COUNT(DISTINCT ci_situacao)::int                       AS d_situacao,
             COUNT(DISTINCT ci_rodada)::int                         AS d_rodada,
             MIN(ci_rodada)::int                                    AS rodada_min,
             MAX(ci_rodada)::int                                    AS rodada_max,
             array_agg(codigo_pc ORDER BY codigo_pc)                AS codigos,
             array_agg(DISTINCT ci_situacao)                        AS situacoes,
             array_agg(codigo_pc || '=' || ci_situacao || '/r' || ci_rodada ORDER BY codigo_pc) AS detalhe
        FROM prestacoes_contas
       WHERE ci_situacao IS NOT NULL
       GROUP BY setorial_id, tr, parcial_num
      HAVING COUNT(DISTINCT ci_situacao) > 1 OR COUNT(DISTINCT ci_rodada) > 1
       ORDER BY tr, parcial_num`;
    const { rows: div } = await cli.query(SQL_DIVERGENTES);

    const porSituacao = div.filter(r => r.d_situacao > 1);
    const soRodada    = div.filter(r => r.d_situacao === 1 && r.d_rodada > 1);

    say('── A FOTO ' + '─'.repeat(66));
    say(`  acervo: na_fila ${foto.na_fila} · com_analista ${foto.com_analista} · `
      + `encerrado ${foto.encerrado} · fora ${foto.fora} · total ${foto.total}`);
    say(`  produtivas (baixada OR enviado_ci) ... ${foto.produtivas}`);
    say(`  PCs com ci_tecnico_id ................ ${foto.com_tecnico}`);
    say('');
    say(`  parcelas com ci_situacao DIVERGENTE .. ${porSituacao.length}  ← regra do Richard, NAO conserta`);
    say(`  parcelas com ci_rodada  divergente ... ${soRodada.length}  ← alinha pelo MAIOR`);
    say('');

    // ══ A) SITUACAO DIVERGENTE — mede, mostra e ABORTA ════════════════════════
    if (porSituacao.length) {
      say('⚠️  PARCELAS COM DECISOES DIFERENTES ENTRE AS PCs — nao ha conserto automatico:');
      say('');
      say('| TR | parcela | PCs | estados | detalhe |');
      say('|---|---|---|---|---|');
      for (const r of porSituacao)
        say(`| ${r.tr} | ${r.parcial_num} | ${r.pcs} | ${r.situacoes.join(' × ')} | ${r.detalhe.join(' · ')} |`);
      say('');
      say('Qual decisao vale — ou se a parcela deve ser redecidida — e REGRA, e regra e do');
      say('Richard. Escolher "a mais recente" ou "a maioria" seria decidir por ele.');
      throw new Error(`${porSituacao.length} parcela(s) com ci_situacao divergente. Nada foi gravado.`);
    }

    // ══ B) RODADA DIVERGENTE — alinha pelo maior ══════════════════════════════
    if (!soRodada.length) {
      say('NADA A FAZER — nenhuma parcela tem ci_situacao nem ci_rodada divergente entre as');
      say('suas PCs. O ciclo do C.I. ja esta consistente por parcela.');
      say('');
      say('(E o que se espera: ate 26/08 o C.I. decidiu 5 PCs pela tela, e as 1.7xx encerradas');
      say(' vieram todas da carga de 16/08, que carimbou o mesmo valor em bloco. A unidade');
      say(' errada existiu, mas quase nao foi usada — a janela fechou antes de o dano ocorrer.)');
      await cli.query('ROLLBACK');
      say('');
      say('ROLLBACK. Nada foi gravado.');
      return;
    }

    say('── O QUE MUDA ' + '─'.repeat(62));
    say('');
    say('| TR | parcela | PCs | rodadas | vira |');
    say('|---|---|---|---|---|');
    for (const r of soRodada)
      say(`| ${r.tr} | ${r.parcial_num} | ${r.pcs} | ${r.rodada_min}..${r.rodada_max} | ${r.rodada_max} |`);
    say('');

    // A foto PC a PC do que vai mudar — a reversao precisa do valor de cada uma.
    const alvoCods = soRodada.flatMap(r => r.codigos);
    const { rows: antes } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, setorial_id, ci_rodada,
              ${INTOCADAS.join(', ')}
         FROM prestacoes_contas WHERE codigo_pc = ANY($1) ORDER BY codigo_pc FOR UPDATE`,
      [alvoCods]);

    // ⚠️ POR LISTA EXPLICITA DE CHAVES (armadilha 12) — nunca por condicao derivada.
    let mudadas = [];
    for (const r of soRodada) {
      const { rows } = await cli.query(
        `UPDATE prestacoes_contas SET ci_rodada = $2::int, atualizado_em = NOW()
          WHERE codigo_pc = ANY($1) AND ci_rodada <> $2::int
          RETURNING codigo_pc, ci_rodada`, [r.codigos, r.rodada_max]);
      mudadas = mudadas.concat(rows);
    }

    // ══ CONFERENCIAS — contra a foto ══════════════════════════════════════════
    say('── CONFERENCIAS (contra a foto, dentro da mesma transacao) ' + '─'.repeat(18));
    const { rows: depois } = await cli.query(
      `SELECT codigo_pc, ci_rodada, ${INTOCADAS.join(', ')}
         FROM prestacoes_contas WHERE codigo_pc = ANY($1) ORDER BY codigo_pc`, [alvoCods]);
    const mapa = new Map(depois.map(r => [r.codigo_pc, r]));

    conf(depois.length === antes.length, 'nenhuma PC do alvo sumiu nem se multiplicou');
    const esperado = antes.filter(a => {
      const r = soRodada.find(x => x.codigos.includes(a.codigo_pc));
      return a.ci_rodada !== r.rodada_max;
    }).length;
    conf(mudadas.length === esperado,
         `o UPDATE alcancou exatamente as ${esperado} PCs previstas`, `mudou ${mudadas.length}`);

    let mau = [];
    for (const a of antes) {
      const d = mapa.get(a.codigo_pc);
      const r = soRodada.find(x => x.codigos.includes(a.codigo_pc));
      if (d.ci_rodada !== r.rodada_max) mau.push(`${a.codigo_pc}: rodada ${d.ci_rodada} ≠ ${r.rodada_max}`);
      for (const c of INTOCADAS) if (iso(a[c]) !== iso(d[c]))
        mau.push(`${a.codigo_pc}.${c}: ${iso(a[c])} → ${iso(d[c])}`);
    }
    conf(!mau.some(m => /rodada/.test(m)), 'toda PC do alvo ficou com a rodada MAIOR da parcela',
         mau.filter(m => /rodada/.test(m)).slice(0, 3).join(' · '));
    conf(!mau.some(m => !/: rodada/.test(m)),
         `as ${INTOCADAS.length} colunas intocadas ficaram IDENTICAS a foto`,
         mau.filter(m => !/: rodada/.test(m)).slice(0, 3).join(' · '));

    const cont = (await cli.query(F)).rows[0];
    for (const k of ['na_fila', 'com_analista', 'encerrado', 'fora', 'total', 'com_tecnico'])
      conf(cont[k] === foto[k], `${k} nao mudou`, `${foto[k]} → ${cont[k]}`);
    conf(cont.produtivas === foto.produtivas, 'PRODUTIVIDADE INTACTA',
         `${foto.produtivas} → ${cont.produtivas}`);

    const { rows: sobra } = await cli.query(SQL_DIVERGENTES);
    conf(sobra.length === 0, 'nao sobrou parcela divergente — e o que torna o script idempotente',
         `${sobra.length}`);

    say('');
    say(`  ${erros === 0 ? 'TODAS as conferencias passaram.' : `*** ${erros} FALHARAM ***`}`);
    say('');

    // ══ REVERSAO — e o dry-run nao encosta na da gravacao ═════════════════════
    const destino = (GRAVAR && erros === 0) ? REVERSAO : REVERSAO.replace(/\.json$/, '_DRYRUN.json');
    if (!GRAVAR && fs.existsSync(REVERSAO)) {
      try {
        if (JSON.parse(fs.readFileSync(REVERSAO, 'utf8')).gravado === true)
          say(`⚠️ ${REVERSAO.split(/[\\/]/).pop()} e de uma GRAVACAO — preservado, intocado.`);
      } catch (_) {}
    }
    fs.writeFileSync(destino, JSON.stringify({
      gerado_em: new Date().toISOString(),
      script: 'alinhar_ci_por_parcela_20260826.js',
      gravado: GRAVAR && erros === 0,
      como_reverter: 'UPDATE prestacoes_contas SET ci_rodada = $rodada_antes WHERE codigo_pc = $codigo_pc',
      pcs: antes.map(a => ({
        codigo_pc: a.codigo_pc, tr: a.tr, parcial_num: a.parcial_num,
        ci_rodada_antes: a.ci_rodada,
        ci_rodada_depois: soRodada.find(x => x.codigos.includes(a.codigo_pc)).rodada_max,
        intocadas: Object.fromEntries(INTOCADAS.map(c => [c, iso(a[c])])),
      })),
      contagens_antes: foto,
    }, null, 2), 'utf8');
    say(`Reversao gravada em ${destino}`);

    if (erros > 0) {
      await cli.query('ROLLBACK');
      say('');
      say('*** ROLLBACK — uma conferencia falhou. NADA foi gravado. ***');
      process.exitCode = 1;
    } else if (GRAVAR) {
      await cli.query('COMMIT');
      commitou = true;
      say('');
      say(`*** COMMIT — ${mudadas.length} PCs alinhadas em ${soRodada.length} parcelas. ***`);
    } else {
      await cli.query('ROLLBACK');
      say('');
      say('ROLLBACK — DRY-RUN. Para gravar:  node alinhar_ci_por_parcela_20260826.js --gravar');
    }
  } catch (e) {
    if (!commitou) { try { await cli.query('ROLLBACK'); } catch (_) {} }
    say('');
    say(`*** ${e.message}`);
    say('*** ROLLBACK. Nada foi gravado.');
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    fs.writeFileSync(__dirname + '/ALINHAR_CI_PARCELA_DRYRUN.md', L.join('\n'), 'utf8');
  }
})();
