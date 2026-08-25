// CAMINHO: sigpc-api/migracao_ci_por_pc_20260825.js
//
// O RESPONSÁVEL DO C.I. PASSA A SER DA PC. PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ═══ O QUE ESTE SCRIPT ESCREVE, EXATAMENTE ═══
//
//   prestacoes_contas.ci_tecnico_id   integer    NULL permitido · SEM default · SEM foreign key
//   prestacoes_contas.ci_tecnico_em   timestamp  NULL permitido · SEM default   (without time zone)
//   índice parcial pc_ci_tecnico_idx  (ci_tecnico_id) WHERE ci_situacao IS NOT NULL
//   ci_responsavel                    RENOMEADA para ci_responsavel_backup_20260825
//
// ⚠️ AS DUAS COLUNAS NASCEM NULAS, E O NULO TEM SIGNIFICADO: "ninguém do C.I. está com esta
// PC". Um DEFAULT qualquer inventaria um dono para 14.658 linhas, e um `NOT NULL` exigiria
// esse dono inventado. É a mesma escolha do `parcela_historico.executado_por`, onde o nulo
// quer dizer "foi ele mesmo".
//
// ⚠️ SEM FOREIGN KEY para `usuarios`, e de propósito — a mesma razão do
// `parcela_historico.executado_por`: existe `DELETE /usuarios/:id`, e uma FK faria a exclusão
// de um cadastro falhar por causa de uma PC que aquela pessoa abriu meses atrás.
// **Trilha não trava cadastro**, e responsável de fila também não.
//
// ⚠️ `ci_tecnico_em` É `timestamp WITHOUT time zone` GUARDANDO UTC, como as irmãs
// `ci_encerrado_em`, `dt_envio_ci` e `parcela_historico.criado_em`. Quem for exibi-la precisa
// dos DOIS passos do `AT TIME ZONE` — armadilha 18. Uma coluna `timestamptz` aqui seria a
// única do grupo com outra semântica, e é assim que uma hora vira 03:31 às 21:31.
//
// ═══ NADA É APAGADO ═══
//
// ⚠️ A `ci_responsavel` É RENOMEADA, NUNCA DERRUBADA (ordem do Richard, 25/08/2026). Ela está
// vazia — 0 linhas, medidas — e mesmo assim o `DROP` sai: uma tabela renomeada volta com um
// comando e um `DROP` não volta com nenhum. O custo de deixá-la de lado é um nome no
// `information_schema`; o custo de derrubá-la é irreversível.
//
// ⚠️ O NOME LEVA O SUFIXO `_backup_20260825`, e não o prefixo `_backup_` das outras
// (`_backup_parcial_num_20260805`, `_backup_nomevazio_20260816`). Foi pedido assim, e o
// sufixo tem a vantagem de manter as duas juntas na ordem alfabética — quem listar as tabelas
// vê `ci_responsavel_backup_20260825` logo abaixo de onde `ci_responsavel` estaria.
//
// ═══ IDEMPOTENTE: RODAR DE NOVO NÃO ESTRAGA ═══
//
//   · as colunas usam `ADD COLUMN IF NOT EXISTS` (armadilha 2 — `CREATE TABLE IF NOT EXISTS`
//     não altera tabela existente, mas `ADD COLUMN IF NOT EXISTS` é o que resolve);
//   · o índice usa `CREATE INDEX IF NOT EXISTS`;
//   · o rename é condicional: só acontece se `ci_responsavel` ainda existir E o backup ainda
//     não existir. Na segunda rodada ele simplesmente não entra no plano;
//   · e a conferência "as colunas nascem nulas" só roda quando elas foram criadas AGORA —
//     senão a segunda rodada daria ROLLBACK por causa do trabalho legítimo feito no meio.
//
// ⚠️ AS CONFERÊNCIAS COMPARAM COM UMA FOTO DO INÍCIO DA TRANSAÇÃO, nunca com número literal
// (armadilha 21). A primeira versão deste arquivo cravava `= 1189` para a fila; três dias
// depois eram 1.193, e a migração teria abortado sozinha por um número que envelheceu.
//
// USO:
//   node migracao_ci_por_pc_20260825.js              dry-run
//   node migracao_ci_por_pc_20260825.js --gravar     grava
//
// ⚠️ Escrita em produção EXIGE ordem expressa do Richard (regra 1 do time de agentes).

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = __dirname + '/reverter_ci_por_pc_20260825.json';
const BACKUP = 'ci_responsavel_backup_20260825';

