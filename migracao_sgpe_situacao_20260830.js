// CAMINHO: sigpc-api/migracao_sgpe_situacao_20260830.js
//
// Cria as DUAS TABELAS da sincronização do SGPe (FASE 3): `sgpe_situacao` e `sgpe_tramitacao`.
// NÃO grava situação nenhuma — quem preenche é o `job_sgpe_situacao.js`. Aqui só nasce a
// estrutura.
//
// USO
//   node migracao_sgpe_situacao_20260830.js              # dry-run: mostra e não toca em nada
//   node migracao_sgpe_situacao_20260830.js --gravar     # cria, confere e faz COMMIT
//
// ⚠️ SÓ CRIA. Não há DROP, não há ALTER de coluna existente, não há UPDATE em tabela alguma
// que já exista — e há conferência que recusa o COMMIT se qualquer tabela anterior tiver
// mudado de tamanho ou de forma. O motivo do rigor é a armadilha 2 do projeto
// (`CREATE TABLE IF NOT EXISTS` não altera tabela existente): se uma destas duas JÁ EXISTIR
// com outro formato, o `IF NOT EXISTS` passa em silêncio e a rodada seguinte grava errado.
// Por isso a forma é conferida COLUNA A COLUNA depois de criar, e não só a existência.
//
// ⚠️ SEM CHAVE ESTRANGEIRA, por decisão do Richard: o histórico de tramitação tem de
// sobreviver a qualquer limpeza de `sgpe_processo_ref` ou de `prestacoes_contas`. É o mesmo
// motivo do `parcela_historico.executado_por`.

const fs = require('fs');
const { Pool } = require('pg');
const sit = require('./lib/sgpe-situacao');
const { escreverReversao } = require('./lib/reversao');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = 'reverter_sgpe_situacao_20260830.json';

const TABELAS = ['sgpe_situacao', 'sgpe_tramitacao'];

// A forma esperada, coluna a coluna. É esta lista que a conferência compara — não a contagem.
const FORMA = {
  sgpe_situacao: [
    ['sigla', 'text', 'NO'], ['numero_oficial', 'integer', 'NO'], ['ano', 'integer', 'NO'],
    ['resultado', 'text', 'NO'], ['situacao_portal', 'text', 'YES'], ['estado_portal', 'text', 'YES'],
    ['posicao', 'text', 'YES'], ['setor_sigla', 'text', 'YES'], ['setor_nome', 'text', 'YES'],
    ['dias_no_setor', 'integer', 'YES'], ['desde', 'date', 'YES'], ['tramitacoes', 'integer', 'YES'],
    ['erro_motivo', 'text', 'YES'], ['checado_em', 'timestamp with time zone', 'NO'],
  ],
  sgpe_tramitacao: [
    ['sigla', 'text', 'NO'], ['numero_oficial', 'integer', 'NO'], ['ano', 'integer', 'NO'],
    ['ordem', 'integer', 'NO'], ['setor_sigla', 'text', 'YES'], ['setor_nome', 'text', 'YES'],
    ['cd_orgao', 'integer', 'YES'], ['dt_recebto', 'date', 'YES'], ['dt_encaminha', 'date', 'YES'],
    ['permanencia_dias', 'integer', 'YES'], ['quem_encaminhou', 'text', 'YES'],
    ['parecer', 'text', 'YES'], ['atualizado_em', 'timestamp with time zone', 'NO'],
  ],
};

const log = (s) => console.log(s);
let ok = 0, mau = 0;
function conf(v, r) { if (v) { ok++; log('    OK    ' + r) } else { mau++; log('    FALHA ' + r) } }

async function forma(cli, tabela) {
  const { rows } = await cli.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tabela]);
  return rows.map(r => [r.column_name, r.data_type, r.is_nullable]);
}

