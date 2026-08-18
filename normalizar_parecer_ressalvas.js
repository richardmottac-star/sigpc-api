// CAMINHO: sigpc-api/normalizar_parecer_ressalvas.js
//
// NORMALIZA O TEXTO DE 7 PARECERES. PADRÃO = DRY-RUN.
//
//   'Parecer Regular com Ressalva(s)'  ->  'Parecer Regular com Ressalvas'
//
// ─────────────────────────────────────────────────────────────────────────────
// DE ONDE VIERAM ESSAS 7 LINHAS (medido em 18/08/2026)
//
// Todas as 7 saíram do MESMO lugar: o botão "Registrar parecer" do detalhe da TR, que grava
// por `POST /prestacoes_contas/registrar_parecer`. O `<select>` daquele modal
// (`index.html:1161`) oferecia **'Parecer Regular com Ressalva(s)'**, enquanto o do cartão da
// Minha Planilha (`index.html:1216`) oferece **'Parecer Regular com Ressalvas'** — e a rota
// legada não validava contra `PARECERES_VALIDOS`. Duas telas, dois rótulos, o mesmo parecer.
//
// O rótulo foi alinhado no `index.html` e a validação entrou na rota. Este script fecha o
// que ficou gravado antes disso.
//
// ⚠️ ELAS NÃO ESTÃO QUEBRANDO NADA HOJE, e é bom saber disso antes de rodar. `parecer_tipo`
// NÃO é comparado por igualdade em lugar nenhum de leitura — conferido no `server.js`, nas
// libs e no `index.html`. Os dois únicos pontos que olham o valor são
// `pt.startsWith('Parecer Regular')` (Quadro 1 do relatório CGE, `index.html:7158`) e
// `/Irregular/i.test(p)` (a cor do selo, `index.html:8652`), e as 7 passam nos dois. A
// igualdade exata só existe no caminho de ESCRITA (`server.js:3282`), e linha já gravada
// nunca é revalidada. Isto aqui é higiene de dado, não conserto de defeito ativo.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ LISTA EXPLÍCITA DE CHAVES — armadilha 12 do CLAUDE.md. O `WHERE` é
// `codigo_pc = ANY($1)` com os 7 códigos escritos aqui, nunca uma condição derivada. Em
// 12/08 reverter por `ci_rodada <> 1` casou 14.639 linhas onde eram 7.
//
// ⚠️ E O `UPDATE` AINDA EXIGE `parecer_tipo = <valor antigo>`. Sem isso, rodar duas vezes
// depois de alguém ter estornado e emitido outro parecer reescreveria o parecer NOVO com o
// texto normalizado. Com isso, a segunda rodada simplesmente não encontra nada.
//
// ⚠️ NÃO TOCA em `baixada`, `data_baixa`, `origem_baixa`, `status`, `analista_id`,
// `registrado_por`, `enviado_ci`, `dt_envio_ci` nem `ci_situacao`. **5 das 7 estão com
// `enviado_ci = true`** e 1 é parcial de TR com ciclo do C.I. aberto: mudar o texto de um
// parecer não pode mexer na baixa nem no ciclo. Há conferência para cada uma dessas colunas
// depois de escrever.
//
// ⚠️ FICA DE FORA, DE PROPÓSITO: as 1.336 PCs com 'Parecer Regular com Ressalva' (singular).
// Vieram da recarga de 05/08, não desta rota, e normalizá-las é decisão de outro tamanho —
// 1.336 linhas contra 7. Não incluir aqui "já que estamos mexendo".
//
//   node normalizar_parecer_ressalvas.js              dry-run: mostra o antes e o depois
//   node normalizar_parecer_ressalvas.js --gravar     grava

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');

const DE   = 'Parecer Regular com Ressalva(s)';
const PARA = 'Parecer Regular com Ressalvas';

// Os 7, levantados do banco em 18/08/2026. Escritos à mão de propósito: se a lista e o banco
// divergirem, a conferência abaixo reclama em vez de o script "se ajustar" sozinho.
const CODIGOS = [
  '2021PC002004',
  '2021TR000777-PFINAL',
  '2021TR001601-PFINAL',
  '2021TR001622-PFINAL',
  '2021TR001657-PFINAL',
  '2021TR001682-PFINAL',
  '2021TR001739-PFINAL',
];

