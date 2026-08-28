// CAMINHO: sigpc-api/migracao_dispensa_20260828.js
//
// A DISPENSA DOS ANALISTAS — `usuarios.portaria` + `usuarios.data_saida`, e a tabela
// `substituicao`. Autorizada pelo Richard em 28/08/2026.
//
//   node migracao_dispensa_20260828.js              (DRY-RUN — nao grava nada)
//   node migracao_dispensa_20260828.js --gravar     (grava)
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTA RODADA FAZ, E O QUE ELA NAO FAZ
//
// FAZ: carimba `portaria` e `data_saida` em 7 cadastros, e cria a tabela `substituicao` com
// as 9 substituicoes das portarias.
//
// NAO FAZ: nao move PC nenhuma, nao mexe em `ativo`, nao mexe em `data_ingresso`, nao mexe em
// `metas_analistas`, nao mexe no cadastro de grupo de ninguem. Decisao do Richard, 28/08.
//
// ⚠️ O DISPENSADO CONTINUA `ativo = true`, E ISSO E DELIBERADO. Ele precisa terminar o que
// ficou em curso. Gravar a saida NAO fecha porta nenhuma — o que muda e que passa a existir a
// pergunta "por que houve acao em conta com saida registrada?", e ela passa a ter resposta.
// Ja ha caso medido: as 3 PCs do Higor (id 43) foram encaminhadas ao C.I. DEPOIS da dispensa
// dele, em 12/06.
//
// ⚠️ QUATRO DOS DEZOITO NOMES NAO TEM CADASTRO, e a tabela guarda o NOME em texto ao lado do
// id. Luis Filipe e Caroline (dispensados) e Fabiana e Carla (substitutas) entram com id NULO.
// Decisao do Richard: nao esperar o cadastro existir. Quando ele existir, liga-se o id — e e
// por isso que `dispensado_nome`/`substituto_nome` sao colunas, e nao um comentario.
//
// ⚠️ SEM FOREIGN KEY para `usuarios`, pelo mesmo motivo do `parcela_historico`: existe
// `DELETE /usuarios/:id`, e uma FK faria a exclusao de um cadastro falhar por causa de uma
// linha de historico. Trilha nao trava cadastro. E aqui ha um motivo a mais — metade das
// linhas tem id nulo de proposito, e uma FK nao aceitaria a intencao.
//
// ⚠️ O `grupo` DA TABELA E O DA PORTARIA, e nao o do cadastro. Eles DIVERGEM em dois casos e
// isso e registrado de proposito: o Guilherme (id 14) esta no grupo 1 no cadastro e a portaria
// diz 2; o Jeisson (id 72) idem. A portaria e o documento; o cadastro e o que alguem digitou.
// Fazer os dois concordarem aqui apagaria a divergencia que o Richard quer resolver depois.

const { Pool } = require('pg');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');

const ARQ_REVERSAO = GRAVAR
  ? 'reverter_dispensa_20260828.json'
  : 'reverter_dispensa_20260828_DRYRUN.json';

// ── 1. AS SETE DISPENSAS COM CADASTRO ────────────────────────────────────────
// ⚠️ Por `id`, nunca por nome: `usuarios.nome` guarda o nome CURTO em seis destes sete
// (`Elquier`, `Marilza`, `Samoel`, `Higor`, `Guilherme`, `Willian`), e o nome da portaria tem
// quatro palavras. E a armadilha 1 — filtrar por nome aqui casaria errado ou nao casaria.
const DISPENSAS = [
  { id: 40, nome: 'Maria Goreti Korb', portaria: '203/2026', data_saida: '2026-08-21' },
  { id: 38, nome: 'Elquier', portaria: '8/2026', data_saida: '2026-01-09' },
  { id: 29, nome: 'Marilza', portaria: '46/2026', data_saida: '2026-03-02' },
  { id: 48, nome: 'Samoel', portaria: '95/2026', data_saida: '2026-05-14' },
  { id: 43, nome: 'Higor', portaria: '122/2026', data_saida: '2026-06-12' },
  { id: 14, nome: 'Guilherme', portaria: '192/2026', data_saida: '2026-08-11' },
  { id: 50, nome: 'Willian', portaria: '203/2026', data_saida: '2026-08-21' },
];

