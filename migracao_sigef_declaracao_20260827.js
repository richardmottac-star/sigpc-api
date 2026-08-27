// CAMINHO: sigpc-api/migracao_sigef_declaracao_20260827.js
//
// A DECLARAÇÃO DO ANALISTA — coluna `prestacoes_contas.sigef_declaracao jsonb`.
// Autorizada pelo Richard em 27/08/2026.
//
//   node migracao_sigef_declaracao_20260827.js              (DRY-RUN — nao grava nada)
//   node migracao_sigef_declaracao_20260827.js --gravar     (grava)
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTA COLUNA EXISTE
//
// O cruzamento com o extrato do SIGEF acha 1.038 PCs em tres situacoes (353 + 401 + 284). Nas
// duas que dependem do SIGEF, quem resolve e o analista — e o sistema precisa guardar o que
// ele afirmou, quando afirmou e qual das duas respostas deu. Isso e a declaracao.
//
// ⚠️ A COLUNA E UM ARRAY, E SO CRESCE. "A declaracao nao se desmarca: uma vez feita, fica. Se
// o analista errar, ele declara de novo e o historico guarda as duas." Por isso jsonb e nao
// tres colunas soltas: um `UPDATE ... SET declarou = false` seria possivel com colunas, e o
// `||` do jsonb so sabe apendar. A forma do dado impede o desfazer.
//
// ⚠️ ELA NASCE NULA NAS 14.658 LINHAS, E FICA ASSIM. Nao ha backfill, e nao pode haver: nao
// existe declaracao anterior a existencia do botao. Preencher qualquer coisa aqui seria
// afirmar, em nome de um analista, algo que ele nunca disse — com a CGE lendo. A conferencia
// 7 existe para provar que ninguem preencheu.
//
// ⚠️ ESTA RODADA NAO TOCA EM NENHUMA COLUNA EXISTENTE. As conferencias 5 e 6 provam com um
// `md5` de todas elas, linha a linha, antes e depois — `sigef_status`, `data_baixa_sigef` e
// `sigef_registro_em`, de hoje mais cedo, entram na lista de intocaveis.
//
// ⚠️ E ELA CONFERE A REGRA DAS TAGS CONTRA A LIB (conferencia 10): o mesmo conjunto de PCs
// classificado pelo SQL de `lib/sigef.js` e pelo JS de `lib/sigef.js`, linha a linha. Sao duas
// implementacoes da mesma regra, e duas implementacoes so se justificam com a prova de que
// concordam — e a prova tem de rodar contra o banco, nao contra dublê.

const { Pool } = require('pg');
const fs = require('fs');
const sigef = require('./lib/sigef');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');
const TABELA = 'prestacoes_contas';
const COLUNA = 'sigef_declaracao';
const TIPO = 'jsonb';

// Os numeros que o Richard confirmou em 27/08, e que esta rodada tem de continuar vendo.
// ⚠️ Sao PREVISTOS, nao gabarito: se a equipe baixar uma PC entre a medicao e a gravacao, eles
// mudam de verdade. Por isso a conferencia 8 compara ANTES x DEPOIS (que tem de ser igual), e
// o previsto abaixo so vira um AVISO na tela.
const PREVISTO = { SEM_REGISTRO_SIGEF: 353, ABERTA_COM_BAIXA_SIGEF: 401, VERIFICAR_FINAL: 284 };

// ⚠️ O DRY-RUN NUNCA SOBRESCREVE A REVERSAO DA GRAVACAO — sao dois nomes.
const ARQ_REVERSAO = GRAVAR
  ? 'reverter_sigef_declaracao_20260827.json'
  : 'reverter_sigef_declaracao_20260827_DRYRUN.json';

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