async function chavePrimaria(cli, tabela) {
  const { rows } = await cli.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`, [tabela]);
  return rows.map(r => r.attname);
}

/** A foto: TODAS as tabelas do schema, com o tamanho de cada uma. */
async function foto(cli) {
  const { rows } = await cli.query(
    `SELECT c.relname AS tabela, c.relkind, c.relnatts AS colunas
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m')
      ORDER BY c.relname`);
  const linhas = {};
  for (const r of rows) {
    if (r.relkind !== 'r') continue;
    const { rows: [c] } = await cli.query(`SELECT count(*)::int AS n FROM "${r.tabela}"`);
    linhas[r.tabela] = c.n;
  }
  return { tabelas: rows.map(r => `${r.tabela}:${r.relkind}:${r.colunas}`), linhas };
}

async function rodar() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await db.connect();
  try {
    log('\n═══ MIGRAÇÃO — as tabelas da sincronização do SGPe (FASE 3) ═══');
    log(GRAVAR ? '  MODO: GRAVAÇÃO\n' : '  MODO: DRY-RUN — nada será gravado\n');

    await cli.query('BEGIN');

    // ── A FOTO, ANTES ────────────────────────────────────────────────────────
    const antes = await foto(cli);
    const jaExistiam = TABELAS.filter(t => antes.linhas[t] !== undefined);
    log('  ── O ESTADO DE AGORA ──');
    log(`    tabelas no schema ....... ${antes.tabelas.length}`);
    log(`    sgpe_situacao ........... ${antes.linhas.sgpe_situacao === undefined ? 'NÃO EXISTE' : antes.linhas.sgpe_situacao + ' linhas'}`);
    log(`    sgpe_tramitacao ......... ${antes.linhas.sgpe_tramitacao === undefined ? 'NÃO EXISTE' : antes.linhas.sgpe_tramitacao + ' linhas'}`);
    log(`    sgpe_processo_ref ....... ${antes.linhas.sgpe_processo_ref} linhas  (não é tocada)`);
    log(`    prestacoes_contas ....... ${antes.linhas.prestacoes_contas} linhas  (não é tocada)`);

    // ── O UNIVERSO QUE ESTAS TABELAS VÃO COBRIR ──────────────────────────────
    const { chavesDeValores } = require('./lib/sgpe-lote');
    const { formatarProcesso } = require('./lib/sgpe-link');
    const { rows: brutos } = await cli.query(sit.SQL_UNIVERSO);
    const alvos = new Map();
    for (const p of chavesDeValores(brutos.map(r => r.v)).values()) alvos.set(formatarProcesso(p), p);
    log(`\n  ── O UNIVERSO ──`);
    log(`    processos distintos ..... ${alvos.size}  (processo_pc ∪ processo_mae, normalizados)`);
    log(`    ciclo completo .......... ${Math.ceil(alvos.size / 300)} rodadas de 300`);

    log('\n  ── O QUE SERIA CRIADO ──');
    for (const t of TABELAS) {
      log(`    ${t.padEnd(18)} ${antes.linhas[t] === undefined ? 'CREATE TABLE (' + FORMA[t].length + ' colunas, sem FK)' : 'já existe — CREATE IF NOT EXISTS não faz nada'}`);
    }
    log(`    ix_sgpe_situacao_rodizio  CREATE INDEX (checado_em ASC NULLS FIRST)`);

    // ── A ESCRITA ────────────────────────────────────────────────────────────
    // ⚠️ O DDL RODA TAMBÉM NO DRY-RUN, E É DE PROPÓSITO. No Postgres o DDL é TRANSACIONAL:
    // `CREATE TABLE` dentro de `BEGIN` some no `ROLLBACK` sem deixar rastro. Rodá-lo aqui é o
    // que permite mostrar as CONFERÊNCIAS DE VERDADE antes de alguém autorizar a gravação —
    // um dry-run que sai antes de criar só consegue prometer o que as conferências fariam, e
    // promessa não é conferência. O que separa os dois modos é o COMMIT, e só ele.
    //
    // (Isto não vale em todo banco: no MySQL o DDL faz commit implícito e este mesmo código
    // gravaria de verdade. Aqui é Postgres, e o `ROLLBACK` do fim é conferido logo depois.)
    await cli.query(sit.DDL_SITUACAO);
    await cli.query(sit.DDL_TRAMITACAO);
    await cli.query(sit.DDL_INDICE);

    // ── AS CONFERÊNCIAS, CONTRA A FOTO ───────────────────────────────────────
    log(`\n  ── CONFERÊNCIAS (depois de criar, dentro da mesma transação${GRAVAR ? '' : ' — que será desfeita'}) ──`);
    const depois = await foto(cli);

    for (const t of TABELAS) {
      conf(depois.linhas[t] !== undefined, `${t} existe`);
      const f = await forma(cli, t);
      const esperada = FORMA[t];
      conf(f.length === esperada.length, `${t} tem ${esperada.length} colunas (achei ${f.length})`);
      const igual = f.length === esperada.length &&
        f.every((c, i) => c[0] === esperada[i][0] && c[1] === esperada[i][1] && c[2] === esperada[i][2]);
      conf(igual, `${t} tem a forma esperada — nome, tipo e nulabilidade de cada coluna`);
      if (!igual) {
        for (let i = 0; i < Math.max(f.length, esperada.length); i++) {
          const a = f[i] ? f[i].join(' ') : '(falta)';
          const b = esperada[i] ? esperada[i].join(' ') : '(sobra)';
          if (a !== b) log(`        col ${i}: achei "${a}" · esperava "${b}"`);
        }
      }
    }

    conf((await chavePrimaria(cli, 'sgpe_situacao')).join(',') === 'sigla,numero_oficial,ano',
         'a chave de sgpe_situacao é a tripla (sigla, numero_oficial, ano)');
    // ⚠️ É esta chave que faz "rodar duas vezes não duplica linha".
    conf((await chavePrimaria(cli, 'sgpe_tramitacao')).join(',') === 'sigla,numero_oficial,ano,ordem',
         'e a de sgpe_tramitacao inclui a ORDEM — é a chave do trâmite');

    const { rows: [ix] } = await cli.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='ix_sgpe_situacao_rodizio'`);
    conf(!!ix, 'o índice do rodízio existe');
    conf(!!ix && /checado_em\s+NULLS FIRST/i.test(ix.indexdef),
         'e ele é ASC NULLS FIRST — quem nunca foi checado vem primeiro');

    // ⚠️ SEM FK, e a conferência é explícita: uma FK criada por engano só apareceria no dia em
    // que alguém apagasse uma linha do cache e a exclusão falhasse.
    const { rows: fks } = await cli.query(
      `SELECT conname, conrelid::regclass::text AS t FROM pg_constraint
        WHERE contype='f' AND conrelid::regclass::text = ANY($1::text[])`, [TABELAS]);
    conf(fks.length === 0, `nenhuma chave estrangeira nas duas tabelas (achei ${fks.length})`);

    conf(depois.linhas.sgpe_situacao === 0 && depois.linhas.sgpe_tramitacao === 0,
         'as duas nascem VAZIAS — esta migração não grava situação nenhuma');

    // ── E NADA MAIS MUDOU ────────────────────────────────────────────────────
    const novas = depois.tabelas.filter(t => !antes.tabelas.includes(t));
    const sumiram = antes.tabelas.filter(t => !depois.tabelas.includes(t));
    conf(sumiram.length === 0, `nenhuma tabela sumiu (achei ${sumiram.length})`);
    const esperadasNovas = TABELAS.filter(t => !jaExistiam.includes(t)).length;
    conf(novas.length === esperadasNovas, `nasceram exatamente ${esperadasNovas} tabelas: ${novas.join(', ') || '(nenhuma)'}`);

    let mexidas = [];
    for (const t of Object.keys(antes.linhas)) {
      if (antes.linhas[t] !== depois.linhas[t]) mexidas.push(`${t} ${antes.linhas[t]}→${depois.linhas[t]}`);
    }
    conf(mexidas.length === 0, `nenhuma tabela anterior mudou de tamanho${mexidas.length ? ': ' + mexidas.join(' · ') : ''}`);

    log(`\n  ── ${ok} conferências passaram · ${mau} falharam ──`);
    if (mau) {
      await cli.query('ROLLBACK');
      log('\n  ROLLBACK — alguma conferência falhou. NADA foi criado.\n');
      return 1;
    }

    if (!GRAVAR) {
      await cli.query('ROLLBACK');
      log('\n  ── DRY-RUN: ROLLBACK. ──');
      // ⚠️ E A PROVA DE QUE O ROLLBACK LIMPOU vem de OUTRA CONEXÃO. Perguntar pela mesma
      // seria perguntar a quem acabou de desfazer; e o `information_schema` dentro da
      // transação abortada mostraria o mundo antes dela. Aqui a pergunta sai do pool, por
      // fora — é a única leitura que prova o que o resto do banco enxerga.
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_name = ANY($1::text[])`, [TABELAS]);
      const sobrou = rows.map(r => r.table_name);
      log(`  as duas tabelas existem agora? ${sobrou.length ? 'SIM — ' + sobrou.join(', ') + ' <<< PROBLEMA' : 'NÃO. O ROLLBACK levou tudo.'}`);
      log('\n  Para gravar:  node migracao_sgpe_situacao_20260830.js --gravar\n');
      return sobrou.length ? 1 : 0;
    }

    // ⚠️ A REVERSÃO É ESCRITA ANTES DO COMMIT. Depois dele o processo pode morrer, e o caminho
    // de volta não existiria — que é a armadilha 26, agora com a proteção do lib/reversao.js.
    const r = escreverReversao(REVERSAO, {
      modo: 'gravacao',
      script: 'migracao_sgpe_situacao_20260830.js',
      em: new Date().toISOString(),
      criou: TABELAS.filter(t => !jaExistiam.includes(t)),
      ja_existiam: jaExistiam,
      // Não há dado a restaurar: as tabelas nascem vazias. O caminho de volta é derrubá-las —
      // e só as que ESTA rodada criou.
      desfazer: TABELAS.filter(t => !jaExistiam.includes(t)).map(t => `DROP TABLE ${t}`),
      universo_no_momento: alvos.size,
    });
    log(`  reversão gravada em ${r.caminho}${r.preservou ? ` (preservou ${r.preservou})` : ''}`);

    await cli.query('COMMIT');
    log('\n  ✅ COMMIT. As duas tabelas existem e estão vazias.');
    log('  Próximo passo:  node job_sgpe_situacao.js --limite=20 --gravar\n');
    return 0;
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch (_) {}
    console.error('\n  ERRO:', e.message, '\n  ROLLBACK executado.\n');
    return 1;
  } finally {
    cli.release();
    await db.end();
  }
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL não definida.'); process.exit(1) }
  rodar().then(c => process.exit(c));
}

module.exports = { FORMA, TABELAS };