// ── 2. AS NOVE SUBSTITUICOES ─────────────────────────────────────────────────
// `grupo` = o da PORTARIA. `*_id` nulo = sem cadastro.
const SUBSTITUICOES = [
  { dispensado_id: null, dispensado_nome: 'Luis Filipe Damyan Santos de Souza',
    substituto_id: 4, substituto_nome: 'Richard Motta Coelho',
    portaria: '285/2025', data_publicacao: '2025-10-09', grupo: 3,
    observacao: 'Dispensado sem cadastro em usuarios.' },
  { dispensado_id: null, dispensado_nome: 'Caroline Dalla Barba Pavelegini',
    substituto_id: 50, substituto_nome: 'Willian Ferreira Coelho',
    portaria: '289/2025', data_publicacao: '2025-10-14', grupo: 3,
    observacao: 'Dispensada sem cadastro em usuarios; tem meta vigente id 30 com analista_id nulo. '
      + 'O substituto (id 50) foi ele proprio dispensado depois, pela 203/2026.' },
  { dispensado_id: 38, dispensado_nome: 'Elquier Smaniotto Luzzatto',
    substituto_id: 49, substituto_nome: 'Scheila Zimmermann Furtado',
    portaria: '8/2026', data_publicacao: '2026-01-09', grupo: 3,
    observacao: 'Cadastro do dispensado guarda o nome curto "Elquier".' },
  { dispensado_id: 29, dispensado_nome: 'Marilza Andrade Correa Justino',
    substituto_id: 12, substituto_nome: 'Franciani Mary Daniel Pereira',
    portaria: '46/2026', data_publicacao: '2026-03-02', grupo: 2,
    observacao: 'Cadastro do dispensado guarda "Marilza"; a substituta esta no grupo 1 no cadastro.' },
  { dispensado_id: 48, dispensado_nome: 'Samoel Mauri da Silva',
    substituto_id: 56, substituto_nome: 'Gustavo Hallack Porto',
    portaria: '95/2026', data_publicacao: '2026-05-14', grupo: 3,
    observacao: 'O substituto era coordenador do grupo 3, e continua com perfil coordenador.' },
  { dispensado_id: 43, dispensado_nome: 'Higor Robson Amaral Kuntze',
    substituto_id: 52, substituto_nome: 'Eduardo Pizolati',
    portaria: '122/2026', data_publicacao: '2026-06-12', grupo: 3,
    observacao: '3 PCs do dispensado foram encaminhadas ao C.I. DEPOIS desta data.' },
  { dispensado_id: 14, dispensado_nome: 'Guilherme Jose dos Santos',
    substituto_id: 72, substituto_nome: 'Jeisson Klein Garcia',
    portaria: '192/2026', data_publicacao: '2026-08-11', grupo: 2,
    observacao: 'DIVERGENCIA: portaria diz grupo 2; cadastro tem o dispensado (id 14) e o '
      + 'substituto (id 72) no grupo 1. Registrado o da portaria; cadastro nao foi tocado.' },
  { dispensado_id: 50, dispensado_nome: 'Willian Ferreira Coelho',
    substituto_id: null, substituto_nome: 'Fabiana Vieira',
    portaria: '203/2026', data_publicacao: '2026-08-21', grupo: 3,
    observacao: 'Substituta sem cadastro em usuarios. O dispensado (id 50) nunca acessou o sistema.' },
  { dispensado_id: 40, dispensado_nome: 'Maria Goreti Korb',
    substituto_id: null, substituto_nome: 'Carla Goedert Xavier',
    portaria: '203/2026', data_publicacao: '2026-08-21', grupo: 3,
    observacao: 'Substituta sem cadastro em usuarios.' },
];

const TABELA = 'substituicao';

const DDL_TABELA = `
  CREATE TABLE IF NOT EXISTS ${TABELA} (
    id              SERIAL PRIMARY KEY,
    dispensado_id   INTEGER,
    dispensado_nome TEXT NOT NULL,
    substituto_id   INTEGER,
    substituto_nome TEXT NOT NULL,
    portaria        TEXT NOT NULL,
    data_publicacao DATE NOT NULL,
    grupo           INTEGER,
    observacao      TEXT,
    criado_em       TIMESTAMP DEFAULT NOW()
  )`;

