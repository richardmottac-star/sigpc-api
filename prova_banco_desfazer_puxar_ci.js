// CAMINHO: sigpc-api/prova_banco_desfazer_puxar_ci.js
//
// A FOTO E O DESFAZER, PROVADOS CONTRA O POSTGRES DE VERDADE.  26/08/2026.
//
//   node prova_banco_desfazer_puxar_ci.js
//
// ⚠️ SO LEITURA — tudo dentro de BEGIN/ROLLBACK, e a ultima conferencia PROVA que o rollback
// levou tudo. Nada e commitado em nenhum caminho, nem no de erro.
//
// ⚠️ E POR QUE ELE USA O SQL CRU, E NAO AS ROTAS (armadilha 11 do CLAUDE.md): as rotas
// gerenciam a propria transacao, e o COMMIT interno delas confirmaria a transacao externa
// deste arquivo — o ROLLBACK nao teria mais o que desfazer. Em 12/08 isso gravou 7 PCs e 14
// mensagens em producao num teste que parecia isolado. `SQL_FOTO`, `SQL_PUXAR_CI` e
// `SQL_RESTAURAR_FOTO` sao constantes de SQL: elas nao abrem nem fecham transacao nenhuma.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ O DEFEITO QUE ESTE ARQUIVO ACHOU, EM 26/08/2026, E QUE O DUBLE NAO ACHARIA
//
// O `timestamp` do Postgres guarda MICROSSEGUNDOS (`17:54:23.175269`); o `Date` do JavaScript
// so tem MILISSEGUNDOS (`17:54:23.175`). A primeira versao da conferencia lia a coluna em JS e
// comparava com a foto — e acusava divergencia em TODA PC cujo microssegundo nao fosse zero.
// Foram 8 falhas em 39 nesta prova. Em producao o efeito seria o pior possivel: o desfazer
// gravaria certo, a conferencia diria que nao bateu e o ROLLBACK desfaria uma restauracao
// correta. Um desfazer que nunca funciona, sem erro que aponte para a causa.
//
// A correcao: os dois lados da comparacao saem do MESMO `to_jsonb` do Postgres. Nenhuma
// conferencia do desfazer passa por um `Date`. E a mesma familia da armadilha 25.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ELE PROVA, E QUE O DUBLE NAO PROVARIA
//
//   1. o round-trip `to_jsonb` -> jsonb -> `::timestamp` devolve a data IDENTICA, ao
//      microssegundo — o duble nao tem fuso, nem `timestamp WITHOUT time zone`, nem o parser
//      de datas do `pg`;
//   2. o `SQL_RESTAURAR_FOTO` alcanca exatamente as PCs da foto;
//   3. `data_baixa` atravessa a puxada e o desfazer sem se mover;
//   4. o caso da carga historica (`2026-06-30 00:00`), que e onde o erro de FUSO apareceria
//      com mais forca: `toISOString()` a mostraria como `03:00`.

const { Pool } = require('pg');
const correcao = require('./lib/correcao');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

let ok = 0, falhou = 0;
const T = (nome, cond, extra) => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

const MARCA = 'prova de banco — ROLLBACK garantido';

// Uma PC de verdade que hoje esta puxavel, escolhida por criterio e nao por id fixo: id fixo
// envelhece e o arquivo passa a testar uma linha que ja nao existe.
const SQL_ESCOLHER = `
  SELECT codigo_pc, tr, parcial_num, setorial_id
    FROM prestacoes_contas
   WHERE enviado_ci = true AND (ci_situacao IS NULL OR ci_situacao = 'na_fila')
     AND parecer_tipo IS NOT NULL AND dt_envio_ci IS NOT NULL AND baixada = true
     AND data_baixa $CORTE$
   ORDER BY codigo_pc
   LIMIT 1`;

