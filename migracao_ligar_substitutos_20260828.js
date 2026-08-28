// CAMINHO: sigpc-api/migracao_ligar_substitutos_20260828.js
//
// LIGAR O `substituto_id` DAS DUAS SUBSTITUTAS QUE GANHARAM CADASTRO HOJE.
// Autorizada pelo Richard em 28/08/2026.
//
//   node migracao_ligar_substitutos_20260828.js              (DRY-RUN — nao grava nada)
//   node migracao_ligar_substitutos_20260828.js --gravar     (grava)
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTA RODADA FAZ
//
// A tabela `substituicao` nasceu em 28/08 com QUATRO ids nulos, de proposito: duas
// dispensadas e duas substitutas nao tinham cadastro. As duas substitutas passaram a ter —
// Fabiana Vieira (id 74) e Carla Goedert Xavier (id 75), cadastradas hoje. Esta rodada liga
// o `substituto_id` das duas linhas, e mais nada.
//
// ⚠️ SOBRAM DOIS NULOS DEPOIS DESTA RODADA, e e o certo: Luis Filipe e Caroline continuam sem
// cadastro, e o Richard decide o que fazer com eles. A conferencia 6 exige exatamente 2 — nao
// 0 e nao 4. Zerar seria sinal de que alguem ligou por nome quem nao tem id.
//
// ⚠️ O CASAMENTO E POR NOME EXATO, E ISSO SO E SEGURO AQUI. `usuarios.nome` guarda o nome
// CURTO em boa parte do cadastro ("Elquier", "Samoel", "Willian"), e casar por nome e a
// armadilha 1. Estas duas sao a excecao verificavel: o cadastro tem o nome COMPLETO, igual
// caractere a caractere ao da portaria, e cada uma casa com UMA linha so. O script CONFERE
// as duas coisas antes de escrever, e aborta se qualquer uma falhar.
//
// ⚠️ E O ALVO E A CHAVE NATURAL `(portaria, dispensado_nome)`, nao o `id` da linha. O id 8 e
// o 9 sao o que o SERIAL entregou hoje; a chave natural e o que a portaria diz. Um script que
// mira id de sequence quebra em silencio se a tabela for recriada.

const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');

const ARQ_REVERSAO = GRAVAR
  ? 'reverter_ligar_substitutos_20260828.json'
  : 'reverter_ligar_substitutos_20260828_DRYRUN.json';

// As duas ligacoes. `nome_cadastro` tem de bater EXATO com `usuarios.nome`.
const LIGACOES = [
  { portaria: '203/2026', dispensado_nome: 'Willian Ferreira Coelho',
    substituto_nome: 'Fabiana Vieira', nome_cadastro: 'Fabiana Vieira' },
  { portaria: '203/2026', dispensado_nome: 'Maria Goreti Korb',
    substituto_nome: 'Carla Goedert Xavier', nome_cadastro: 'Carla Goedert Xavier' },
];

// Quantos ids nulos DEVEM sobrar. Luis Filipe e Caroline, os dois dispensados sem cadastro.
const NULOS_ESPERADOS_DEPOIS = 2;

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