// ⚠️ A CHAVE NATURAL E (portaria, dispensado_nome), E E ELA QUE FAZ O SCRIPT SER IDEMPOTENTE.
// Nao da para usar so `portaria`: a 203/2026 dispensou DUAS pessoas. Nao da para usar
// `dispensado_id`: quatro linhas tem id nulo, e NULL nao colide com NULL num indice unico —
// duas rodadas criariam duplicatas silenciosas das quatro linhas sem cadastro.
const DDL_UNICO = `
  CREATE UNIQUE INDEX IF NOT EXISTS ${TABELA}_portaria_dispensado_uk
    ON ${TABELA} (portaria, dispensado_nome)`;

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

// A FOTO.
//
// ⚠️ O `md5_usuarios_intocavel` COBRE TODAS AS COLUNAS DE `usuarios` MENOS `portaria` e
// `data_saida` — as duas que esta rodada escreve. E o `md5_ativo` esta separado e explicito
// porque `ativo` e a coluna que o Richard mandou NAO tocar, e uma promessa dessas merece uma
// conferencia com nome proprio, nao diluida num md5 de 25 colunas.
const SQL_FOTO = `
  SELECT
    (SELECT COUNT(*)::int FROM usuarios)                                       AS n_usuarios,
    (SELECT COUNT(*)::int FROM usuarios WHERE ativo = true)                    AS n_ativos,
    (SELECT COUNT(*)::int FROM usuarios WHERE data_saida IS NOT NULL)          AS n_com_saida,
    (SELECT COUNT(*)::int FROM usuarios WHERE portaria IS NOT NULL AND portaria <> '') AS n_com_portaria,
    (SELECT COUNT(*)::int FROM usuarios WHERE data_ingresso IS NOT NULL)       AS n_com_ingresso,
    (SELECT COUNT(*)::int FROM information_schema.tables
      WHERE table_schema='public' AND table_name='${TABELA}')                  AS tem_tabela,
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name='${TABELA}')                                            AS n_colunas_tabela,
    (SELECT md5(COALESCE(string_agg(concat_ws(chr(31), id, ativo), chr(30) ORDER BY id), ''))
       FROM usuarios)                                                          AS md5_ativo,
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id, concat_ws(chr(31), id, nome, cpf, senha_hash, perfil, setorial_id,
                    grupo, ativo, criado_em, ultimo_acesso, regiao, municipio, telefone, email,
                    nucleo, aprovado, aguardando_aprovacao, matricula, data_ingresso,
                    meta_mensal, senha_provisoria, sessao_fim, papel_ativo, novidades_visto_em) AS a
               FROM usuarios) t)                                               AS md5_usuarios_intocavel,
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id, concat_ws(chr(31), id, analista_nome, analista_id, grupo, periodo,
                    meta, vigente, setorial_id) AS a FROM metas_analistas) t)  AS md5_metas,
    (SELECT COUNT(*)::int FROM prestacoes_contas)                              AS n_pcs,
    (SELECT md5(COALESCE(string_agg(concat_ws(chr(31), codigo_pc, analista_id, status, baixada),
                chr(30) ORDER BY codigo_pc), '')) FROM prestacoes_contas)      AS md5_pcs`;

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha('  A DISPENSA DOS ANALISTAS — usuarios.portaria/data_saida + substituicao');
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    await cli.query('BEGIN');

    // ── 1. FOTO ──────────────────────────────────────────────────────────────
    passo('1. FOTO DE ANTES');
    const { rows: a } = await cli.query(SQL_FOTO);
    const antes = a[0];
    linha(`   usuarios ...................... ${antes.n_usuarios}  (ativos ${antes.n_ativos})`);
    linha(`   com data_saida ................ ${antes.n_com_saida}`);
    linha(`   com portaria .................. ${antes.n_com_portaria}`);
    linha(`   com data_ingresso ............. ${antes.n_com_ingresso}   (nao sera tocada)`);
    linha(`   tabela ${TABELA} existe? .. ${antes.tem_tabela ? 'SIM (' + antes.n_colunas_tabela + ' colunas)' : 'nao'}`);
    linha(`   md5 de ativo .................. ${antes.md5_ativo}`);
    linha(`   md5 do resto de usuarios ...... ${antes.md5_usuarios_intocavel}`);
    linha(`   md5 de metas_analistas ........ ${antes.md5_metas}`);
    linha(`   PCs ........................... ${antes.n_pcs}  ·  md5 ${antes.md5_pcs}`);

    // ── 2. OS SETE CADASTROS, ANTES ──────────────────────────────────────────
    passo('2. OS SETE CADASTROS');
    const ids = DISPENSAS.map((d) => d.id);
    const { rows: alvo } = await cli.query(
      `SELECT id, nome, perfil, grupo, ativo, portaria, data_saida::text, data_ingresso::text
         FROM usuarios WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
    conferir('0. os sete ids existem no cadastro', alvo.length === DISPENSAS.length,
      `achei ${alvo.length} de ${DISPENSAS.length}`);
    if (alvo.length !== DISPENSAS.length) throw new Error('id de dispensado nao encontrado — nada foi gravado');

    for (const d of DISPENSAS) {
      const u = alvo.find((x) => x.id === d.id);
      const aviso = u.nome !== d.nome ? `  ⚠️ o cadastro diz "${u.nome}"` : '';
      linha(`   id ${String(d.id).padStart(2)} ${d.nome.padEnd(20)} portaria ${d.portaria.padEnd(9)}`
        + ` saida ${d.data_saida}${aviso}`);
      linha(`        hoje: portaria=${u.portaria || 'NULL'} · data_saida=${u.data_saida || 'NULL'}`
        + ` · ativo=${u.ativo} · grupo=${u.grupo}`);
    }
    const jaCertos = alvo.filter((u) => {
      const d = DISPENSAS.find((x) => x.id === u.id);
      return u.portaria === d.portaria && u.data_saida === d.data_saida;
    }).length;
    linha(`\n   ja estao carimbados .......... ${jaCertos} de ${DISPENSAS.length}`);

    // ── 3. A ESCRITA EM `usuarios` ───────────────────────────────────────────
    passo('3. O CARIMBO DA DISPENSA');
    linha('   UPDATE usuarios u SET portaria = v.portaria, data_saida = v.saida::date');
    linha('     FROM (VALUES ...) v(id, portaria, saida) WHERE u.id = v.id');
    linha('       AND (u.portaria IS DISTINCT FROM v.portaria OR u.data_saida IS DISTINCT FROM v.saida::date)');
    linha('');
    linha('   ⚠️  DUAS colunas no SET. `ativo`, `data_ingresso`, `grupo`, `perfil` e `nome`');
    linha('       nao aparecem nem no SET nem em lugar nenhum deste UPDATE.');
    const SQL_CARIMBO = `
      UPDATE usuarios u
         SET portaria = v.portaria, data_saida = v.saida::date
        FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS portaria,
                     unnest($3::text[]) AS saida) v
       WHERE u.id = v.id
         AND (u.portaria IS DISTINCT FROM v.portaria
              OR u.data_saida IS DISTINCT FROM v.saida::date)
      RETURNING u.id`;
    const res1 = await cli.query(SQL_CARIMBO, [
      ids, DISPENSAS.map((d) => d.portaria), DISPENSAS.map((d) => d.data_saida)]);
    linha(`   cadastros carimbados .......... ${res1.rowCount}`);

    // ── 4. A TABELA `substituicao` ───────────────────────────────────────────
    passo('4. A TABELA substituicao');
    linha(`   ${DDL_TABELA.trim().split('\n')[0].trim()}`);
    linha(`   ${DDL_UNICO.trim().split('\n')[0].trim()} (portaria, dispensado_nome)`);
    await cli.query(DDL_TABELA);
    await cli.query(DDL_UNICO);

    // ⚠️ ON CONFLICT DO NOTHING sobre a chave natural — e o que faz rodar de novo nao duplicar.
    const SQL_INSERT = `
      INSERT INTO ${TABELA}
        (dispensado_id, dispensado_nome, substituto_id, substituto_nome,
         portaria, data_publicacao, grupo, observacao)
      SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[],
                           $5::text[], $6::date[], $7::int[], $8::text[])
      ON CONFLICT (portaria, dispensado_nome) DO NOTHING
      RETURNING id`;
    const col = (k) => SUBSTITUICOES.map((s) => s[k]);
    const res2 = await cli.query(SQL_INSERT, [
      col('dispensado_id'), col('dispensado_nome'), col('substituto_id'), col('substituto_nome'),
      col('portaria'), col('data_publicacao'), col('grupo'), col('observacao')]);
    linha(`   linhas inseridas .............. ${res2.rowCount} de ${SUBSTITUICOES.length}`);
    if (res2.rowCount === 0) linha('   -> IDEMPOTENTE: as nove ja estavam la.');

    const { rows: subs } = await cli.query(
      `SELECT dispensado_id, dispensado_nome, substituto_id, substituto_nome, portaria,
              data_publicacao::text, grupo FROM ${TABELA} ORDER BY data_publicacao, dispensado_nome`);
    linha('');
    subs.forEach((s) => linha(`   ${s.data_publicacao} ${s.portaria.padEnd(9)} g${s.grupo}  `
      + `${(s.dispensado_id ? '#' + s.dispensado_id : '  —').padStart(4)} ${s.dispensado_nome.padEnd(35)}`
      + ` -> ${(s.substituto_id ? '#' + s.substituto_id : '  —').padStart(4)} ${s.substituto_nome}`));

    // ── 5. CONFERENCIAS ──────────────────────────────────────────────────────
    passo('5. CONFERENCIAS (contra a foto de antes)');
    const { rows: d2 } = await cli.query(SQL_FOTO);
    const depois = d2[0];

    conferir('1. o numero de usuarios nao mudou',
      depois.n_usuarios === antes.n_usuarios, `${antes.n_usuarios} -> ${depois.n_usuarios}`);
    // ⚠️ A PROMESSA COM NOME PROPRIO: `ativo` nao foi tocado em ninguem.
    conferir('2. `ativo` IDENTICO em todos os cadastros — o dispensado continua ativo',
      depois.md5_ativo === antes.md5_ativo, `${antes.md5_ativo} -> ${depois.md5_ativo}`);
    conferir('3. o numero de ativos nao mudou',
      depois.n_ativos === antes.n_ativos, `${antes.n_ativos} -> ${depois.n_ativos}`);
    conferir('4. md5 do RESTO de usuarios IDENTICO — so portaria e data_saida mudaram',
      depois.md5_usuarios_intocavel === antes.md5_usuarios_intocavel,
      `${antes.md5_usuarios_intocavel} -> ${depois.md5_usuarios_intocavel}`);
    conferir('5. data_ingresso nao foi tocada',
      depois.n_com_ingresso === antes.n_com_ingresso,
      `${antes.n_com_ingresso} -> ${depois.n_com_ingresso}`);
    conferir('6. metas_analistas IDENTICA — ninguem perdeu nem ganhou meta nesta rodada',
      depois.md5_metas === antes.md5_metas, `${antes.md5_metas} -> ${depois.md5_metas}`);
    // ⚠️ NENHUMA PC FOI MOVIDA. E a promessa central da rodada: "nenhuma PC e transferida".
    conferir('7. prestacoes_contas IDENTICA em dono, status e baixa — nenhuma PC transferida',
      depois.md5_pcs === antes.md5_pcs && depois.n_pcs === antes.n_pcs,
      `${antes.md5_pcs} -> ${depois.md5_pcs}`);

    const { rows: conf } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM usuarios u
         JOIN (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS portaria,
                      unnest($3::text[]) AS saida) v ON v.id = u.id
        WHERE u.portaria IS DISTINCT FROM v.portaria
           OR u.data_saida IS DISTINCT FROM v.saida::date`,
      [ids, DISPENSAS.map((d) => d.portaria), DISPENSAS.map((d) => d.data_saida)]);
    conferir('8. os sete cadastros ficaram exatamente com a portaria e a data previstas',
      conf[0].n === 0, `${conf[0].n} divergentes`);

    const { rows: fora } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM usuarios WHERE data_saida IS NOT NULL AND NOT (id = ANY($1))`,
      [ids]);
    conferir('9. nenhum cadastro de fora da lista ganhou data_saida',
      fora[0].n === 0, `${fora[0].n} de fora com saida`);
    conferir('10. o total com data_saida e exatamente sete',
      depois.n_com_saida === DISPENSAS.length, `veio ${depois.n_com_saida}`);

    conferir('11. a tabela substituicao existe com as 10 colunas',
      depois.tem_tabela === 1 && depois.n_colunas_tabela === 10,
      `tem_tabela=${depois.tem_tabela} colunas=${depois.n_colunas_tabela}`);
    conferir('12. a tabela tem exatamente as nove substituicoes',
      subs.length === SUBSTITUICOES.length, `${subs.length} linhas`);
    // ⚠️ Os quatro id nulos sao os quatro previstos, e nao um a mais: um id que nasceu nulo
    // por engano de digitacao passaria despercebido — sao justamente as linhas que ninguem vai
    // conseguir ligar depois.
    const nulos = subs.filter((s) => s.dispensado_id == null).length
      + subs.filter((s) => s.substituto_id == null).length;
    conferir('13. sao exatamente QUATRO ids nulos — os dois sem cadastro de cada lado',
      nulos === 4, `${nulos} nulos`);
    const grupoGui = subs.find((s) => s.dispensado_nome.startsWith('Guilherme'));
    conferir('14. o grupo registrado e o da PORTARIA (Guilherme: 2), nao o do cadastro (1)',
      grupoGui && grupoGui.grupo === 2, `veio ${grupoGui && grupoGui.grupo}`);

    // Idempotencia, provada dentro da propria transacao.
    const r1b = await cli.query(SQL_CARIMBO, [
      ids, DISPENSAS.map((d) => d.portaria), DISPENSAS.map((d) => d.data_saida)]);
    const r2b = await cli.query(SQL_INSERT, [
      col('dispensado_id'), col('dispensado_nome'), col('substituto_id'), col('substituto_nome'),
      col('portaria'), col('data_publicacao'), col('grupo'), col('observacao')]);
    conferir('15. rodar tudo de novo afeta ZERO linhas (idempotente)',
      r1b.rowCount === 0 && r2b.rowCount === 0,
      `carimbo ${r1b.rowCount} · substituicao ${r2b.rowCount}`);

    // ── 6. REVERSAO ──────────────────────────────────────────────────────────
    passo('6. JSON DE REVERSAO');
    const reversao = {
      script: 'migracao_dispensa_20260828.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 28/08/2026',
      alterou: {
        usuarios: 'portaria, data_saida em 7 cadastros',
        tabela_nova: TABELA,
      },
      resumo: {
        cadastros_carimbados: res1.rowCount,
        ja_estavam_carimbados: jaCertos,
        substituicoes_inseridas: res2.rowCount,
        substituicoes_na_tabela: subs.length,
        ids_nulos: nulos,
      },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      // ⚠️ LISTA EXPLICITA DE CHAVES com o valor ANTERIOR de cada uma (armadilha 12). Voltar
      // por `WHERE data_saida IS NOT NULL` apagaria tambem o que uma rodada posterior gravar.
      valores_anteriores_usuarios: alvo.map((u) => ({
        id: u.id, nome: u.nome, portaria: u.portaria, data_saida: u.data_saida,
      })),
      reverter_usuarios:
        'UPDATE usuarios SET portaria = v.portaria, data_saida = v.data_saida::date '
        + 'FROM (VALUES ...) AS v(id, portaria, data_saida) WHERE usuarios.id = v.id  '
        + '-- monte o VALUES a partir de `valores_anteriores_usuarios` (todos eram NULL)',
      reverter_tabela:
        `ALTER TABLE ${TABELA} RENAME TO ${TABELA}_backup_20260828`,
      aviso_reversao:
        'A tabela sai por RENAME, nunca por DROP — e o padrao deste projeto, e aqui ela guarda '
        + 'o unico registro de quem substituiu quem. E o UPDATE de volta poe NULL nas sete: '
        + 'se alguem tiver carimbado outra portaria depois, essa some junto.',
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
      linha('   Para gravar: node migracao_dispensa_20260828.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha(`\n   OK COMMIT — ${res1.rowCount} cadastros carimbados, ${subs.length} substituicoes.`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   ⚠️  NADA MUDOU DE COMPORTAMENTO. `ativo` continua true, as PCs continuam');
      linha('       onde estavam, e nenhuma tela le `data_saida` ainda. O congelamento da');
      linha('       produtividade e a proxima rodada — ver o relatorio.');
    }
  }
})();