async function rodada(cli, rotulo, corte) {
  S(rotulo);
  const { rows: esc } = await cli.query(SQL_ESCOLHER.replace('$CORTE$', corte));
  if (!esc.length) { console.log('  (nenhuma PC nesse recorte — nada a provar aqui)'); return; }
  const pc = esc[0];
  const alvo = [pc.codigo_pc];

  // ── 1. A FOTO, antes de qualquer escrita ───────────────────────────────────
  const { rows: f } = await cli.query(correcao.SQL_FOTO, [alvo]);
  const foto = f[0].foto;
  const antes = foto?.[pc.codigo_pc];
  T('a foto saiu e tem a PC', antes != null);
  T('a foto tem as 20 colunas', Object.keys(antes).length === correcao.COLUNAS_FOTO.length,
    String(Object.keys(antes).length));
  console.log(`  PC ${pc.codigo_pc} · ${pc.tr}/${pc.parcial_num} · data_baixa ${antes.data_baixa}`);

  // ⚠️ A prova do fuso: o `to_jsonb` escreve o relogio de parede, sem `Z`. Se um dia alguem
  // trocar isto por `JSON.stringify(Date)`, este teste e o que acusa.
  T('a data na foto e o relogio de parede, sem Z',
    typeof antes.data_baixa === 'string' && !/Z$/.test(antes.data_baixa), String(antes.data_baixa));
  T('e nao esta deslocada em 3 h como o toISOString deixaria',
    !/T0[0-3]:00:00$/.test(antes.data_baixa) || /T00:00:00$/.test(antes.data_baixa), antes.data_baixa);

  const parecerAntes = antes.parecer_tipo;
  const envioAntes = antes.dt_envio_ci;

  // ── 2. A PUXADA — o UPDATE que destroi ─────────────────────────────────────
  const { rows: pux } = await cli.query(correcao.SQL_PUXAR_CI, [alvo, MARCA, 'prova']);
  T('a puxada alcancou a PC', pux.length === 1);

  const { rows: fDep } = await cli.query(correcao.SQL_FOTO, [alvo]);
  const dep = fDep[0].foto[pc.codigo_pc];
  T('e apagou o parecer, como se sabia', dep.parecer_tipo === null);
  T('e a data de envio ao C.I.', dep.dt_envio_ci === null);
  T('e derrubou a baixa', dep.baixada === false);
  // ⚠️ O ponto do Richard: a `data_baixa` NAO e apagada pela puxada — ela sobrevive intacta.
  T('MAS NAO tocou na data da baixa', dep.data_baixa === antes.data_baixa,
    `${dep.data_baixa} vs ${antes.data_baixa}`);

  // ── 3. A GUARDA — a PC esta como a puxada deixou? ──────────────────────────
  T('conferirIntacta passa logo depois da puxada',
    correcao.conferirIntacta(dep, antes) === null, String(correcao.conferirIntacta(dep, antes)));
  // E o caso da 2023PC002107: baixa refeita a mao muda a data e a guarda RECUSA.
  T('e RECUSA quando a baixa foi refeita (data_baixa diferente)',
    /a data da baixa mudou/.test(correcao.conferirIntacta({ ...dep, data_baixa: '2026-08-20T23:45:25.674' }, antes) || ''));

  // ── 4. O DESFAZER ──────────────────────────────────────────────────────────
  const { rows: rest } = await cli.query(correcao.SQL_RESTAURAR_FOTO, [JSON.stringify(foto)]);
  T('a restauracao alcancou exatamente a PC da foto', rest.length === 1);

  const { rows: f2 } = await cli.query(correcao.SQL_FOTO, [alvo]);
  const fim = f2[0].foto[pc.codigo_pc];
  const fora = correcao.conferirRestauracao(foto, f2[0].foto);
  T('conferirRestauracao: ZERO divergencias nas 20 colunas', fora.length === 0, fora.join(' | '));

  // As que o Richard nomeou, uma a uma, com o valor na frente.
  T(`parecer_tipo voltou ao valor gravado (${parecerAntes})`, fim.parecer_tipo === parecerAntes);
  // ⚠️ AO MICROSSEGUNDO, e nao ao milissegundo: e o digito que o `Date` do JS come.
  T(`dt_envio_ci voltou ao instante EXATO (${envioAntes})`, fim.dt_envio_ci === envioAntes, fim.dt_envio_ci);
  T('a baixa voltou', fim.baixada === true);
  T('estornada voltou a false', fim.estornada === false);
  T('e a data da baixa NUNCA se moveu — nem um microssegundo', fim.data_baixa === antes.data_baixa);

  // ── 5. O ciclo fecha em si mesmo ───────────────────────────────────────────
  T('a foto depois do desfazer e IDENTICA a foto de antes',
    JSON.stringify(f2[0].foto) === JSON.stringify(foto));
}

