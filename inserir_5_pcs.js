// CAMINHO: sigpc-api/inserir_5_pcs.js
//
// AS 5 PCs QUE FALTAM DE VERDADE — inserção à mão, lista explícita.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// Confirmadas pelo Richard em 16/08/2026, depois da triangulação das 180 linhas do
// `PCS_AUSENTES_v2.csv` contra a planilha e o banco:
//
//    180 no CSV
//   -129 o banco já tem a parcela completa
//   - 27 a planilha diz que falta PC, mas o VALOR já está completo (a inflação 4/2 do G2)
//   -  1 diferença de centavos
//   -  9 diferença "real" que se desfaz: é PROCESSO digitado errado no CSV, não PC ausente
//        (`SCC 78256/2023` contra `SCC 00007826/2023`; `SCC 3667/2022` contra `SCC3967/2022`…)
//   ====
//      5 parcelas que NÃO EXISTEM no banco  ← estas
//
// ⚠️ QUATRO DELAS SÃO PCs FINAIS, e é por isso que o lote automático as descartava: a guarda
// recusava `parcial = FINAL` para não duplicar uma PFINAL existente. Aqui não há nenhuma para
// duplicar — as quatro TRs têm 0 finais, e o acervo tem 533 TRs nessa situação.
//
// ⚠️ `codigo_nl` FICA NULO NAS QUATRO, E ISSO ESTÁ CERTO: 0 das 1.026 finais do acervo têm NL.
// A regra "1 PC = 1 NL" é das PARCIAIS. A exceção real é a quinta linha — ver abaixo.

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const D = __dirname + '/';
const BK = '_backup_5pcs_20260816';

// ⚠️ LISTA EXPLÍCITA, escrita à mão (regra 12). Cada linha foi conferida contra o banco:
// a TR existe (menos a última), tem 0 finais, e o analista tem cadastro ativo.
//
// `entidade` e `processo_mae` das quatro primeiras vêm do BANCO, não do CSV — a TR já os tem,
// e o CSV escreve o mesmo processo com outra grafia (`SCC 1896/2022` × `SCC1896/2022`).
const AS_5 = [
  { tr: '2020TR000811', tipo: 'final',   parcial: 'FINAL', proc: 'SCC 3956/2024',
    valor: 1014075.96, analista_id: 28, analista_nome: 'Isabel',    grupo: 2 },
  { tr: '2022TR000927', tipo: 'final',   parcial: 'FINAL', proc: 'SCC 13149/2024',
    valor: 2906908.68, analista_id: 24, analista_nome: 'Elisandra', grupo: 2 },
  { tr: '2022TR001421', tipo: 'final',   parcial: 'FINAL', proc: 'SCC 16533/2024',
    valor: 2314144.33, analista_id: 32, analista_nome: 'Perla',     grupo: 2 },
  { tr: '2023TR000810', tipo: 'final',   parcial: 'FINAL', proc: 'SCC 14546/2024',
    valor: 116168.16,  analista_id: 24, analista_nome: 'Elisandra', grupo: 2 },
  // ⚠️ A ÚNICA PARCIAL, E A ÚNICA QUE CRIA TR NOVA. A `2024TR000204` não existe no banco (0
  // PCs), então `entidade` e `processo_mae` vêm do CSV. E é a **primeira parcial da história
  // da base sem `codigo_nl`** — hoje são 0 de 13.626. Fica registrado: ela não entra em
  // `COUNT(DISTINCT codigo_nl)` nem na baixa por NL (`server.js`, ramo `&& codigo_nl`).
  { tr: '2024TR000204', tipo: 'parcial', parcial: '1',     proc: 'SCC 16388/2024',
    valor: 202051.18,  analista_id: 31, analista_nome: 'Noici',     grupo: 2,
    entidade: 'APAE DE SAO DOMINGOS', processo_mae: 'SCC 5386/2023',
    codigo_pc: '2024PC900000' },
];

