// CAMINHO: sigpc-api/migracao_estado_anterior_20260826.js
//
// A FOTO DO ESTADO ANTERIOR NO `parcela_historico` — coluna `estado_anterior jsonb`.
// Autorizada pelo Richard em 26/08/2026.
//
//   node migracao_estado_anterior_20260826.js              (DRY-RUN — nao grava nada)
//   node migracao_estado_anterior_20260826.js --gravar     (grava)
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTA COLUNA EXISTE
//
// O `POST /parcela/puxar_ci` escreve 20 colunas de `prestacoes_contas` e o
// `parcela_historico` guardava UMA delas (o `ci_situacao`, em `valor_anterior`). `dt_envio_ci`,
// `parecer_tipo`, `baixada`, `estornada`, `enviado_ci_por`, `ci_rodada`, `baixado_por`,
// `status` e `situacao_atual` viravam NULL/false sem copia em lugar nenhum: era o unico evento
// do sistema que destruia dado sem caminho de volta. Refazer a mao gerava `data_baixa` NOVA e
// movia a produtividade de mes.
//
// ⚠️ A COLUNA NASCE NULA EM TODAS AS LINHAS, E FICA ASSIM. Nao ha backfill, e nao pode haver:
// as seis puxadas de 20 a 24/08 nao tem foto porque os valores nunca foram gravados, e deduzi-
// los do evento `ci` anterior foi medido e reprovado (12 PCs sem evento `ci`, 6 divergencias de
// ate 21 s no `dt_envio_ci`, 2 parcelas com `dt_envio_ci` diferente entre PCs irmas). Decisao
// do Richard, 26/08: inventar valor e pior que o buraco, com a auditoria da CGE em cima.
//
// ⚠️ ESTE SCRIPT NAO TOCA EM LINHA NENHUMA. Ele so acrescenta a coluna. As nove conferencias
// existem para PROVAR isso — inclusive um `md5` do conteudo inteiro da tabela antes e depois,
// porque contar linhas nao prova que elas nao mudaram (a licao do aviso id 6, em 17/08).

const { Pool } = require('pg');
const fs = require('fs');

const GRAVAR = process.argv.includes('--gravar');
const TABELA = 'parcela_historico';
const COLUNA = 'estado_anterior';
const TIPO = 'jsonb';

const ARQ_REVERSAO = GRAVAR
  ? 'reverter_estado_anterior_20260826.json'
  : 'reverter_estado_anterior_20260826_DRYRUN.json';

// ⚠️ O DRY-RUN NUNCA SOBRESCREVE A REVERSAO DA GRAVACAO. Sao dois nomes de arquivo, e nao um
// com flag: um dry-run rodado depois da gravacao apagaria o unico registro de como voltar.
// E o mesmo cuidado do `reverter_aviso_reabertura_20260826_DRYRUN.json`.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const linha = (t) => console.log(t);
const passo = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);