(async () => {
  const cli = await pool.connect();
  try {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  PROVA CONTRA O BANCO — foto + puxada + desfazer, tudo em ROLLBACK');
    console.log('═══════════════════════════════════════════════════════════════════');
    await cli.query('BEGIN');

    // ⚠️ Duas rodadas de proposito. A da carga historica (`2026-06-30 00:00:00`, meia-noite
    // cravada) e onde o erro de fuso gritaria: `toISOString()` a mostra como `03:00:00.000Z`.
    await rodada(cli, '1. PC COM BAIXA RECENTE (data com hora e microssegundo)', "> '2026-07-01'");
    await rodada(cli, '2. PC DA CARGA HISTORICA (2026-06-30 00:00 — o caso do fuso)', "<= '2026-07-01'");

    // ── 6. O round-trip puro, sem depender de qual PC caiu no sorteio ─────────
    S('3. O ROUND-TRIP DO TIMESTAMP, ISOLADO');
    for (const d of ['2026-06-30T00:00:00', '2026-08-21T18:40:54.458',
                     '2026-08-19T17:54:23.175269', '2026-01-01T23:59:59.999999']) {
      const { rows } = await cli.query(
        `SELECT to_jsonb(x) ->> 'd' AS ida, (($1::jsonb) ->> 'd')::timestamp = x.d AS volta
           FROM (SELECT $2::timestamp AS d) x`,
        [JSON.stringify({ d }), d]);
      T(`${d} atravessa jsonb sem se mover`, rows[0].ida === d && rows[0].volta === true,
        `ida ${rows[0].ida} volta ${rows[0].volta}`);
    }

    // ⚠️ E A PROVA DIRETA DO QUE O `Date` COME — o motivo de a conferencia nao passar por ele.
    S('4. O MICROSSEGUNDO QUE O Date DO JAVASCRIPT PERDE');
    const { rows: mic } = await cli.query(
      `SELECT '2026-08-19 17:54:23.175269'::timestamp AS d,
              to_jsonb(x) ->> 'd' AS pelo_jsonb
         FROM (SELECT '2026-08-19 17:54:23.175269'::timestamp AS d) x`);
    T('o Postgres guarda o microssegundo', mic[0].pelo_jsonb === '2026-08-19T17:54:23.175269');
    T('e o Date do pg o TRUNCA — por isso nao se compara por Date',
      correcao.textoData(mic[0].d) === '2026-08-19T17:54:23.175', correcao.textoData(mic[0].d));

    await cli.query('ROLLBACK');

    // ── 7. ⚠️ A CONFERENCIA QUE PROVA QUE NADA FICOU ─────────────────────────
    // Sem ela este arquivo seria mais uma "prova isolada" que gravou em producao — e ja
    // houve uma, em 12/08.
    S('5. O ROLLBACK LEVOU TUDO?');
    const { rows: sobra } = await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE motivo_estorno = $1`, [MARCA]);
    T('nenhuma linha de producao ficou com a marca da prova', sobra[0].n === 0, `${sobra[0].n} ficaram`);
    const { rows: hist } = await cli.query(
      `SELECT COUNT(*)::int n FROM parcela_historico WHERE evento = 'puxar_ci'`);
    T('as puxadas em producao continuam sendo 6', hist[0].n === 6, String(hist[0].n));
    const { rows: est } = await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas
        WHERE enviado_ci = true AND (ci_situacao IS NULL OR ci_situacao = 'na_fila')`);
    T('e as PCs puxaveis continuam sendo 1.421', est[0].n === 1421, String(est[0].n));
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\n  ERRO — ROLLBACK:', e.message);
    falhou++;
  } finally {
    cli.release();
    await pool.end();
    console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
    process.exitCode = falhou ? 1 : 0;
  }
})();