// ⚠️ `situacao_atual` e `parecer_tipo` FICAM NULOS, de propósito.
//
// O CSV traz `Análise`, `Analisar` e `Diligência` na coluna de situação — e os dois primeiros
// **não existem em lugar nenhum da base** (o sistema só conhece `Em análise`, `Diligência`,
// `Reanálise`, `Aguardando documentação`). Gravar um deles faz o `<select>` do modal abrir em
// BRANCO e o salvar devolver 400 — a armadilha 15 ao contrário.
//
// E traz `parecer_tipo` preenchido com a PC não baixada, estado que existe em 2 de 14.652.
// O parecer é o passo que BAIXA: quem o registra é `POST /parcela/parecer`, que grava a baixa
// e o histórico junto. Gravá-lo aqui produziria um parecer sem baixa e sem trilha.
//
// As cinco nascem limpas, em `analise`. O analista registra pela tela, que é o caminho certo.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);
    await cli.query(`CREATE TABLE ${BK} AS SELECT * FROM prestacoes_contas`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK}`);
    nl(`── BACKUP ${BK}: ${bk.n} linhas`);

    const inseridos = [];
    for (const p of AS_5) {
      const codigo = p.codigo_pc || `${p.tr}-PFINAL`;

      // herda entidade e processo_mae da TR quando ela já existe
      const { rows: [tr] } = await cli.query(
        `SELECT MAX(entidade) entidade, MAX(processo_mae) mae, COUNT(*)::int pcs,
                COUNT(*) FILTER (WHERE tipo='final')::int finais
           FROM prestacoes_contas WHERE tr = $1`, [p.tr]);

      // ⚠️ guarda: não duplicar uma FINAL que já exista
      if (p.tipo === 'final' && tr.finais > 0)
        throw new Error(`${p.tr} ja tem ${tr.finais} PC final — nao insiro`);
      const { rows: [ja] } = await cli.query(
        `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE codigo_pc = $1`, [codigo]);
      if (ja.n > 0) throw new Error(`${codigo} JA EXISTE`);

      await cli.query(
        `INSERT INTO prestacoes_contas
           (codigo_pc, codigo_nl, tr, parcial_num, tipo, setorial_id, processo_pc, processo_mae,
            entidade, valor, analista_id, analista_nome, grupo, status, situacao_atual,
            parecer_tipo, baixada, parcela_seq, registrado_por, atualizado_em)
         VALUES ($1, NULL, $2, $3, $4, 'FCEE', $5, $6, $7, $8, $9, $10, $11, 'analise',
                 NULL, NULL, false, $12,
                 'inclusao manual 16/08/2026 — as 5 confirmadas pelo Richard', NOW())`,
        [codigo, p.tr, p.parcial, p.tipo, p.proc,
         p.processo_mae ?? tr.mae, p.entidade ?? tr.entidade, p.valor,
         p.analista_id, p.analista_nome, p.grupo, p.tipo === 'final' ? 999 : 1]);

      inseridos.push(codigo);
      nl(`   + ${codigo.padEnd(22)} ${p.tipo.padEnd(7)} ${String(p.proc).padEnd(16)} ` +
         `R$ ${p.valor.toLocaleString('pt-BR', {minimumFractionDigits: 2}).padStart(14)}  ${p.analista_nome}` +
         (tr.pcs === 0 ? '   ⚠️ TR NOVA' : ''));
    }

    // ── CONFERÊNCIA ───────────────────────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.baixada,b.data_baixa,b.parecer_tipo,b.valor,b.parcial_num,b.analista_id,
             b.enviado_ci,b.ci_situacao)
         IS DISTINCT FROM (p.baixada,p.data_baixa,p.parecer_tipo,p.valor,p.parcial_num,
             p.analista_id,p.enviado_ci,p.ci_situacao)`);
    const c2 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);
    const c3 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM prestacoes_contas WHERE tipo='final' GROUP BY tr HAVING COUNT(*) > 1) t`);
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE codigo_pc = ANY($1) AND (analista_id IS NULL OR baixada <> false
        OR parecer_tipo IS NOT NULL OR situacao_atual IS NOT NULL
        OR entidade IS NULL OR processo_mae IS NULL OR valor IS NULL)`, [inseridos]);
    const c5 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE codigo_nl IS NULL AND tipo = 'parcial'`);
    const c6 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr, parcial_num FROM prestacoes_contas WHERE setorial_id='FCEE' AND tipo<>'final'
       AND (tr, parcial_num) IN (SELECT tr, parcial_num FROM prestacoes_contas
                                  WHERE codigo_pc = ANY($1))
       GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE baixada) > 0
                       AND COUNT(*) FILTER (WHERE NOT baixada) > 0) t`, [inseridos]);

    const checks = [
      ['nenhuma PC antiga alterada',        c1.n === 0, c1.n],
      ['total = antes + 5',                 c2.n === bk.n + 5, `${bk.n}+5=${c2.n}`],
      ['nenhuma TR com 2 PCs finais',       c3.n === 0, c3.n],
      ['as 5 nascem completas e limpas',    c4.n === 0, c4.n],
      ['parciais sem NL (era 0, vira 1)',   c5.n === 1, c5.n],
      ['nenhuma parcela ficou mista',       c6.n === 0, c6.n],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(36)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_5pcs_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup: BK, inseridos }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   reversao: DELETE FROM prestacoes_contas WHERE codigo_pc = ANY(ARRAY[${inseridos.map(c => `'${c}'`).join(',')}]);`);
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