// ⚠️ O `md5` cobre TODAS as colunas pre-existentes, EXCLUINDO a nova. Um `md5` de
// `to_jsonb(linha)` mudaria sozinho quando a coluna entrasse — e a conferencia que deveria
// provar "nada mais mudou" acusaria a propria migracao.
function sqlFoto(listaColunas) {
  return `
  SELECT
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS tem_coluna,
    (SELECT data_type FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS tipo_coluna,
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS nullable_coluna,
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS default_coluna,
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}')                                        AS n_colunas,
    (SELECT COUNT(*)::int FROM ${TABELA})                                    AS n_linhas,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE baixada = true)               AS n_baixadas,
    (SELECT COUNT(*)::int FROM ${TABELA}
      WHERE baixada = true OR enviado_ci = true)                             AS n_produtividade,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE sigef_status IS NOT NULL)     AS n_com_status,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE data_baixa_sigef IS NOT NULL) AS n_com_data_sigef,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE sigef_registro_em IS NOT NULL) AS n_com_registro,
    -- as colunas que esta rodada promete nao tocar, explicitas e legiveis.
    -- (sem crase nos nomes: uma crase dentro de template literal fecha a string, armadilha 10)
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), codigo_pc, data_baixa, data_baixa_sigef, baixada, enviado_ci,
                  parecer_tipo, sigef_status, sigef_registro_em),
        chr(30) ORDER BY codigo_pc), '')) FROM ${TABELA})                    AS md5_intocaveis,
    -- e o md5 de TUDO que ja existia, que e a conferencia que fecha a porta de verdade
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.codigo_pc), ''))
       FROM (SELECT codigo_pc, concat_ws(chr(31), ${listaColunas}) AS a
               FROM ${TABELA}) t)                                            AS md5_conteudo`;
}

