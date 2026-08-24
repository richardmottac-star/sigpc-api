// CAMINHO: sigpc-api/migracao_ci_responsavel_20260824.js
//
// O RESPONSÁVEL DO CONTROLE INTERNO POR TR.  PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ═══ POR QUE ISTO EXISTE ═══
//
// Os três técnicos do C.I. olham a MESMA fila. Medido em 24/08/2026: 1.145 PCs `na_fila`,
// em 726 parcelas. Nada no banco diz quem está com o quê, então dois podem abrir a mesma TR
// ao mesmo tempo e descobrir depois — ou, pior, nenhum abrir, porque cada um supõe que o
// outro já pegou.
//
// ═══ POR QUE UMA TABELA, E NÃO UMA COLUNA EM `prestacoes_contas` ═══
//
// O responsável é da TR, e `prestacoes_contas` é por PC. A 2020TR000657 tem 83 PCs: gravar o
// responsável nelas seria repetir o mesmo dado 83 vezes e depender de os 83 continuarem
// iguais para sempre. Uma escrita parcial — falha de rede no meio de um UPDATE em lote —
// deixaria a TR com dois responsáveis ao mesmo tempo, e nada acusaria.
//
// Uma linha por TR responde a pergunta uma vez, e a PRIMARY KEY (tr, setorial_id) é o que
// impede dois responsáveis para a mesma TR. É a mesma escolha do índice único parcial da
// `solicitacao_devolucao`: a trava mora no banco, não na conferência da rota.
//
// ⚠️ NÃO HÁ FOREIGN KEY para `usuarios`, de propósito, e é a mesma razão do
// `parcela_historico.executado_por`: existe `DELETE /usuarios/:id`, e uma FK faria a exclusão
// de um cadastro falhar por causa de uma linha de trabalho. Trilha não trava cadastro.
//
// ⚠️ E NÃO HÁ FK para a TR: `prestacoes_contas` não tem chave única por TR — a chave dela é
// `codigo_pc`. Não há para onde apontar.
//
// USO:
//   node migracao_ci_responsavel_20260824.js              dry-run
//   node migracao_ci_responsavel_20260824.js --gravar     grava
//
// ⚠️ Escrita em produção EXIGE ordem expressa do Richard (regra 1 do time de agentes).

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const D = __dirname + '/';
const REVERSAO = D + 'reverter_ci_responsavel_20260824.json';

const DDL = [
  [`CREATE TABLE IF NOT EXISTS ci_responsavel (
      tr           text NOT NULL,
      setorial_id  text NOT NULL DEFAULT 'FCEE',
      tecnico_id   integer NOT NULL,
      tecnico_nome text,
      assumida_em  timestamp NOT NULL DEFAULT NOW(),
      atualizado_em timestamp NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tr, setorial_id)
    )`, 'a tabela ci_responsavel'],
  // O índice serve à pergunta que a tela faz o tempo todo: "o que é meu?".
  [`CREATE INDEX IF NOT EXISTS ci_responsavel_tecnico_idx ON ci_responsavel (tecnico_id)`,
   'o índice por técnico'],
];

const CONFERENCIAS = [
  [`SELECT to_regclass('public.ci_responsavel') IS NOT NULL AS ok`, 'a tabela existe'],
  [`SELECT COUNT(*) = 5 AS ok FROM information_schema.columns
     WHERE table_name = 'ci_responsavel'
       AND column_name IN ('tr','setorial_id','tecnico_id','tecnico_nome','assumida_em')`,
   'as cinco colunas de identidade estão lá'],
  [`SELECT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = 'ci_responsavel'::regclass AND contype = 'p') AS ok`,
   'a PRIMARY KEY (tr, setorial_id) existe — é ela que impede dois responsáveis'],
  [`SELECT EXISTS (SELECT 1 FROM pg_indexes
       WHERE tablename = 'ci_responsavel' AND indexname = 'ci_responsavel_tecnico_idx') AS ok`,
   'o índice por técnico existe'],
  [`SELECT COUNT(*) = 0 AS ok FROM ci_responsavel`, 'a tabela nasce VAZIA — ninguém é dono de nada ainda'],
];

