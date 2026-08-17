// CAMINHO: sigpc-api/corrigir_nome_analista.js
//
// AS 18 PCs COM `analista_id` PREENCHIDO E `analista_nome` VAZIO. PADRÃO = DRY-RUN.
//
// Pendência registrada em 16/08/2026 (SESSAO.md, item 2). São 18 PCs em 5 TRs:
//
//   2020TR000723   14 PCs   id 31   Noici
//   2020TR001636    1 PC    id 22   Ana Claudia   (PFINAL)
//   2021TR002029    1 PC    id 22   Ana Claudia   (PFINAL)
//   2022TR001328    1 PC    id 41   Graciane      (PFINAL)
//   2023TR000039    1 PC    id 41   Graciane      (PFINAL)
//
// ⚠️ TODAS AS 18 ESTÃO BAIXADAS. Este script NÃO TOCA em `baixada`, `data_baixa`,
// `parecer_tipo`, `parecer_ci`, `enviado_ci`, `dt_envio_ci`, `ci_situacao`, `ci_rodada`,
// `valor`, `parcial_num`, `status` nem `analista_id`. Escreve DUAS colunas: `analista_nome`
// e `atualizado_em`. A conferência pós-escrita prova isso contra o backup e faz ROLLBACK.
//
// ⚠️ A PRODUTIVIDADE JÁ CONTA CERTO. Ela filtra por `analista_id` (armadilha 1), que está
// preenchido. Quem mente é a TELA, que mostra o nome vazio. Isto é correção de exibição.
//
// ══ POR QUE NÃO É "UMA LINHA COM nomeCurto(usuarios.nome)" ═══════════════════════════
//
// A receita escrita no SESSAO.md era `analista_nome = assumir.nomeCurto(usuarios.nome)`.
// Medido contra o banco em 16/08, ela erra em 2 das 18:
//
//   id 22   cadastro "Ana Claudia Carvalho Costa"   nomeCurto -> "Ana"
//           mas as outras 105 PCs dela no acervo dizem "Ana Claudia"
//
// A causa está no `MAPA_NOME` do `lib/assumir.js`: TRÊS das oito chaves são o nome CURTO,
// não o `usuarios.nome`, e por isso NUNCA disparam — "Sandra Rocha", "Ana Claudia" e
// "Ana Leticia". Não existe usuário chamado assim. É defeito VIVO, e maior que estas 18:
// vale para `POST /tr/assumir`. Ver o relatório da sessão. NÃO é escopo deste script.
//
// Por isso a FONTE padrão é o ACERVO: o nome que o próprio `analista_id` já tem gravado nas
// outras PCs dele. É a única resposta que não inventa nada e não briga com a tela de hoje.
//
//   node corrigir_nome_analista.js                     dry-run, fonte = acervo
//   node corrigir_nome_analista.js --fonte=cadastro    dry-run, fonte = nomeCurto(usuarios)
//   node corrigir_nome_analista.js --gravar            grava, fonte = acervo
//
// ⚠️ Escrita em produção EXIGE ordem expressa do Richard (regra 1 do time de agentes).

const fs = require('fs');
const { Pool } = require('pg');
const assumir = require('./lib/assumir');

const GRAVAR = process.argv.includes('--gravar');
const FONTE = process.argv.includes('--fonte=cadastro') ? 'cadastro' : 'acervo';
const D = __dirname + '/';
const BK = '_backup_nomevazio_20260816';

const PCS_ESPERADAS = 18;
const TRS_ESPERADAS = 5;
const IDS_ESPERADOS = 3;