// As tabelas que esta migração não pode ter tocado. Conferidas linha a linha, antes e depois,
// dentro da mesma transação.
const INTOCADAS = ['prestacoes_contas', 'parcela_historico', 'usuarios', 'notificacao'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;
  try {
    // ── 1. O ESTADO DE AGORA ─────────────────────────────────────────────────
    const est = (await cli.query(`
      SELECT to_regclass('public.ci_responsavel') IS NOT NULL              AS tem_tabela,
             to_regclass('public.${BACKUP}')      IS NOT NULL              AS tem_backup,
             (SELECT COUNT(*)::int FROM information_schema.columns
               WHERE table_name = 'prestacoes_contas'
                 AND column_name IN ('ci_tecnico_id','ci_tecnico_em'))     AS colunas,
             (SELECT COUNT(*)::int FROM pg_indexes
               WHERE indexname = 'pc_ci_tecnico_idx')                      AS indice,
             (SELECT COUNT(*)::int FROM parcela_historico
               WHERE evento LIKE 'ci\\_%')                                 AS hist`)).rows[0];
    const linhas = est.tem_tabela
      ? (await cli.query(`SELECT COUNT(*)::int n FROM ci_responsavel`)).rows[0].n : 0;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  O RESPONSÁVEL DO C.I. PASSA A SER DA PC — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════');
    console.log('\n── ESTADO DE AGORA');
    console.log(`   ci_responsavel existe? ............. ${est.tem_tabela ? 'sim' : 'não'}`);
    console.log(`   ci_responsavel tem quantas linhas? . ${linhas}`);
    console.log(`   ${BACKUP} já existe? ..... ${est.tem_backup ? 'sim' : 'não'}`);
    console.log(`   eventos ci_* no parcela_historico .. ${est.hist}`);
    console.log(`   colunas por PC já criadas .......... ${est.colunas} de 2`);
    console.log(`   índice pc_ci_tecnico_idx já existe . ${est.indice ? 'sim' : 'não'}`);

    // ⚠️ A TRAVA. Se alguém tiver assumido uma TR entre a medição e a execução, esta migração
    // esconderia esse trabalho num backup sem avisar. Não é "é só uma tabela vazia": é uma
    // tabela vazia AGORA, e a conferência é o que garante que continue sendo na hora de rodar.
    if (linhas > 0 || est.hist > 0) {
      throw new Error(`ci_responsavel tem ${linhas} linha(s) e o histórico ${est.hist} evento(s) — ` +
                      `há trabalho a migrar. Esta migração pressupõe tabela vazia; pare e reavalie.`);
    }
    if (est.tem_tabela && est.tem_backup) {
      throw new Error(`existem AS DUAS: ci_responsavel e ${BACKUP}. ` +
                      `Renomear por cima misturaria duas coisas diferentes; resolva à mão antes.`);
    }

    // ── 2. O PLANO ───────────────────────────────────────────────────────────
    const DDL = [];
    DDL.push([`ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS ci_tecnico_id integer`,
              `cria prestacoes_contas.ci_tecnico_id — integer, NULL permitido, SEM default, SEM FK`]);
    DDL.push([`ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS ci_tecnico_em timestamp`,
              `cria prestacoes_contas.ci_tecnico_em — timestamp without time zone (UTC), NULL permitido, SEM default`]);
    DDL.push([`CREATE INDEX IF NOT EXISTS pc_ci_tecnico_idx ON prestacoes_contas (ci_tecnico_id)
                 WHERE ci_situacao IS NOT NULL`,
              `cria o índice parcial do recorte por técnico`]);
    if (est.tem_tabela) {
      DDL.push([`ALTER TABLE ci_responsavel RENAME TO ${BACKUP}`,
                `RENOMEIA ci_responsavel → ${BACKUP} — nada é apagado`]);
    }

    console.log('\n── O QUE SERÁ EXECUTADO');
    if (!DDL.length) console.log('   (nada — já está tudo no lugar)');
    DDL.forEach(([sql, o], i) => {
      console.log(`   ${i + 1}. ${o}`);
      console.log(`      ${sql.replace(/\s+/g, ' ').trim()}`);
    });

    console.log('\n── O QUE NÃO É TOCADO');
    console.log('   Nenhuma LINHA de prestacoes_contas é reescrita — só se ACRESCENTAM duas');
    console.log('   colunas, que nascem NULAS em todas as 14.658. ci_situacao, ci_rodada,');
    console.log('   ci_encerrado_em, ci_encerrado_por, baixada, data_baixa e enviado_ci ficam');
    console.log('   exatamente como estão. Nenhum DROP, nenhum DELETE, nenhum UPDATE.');
    if (!est.tem_tabela && est.tem_backup) {
      console.log(`\n   (a ci_responsavel já foi renomeada numa rodada anterior — nada a fazer nela)`);
    }

    if (!GRAVAR) {
      console.log('\n── DRY-RUN. Nada foi gravado. Rode com --gravar para executar.\n');
      return;
    }

    // ── 3. A TRANSAÇÃO ───────────────────────────────────────────────────────
    await cli.query('BEGIN');

    // ⚠️ A FOTO DO INÍCIO DA RODADA, e não um número literal (armadilha 21). A pergunta é
    // "esta rodada mexeu no que não devia?", e não "algo mudou desde que eu escrevi o script?".
    const antes = {};
    for (const t of INTOCADAS) antes[t] = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
    const cicloAntes = (await cli.query(
      `SELECT COALESCE(ci_situacao,'(nulo)') s, COUNT(*)::int n FROM prestacoes_contas
        GROUP BY 1 ORDER BY 1`)).rows;
    const baixaAntes = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE baixada)::int b,
              COUNT(*) FILTER (WHERE enviado_ci)::int e,
              COUNT(*) FILTER (WHERE data_baixa IS NOT NULL)::int d FROM prestacoes_contas`)).rows[0];

    for (const [sql] of DDL) await cli.query(sql);

    // ── 4. CONFERIR DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ───────────────────
    //
    // ⚠️ Conferir só ANTES prova o que se esperava, não o que aconteceu. Se qualquer uma
    // falhar, é ROLLBACK — e o banco fica exatamente como estava.
    console.log('\n── CONFERÊNCIA DEPOIS DE GRAVAR (dentro da transação)');
    let falhou = 0;
    const check = async (sql, rot) => {
      const ok = (await cli.query(sql)).rows[0].ok;
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${rot}`);
    };

    await check(`SELECT COUNT(*) = 2 AS ok FROM information_schema.columns
                  WHERE table_name = 'prestacoes_contas'
                    AND column_name IN ('ci_tecnico_id','ci_tecnico_em')`,
                'as duas colunas por PC existem');
    await check(`SELECT bool_and(is_nullable = 'YES' AND column_default IS NULL) AS ok
                   FROM information_schema.columns
                  WHERE table_name = 'prestacoes_contas'
                    AND column_name IN ('ci_tecnico_id','ci_tecnico_em')`,
                'as duas aceitam NULL e não têm default');
    await check(`SELECT bool_and(t.ok) AS ok FROM (
                   SELECT (column_name = 'ci_tecnico_id' AND data_type = 'integer')
                       OR (column_name = 'ci_tecnico_em' AND data_type = 'timestamp without time zone') AS ok
                     FROM information_schema.columns
                    WHERE table_name = 'prestacoes_contas'
                      AND column_name IN ('ci_tecnico_id','ci_tecnico_em')) t`,
                'com os tipos certos — integer e timestamp without time zone');
    await check(`SELECT NOT EXISTS (
                   SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'prestacoes_contas'::regclass AND c.contype = 'f'
                      AND c.conkey && (SELECT array_agg(attnum) FROM pg_attribute
                                        WHERE attrelid = 'prestacoes_contas'::regclass
                                          AND attname IN ('ci_tecnico_id','ci_tecnico_em'))) AS ok`,
                'e sem foreign key — trilha não trava cadastro');
    await check(`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'pc_ci_tecnico_idx') AS ok`,
                'o índice por técnico existe');

    // ⚠️ SÓ NA PRIMEIRA RODADA. Numa segunda, PCs legitimamente abertas teriam dono, e esta
    // conferência daria ROLLBACK num script que se anuncia idempotente.
    if (est.colunas < 2) {
      await check(`SELECT COUNT(*) FILTER (WHERE ci_tecnico_id IS NOT NULL) = 0
                     AND COUNT(*) FILTER (WHERE ci_tecnico_em IS NOT NULL) = 0 AS ok
                     FROM prestacoes_contas`,
                  'e nascem NULAS nas 14.658 — ninguém está com PC nenhuma ainda');
    } else {
      console.log('   --    (as colunas já existiam; "nascem nulas" não se aplica a esta rodada)');
    }

    // ⚠️ NADA FOI APAGADO: a tabela mudou de nome, e o backup tem as mesmas 0 linhas.
    await check(`SELECT to_regclass('public.${BACKUP}') IS NOT NULL AS ok`,
                `${BACKUP} existe — a tabela foi renomeada, não derrubada`);
    await check(`SELECT (SELECT COUNT(*) FROM ${BACKUP}) = ${linhas} AS ok`,
                `e tem as mesmas ${linhas} linhas que ci_responsavel tinha`);
    await check(`SELECT to_regclass('public.ci_responsavel') IS NULL AS ok`,
                'e o nome antigo não responde mais');

    // As tabelas que não podiam ser tocadas, contra a foto do início.
    for (const t of INTOCADAS) {
      const dep = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      const ok = dep === antes[t];
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${t} intacta — ${antes[t]} linhas antes e depois`);
    }
    // ⚠️ E O CICLO DO C.I. E A BAIXA, um a um. Contar `prestacoes_contas` prova que nenhuma
    // linha sumiu; não prova que nenhuma MUDOU. Foi a lição de 17/08: contar linhas não prova
    // que elas não mudaram.
    const cicloDep = (await cli.query(
      `SELECT COALESCE(ci_situacao,'(nulo)') s, COUNT(*)::int n FROM prestacoes_contas
        GROUP BY 1 ORDER BY 1`)).rows;
    const igualCiclo = JSON.stringify(cicloAntes) === JSON.stringify(cicloDep);
    if (!igualCiclo) falhou++;
    console.log(`   ${igualCiclo ? 'OK  ' : 'FALHA'}  ci_situacao intacta — ` +
                cicloAntes.map(r => `${r.s}:${r.n}`).join(' · '));
    const baixaDep = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE baixada)::int b,
              COUNT(*) FILTER (WHERE enviado_ci)::int e,
              COUNT(*) FILTER (WHERE data_baixa IS NOT NULL)::int d FROM prestacoes_contas`)).rows[0];
    const igualBaixa = JSON.stringify(baixaAntes) === JSON.stringify(baixaDep);
    if (!igualBaixa) falhou++;
    console.log(`   ${igualBaixa ? 'OK  ' : 'FALHA'}  a baixa intacta — baixada:${baixaAntes.b} · ` +
                `enviado_ci:${baixaAntes.e} · data_baixa:${baixaAntes.d}`);

    if (falhou) { await cli.query('ROLLBACK'); throw new Error(`${falhou} conferência(s) falharam — ROLLBACK`); }

    await cli.query('COMMIT');
    commitou = true;
    console.log('\n   Todas as conferências passaram. COMMIT.\n');

    // ── 5. A REVERSÃO ────────────────────────────────────────────────────────
    fs.writeFileSync(REVERSAO, JSON.stringify({
      o_que: 'C.I. por PC: colunas ci_tecnico_id/ci_tecnico_em e rename da ci_responsavel',
      quando: new Date().toISOString(),
      criado: ['prestacoes_contas.ci_tecnico_id', 'prestacoes_contas.ci_tecnico_em', 'pc_ci_tecnico_idx'],
      renomeado: est.tem_tabela ? [`ci_responsavel -> ${BACKUP} (tinha ${linhas} linhas)`] : [],
      nada_foi_apagado: true,
      reverter_com: [
        'BEGIN;',
        'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ci_tecnico_id;',
        'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ci_tecnico_em;',
        'DROP INDEX IF EXISTS pc_ci_tecnico_idx;',
        ...(est.tem_tabela ? [`ALTER TABLE IF EXISTS ${BACKUP} RENAME TO ci_responsavel;`] : []),
        'COMMIT;',
      ],
      atencao: 'reverter apaga quem esta com cada PC — ver ci_tecnico_id antes de rodar. ' +
               'O rename de volta e exato: a tabela nunca foi derrubada.',
      nao_tocado: INTOCADAS,
    }, null, 2));
    console.log('   reversão: ' + REVERSAO + '\n');
  } catch (e) {
    if (!commitou) { try { await cli.query('ROLLBACK'); } catch (_) {} }
    console.error('\n✗ ' + e.message + '\n');
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