let confOk = 0, confFalhou = 0;
function conferir(nome, cond, detalhe) {
  if (cond) { confOk++; linha(`   OK    ${nome}`); }
  else { confFalhou++; linha(`   FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
  return cond;
}

// A foto da tabela: existe a coluna? quantas linhas? e o md5 do conteudo de todas elas.
//
// ⚠️ O `md5` COBRE AS DEZ COLUNAS EXISTENTES, uma a uma, com separador. Um `md5` do
// `to_jsonb(linha)` mudaria sozinho quando a coluna nova entrasse — e a conferencia que
// deveria provar "nada mudou" acusaria a propria migracao.
const SQL_FOTO_TABELA = `
  SELECT
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2)                              AS tem_coluna,
    (SELECT data_type FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2)                              AS tipo_coluna,
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = $1)                                                   AS n_colunas,
    (SELECT COUNT(*)::int FROM parcela_historico)                              AS n_linhas,
    (SELECT COUNT(*)::int FROM parcela_historico WHERE evento = 'puxar_ci')    AS n_puxadas,
    (SELECT md5(COALESCE(string_agg(t.assinatura, chr(30) ORDER BY t.id), ''))
       FROM (SELECT id,
                    -- Separador EXPLICITO entre os campos, e via chr(): concatenar sem
                    -- separador faz ('ab','c') e ('a','bc') darem a mesma assinatura, e um
                    -- byte de controle CRU no fonte e o que quebrou o avisar.ps1.
                    concat_ws(chr(31), id, tr, parcial_num, setorial_id, evento,
                              valor_anterior, valor_novo, analista_id, observacao,
                              executado_por, criado_em) AS assinatura
               FROM parcela_historico) t)                                      AS md5_conteudo`;

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('═══════════════════════════════════════════════════════════════════════');
    linha(`  FOTO DO ESTADO ANTERIOR — ${TABELA}.${COLUNA} ${TIPO}`);
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('═══════════════════════════════════════════════════════════════════════');

    await cli.query('BEGIN');

    // ── 1. A FOTO, ANTES ─────────────────────────────────────────────────────
    passo('1. FOTO DE ANTES');
    const { rows: a } = await cli.query(SQL_FOTO_TABELA, [TABELA, COLUNA]);
    const antes = a[0];
    linha(`   coluna ${COLUNA} existe? ....... ${antes.tem_coluna ? 'SIM (' + antes.tipo_coluna + ')' : 'nao'}`);
    linha(`   colunas na tabela ............. ${antes.n_colunas}`);
    linha(`   linhas de historico ........... ${antes.n_linhas}`);
    linha(`   dessas, eventos puxar_ci ...... ${antes.n_puxadas}`);
    linha(`   md5 do conteudo ............... ${antes.md5_conteudo}`);

    // ── 2. IDEMPOTENCIA ──────────────────────────────────────────────────────
    passo('2. IDEMPOTENCIA');
    if (antes.tem_coluna) {
      linha(`   A coluna ${COLUNA} JA EXISTE (${antes.tipo_coluna}). Nada a fazer.`);
      if (antes.tipo_coluna !== TIPO)
        linha(`   ⚠️  MAS O TIPO E ${antes.tipo_coluna}, e o esperado e ${TIPO}. Conferir a mao.`);
      await cli.query('ROLLBACK');
      linha('\n   ROLLBACK — nenhuma alteracao. Rodar de novo nao estraga.');
      return;
    }
    linha(`   A coluna ${COLUNA} nao existe. Ha o que fazer.`);

    // ── 3. O QUE VAI SER FEITO ───────────────────────────────────────────────
    passo('3. O COMANDO');
    const DDL = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COLUNA} ${TIPO}`;
    linha(`   ${DDL}`);
    linha('');
    linha('   Efeito no dado existente: NENHUM. As ' + antes.n_linhas + ' linhas ficam com');
    linha('   ' + COLUNA + ' = NULL, inclusive as ' + antes.n_puxadas + ' puxadas — elas NAO tem');
    linha('   foto e nao vao ganhar uma. Ver o cabecalho deste arquivo.');

    await cli.query(DDL);

    // ── 4. AS CONFERENCIAS, CONTRA A FOTO, DEPOIS DE ESCREVER ────────────────
    passo('4. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO_TABELA, [TABELA, COLUNA]);
    const depois = d[0];

    conferir('1. a coluna passou a existir', depois.tem_coluna === 1);
    conferir(`2. o tipo dela e ${TIPO}`, depois.tipo_coluna === TIPO, `veio ${depois.tipo_coluna}`);
    conferir('3. a tabela ganhou exatamente UMA coluna',
      depois.n_colunas === antes.n_colunas + 1, `${antes.n_colunas} -> ${depois.n_colunas}`);
    conferir('4. o numero de linhas nao mudou',
      depois.n_linhas === antes.n_linhas, `${antes.n_linhas} -> ${depois.n_linhas}`);
    conferir('5. o numero de puxadas nao mudou',
      depois.n_puxadas === antes.n_puxadas, `${antes.n_puxadas} -> ${depois.n_puxadas}`);
    // ⚠️ A conferencia que importa: NENHUMA LINHA FOI TOCADA. Contar linhas nao prova isso.
    conferir('6. o md5 do conteudo e IDENTICO — nenhuma linha foi tocada',
      depois.md5_conteudo === antes.md5_conteudo,
      `${antes.md5_conteudo} -> ${depois.md5_conteudo}`);

    const { rows: nn } = await cli.query(
      `SELECT COUNT(*)::int n FROM ${TABELA} WHERE ${COLUNA} IS NOT NULL`);
    conferir('7. nenhuma linha nasceu com foto (todas NULL)', nn[0].n === 0, `${nn[0].n} com valor`);

    const { rows: nul } = await cli.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`, [TABELA, COLUNA]);
    conferir('8. a coluna aceita NULL e nao tem DEFAULT',
      nul[0].is_nullable === 'YES' && nul[0].column_default === null,
      `nullable=${nul[0].is_nullable} default=${nul[0].column_default}`);

    // A prova de que a coluna serve para o que foi feita: um round-trip de jsonb.
    const { rows: rt } = await cli.query(
      `SELECT ($1::jsonb -> 'x' ->> 'dt')::timestamp = $2::timestamp AS bate`,
      ['{"x":{"dt":"2026-06-30T00:00:00"}}', '2026-06-30 00:00:00']);
    conferir('9. jsonb devolve o timestamp sem mexer no fuso (armadilha 18)', rt[0].bate === true);

    // ── 5. REVERSAO ──────────────────────────────────────────────────────────
    passo('5. JSON DE REVERSAO');
    const reversao = {
      script: 'migracao_estado_anterior_20260826.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 26/08/2026',
      alterou: { tabela: TABELA, coluna: COLUNA, tipo: TIPO, comando: DDL },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      // ⚠️ A REVERSAO E UM `DROP COLUMN`, E ELA APAGA AS FOTOS JA TIRADAS. Se alguma puxada
      // tiver acontecido depois desta migracao, reverter destroi a unica copia do estado
      // anterior daquelas PCs — e o desfazer delas some junto. Conferir antes:
      //   SELECT COUNT(*) FROM parcela_historico WHERE estado_anterior IS NOT NULL;
      reverter_com: `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COLUNA}`,
      aviso_reversao:
        'O DROP COLUMN apaga as fotos ja tiradas. Conferir antes: SELECT COUNT(*) FROM '
        + 'parcela_historico WHERE estado_anterior IS NOT NULL; se for > 0, reverter tira o '
        + 'caminho de volta daquelas puxadas.',
    };
    fs.writeFileSync(ARQ_REVERSAO, JSON.stringify(reversao, null, 2), 'utf8');
    linha(`   escrito: ${ARQ_REVERSAO}`);
    linha(`   reverter com: ${reversao.reverter_com}`);

    // ── 6. COMMIT OU ROLLBACK ────────────────────────────────────────────────
    passo('6. DESFECHO');
    linha(`   conferencias: ${confOk} passaram · ${confFalhou} falharam`);

    if (confFalhou > 0) {
      await cli.query('ROLLBACK');
      linha('\n   ✖ ROLLBACK — alguma conferencia falhou. Nada foi gravado.');
      process.exitCode = 1;
      return;
    }
    if (!GRAVAR) {
      await cli.query('ROLLBACK');
      linha('\n   ROLLBACK — DRY-RUN. Nada foi gravado.');
      linha('   Para gravar: node migracao_estado_anterior_20260826.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha('\n   ✔ COMMIT — a coluna esta gravada.');
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\n   ✖ ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) linha('\n   Reinicie a API (o boot tem garantirFotoHistorico e e idempotente).');
  }
})();
