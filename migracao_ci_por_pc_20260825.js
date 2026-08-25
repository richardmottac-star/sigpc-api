// CAMINHO: sigpc-api/migracao_ci_por_pc_20260825.js
//
// O C.I. VOLTA A SER POR PC. PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ═══ A DECISÃO DO ITEM 6: NÃO HÁ DADO PARA MIGRAR ═══
//
// A pergunta era se o responsável guardado por TR em `ci_responsavel` precisava virar
// responsável por PC. Medido em 25/08/2026, antes de escrever qualquer coisa:
//
//   SELECT COUNT(*) FROM ci_responsavel                          → 0
//   SELECT ... FROM parcela_historico WHERE evento LIKE 'ci\_%'  → nenhuma linha
//
// A tabela nasceu em 24/08 e **nenhum técnico chegou a assumir uma TR**. Não há uma linha
// para converter. A migração é só de ESQUEMA: cria o par de colunas por PC e remove a
// tabela vazia.
//
// ⚠️ COLUNAS EM `prestacoes_contas`, E NÃO UMA TABELA `ci_responsavel_pc`.
//
// O motivo é o oposto do que valeu em 24/08. Lá o responsável era da TR e a tabela era por
// PC: guardar o dono nas 83 PCs de uma TR seria repetir a mesma informação 83 vezes. Agora
// o responsável É DA PC — a mesma granularidade da linha. Uma tabela ao lado exigiria um
// JOIN em toda leitura da fila para responder algo que cabe na própria linha, e abriria a
// porta para PC sem linha correspondente.
//
// E elas entram na família que já existe: `ci_situacao`, `ci_rodada`, `ci_encerrado_em`,
// `ci_encerrado_por`. `ci_tecnico_id` é quem está com ela AGORA; `ci_encerrado_por` é quem
// decidiu no fim. As duas perguntas são diferentes e as duas colunas continuam.
//
// ⚠️ `DROP TABLE ci_responsavel` É SEGURO PORQUE ELA ESTÁ VAZIA — e a conferência pré-escrita
// aborta se não estiver. Código e tabela que ninguém usa é o que ninguém revisa; deixá-la de
// pé pareceria zelo e seria só uma segunda resposta para "quem está com esta demanda".
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

const DDL = [
  [`ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS ci_tecnico_id integer`,
   'prestacoes_contas.ci_tecnico_id — quem do C.I. está com esta PC agora'],
  [`ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS ci_tecnico_em timestamp`,
   'prestacoes_contas.ci_tecnico_em — desde quando'],
  // A fila abre por `ci_situacao` e recorta por técnico o tempo todo.
  [`CREATE INDEX IF NOT EXISTS pc_ci_tecnico_idx ON prestacoes_contas (ci_tecnico_id)
      WHERE ci_situacao IS NOT NULL`,
   'o índice parcial do recorte por técnico'],
  [`DROP TABLE IF EXISTS ci_responsavel`, 'a tabela por TR, vazia, sai'],
];

const CONFERENCIAS = [
  [`SELECT COUNT(*) = 2 AS ok FROM information_schema.columns
     WHERE table_name = 'prestacoes_contas' AND column_name IN ('ci_tecnico_id','ci_tecnico_em')`,
   'as duas colunas por PC existem'],
  [`SELECT COUNT(*) FILTER (WHERE ci_tecnico_id IS NOT NULL) = 0 AS ok FROM prestacoes_contas`,
   'e nascem NULAS — ninguém está com PC nenhuma ainda'],
  [`SELECT to_regclass('public.ci_responsavel') IS NULL AS ok`, 'a tabela por TR não existe mais'],
  [`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'pc_ci_tecnico_idx') AS ok`,
   'o índice por técnico existe'],
  // ⚠️ As colunas do ciclo que NÃO podem ter sido tocadas: a migração só ACRESCENTA.
  [`SELECT COUNT(*) = 1189 AS ok FROM prestacoes_contas WHERE ci_situacao = 'na_fila'`,
   'as 1.189 na fila continuam na fila'],
  [`SELECT COUNT(*) = 1737 AS ok FROM prestacoes_contas WHERE ci_situacao = 'encerrado'`,
   'as 1.737 encerradas continuam encerradas'],
];