const ARQ_REVERSAO = `reverter_parecer_ressalvas_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

// As colunas que este script promete NÃO tocar, das 7 linhas. Datas já em texto ISO —
// armadilha 25: o `pg` devolve `timestamp` como objeto `Date`, e comparar `Date` como texto
// dá "Thu Aug 13", que passa em qualquer teste de igualdade frouxo.
const SEL_ALVO = `
  SELECT codigo_pc, tr, parcial_num, setorial_id, tipo, parecer_tipo,
         baixada, status, origem_baixa, registrado_por, analista_id,
         enviado_ci, ci_situacao, ci_rodada,
         to_char(data_baixa,  'YYYY-MM-DD HH24:MI:SS') AS data_baixa_iso,
         to_char(dt_envio_ci, 'YYYY-MM-DD HH24:MI:SS') AS dt_envio_ci_iso
    FROM prestacoes_contas
   WHERE codigo_pc = ANY($1)
   ORDER BY codigo_pc`;

// A impressão digital de TODAS as outras 14.651 linhas, no par (codigo_pc, parecer_tipo).
//
// ⚠️ CONTAR NÃO PROVA QUE NÃO MUDARAM — é a lição de 17/08, quando a conferência "nenhum
// outro aviso foi tocado" deixou de ser uma contagem e virou md5. A contagem continuaria
// idêntica se um UPDATE largo tivesse reescrito o parecer de outra linha qualquer.
const SEL_OUTRAS = `
  SELECT COUNT(*)::int AS n,
         COALESCE(md5(string_agg(
           codigo_pc || '|' || COALESCE(parecer_tipo, '-'), ',' ORDER BY codigo_pc)), 'vazio') AS marca
    FROM prestacoes_contas
   WHERE NOT (codigo_pc = ANY($1))`;

// Os totais que sustentam a produtividade e o ciclo do C.I. Se qualquer um mexer, é ROLLBACK.
//
// ⚠️ OS PARÂMETROS SÃO $1 e $2, e não $2/$3 "para casar com as outras consultas". Um $1 que
// a consulta não referencia faz o Postgres recusar com `could not determine data type of
// parameter $1` — o placeholder tem de existir no texto, não só na chamada.
const SEL_TOTAIS = `
  SELECT COUNT(*) FILTER (WHERE baixada)::int                                   AS baixadas,
         COUNT(*) FILTER (WHERE enviado_ci)::int                                AS no_ci,
         COUNT(*) FILTER (WHERE parecer_tipo = $1)::int                         AS com_texto_antigo,
         COUNT(*) FILTER (WHERE parecer_tipo = $2)::int                         AS com_texto_novo,
         COUNT(*) FILTER (WHERE parecer_tipo = 'Parecer Regular com Ressalva')::int AS singular_intocado
    FROM prestacoes_contas`;

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '15s'");

    const { rows: antes } = await cli.query(`${SEL_ALVO} FOR UPDATE`, [CODIGOS]);
    const { rows: [outrasAntes] } = await cli.query(SEL_OUTRAS, [CODIGOS]);
    const { rows: [totAntes] } = await cli.query(SEL_TOTAIS, [DE, PARA]);

    nl('── ANTES ─────────────────────────────────────────────────');
    nl(`   ${antes.length} das ${CODIGOS.length} PCs da lista existem no banco`);
    for (const p of antes) {
      nl(`   ${p.codigo_pc.padEnd(22)} ${p.tr} p${String(p.parcial_num).padEnd(6)} ${p.tipo.padEnd(8)}`
        + ` id ${String(p.analista_id).padEnd(3)} ${p.baixada ? 'baixada' : 'ABERTA '}`
        + ` ${p.enviado_ci ? 'no C.I.' : '       '}  "${p.parecer_tipo}"`);
    }
    nl(`\n   no acervo inteiro: ${totAntes.com_texto_antigo} com "${DE}"`);
    nl(`                      ${totAntes.com_texto_novo} com "${PARA}"`);
    nl(`                      ${totAntes.singular_intocado} com "Parecer Regular com Ressalva" (singular — NAO entram)`);
    nl(`                      ${totAntes.baixadas} baixadas · ${totAntes.no_ci} no C.I.`);

    // ── As recusas, ANTES de escrever ────────────────────────────────────────
    const faltando = CODIGOS.filter(c => !antes.some(p => p.codigo_pc === c));
    if (faltando.length)
      throw new Error(`estas PCs da lista nao existem no banco: ${faltando.join(', ')}`);

    const foraDoEsperado = antes.filter(p => p.parecer_tipo !== DE);
    if (foraDoEsperado.length && foraDoEsperado.length < antes.length)
      throw new Error('lista MISTA — estas ja nao estao com o texto antigo: '
        + foraDoEsperado.map(p => `${p.codigo_pc} ("${p.parecer_tipo}")`).join(', '));

    // Idempotente, como o atualizar_aviso_id6.js: rodar de novo nao estraga.
    if (foraDoEsperado.length === antes.length) {
      await cli.query('ROLLBACK');
      nl(`\n>> Nenhuma das 7 esta com "${DE}". Nada a fazer.`);
      return;
    }

    nl('\n── DEPOIS ────────────────────────────────────────────────');
    nl(`   as ${antes.length} passam a ter "${PARA}"`);
    nl('   nada mais muda: baixada, data_baixa, status, analista_id, registrado_por,');
    nl('   enviado_ci, dt_envio_ci e ci_situacao ficam como estao.');

    // ⚠️ Lista explicita de chaves E o texto antigo no WHERE — as duas travas juntas.
    const { rows: tocadas } = await cli.query(
      `UPDATE prestacoes_contas
          SET parecer_tipo = $3, atualizado_em = NOW()
        WHERE codigo_pc = ANY($1) AND parecer_tipo = $2
        RETURNING codigo_pc`,
      [CODIGOS, DE, PARA]);
    if (tocadas.length !== CODIGOS.length)
      throw new Error(`esperava tocar ${CODIGOS.length} linhas, toquei ${tocadas.length}`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ───────────────────
    // Conferir só antes prova o que se esperava, não o que aconteceu (CLAUDE.md, 16/08).
    const { rows: dep } = await cli.query(SEL_ALVO, [CODIGOS]);
    const { rows: [outrasDep] } = await cli.query(SEL_OUTRAS, [CODIGOS]);
    const { rows: [totDep] } = await cli.query(SEL_TOTAIS, [DE, PARA]);

    const porCodigo = Object.fromEntries(antes.map(p => [p.codigo_pc, p]));
    const igualEm = (campo) => dep.every(d => String(d[campo]) === String(porCodigo[d.codigo_pc][campo]));

    // Linha a linha, o antes e o depois DE VERDADE — lido do banco depois de escrever, e não
    // o que o script prometeu. É a diferença entre "o que eu esperava" e "o que aconteceu".
    nl('\n── AS 7, LIDAS DO BANCO DEPOIS DE ESCREVER ───────────────');
    for (const d of dep) {
      nl(`   ${d.codigo_pc.padEnd(22)} antes: "${porCodigo[d.codigo_pc].parecer_tipo}"`);
      nl(`   ${''.padEnd(22)} depois: "${d.parecer_tipo}"`
        + `   [baixada ${d.baixada} · ci ${d.enviado_ci} · status ${d.status}]`);
    }

    const checks = [
      ['as 7 tem o texto novo',        dep.every(d => d.parecer_tipo === PARA), `${dep.length} linhas`],
      ['nenhuma sobrou com o antigo',  totDep.com_texto_antigo === 0, `${totAntes.com_texto_antigo} -> ${totDep.com_texto_antigo}`],
      ['o total do texto novo subiu 7', totDep.com_texto_novo === totAntes.com_texto_novo + CODIGOS.length,
                                       `${totAntes.com_texto_novo} -> ${totDep.com_texto_novo}`],
      ['o singular ficou INTOCADO',    totDep.singular_intocado === totAntes.singular_intocado,
                                       `${totAntes.singular_intocado} -> ${totDep.singular_intocado}`],
      ['baixada nao mudou',            igualEm('baixada'), 'nas 7'],
      ['data_baixa nao mudou',         igualEm('data_baixa_iso'), 'nas 7'],
      ['status nao mudou',             igualEm('status'), 'nas 7'],
      ['origem_baixa nao mudou',       igualEm('origem_baixa'), 'nas 7'],
      ['registrado_por nao mudou',     igualEm('registrado_por'), 'nas 7'],
      ['analista_id nao mudou',        igualEm('analista_id'), 'nas 7'],
      ['enviado_ci nao mudou',         igualEm('enviado_ci'), 'nas 7'],
      ['dt_envio_ci nao mudou',        igualEm('dt_envio_ci_iso'), 'nas 7'],
      ['ci_situacao nao mudou',        igualEm('ci_situacao'), 'nas 7'],
      ['ci_rodada nao mudou',          igualEm('ci_rodada'), 'nas 7'],
      ['total de baixadas do acervo',  totDep.baixadas === totAntes.baixadas, `${totAntes.baixadas} -> ${totDep.baixadas}`],
      ['total no C.I. do acervo',      totDep.no_ci === totAntes.no_ci, `${totAntes.no_ci} -> ${totDep.no_ci}`],
      ['nenhuma OUTRA PC foi tocada',  outrasDep.n === outrasAntes.n && outrasDep.marca === outrasAntes.marca,
                                       `${outrasDep.n} outras, marca ${outrasDep.marca === outrasAntes.marca ? 'igual' : 'DIFERENTE'}`],
    ];

    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) {
      if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(32)} ${v}`);
    }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      // A lista de reversão é gravada ANTES do COMMIT: se o disco recusar, a transação cai
      // junto e não fica escrita sem como desfazer.
      fs.writeFileSync(ARQ_REVERSAO, JSON.stringify({
        quando: new Date().toISOString(),
        tabela: 'prestacoes_contas',
        coluna: 'parecer_tipo',
        de: DE,
        para: PARA,
        // Para desfazer: UPDATE prestacoes_contas SET parecer_tipo = <de>
        //                 WHERE codigo_pc = ANY(<codigos>) AND parecer_tipo = <para>
        codigos: CODIGOS,
        antes: antes.map(p => ({ codigo_pc: p.codigo_pc, parecer_tipo: p.parecer_tipo })),
      }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   Para desfazer: ${ARQ_REVERSAO}`);
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
