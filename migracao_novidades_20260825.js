// CAMINHO: sigpc-api/migracao_novidades_20260825.js
//
// NOVIDADES DO SISTEMA — a tabela e a marca de "até onde eu já vi".  PADRÃO = DRY-RUN.
//
// ═══ POR QUE ISTO EXISTE ═══
//
// Hoje cada mudança do sistema vira mensagem de WhatsApp e PDF por e-mail. Quem não leu a
// mensagem não fica sabendo, e quem entra depois nunca vê — o histórico mora fora do
// sistema, num lugar que não pertence a ninguém.
//
// ═══ A DECISÃO DO ITEM 5: TIMESTAMP NO CADASTRO, E NÃO TABELA DE LEITURA ═══
//
// A pergunta era: guardar o que cada um já leu numa tabela `novidade_leitura`
// (usuario_id, novidade_id), ou uma data de "última visita" em `usuarios`?
//
// ⚠️ ESCOLHI A DATA, e o motivo é a GRANULARIDADE QUE A TELA PEDE. Em nenhum lugar da
// especificação existe "marcar ESTA novidade como lida": o contador some quando a pessoa
// ABRE A TELA, e o botão é "Marcar TUDO como lido". Ou seja, só há um evento de leitura, e
// ele é "vi até aqui" — que é exatamente o que uma data responde.
//
// A tabela de leitura responderia a mesma pergunta com 54 usuários × N novidades linhas, e
// precisaria inserir uma linha por pessoa a cada publicação (ou fazer um LEFT JOIN cujo
// NULL significa "não lida" — que é o mesmo que comparar com a data, só que mais caro).
// Ela só ganharia se um dia existisse "marcar só esta", e nesse dia a migração é trivial:
// a data vira a linha inicial de cada um.
//
// ⚠️ E A COMPARAÇÃO É COM `criado_em`, NUNCA COM `data`. O formulário deixa o superadmin
// escolher a data da novidade — que é editorial, serve para agrupar a lista e pode ser
// retroativa. Se a conta de "não lida" usasse ela, publicar hoje algo datado de semana
// passada nasceria JÁ LIDO para todo mundo, e ninguém veria. `criado_em` é quando a linha
// entrou no banco, e é isso que "novo para você" significa.
//
// ⚠️ `novidades_visto_em` NASCE NULO, de propósito. Nulo quer dizer "nunca abriu a tela", e
// aí TUDO conta como novidade — inclusive para quem for cadastrado amanhã. É a resposta ao
// "quem entra depois nunca vê", que é metade do problema.
//
// USO:
//   node migracao_novidades_20260825.js              dry-run
//   node migracao_novidades_20260825.js --gravar     grava
//
// ⚠️ Escrita em produção EXIGE ordem expressa do Richard (regra 1 do time de agentes).

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = __dirname + '/reverter_novidades_20260825.json';

const DDL = [
  [`CREATE TABLE IF NOT EXISTS novidade (
      id             serial PRIMARY KEY,
      titulo         text NOT NULL,
      texto          text NOT NULL,
      categoria      text NOT NULL DEFAULT 'melhoria',
      publico        text NOT NULL DEFAULT 'todos',
      imagem_url     text,
      imagem_legenda text,
      guia_url       text,
      data           date NOT NULL DEFAULT CURRENT_DATE,
      criado_em      timestamp NOT NULL DEFAULT NOW(),
      criado_por     integer,
      criado_por_nome text,
      atualizado_em  timestamp
    )`, 'a tabela novidade'],
  // ⚠️ O CHECK do público mora no BANCO. A rota também valida, mas é o banco que impede uma
  // linha escrita por script ou por engano de virar novidade que ninguém consegue ver.
  [`ALTER TABLE novidade DROP CONSTRAINT IF EXISTS novidade_publico_valido`, 'limpa o CHECK antigo'],
  [`ALTER TABLE novidade ADD CONSTRAINT novidade_publico_valido
      CHECK (publico IN ('todos','analistas','controle_interno','coordenacao'))`, 'o CHECK do público'],
  // A lista abre sempre pela data, da mais recente para a mais antiga.
  [`CREATE INDEX IF NOT EXISTS novidade_data_idx ON novidade (data DESC, id DESC)`, 'o índice da ordem'],
  // ⚠️ ADD COLUMN IF NOT EXISTS — armadilha 2: `CREATE TABLE IF NOT EXISTS` não altera tabela
  // que já existe, e `usuarios` existe há muito tempo.
  [`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS novidades_visto_em timestamp`,
   'a coluna usuarios.novidades_visto_em'],
];