const INTOCADAS = ['prestacoes_contas', 'parcela_historico', 'usuarios', 'notificacao'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;
  try {
    const temTab = (await cli.query(`SELECT to_regclass('public.ci_responsavel') IS NOT NULL AS x`)).rows[0].x;
    const linhas = temTab ? (await cli.query(`SELECT COUNT(*)::int n FROM ci_responsavel`)).rows[0].n : 0;
    const hist = (await cli.query(`SELECT COUNT(*)::int n FROM parcela_historico WHERE evento LIKE 'ci\\_%'`)).rows[0].n;
    const jaTem = (await cli.query(`SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name='prestacoes_contas' AND column_name IN ('ci_tecnico_id','ci_tecnico_em')`)).rows[0].n;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  O C.I. VOLTA A SER POR PC — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`── ci_responsavel existe? ${temTab ? 'sim' : 'não'} · linhas: ${linhas}`);
    console.log(`── eventos ci_assumiu/ci_devolveu/ci_passou no histórico: ${hist}`);
    console.log(`── colunas por PC já criadas: ${jaTem} de 2`);

    // ⚠️ A TRAVA. Se alguém tiver assumido uma TR entre a medição e a execução, esta
    // migração APAGARIA esse trabalho sem avisar. Não é "é só uma tabela vazia": é uma
    // tabela vazia AGORA, e a conferência é o que garante que continue sendo na hora de rodar.
    if (linhas > 0 || hist > 0) {
      throw new Error(`ci_responsavel tem ${linhas} linha(s) e o histórico ${hist} evento(s) — ` +
                      `há trabalho a migrar. Esta migração pressupõe tabela vazia; pare e reavalie.`);
    }
    console.log('\n   ✓ nada a migrar: a troca é só de esquema.');

    console.log('\n── o que será executado:');
    DDL.forEach(([sql, o]) => console.log(`   ${o}\n     ${sql.replace(/\s+/g, ' ').trim()}`));
    console.log('\n── o que NÃO é tocado: nenhuma linha de prestacoes_contas é reescrita —');
    console.log('   só se ACRESCENTAM duas colunas. ci_situacao, ci_rodada, ci_encerrado_em,');
    console.log('   ci_encerrado_por, baixada, data_baixa e enviado_ci ficam como estão.');

    if (!GRAVAR) {
      console.log('\n── DRY-RUN. Nada foi gravado. Rode com --gravar para executar.\n');
      return;
    }

    await cli.query('BEGIN');
    const antes = {};
    for (const t of INTOCADAS) antes[t] = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;

    for (const [sql] of DDL) await cli.query(sql);

    console.log('\n── CONFERÊNCIA DEPOIS DE GRAVAR (dentro da transação)');
    let falhou = 0;
    for (const [sql, rot] of CONFERENCIAS) {
      const ok = (await cli.query(sql)).rows[0].ok;
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${rot}`);
    }
    for (const t of INTOCADAS) {
      const dep = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      const ok = dep === antes[t];
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${t} intacta — ${antes[t]} linhas antes e depois`);
    }
    if (falhou) { await cli.query('ROLLBACK'); throw new Error(`${falhou} conferência(s) falharam — ROLLBACK`); }

    await cli.query('COMMIT');
    commitou = true;
    console.log(`\n   ${CONFERENCIAS.length + INTOCADAS.length} conferências passaram. COMMIT.\n`);

    fs.writeFileSync(REVERSAO, JSON.stringify({
      o_que: 'C.I. por PC: colunas ci_tecnico_id/ci_tecnico_em e remocao da ci_responsavel',
      quando: new Date().toISOString(),
      criado: ['prestacoes_contas.ci_tecnico_id', 'prestacoes_contas.ci_tecnico_em', 'pc_ci_tecnico_idx'],
      removido: ['ci_responsavel (estava VAZIA — 0 linhas, nenhum dado perdido)'],
      reverter_com: [
        'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ci_tecnico_id;',
        'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS ci_tecnico_em;',
        'DROP INDEX IF EXISTS pc_ci_tecnico_idx;',
        `CREATE TABLE IF NOT EXISTS ci_responsavel (tr text NOT NULL, setorial_id text NOT NULL DEFAULT 'FCEE',` +
        ` tecnico_id integer NOT NULL, tecnico_nome text, assumida_em timestamp NOT NULL DEFAULT NOW(),` +
        ` atualizado_em timestamp NOT NULL DEFAULT NOW(), PRIMARY KEY (tr, setorial_id));`,
      ],
      atencao: 'reverter apaga quem esta com cada PC; a ci_responsavel volta VAZIA, como estava',
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