// ⚠️ A CONFERÊNCIA DE "NADA MAIS FOI TOCADO" COMPARA COM A FOTO DO INÍCIO DESTA RODADA,
// e não com um número escrito no arquivo. Na primeira execução ela dizia
// `COUNT(*) = 14652 FROM prestacoes_contas` — o acervo tinha mudado para 14.651 desde que o
// número foi anotado, e a migração abortou por uma diferença que não era dela. É a armadilha
// 21 do CLAUDE.md: comparar com um valor antigo acusa o que rodadas anteriores fizeram de
// propósito. A pergunta é "ESTA rodada mexeu no que não devia?".
const INTOCADAS = ['prestacoes_contas', 'usuarios', 'parcela_historico', 'ci_mensagem'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;
  try {
    const jaExiste = (await cli.query(`SELECT to_regclass('public.ci_responsavel') IS NOT NULL AS x`)).rows[0].x;
    const fila = await cli.query(`
      SELECT COUNT(*)::int pcs, COUNT(DISTINCT tr)::int trs,
             COUNT(DISTINCT tr || '|' || parcial_num)::int parcelas
        FROM prestacoes_contas WHERE ci_situacao = 'na_fila'`);
    const tec = await cli.query(
      `SELECT id, nome FROM usuarios WHERE perfil = 'controle_interno' AND ativo = true ORDER BY id`);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ci_responsavel — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`── a tabela já existe? ${jaExiste ? 'SIM — nada a criar' : 'não'}`);
    console.log(`── a fila do C.I. hoje: ${fila.rows[0].pcs} PCs · ${fila.rows[0].parcelas} parcelas · ${fila.rows[0].trs} TRs`);
    console.log(`── técnicos do C.I. (perfil = 'controle_interno' e ativo): ${tec.rows.length}`);
    tec.rows.forEach(t => console.log(`     id ${t.id}  ${t.nome}`));
    console.log('\n── o que será executado:');
    DDL.forEach(([sql, o]) => console.log(`   ${o}\n     ${sql.replace(/\s+/g, ' ').trim()}`));
    console.log('\n── o que NÃO é tocado: prestacoes_contas · usuarios · parcela_historico ·');
    console.log('   ci_mensagem · e nenhuma coluna ci_* existente. Só se CRIA.');

    if (!GRAVAR) {
      console.log('\n── DRY-RUN. Nada foi gravado. Rode com --gravar para executar.\n');
      return;
    }

    await cli.query('BEGIN');

    // A foto do início da rodada, DENTRO da transação: é contra ela que se confere depois.
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
      const depois = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      const ok = depois === antes[t];
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${t} intacta — ${antes[t]} linhas antes e depois`);
    }
    if (falhou) { await cli.query('ROLLBACK'); throw new Error(`${falhou} conferência(s) falharam — ROLLBACK`); }

    await cli.query('COMMIT');
    commitou = true;
    console.log(`\n   ${CONFERENCIAS.length} conferências passaram. COMMIT.\n`);

    fs.writeFileSync(REVERSAO, JSON.stringify({
      o_que: 'criacao da tabela ci_responsavel e do indice ci_responsavel_tecnico_idx',
      quando: new Date().toISOString(),
      criado: ['ci_responsavel', 'ci_responsavel_tecnico_idx'],
      // ⚠️ A REVERSÃO APAGA DADO DE TRABALHO. Depois que os técnicos começarem a assumir, o
      // DROP leva junto quem estava com o quê. O histórico das trocas fica em
      // `parcela_historico` (eventos ci_assumiu / ci_devolveu / ci_passou) e sobrevive.
      reverter_com: 'DROP TABLE IF EXISTS ci_responsavel;',
      atencao: 'reverter apaga as atribuicoes existentes; a trilha em parcela_historico permanece',
      nao_tocado: ['prestacoes_contas', 'usuarios', 'parcela_historico', 'ci_mensagem'],
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
