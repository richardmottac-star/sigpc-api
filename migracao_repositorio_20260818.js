// CAMINHO: sigpc-api/migracao_repositorio_20260818.js
//
// A MIGRAÇÃO DA TELA REPOSITÓRIO. PADRÃO = DRY-RUN.
//
//   1. repositorio.fixado  (bool)  — o alfinete: fixado aparece primeiro na categoria
//   2. repositorio.ordem   (int)   — a ordem dentro da categoria
//   3. tabela repositorio_categoria — nome, cores e ordem dos chips
//   4. semeadura das 5 categorias da especificação + "Sem categoria"
//   5. semeadura das categorias que JÁ EXISTEM nos itens e não estão na lista
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE A TABELA JÁ TINHA (medido em 18/08/2026, 4 itens):
//   categoria ✔ · adicionado_por ✔ · criado_em ✔ · fixado ✘ · ordem ✘
//
// ⚠️ AS CORES PRECISAM DE TABELA, e não de uma constante no `index.html`. O Richard pediu
// "+ Nova categoria" com cor escolhida na tela: categoria que nasce em tempo de execução não
// cabe num objeto escrito no front, e a cor teria de viver junto do nome — senão a categoria
// nova apareceria sem cor até alguém publicar uma versão do arquivo.
//
// ⚠️ E OS ITENS APONTAM PARA A CATEGORIA PELO NOME (texto), não por id. É o que a coluna
// `categoria` já é, com 4 itens gravados; trocar para FK exigiria reescrever esses dados e a
// rota, para ganhar o quê? A lista de categorias é de seis linhas, não de seis mil.
//
// ⚠️ NADA É RENOMEADO AQUI. Dois itens estão em 'Relatórios', que não é nenhum dos cinco
// nomes da especificação ('Relatórios CGE' é o mais próximo). Renomear seria eu decidir que
// são a mesma coisa — em vez disso a migração SEMEIA 'Relatórios' como categoria própria,
// em cinza neutro, e o Richard decide se funde. Item nenhum fica escondido.
//
//   node migracao_repositorio_20260818.js              dry-run
//   node migracao_repositorio_20260818.js --gravar     grava

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const ARQ_REVERSAO = `reverter_migracao_repositorio_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

// As cinco da especificação do Richard, na ordem em que ele as listou, mais a neutra.
// cor = a barra e o botão · bg = o fundo claro do ícone e do chip · txt = o texto sobre o bg.
const CATEGORIAS = [
  { nome: 'Relatórios CGE', cor: '#185FA5', bg: '#E6F1FB', txt: '#0C447C', ordem: 1 },
  { nome: 'Orientações',    cor: '#BA7517', bg: '#FAEEDA', txt: '#633806', ordem: 2 },
  { nome: 'Planilhas',      cor: '#3B6D11', bg: '#EAF3DE', txt: '#27500A', ordem: 3 },
  { nome: 'Legislação',     cor: '#534AB7', bg: '#EEEDFE', txt: '#3C3489', ordem: 4 },
  { nome: 'Modelos',        cor: '#D4537E', bg: '#FBEAF0', txt: '#993556', ordem: 5 },
  // ⚠️ "Sem categoria" É UMA CATEGORIA DE VERDADE, com linha na tabela. Tratá-la só como
  // `NULL` no front faria cada tela inventar o próprio rótulo e a própria cor para ela.
  { nome: 'Sem categoria',  cor: '#5F5E5A', bg: '#F1F4F2', txt: '#4A4A46', ordem: 99 },
];

const DDL_COLUNAS = [
  `ALTER TABLE repositorio ADD COLUMN IF NOT EXISTS fixado boolean NOT NULL DEFAULT false`,
  `ALTER TABLE repositorio ADD COLUMN IF NOT EXISTS ordem integer`,
];

const DDL_TABELA = `
  CREATE TABLE IF NOT EXISTS repositorio_categoria (
    id        serial PRIMARY KEY,
    nome      text NOT NULL,
    cor       text NOT NULL,
    cor_bg    text NOT NULL,
    cor_txt   text NOT NULL,
    ordem     integer NOT NULL DEFAULT 50,
    criado_em timestamp NOT NULL DEFAULT now(),
    CONSTRAINT rc_nome_preenchido CHECK (btrim(nome) <> ''),
    -- Cor tem de ser hexadecimal de 6 dígitos: a tela põe esse valor direto num style, e
    -- texto livre ali é onde um valor quebrado vira layout quebrado.
    CONSTRAINT rc_cor_hex     CHECK (cor     ~* '^#[0-9a-f]{6}$'),
    CONSTRAINT rc_cor_bg_hex  CHECK (cor_bg  ~* '^#[0-9a-f]{6}$'),
    CONSTRAINT rc_cor_txt_hex CHECK (cor_txt ~* '^#[0-9a-f]{6}$')
  )`;

// ⚠️ NOME ÚNICO, e o índice é que garante. Os itens apontam para a categoria PELO NOME: dois
// registros com o mesmo nome fariam a tela mostrar o mesmo grupo duas vezes, com cores
// diferentes, e o segundo chip nunca filtraria nada.
const DDL_INDICE = `CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_nome ON repositorio_categoria (lower(btrim(nome)))`;

const SQL_SEMEAR = `
  INSERT INTO repositorio_categoria (nome, cor, cor_bg, cor_txt, ordem)
  SELECT $1, $2, $3, $4, $5
   WHERE NOT EXISTS (SELECT 1 FROM repositorio_categoria WHERE lower(btrim(nome)) = lower(btrim($1)))
  RETURNING nome`;

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '20s'");

    const antes = (await cli.query(`SELECT count(*)::int n, count(categoria)::int com_cat FROM repositorio`)).rows[0];
    const jaCol = (await cli.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='repositorio' AND column_name IN ('fixado','ordem')`)).rows.map(r => r.column_name);
    const jaTab = (await cli.query(`SELECT to_regclass('public.repositorio_categoria') t`)).rows[0].t;

    nl('── ANTES ─────────────────────────────────────────────────');
    nl(`   ${antes.n} itens · ${antes.com_cat} com categoria · ${antes.n - antes.com_cat} SEM categoria`);
    nl(`   colunas ja existentes: ${jaCol.length ? jaCol.join(', ') : 'nenhuma'}`);
    nl(`   repositorio_categoria ja existe: ${jaTab ? 'SIM' : 'nao'}`);

    const distintas = (await cli.query(
      `SELECT DISTINCT btrim(categoria) c FROM repositorio
        WHERE categoria IS NOT NULL AND btrim(categoria) <> '' ORDER BY 1`)).rows.map(r => r.c);
    nl(`   categorias ja usadas pelos itens: ${distintas.length ? distintas.join(', ') : 'nenhuma'}`);

    // ── PASSOS 1-3 ─────────────────────────────────────────────────────────
    nl('\n── PASSOS 1-3: colunas e tabela ──────────────────────────');
    for (const s of DDL_COLUNAS) { await cli.query(s); nl(`   ${s.replace(/\s+/g, ' ')}`); }
    await cli.query(DDL_TABELA);
    await cli.query(DDL_INDICE);
    nl('   repositorio_categoria + indice unico por nome');

    // ── PASSO 4: as seis da especificação ──────────────────────────────────
    nl('\n── PASSO 4: semeando as categorias da especificacao ──────');
    const semeadas = [];
    for (const c of CATEGORIAS) {
      const { rows } = await cli.query(SQL_SEMEAR, [c.nome, c.cor, c.bg, c.txt, c.ordem]);
      if (rows.length) { semeadas.push(c.nome); nl(`   + ${c.nome}`); }
      else nl(`   = ${c.nome} (ja existia)`);
    }

    // ── PASSO 5: as que os itens já usam e não estão na lista ───────────────
    //
    // ⚠️ SEMEIA EM CINZA, NÃO RENOMEIA. 'Relatórios' não é 'Relatórios CGE' — dizer que são a
    // mesma coisa é decisão do Richard, não da migração. Assim os dois itens continuam
    // visíveis, com chip próprio, e ele funde depois se quiser.
    nl('\n── PASSO 5: categorias orfas dos itens ───────────────────');
    const conhecidas = CATEGORIAS.map(c => c.nome.toLowerCase());
    const orfas = distintas.filter(d => !conhecidas.includes(d.toLowerCase()));
    for (const [i, nome] of orfas.entries()) {
      const { rows } = await cli.query(SQL_SEMEAR, [nome, '#5F5E5A', '#F1F4F2', '#4A4A46', 50 + i]);
      if (rows.length) { semeadas.push(nome); nl(`   + ${nome}  (cinza neutro — o Richard decide se funde)`); }
    }
    if (!orfas.length) nl('   nenhuma');

    // ── CONFERÊNCIA DEPOIS DE ESCREVER ─────────────────────────────────────
    const dep = (await cli.query(`SELECT count(*)::int n, count(categoria)::int com_cat,
      count(*) FILTER (WHERE fixado)::int fixados FROM repositorio`)).rows[0];
    const cats = (await cli.query(`SELECT nome, cor, ordem FROM repositorio_categoria ORDER BY ordem, nome`)).rows;
    const semDono = (await cli.query(`
      SELECT count(*)::int n FROM repositorio r
       WHERE r.categoria IS NOT NULL AND btrim(r.categoria) <> ''
         AND NOT EXISTS (SELECT 1 FROM repositorio_categoria c
                          WHERE lower(btrim(c.nome)) = lower(btrim(r.categoria)))`)).rows[0].n;

    const checks = [
      ['as duas colunas existem', (await cli.query(`SELECT count(*)::int n FROM information_schema.columns
          WHERE table_name='repositorio' AND column_name IN ('fixado','ordem')`)).rows[0].n === 2, '2 colunas'],
      ['repositorio_categoria existe', !!(await cli.query(`SELECT to_regclass('public.repositorio_categoria') t`)).rows[0].t, 'ok'],
      ['as 6 da especificacao estao la', CATEGORIAS.every(c => cats.some(x => x.nome === c.nome)), `${cats.length} no total`],
      ['"Sem categoria" existe', cats.some(c => c.nome === 'Sem categoria'), 'cinza'],
      ['nenhum item aponta para categoria inexistente', semDono === 0, `${semDono} orfaos`],
      ['fixado nasce false', dep.fixados === 0, `${dep.fixados} fixados`],
      ['nenhum item foi perdido', dep.n === antes.n, `${antes.n} -> ${dep.n}`],
      ['e nenhuma categoria foi reescrita', dep.com_cat === antes.com_cat, `${antes.com_cat} -> ${dep.com_cat}`],
    ];

    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true; nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(42)} ${v}`); }
    nl(`\n   categorias na tabela: ${cats.map(c => c.nome).join(' · ')}`);

    if (falhou) { await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2; }
    else if (GRAVAR) {
      fs.writeFileSync(ARQ_REVERSAO, JSON.stringify({
        quando: new Date().toISOString(),
        desfazer: [
          'DROP TABLE IF EXISTS repositorio_categoria',
          'ALTER TABLE repositorio DROP COLUMN IF EXISTS fixado',
          'ALTER TABLE repositorio DROP COLUMN IF EXISTS ordem',
        ],
        ja_existia: { colunas: jaCol, tabela: !!jaTab },
        categorias_semeadas: semeadas,
        // Nenhum dado de item foi alterado — só colunas novas com o padrao.
        itens_tocados: 0,
      }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   Para desfazer: ${ARQ_REVERSAO}`);
    } else { await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.'); }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