const CONFERENCIAS = [
  [`SELECT to_regclass('public.novidade') IS NOT NULL AS ok`, 'a tabela novidade existe'],
  [`SELECT COUNT(*) = 13 AS ok FROM information_schema.columns WHERE table_name = 'novidade'`,
   'com as 13 colunas'],
  [`SELECT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'novidade'::regclass AND conname = 'novidade_publico_valido') AS ok`,
   'o CHECK do público existe — o banco recusa público inventado'],
  [`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'novidade_data_idx') AS ok`,
   'o índice da ordem existe'],
  [`SELECT COUNT(*) = 0 AS ok FROM novidade`, 'a tabela nasce VAZIA'],
  [`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'usuarios' AND column_name = 'novidades_visto_em') AS ok`,
   'usuarios.novidades_visto_em existe'],
  // ⚠️ NASCE NULA EM TODO MUNDO: é o que faz a primeira novidade aparecer para os 54.
  [`SELECT COUNT(*) FILTER (WHERE novidades_visto_em IS NOT NULL) = 0 AS ok FROM usuarios`,
   'e nasce NULA em todos — ninguém "já viu" o que ainda não existe'],
];

// ⚠️ `ci_responsavel` SAIU DESTA LISTA EM 25/08/2026. Ela foi renomeada para
// `ci_responsavel_backup_20260825` quando o C.I. voltou a ser por PC, e um `COUNT(*)` sobre
// um nome que não responde mais faria ESTE script — que já rodou e é idempotente — abortar na
// próxima vez que alguém o executasse. Uma lista de "tabelas intocadas" que cita uma tabela
// extinta não protege nada: só quebra.
const INTOCADAS = ['prestacoes_contas', 'parcela_historico', 'notificacao'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;
  try {
    const ja = (await cli.query(`SELECT to_regclass('public.novidade') IS NOT NULL AS x`)).rows[0].x;
    const col = (await cli.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='usuarios' AND column_name='novidades_visto_em') AS x`)).rows[0].x;
    const u = (await cli.query(`SELECT COUNT(*)::int n FROM usuarios`)).rows[0].n;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  NOVIDADES DO SISTEMA — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`── tabela novidade já existe? ................ ${ja ? 'SIM' : 'não'}`);
    console.log(`── usuarios.novidades_visto_em já existe? .... ${col ? 'SIM' : 'não'}`);
    console.log(`── usuários que passam a ter a coluna ........ ${u}`);
    console.log('\n── o que será executado:');
    DDL.forEach(([sql, o]) => console.log(`   ${o}\n     ${sql.replace(/\s+/g, ' ').trim().slice(0, 150)}`));
    console.log('\n── o que NÃO é tocado: ' + INTOCADAS.join(' · '));
    console.log('   Em `usuarios` só se ACRESCENTA uma coluna; nenhuma linha é reescrita.');

    if (!GRAVAR) {
      console.log('\n── DRY-RUN. Nada foi gravado. Rode com --gravar para executar.\n');
      return;
    }

    await cli.query('BEGIN');
    const antes = {};
    for (const t of INTOCADAS.concat('usuarios')) {
      try { antes[t] = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n; } catch (_) { antes[t] = null; }
    }

    for (const [sql] of DDL) await cli.query(sql);

    console.log('\n── CONFERÊNCIA DEPOIS DE GRAVAR (dentro da transação)');
    let falhou = 0;
    for (const [sql, rot] of CONFERENCIAS) {
      const ok = (await cli.query(sql)).rows[0].ok;
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${rot}`);
    }
    for (const t of Object.keys(antes)) {
      if (antes[t] === null) continue;
      const dep = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      const ok = dep === antes[t];
      if (!ok) falhou++;
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${t} intacta — ${antes[t]} linhas antes e depois`);
    }
    if (falhou) { await cli.query('ROLLBACK'); throw new Error(`${falhou} conferência(s) falharam — ROLLBACK`); }

    await cli.query('COMMIT');
    commitou = true;
    console.log(`\n   ${CONFERENCIAS.length + Object.keys(antes).length} conferências passaram. COMMIT.\n`);

    fs.writeFileSync(REVERSAO, JSON.stringify({
      o_que: 'tabela novidade + coluna usuarios.novidades_visto_em',
      quando: new Date().toISOString(),
      criado: ['novidade', 'novidade_data_idx', 'novidade_publico_valido', 'usuarios.novidades_visto_em'],
      reverter_com: [
        'DROP TABLE IF EXISTS novidade;',
        'ALTER TABLE usuarios DROP COLUMN IF EXISTS novidades_visto_em;',
      ],
      // ⚠️ Reverter APAGA o histórico de novidades publicadas — que é justamente o que esta
      // tela existe para guardar. A coluna some junto, e todo mundo volta a "nunca viu".
      atencao: 'reverter apaga as novidades publicadas e a marca de leitura de todos',
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