// As colunas que este script promete não tocar. A conferência pós-escrita testa uma a uma.
const INTOCADAS = [
  'analista_id', 'status', 'baixada', 'data_baixa', 'origem_baixa', 'parecer_tipo',
  'parecer_ci', 'enviado_ci', 'dt_envio_ci', 'ci_situacao', 'ci_rodada', 'ci_encerrado_em',
  'valor', 'parcial_num', 'tipo', 'tr', 'processo_pc', 'processo_mae', 'codigo_nl',
  'dt_assumida', 'dt_inicio_analise', 'dt_limite_pc', 'grupo', 'setorial_id',
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '15s'");
    await cli.query(`CREATE TABLE ${BK} AS SELECT * FROM prestacoes_contas`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK}`);
    nl(`── BACKUP ${BK}: ${bk.n} linhas`);
    nl(`── FONTE DO NOME: ${FONTE === 'acervo' ? 'o acervo (nome dominante do proprio analista_id)' : 'o cadastro (assumir.nomeCurto(usuarios.nome))'}`);

    // ── O ALVO — lista explícita, capturada ANTES de escrever (armadilha 12) ──
    const { rows: alvo } = await cli.query(`
      SELECT p.codigo_pc, p.tr, p.tipo, p.baixada, p.parecer_tipo,
             p.analista_id, u.nome AS cadastro
        FROM prestacoes_contas p
        LEFT JOIN usuarios u ON u.id = p.analista_id
       WHERE p.analista_id IS NOT NULL
         AND COALESCE(btrim(p.analista_nome), '') = ''
       ORDER BY p.tr, p.codigo_pc
         FOR UPDATE OF p`);

    const codigos = alvo.map(r => r.codigo_pc);
    const trs = [...new Set(alvo.map(r => r.tr))];
    const ids = [...new Set(alvo.map(r => r.analista_id))];

    nl(`\n── O ALVO ────────────────────────────────────────────────`);
    nl(`   ${codigos.length} PCs · ${trs.length} TRs · ${ids.length} analistas`);
    if (codigos.length !== PCS_ESPERADAS || trs.length !== TRS_ESPERADAS || ids.length !== IDS_ESPERADOS)
      throw new Error(`esperava ${PCS_ESPERADAS} PCs / ${TRS_ESPERADAS} TRs / ${IDS_ESPERADOS} ids, `
        + `achei ${codigos.length} / ${trs.length} / ${ids.length} — o banco mudou, parar e remedir`);

    // ⚠️ TODAS têm de estar baixadas. Se aparecer uma aberta, o alvo não é o que este script
    // descreve, e a decisão volta ao Richard antes de qualquer escrita.
    const abertas = alvo.filter(r => !r.baixada);
    if (abertas.length) throw new Error(`${abertas.length} PCs do alvo NAO estao baixadas: `
      + abertas.map(r => r.codigo_pc).join(', '));

    // ── O NOME QUE ENTRA, por analista_id ────────────────────────────────────
    const plano = new Map();   // analista_id -> nome
    nl(`\n── O NOME QUE ENTRA ──────────────────────────────────────`);
    for (const id of ids) {
      const cadastro = alvo.find(r => r.analista_id === id).cadastro;
      if (!cadastro) throw new Error(`id ${id} nao tem cadastro em usuarios — sem fonte de nome`);

      // O que o acervo já grava para este id, do mais frequente ao menos.
      const { rows: usados } = await cli.query(`
        SELECT analista_nome, COUNT(*)::int n
          FROM prestacoes_contas
         WHERE analista_id = $1 AND COALESCE(btrim(analista_nome), '') <> ''
         GROUP BY analista_nome ORDER BY n DESC`, [id]);

      const doCadastro = assumir.nomeCurto(cadastro);
      const doAcervo = usados.length ? usados[0].analista_nome : null;

      // ⚠️ EMPATE É AMBIGUIDADE, NÃO ESCOLHA (armadilha 19). Dois nomes com a mesma
      // contagem não elegem dominante: para e devolve a decisão.
      if (FONTE === 'acervo' && usados.length > 1 && usados[0].n === usados[1].n)
        throw new Error(`id ${id} tem empate no acervo: `
          + usados.map(u => `${u.analista_nome} (${u.n})`).join(' · '));
      if (FONTE === 'acervo' && !doAcervo)
        throw new Error(`id ${id} nao tem nenhum nome gravado no acervo — use --fonte=cadastro`);

      const escolhido = FONTE === 'acervo' ? doAcervo : doCadastro;
      plano.set(id, escolhido);

      const quantas = alvo.filter(r => r.analista_id === id).length;
      nl(`   id ${String(id).padStart(3)}  ${quantas} PCs  ->  "${escolhido}"`);
      nl(`        cadastro "${cadastro}"  ·  nomeCurto() daria "${doCadastro}"`);
      nl(`        acervo:  ${usados.map(u => `"${u.analista_nome}" (${u.n})`).join(' · ') || '(nenhum)'}`);
      if (doCadastro !== doAcervo)
        nl(`        ⚠️  as duas fontes DIVERGEM — esta rodada usa a "${FONTE}"`);
    }

    nl(`\n── LINHA A LINHA ─────────────────────────────────────────`);
    alvo.forEach(r => nl(`   ${r.tr.padEnd(14)} ${String(r.codigo_pc).padEnd(22)} `
      + `${String(r.tipo).padEnd(7)} baixada ${r.baixada ? 'S' : 'n'} · `
      + `"${r.parecer_tipo ?? '—'}"  ->  analista_nome = "${plano.get(r.analista_id)}"`));

    // ── A ESCRITA — uma por analista_id, e SÓ duas colunas ───────────────────
    let tocadas = 0;
    for (const id of ids) {
      const lista = alvo.filter(r => r.analista_id === id).map(r => r.codigo_pc);
      const { rowCount } = await cli.query(
        `UPDATE prestacoes_contas
            SET analista_nome = $2, atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [lista, plano.get(id)]);
      tocadas += rowCount;
    }
    if (tocadas !== codigos.length)
      throw new Error(`esperava escrever ${codigos.length}, escrevi ${tocadas}`);
    nl(`\n>> ${tocadas} PCs com o nome preenchido`);

    // ══ CONFERÊNCIA DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ═══════════════════
    const un = async (s, p) => (await cli.query(s, p)).rows[0];

    // 1. NENHUMA linha fora da lista mudou em coluna nenhuma.
    const c1 = await un(`
      SELECT COUNT(*)::int n FROM (
        SELECT codigo_pc FROM prestacoes_contas
        EXCEPT
        SELECT codigo_pc FROM ${BK}) t`);
    const c1b = await un(`
      SELECT COUNT(*)::int n
        FROM ${BK} b JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
       WHERE b.analista_nome IS DISTINCT FROM p.analista_nome
         AND NOT (p.codigo_pc = ANY($1))`, [codigos]);

    // 2. Nas 18, TUDO o que este script prometeu não tocar está idêntico ao backup.
    const cols = INTOCADAS.map(c => `b.${c}`).join(', ');
    const colsP = INTOCADAS.map(c => `p.${c}`).join(', ');
    const c2 = await un(`
      SELECT COUNT(*)::int n
        FROM ${BK} b JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
       WHERE p.codigo_pc = ANY($1)
         AND (${cols}) IS DISTINCT FROM (${colsP})`, [codigos]);

    // 3. E no acervo INTEIRO, nada de baixa/parecer/C.I. se mexeu.
    const c3 = await un(`
      SELECT COUNT(*)::int n
        FROM ${BK} b JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
       WHERE (b.baixada, b.data_baixa, b.parecer_tipo, b.parecer_ci, b.enviado_ci,
              b.dt_envio_ci, b.ci_situacao, b.ci_rodada, b.valor, b.parcial_num, b.status)
          IS DISTINCT FROM
             (p.baixada, p.data_baixa, p.parecer_tipo, p.parecer_ci, p.enviado_ci,
              p.dt_envio_ci, p.ci_situacao, p.ci_rodada, p.valor, p.parcial_num, p.status)`);

    // 4. O nome gravado é EXATAMENTE o previsto no dry-run — linha a linha.
    let divergiu = 0;
    for (const r of alvo) {
      const { rows: [d] } = await cli.query(
        'SELECT analista_nome FROM prestacoes_contas WHERE codigo_pc = $1', [r.codigo_pc]);
      if (d.analista_nome !== plano.get(r.analista_id)) divergiu++;
    }

    // 5. O buraco fechou, e nenhuma PC nasceu ou sumiu.
    const c5 = await un(`
      SELECT COUNT(*)::int n FROM prestacoes_contas
       WHERE analista_id IS NOT NULL AND COALESCE(btrim(analista_nome), '') = ''`);
    const c6 = await un('SELECT COUNT(*)::int n FROM prestacoes_contas');

    // 6. Ninguém ganhou um nome NOVO no acervo — o conjunto de nomes por id não cresceu.
    const c7 = await un(`
      SELECT COUNT(*)::int n FROM (
        SELECT p.analista_id
          FROM prestacoes_contas p
         WHERE p.analista_id = ANY($1) AND COALESCE(btrim(p.analista_nome), '') <> ''
         GROUP BY p.analista_id
        HAVING COUNT(DISTINCT p.analista_nome) > (
          SELECT COUNT(DISTINCT b.analista_nome) FROM ${BK} b
           WHERE b.analista_id = p.analista_id
             AND COALESCE(btrim(b.analista_nome), '') <> '')) t`, [ids]);

    const checks = [
      ['nenhuma PC criada nem apagada',            c1.n === 0 && c6.n === bk.n, `${bk.n} -> ${c6.n}`],
      ['nome mexido fora da lista das 18',         c1b.n === 0, c1b.n],
      ['nas 18, as 24 colunas intocadas iguais',   c2.n === 0, c2.n],
      ['baixa/parecer/C.I. intactos no acervo',    c3.n === 0, c3.n],
      ['o nome gravado bate com o dry-run',        divergiu === 0, `${alvo.length - divergiu}/${alvo.length}`],
      ['"id sem nome" zerou',                      c5.n === 0, c5.n],
      ['ninguem ganhou um nome NOVO',              c7.n === 0, c7.n],
    ];

    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) {
      if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(40)} ${v}`);
    }

    if (falhou) {
      await cli.query('ROLLBACK');
      nl('\n>> CONFERENCIA FALHOU: ROLLBACK. Nada gravado.');
      process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_nomevazio_20260816.json', JSON.stringify({
        quando: new Date().toISOString(), backup: BK, fonte: FONTE,
        antes: alvo.map(r => ({ codigo_pc: r.codigo_pc, analista_id: r.analista_id, analista_nome: null })),
        depois: alvo.map(r => ({ codigo_pc: r.codigo_pc, analista_nome: plano.get(r.analista_id) })),
      }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
    } else {
      await cli.query('ROLLBACK');
      nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
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