// As tres pendencias, pela MESMA expressao que a tela vai usar. `PENDENCIA_SQL` nao depende da
// coluna nova, entao roda antes e depois do ALTER.
const SQL_PENDENCIAS = `
  SELECT COALESCE(${sigef.PENDENCIA_SQL}, '(sem tag)') AS tag, COUNT(*)::int AS n
    FROM ${TABELA} p GROUP BY 1 ORDER BY n DESC`;

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha(`  A DECLARACAO DO ANALISTA — ${TABELA}.${COLUNA} ${TIPO}`);
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    await cli.query('BEGIN');

    // ── 1. A FOTO, ANTES ─────────────────────────────────────────────────────
    passo('1. FOTO DE ANTES');
    const { rows: cols } = await cli.query(
      `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS lista
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name <> $2`, [TABELA, COLUNA]);
    const SQL_FOTO = sqlFoto(cols[0].lista);

    const { rows: a } = await cli.query(SQL_FOTO);
    const antes = a[0];
    linha(`   coluna ${COLUNA} existe? ... ${antes.tem_coluna ? 'SIM (' + antes.tipo_coluna + ')' : 'nao'}`);
    linha(`   colunas na tabela ............. ${antes.n_colunas}`);
    linha(`   linhas (PCs) .................. ${antes.n_linhas}`);
    linha(`   baixada = true ................ ${antes.n_baixadas}`);
    linha(`   produtividade (baixada OU ci) . ${antes.n_produtividade}`);
    linha(`   com sigef_status .............. ${antes.n_com_status}`);
    linha(`   com data_baixa_sigef .......... ${antes.n_com_data_sigef}`);
    linha(`   com sigef_registro_em ......... ${antes.n_com_registro}`);
    linha(`   md5 das intocaveis ............ ${antes.md5_intocaveis}`);
    linha(`   md5 de tudo que ja existia .... ${antes.md5_conteudo}`);

    // ── 2. AS TRES SITUACOES, MEDIDAS AGORA ──────────────────────────────────
    passo('2. AS TRES SITUACOES (pela expressao de lib/sigef.js)');
    const { rows: pAntes } = await cli.query(SQL_PENDENCIAS);
    const mapaAntes = Object.fromEntries(pAntes.map((r) => [r.tag, r.n]));
    for (const [tag, prev] of Object.entries(PREVISTO)) {
      const agora = mapaAntes[tag] || 0;
      linha(`   ${tag.padEnd(24)} ${String(agora).padStart(5)}`
        + (agora === prev ? `   (previsto ${prev})` : `   ⚠️ PREVISTO ERA ${prev}`));
    }
    linha(`   ${'(sem tag)'.padEnd(24)} ${String(mapaAntes['(sem tag)'] || 0).padStart(5)}`);
    linha(`   corte da extracao ............. data_baixa < ${sigef.CORTE_EXTRACAO}`);

    // ── 3. A COLUNA ──────────────────────────────────────────────────────────
    passo('3. O COMANDO');
    const DDL = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COLUNA} ${TIPO}`;
    linha(`   ${DDL}`);
    if (antes.tem_coluna) {
      linha(`   (a coluna JA EXISTE — ${antes.tipo_coluna}. O IF NOT EXISTS nao faz nada.)`);
    }
    linha('');
    linha(`   Efeito no dado existente: NENHUM. As ${antes.n_linhas} linhas ficam com`);
    linha(`   ${COLUNA} = NULL. Nao ha backfill — ver o cabecalho deste arquivo.`);
    await cli.query(DDL);

    // ── 4. AS CONFERENCIAS ───────────────────────────────────────────────────
    passo('4. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO);
    const depois = d[0];

    conferir(`1. a coluna passou a existir, tipo ${TIPO}`,
      depois.tem_coluna === 1 && depois.tipo_coluna === TIPO, `veio ${depois.tipo_coluna}`);
    conferir('2. aceita NULL e nao tem DEFAULT',
      depois.nullable_coluna === 'YES' && depois.default_coluna === null,
      `nullable=${depois.nullable_coluna} default=${depois.default_coluna}`);
    conferir(`3. a tabela ganhou exatamente ${antes.tem_coluna ? 0 : 1} coluna(s)`,
      depois.n_colunas === antes.n_colunas + (antes.tem_coluna ? 0 : 1),
      `${antes.n_colunas} -> ${depois.n_colunas}`);
    conferir('4. o numero de PCs nao mudou',
      depois.n_linhas === antes.n_linhas, `${antes.n_linhas} -> ${depois.n_linhas}`);

    // ⚠️ AS DUAS QUE FECHAM A PORTA DE VERDADE.
    conferir('5. md5 das intocaveis IDENTICO — data_baixa, data_baixa_sigef, baixada, enviado_ci, parecer_tipo, sigef_status, sigef_registro_em',
      depois.md5_intocaveis === antes.md5_intocaveis,
      `${antes.md5_intocaveis} -> ${depois.md5_intocaveis}`);
    conferir('6. md5 de TODAS as colunas pre-existentes IDENTICO — so a coluna nova mudou',
      depois.md5_conteudo === antes.md5_conteudo,
      `${antes.md5_conteudo} -> ${depois.md5_conteudo}`);

    const { rows: nn } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} WHERE ${COLUNA} IS NOT NULL`);
    conferir('7. nenhuma linha nasceu com declaracao (todas NULL)',
      nn[0].n === 0, `${nn[0].n} com valor`);

    conferir('8. a produtividade nao se moveu',
      depois.n_produtividade === antes.n_produtividade,
      `${antes.n_produtividade} -> ${depois.n_produtividade}`);

    const { rows: pDepois } = await cli.query(SQL_PENDENCIAS);
    const mapaDepois = Object.fromEntries(pDepois.map((r) => [r.tag, r.n]));
    const pendenciasIguais = Object.keys({ ...mapaAntes, ...mapaDepois })
      .every((k) => (mapaAntes[k] || 0) === (mapaDepois[k] || 0));
    conferir('9. as tres situacoes contam o mesmo antes e depois',
      pendenciasIguais, `${JSON.stringify(mapaAntes)} -> ${JSON.stringify(mapaDepois)}`);

    // ⚠️ A DUPLA VERIFICACAO DA REGRA: o SQL e o JS de lib/sigef.js, linha a linha, no acervo
    // inteiro. Duas implementacoes da mesma regra so se justificam com esta prova.
    const { rows: amostra } = await cli.query(
      `SELECT p.codigo_pc, p.tipo, p.baixada, p.data_baixa, p.sigef_status, p.sigef_declaracao,
              ${sigef.SQL_TAG} AS tag_sql
         FROM ${TABELA} p`);
    let divergiuRegra = 0;
    const exemplos = [];
    for (const r of amostra) {
      const js = sigef.classificar(r);
      if ((js || null) !== (r.tag_sql || null)) {
        divergiuRegra++;
        if (exemplos.length < 5) exemplos.push({ pc: r.codigo_pc, sql: r.tag_sql, js });
      }
    }
    conferir('10. a regra em SQL e a regra em JS concordam nas 14.658 linhas',
      divergiuRegra === 0, `${divergiuRegra} divergentes: ${JSON.stringify(exemplos)}`);

    // A coluna serve para o que foi feita? Um round-trip de append, SEM tocar na tabela.
    const { rows: rt } = await cli.query(
      `SELECT (COALESCE(NULL::jsonb, '[]'::jsonb) || $1::jsonb) AS primeira,
              (COALESCE($2::jsonb, '[]'::jsonb) || $1::jsonb)   AS segunda`,
      [JSON.stringify([{ resposta: 'ja_estava' }]), JSON.stringify([{ resposta: 'registrei_agora' }])]);
    conferir('11. o append do jsonb cria a primeira e preserva a anterior',
      Array.isArray(rt[0].primeira) && rt[0].primeira.length === 1
      && Array.isArray(rt[0].segunda) && rt[0].segunda.length === 2,
      JSON.stringify(rt[0]));

    // ── 5. REVERSAO ──────────────────────────────────────────────────────────
    passo('5. JSON DE REVERSAO');
    const reversao = {
      script: 'migracao_sigef_declaracao_20260827.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 27/08/2026',
      alterou: { tabela: TABELA, coluna: COLUNA, tipo: TIPO, comando: DDL },
      situacoes: mapaDepois,
      corte_extracao: sigef.CORTE_EXTRACAO,
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      reverter_com: `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COLUNA}`,
      aviso_reversao:
        'O DROP COLUMN apaga TODA declaracao que os analistas tiverem feito desde a gravacao, '
        + 'e com ela a unica prova do que cada um afirmou. Conferir antes: SELECT COUNT(*) FROM '
        + 'prestacoes_contas WHERE sigef_declaracao IS NOT NULL; se for > 0, NAO derrubar. '
        + '⚠️ E sigef_registro_em NAO volta sozinha: ela e outra coluna, e continuaria com a '
        + 'data declarada depois do DROP.',
    };
    const escrito = escreverReversao(ARQ_REVERSAO, reversao);
    linha(`   escrito: ${escrito.caminho}`);
    if (escrito.preservou) {
      linha(`   ⚠️  ${escrito.preservou} JA EXISTIA com modo=gravacao e foi PRESERVADO.`);
      linha('       (o defeito de sobrescrever a reversao foi achado em 27/08 — ver o cabecalho)');
    }
    linha(`   reverter com: ${reversao.reverter_com}`);

    // ── 6. DESFECHO ──────────────────────────────────────────────────────────
    passo('6. DESFECHO');
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
      linha('   Para gravar: node migracao_sigef_declaracao_20260827.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha('\n   OK COMMIT — a coluna esta gravada, vazia nas 14.658 linhas.');
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* a transacao pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   ⚠️  SO AGORA o server.js pode subir citando esta coluna. Publicar o');
      linha('       sigpc-api antes disto derruba GET /prestacoes_contas para a equipe.');
    }
  }
})();