// ⚠️ O `md5_outras` cobre TUDO menos as duas linhas que esta rodada toca — e a conferencia de
// que as outras sete nao se mexeram. O `md5_usuarios` prova que o cadastro nao foi tocado:
// esta rodada LE `usuarios` e nao escreve nele.
const SQL_FOTO = `
  SELECT
    (SELECT COUNT(*)::int FROM substituicao)                                  AS n_linhas,
    (SELECT COUNT(*)::int FROM substituicao WHERE substituto_id IS NULL)      AS n_subst_nulo,
    (SELECT COUNT(*)::int FROM substituicao WHERE dispensado_id IS NULL)      AS n_disp_nulo,
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id, concat_ws(chr(31), id, dispensado_id, dispensado_nome, substituto_id,
                    substituto_nome, portaria, data_publicacao, grupo, observacao) AS a
               FROM substituicao) t)                                          AS md5_tudo,
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id, concat_ws(chr(31), id, dispensado_id, dispensado_nome, substituto_id,
                    substituto_nome, portaria, data_publicacao, grupo, observacao) AS a
               FROM substituicao
              WHERE NOT (portaria = '203/2026'
                         AND substituto_nome IN ('Fabiana Vieira', 'Carla Goedert Xavier'))) t)
                                                                              AS md5_outras,
    (SELECT COUNT(*)::int FROM usuarios)                                      AS n_usuarios,
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id, concat_ws(chr(31), id, nome, perfil, grupo, ativo, portaria,
                    data_ingresso, data_saida) AS a FROM usuarios) t)         AS md5_usuarios`;

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha('  LIGAR O substituto_id — Fabiana Vieira e Carla Goedert Xavier');
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    await cli.query('BEGIN');

    // ── 1. FOTO ──────────────────────────────────────────────────────────────
    passo('1. FOTO DE ANTES');
    const { rows: a } = await cli.query(SQL_FOTO);
    const antes = a[0];
    linha(`   linhas em substituicao ........ ${antes.n_linhas}`);
    linha(`   com substituto_id NULO ........ ${antes.n_subst_nulo}`);
    linha(`   com dispensado_id NULO ........ ${antes.n_disp_nulo}`);
    linha(`   usuarios ...................... ${antes.n_usuarios}`);
    linha(`   md5 de substituicao ........... ${antes.md5_tudo}`);
    linha(`   md5 das OUTRAS linhas ......... ${antes.md5_outras}`);
    linha(`   md5 de usuarios ............... ${antes.md5_usuarios}`);

    // ── 2. ACHAR AS DUAS NO CADASTRO ─────────────────────────────────────────
    passo('2. AS DUAS NO CADASTRO');
    const plano = [];
    for (const l of LIGACOES) {
      const { rows: us } = await cli.query(
        `SELECT id, nome, perfil, grupo, ativo, portaria, data_ingresso::text, data_saida::text
           FROM usuarios WHERE nome = $1`, [l.nome_cadastro]);
      // ⚠️ EXATAMENTE UMA. Zero e "nao cadastrada"; duas ou mais e ambiguidade, e escolher
      // uma seria inventar correspondencia com dado de pessoal.
      if (us.length !== 1) {
        linha(`   X "${l.nome_cadastro}" casou com ${us.length} cadastro(s)`);
        us.forEach((u) => linha(`       id ${u.id} "${u.nome}" ${u.perfil} grupo ${u.grupo}`));
        throw new Error(`"${l.nome_cadastro}" nao casa com exatamente um cadastro — nada foi gravado`);
      }
      const u = us[0];
      plano.push({ ...l, id: u.id, u });
      linha(`   ${l.nome_cadastro.padEnd(24)} -> id ${u.id} · ${u.perfil} · grupo ${u.grupo}`
        + ` · ativo=${u.ativo} · ingresso ${u.data_ingresso || '—'}`);
      linha(`        portaria no cadastro: "${u.portaria || '—'}"`);
      // ⚠️ AVISO, NAO ERRO. O cadastro grava "FCEE nº 203/2026" e a tabela "203/2026" — sao
      // formatos diferentes na mesma informacao. Nao normalizo aqui: qual formato vale e
      // decisao do Richard, e esta rodada nao foi autorizada a mexer em `usuarios`.
      if (u.portaria && !u.portaria.includes(l.portaria)) {
        linha(`        ⚠️  a portaria do cadastro nao contem "${l.portaria}"`);
      } else if (u.portaria && u.portaria !== l.portaria) {
        linha(`        ⚠️  FORMATOS DIFERENTES para a mesma portaria — cadastro "${u.portaria}"`
          + ` x tabela "${l.portaria}". Nao normalizado: e decisao sua.`);
      }
      if (u.data_saida) linha(`        ⚠️  esta substituta TEM data_saida (${u.data_saida})`);
    }

    // ── 3. AS LINHAS ALVO ────────────────────────────────────────────────────
    passo('3. AS LINHAS DE substituicao');
    for (const p of plano) {
      const { rows } = await cli.query(
        `SELECT id, dispensado_id, dispensado_nome, substituto_id, substituto_nome
           FROM substituicao WHERE portaria = $1 AND dispensado_nome = $2 FOR UPDATE`,
        [p.portaria, p.dispensado_nome]);
      if (rows.length !== 1)
        throw new Error(`a chave (${p.portaria}, ${p.dispensado_nome}) casou ${rows.length} linhas`);
      const r = rows[0];
      // ⚠️ O nome da linha tem de ser o que o plano diz. Se a linha ja tiver outro substituto,
      // esta rodada NAO e a rodada certa — e alguem mudou a tabela por fora.
      if (r.substituto_nome !== p.substituto_nome)
        throw new Error(`a linha ${r.id} tem substituto_nome "${r.substituto_nome}", `
          + `e o plano diz "${p.substituto_nome}"`);
      p.linha_id = r.id;
      p.id_antes = r.substituto_id;
      linha(`   linha ${String(r.id).padStart(2)} · ${r.dispensado_nome.padEnd(24)} -> `
        + `${r.substituto_nome.padEnd(22)} substituto_id ${r.substituto_id === null ? 'NULO' : r.substituto_id}`
        + `  =>  ${p.id}`);
    }
    const aGravar = plano.filter((p) => p.id_antes !== p.id);
    linha(`\n   ja estao ligadas .............. ${plano.length - aGravar.length}`);
    linha(`   vao ser ligadas ............... ${aGravar.length}`);
    if (!aGravar.length) linha('   -> IDEMPOTENTE: nada mudou desde a ultima rodada.');

    // ── 4. A ESCRITA ─────────────────────────────────────────────────────────
    passo('4. O COMANDO');
    linha('   UPDATE substituicao s SET substituto_id = v.id');
    linha('     FROM (VALUES ...) v(portaria, dispensado_nome, id)');
    linha('    WHERE s.portaria = v.portaria AND s.dispensado_nome = v.dispensado_nome');
    linha('      AND s.substituto_id IS DISTINCT FROM v.id');
    linha('');
    linha('   ⚠️  UMA coluna no SET. `substituto_nome`, `dispensado_id`, `portaria`,');
    linha('       `data_publicacao`, `grupo` e `observacao` nao aparecem.');
    const SQL_LIGAR = `
      UPDATE substituicao s
         SET substituto_id = v.id
        FROM (SELECT unnest($1::text[]) AS portaria, unnest($2::text[]) AS dispensado_nome,
                     unnest($3::int[]) AS id) v
       WHERE s.portaria = v.portaria AND s.dispensado_nome = v.dispensado_nome
         AND s.substituto_id IS DISTINCT FROM v.id
      RETURNING s.id`;
    const args = [plano.map((p) => p.portaria), plano.map((p) => p.dispensado_nome),
      plano.map((p) => p.id)];
    const res = await cli.query(SQL_LIGAR, args);
    linha(`   linhas ligadas ................ ${res.rowCount}`);

    // ── 5. CONFERENCIAS ──────────────────────────────────────────────────────
    passo('5. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO);
    const depois = d[0];

    conferir('1. o numero de linhas nao mudou',
      depois.n_linhas === antes.n_linhas, `${antes.n_linhas} -> ${depois.n_linhas}`);
    // ⚠️ AS OUTRAS SETE NAO SE MEXERAM. Contar linhas nao provaria isso.
    conferir('2. md5 das OUTRAS linhas IDENTICO — so as duas mudaram',
      depois.md5_outras === antes.md5_outras, `${antes.md5_outras} -> ${depois.md5_outras}`);
    // ⚠️ Esta rodada LE `usuarios` e nao escreve nele — nem a portaria em formato diferente.
    conferir('3. usuarios IDENTICO — o cadastro nao foi tocado',
      depois.md5_usuarios === antes.md5_usuarios && depois.n_usuarios === antes.n_usuarios,
      `${antes.md5_usuarios} -> ${depois.md5_usuarios}`);
    conferir('4. o md5 de substituicao MUDOU — a rodada fez alguma coisa',
      GRAVAR || aGravar.length === 0 ? true : depois.md5_tudo !== antes.md5_tudo,
      'nada mudou');
    conferir('5. nao sobrou substituto_id NULO',
      depois.n_subst_nulo === 0, `${depois.n_subst_nulo} nulos`);
    // ⚠️ E OS DOIS DISPENSADOS SEM CADASTRO CONTINUAM NULOS. Zerar aqui seria sinal de que
    // alguem ligou por nome quem nao tem id — exatamente o que esta rodada nao faz.
    conferir(`6. continuam ${NULOS_ESPERADOS_DEPOIS} dispensados sem id — Luis Filipe e Caroline`,
      depois.n_disp_nulo === NULOS_ESPERADOS_DEPOIS,
      `${depois.n_disp_nulo}, esperado ${NULOS_ESPERADOS_DEPOIS}`);

    const { rows: conf } = await cli.query(
      `SELECT s.id, s.substituto_nome, s.substituto_id, u.nome AS nome_no_cadastro
         FROM substituicao s LEFT JOIN usuarios u ON u.id = s.substituto_id
        WHERE s.portaria = '203/2026' ORDER BY s.id`);
    conf.forEach((r) => linha(`         linha ${r.id}: ${r.substituto_nome} -> id ${r.substituto_id}`
      + ` ("${r.nome_no_cadastro}")`));
    conferir('7. o id ligado aponta para o cadastro de MESMO NOME',
      conf.every((r) => r.substituto_id != null && r.nome_no_cadastro === r.substituto_nome),
      JSON.stringify(conf));

    const { rows: orf } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM substituicao s
        WHERE (s.substituto_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = s.substituto_id))
           OR (s.dispensado_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = s.dispensado_id))`);
    conferir('8. nenhum id da tabela aponta para cadastro inexistente',
      orf[0].n === 0, `${orf[0].n} orfaos`);

    const res2 = await cli.query(SQL_LIGAR, args);
    conferir('9. rodar de novo afeta ZERO linhas (idempotente)',
      res2.rowCount === 0, `afetou ${res2.rowCount}`);

    // ── 6. REVERSAO ──────────────────────────────────────────────────────────
    passo('6. JSON DE REVERSAO');
    const reversao = {
      script: 'migracao_ligar_substitutos_20260828.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 28/08/2026',
      resumo: {
        ligadas: res.rowCount,
        ja_estavam: plano.length - aGravar.length,
        dispensados_ainda_sem_id: depois.n_disp_nulo,
      },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      // ⚠️ Lista explicita, com o valor anterior de cada linha (armadilha 12).
      valores_anteriores: plano.map((p) => ({
        linha_id: p.linha_id, portaria: p.portaria, dispensado_nome: p.dispensado_nome,
        substituto_nome: p.substituto_nome, de: p.id_antes, para: p.id,
      })),
      reverter_com:
        'UPDATE substituicao SET substituto_id = NULL WHERE id = ANY(ARRAY['
        + plano.map((p) => p.linha_id).join(', ') + '])',
      aviso_reversao:
        'Reverter volta as duas linhas para substituto_id NULO. Os cadastros 74 e 75 NAO sao '
        + 'tocados por esta reversao — eles existem por conta propria.',
    };
    const escrito = escreverReversao(ARQ_REVERSAO, reversao);
    linha(`   escrito: ${escrito.caminho}`);
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
      linha('   Para gravar: node migracao_ligar_substitutos_20260828.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha(`\n   OK COMMIT — ${res.rowCount} linha(s) ligada(s).`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   A tag "Substituto" passa a aparecer para a Fabiana (74) e a Carla (75).');
      linha('   Nenhuma PC foi transferida — isso continua sendo outra decisao.');
    }
  }
})();
