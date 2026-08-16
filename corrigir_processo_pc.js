// CAMINHO: sigpc-api/corrigir_processo_pc.js
//
// CORRIGE EM LOTE os textos de `processo_pc` que não formam um processo SGPe.
// PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ENTRA, E O QUE NÃO ENTRA
//
// Só entra o que é CERTEZA, e certeza aqui tem DUAS peneiras:
//
//   1. a leitura é determinística — nada é deduzido;
//   2. o SGPe CONFIRMA o processo corrigido.
//
// A segunda peneira existe porque a primeira sozinha não basta. O `ADR19 0011181.2017`
// tinha decomposição limpa (ADR19 · 11181 · 2017) e o SGPe não tem esse processo: uma
// correção assim seria um palpite bem formatado, e pior que o texto errado — pareceria certa.
//
// ⚠️ A SIGLA SÓ ABSORVE DÍGITOS COLADOS NELA.
// A primeira versão desta regra transformou `ADR 1181/2017` em `ADR11 81/2017`, comendo dois
// dígitos do NÚMERO para inventar uma regional. O SGPe até confirmou um processo com esse
// número — apontando para o processo ERRADO. Se há separador depois das letras, a sigla são
// só as letras.
//
// Palpite não entra: `AR35*` (7 textos, 138 PCs), `ADR2600001621`, `SCC7537`, `SCC 6579` e os
// dois acima ficam para conferência humana, pela tela.
// ─────────────────────────────────────────────────────────────────────────────

const GRAVAR = process.argv.includes('--gravar');
// ⚠️ `--mae` corrige `processo_mae` com as MESMAS duas peneiras. A coluna mãe tem textos
// próprios — em 13/08 eram 20, três deles inexistentes na coluna da PC. E não há fusão a
// conferir: quem define a parcial é (tr, processo_pc); o processo mãe não agrupa nada.
const CAMPO = process.argv.includes('--mae') ? 'processo_mae' : 'processo_pc';
const TAB_BK = '_backup_processo_pc_20260813';

const { Pool } = require('pg');
const L = require('./lib/sgpe-link');
const { resolverNoSgpe } = require('./lib/sgpe-dwr');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });

const ANO_MIN = 2000, ANO_MAX = 2030;
const ehAno = n => Number.isInteger(n) && n >= ANO_MIN && n <= ANO_MAX;

/** A sigla. Só absorve dígitos COLADOS; com separador, são só as letras. */
function acharSigla(bruto) {
  const t = String(bruto).trim();
  const letras = (/^[A-Za-z]+/.exec(t) || [''])[0].toUpperCase();
  if (!letras) return null;
  const resto = t.slice(letras.length);

  if (/^\d/.test(resto)) {
    const digitos = (/^\d+/.exec(resto) || [''])[0];
    for (let k = 2; k >= 0; k--) {
      const s = letras + digitos.slice(0, k);
      if (L.siglaConhecida(s)) return { sigla: s, extras: k };
    }
    return { sigla: null, letras };
  }
  if (L.siglaConhecida(letras)) return { sigla: letras, extras: 0 };

  // regional escrita solta: "ADR 19 1010/2017". Só com TRÊS grupos — com dois não dá para
  // saber se o primeiro é regional ou número, e aí é palpite.
  const grupos = resto.match(/\d+/g) || [];
  if (grupos.length >= 3 && grupos[0].length <= 2 && L.siglaConhecida(letras + grupos[0]))
    return { sigla: letras + grupos[0], extras: 0, regionalSolta: true };

  return { sigla: null, letras };
}

/** Propõe a correção. Só devolve `proposta` quando a leitura é determinística. */
function propor(bruto) {
  const t = String(bruto).trim();
  const inf = acharSigla(t);
  if (!inf || !inf.sigla)
    return { proposta: null, motivo: `"${inf ? inf.letras : '?'}" não está no mapa de órgãos` };

  let depois = t.slice((/^[A-Za-z]+/.exec(t) || [''])[0].length).replace(/^[\s./:-]+/, '');
  if (inf.extras) depois = depois.slice(inf.extras);
  let grupos = depois.match(/\d+/g) || [];
  if (inf.regionalSolta) grupos = grupos.slice(1);

  if (grupos.length === 2) {
    const num = parseInt(grupos[0], 10), ano = parseInt(grupos[1], 10);
    if (grupos[1].length === 4 && ehAno(ano) && num > 0)
      return { proposta: `${inf.sigla} ${num}/${ano}`, regra: 'separador' };
  }
  if (grupos.length === 1) {
    const d = grupos[0];
    if (d.length > 4) {
      const ano = parseInt(d.slice(-4), 10), num = parseInt(d.slice(0, -4), 10);
      if (ehAno(ano) && num > 0) return { proposta: `${inf.sigla} ${num}/${ano}`, regra: 'colado' };
      return { proposta: null, motivo: `os 4 últimos dígitos ("${d.slice(-4)}") não formam ano` };
    }
    return { proposta: null, motivo: 'não há ano no texto' };
  }
  return { proposta: null, motivo: 'formato não reconhecido' };
}

;(async () => {
  const cli = await pool.connect();
  try {
    // ── 0. o backup tem de existir e estar em dia ────────────────────────────
    const { rows: bk } = await cli.query(
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [TAB_BK]);
    if (!bk[0].n) { console.log(`>> ${TAB_BK} NÃO EXISTE. Crie o backup antes.`); process.exitCode = 2; return; }
    const { rows: div } = await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.codigo_pc=p.codigo_pc
        WHERE p.${CAMPO} IS DISTINCT FROM b.${CAMPO}`);
    console.log(`backup ${TAB_BK}: ${div[0].n} PCs já divergem dele`);

    // ── 1. quem precisa de correção ──────────────────────────────────────────
    const { rows: pcs } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, ${CAMPO} AS valor FROM prestacoes_contas WHERE setorial_id='FCEE'`);
    const porTexto = new Map();
    for (const p of pcs) {
      const b = (p.valor ?? '').toString();
      if (!b.trim() || b.trim() === '-1') continue;
      if (L.normalizarProcesso(b)) continue;          // já é processo válido
      if (!porTexto.has(b)) porTexto.set(b, { bruto: b, pcs: [], trs: new Set() });
      porTexto.get(b).pcs.push(p.codigo_pc);
      porTexto.get(b).trs.add(p.tr);
    }

    // ── 2. peneira 1: leitura determinística ─────────────────────────────────
    const candidatos = [], palpites = [];
    for (const it of porTexto.values()) {
      const p = propor(it.bruto);
      (p.proposta ? candidatos : palpites).push({ ...it, ...p });
    }

    // ── 3. peneira 2: o SGPe confirma? ───────────────────────────────────────
    console.log(`\nconferindo ${candidatos.length} propostas no SGPe (${'~' + Math.round(candidatos.length * 0.7)}s)...`);
    const certos = [];
    for (const c of candidatos) {
      const n = L.normalizarProcesso(c.proposta);
      if (!n) { palpites.push({ ...c, motivo: 'a proposta não normaliza' }); continue; }
      try {
        const r = await resolverNoSgpe(n);
        if (r && r.nuProcesso) certos.push({ ...c, chave: L.formatarProcesso(n), sgpe: r });
        else palpites.push({ ...c, motivo: 'o SGPe não devolveu o processo' });
      } catch (e) {
        palpites.push({ ...c, motivo: 'o SGPe não tem o processo corrigido' });
      }
      await new Promise(r => setTimeout(r, 700));     // ritmo do SGPe, como o job
    }

    console.log(`\nCERTEZA: ${certos.length} textos · ${certos.reduce((s, c) => s + c.pcs.length, 0)} PCs`);
    console.log(`PALPITE: ${palpites.length} textos · ${palpites.reduce((s, c) => s + c.pcs.length, 0)} PCs (NÃO entram)`);
    if (!certos.length) { console.log('Nada a corrigir.'); return; }

    // ── 4. processos que passam a CONVIVER na mesma TR ───────────────────────
    //
    // ⚠️ ISTO ABORTAVA A RODADA INTEIRA ATÉ 16/08/2026, e não pode mais.
    //
    // A regra que sustentava o abort era "uma parcial = (tr, processo_pc)": se o texto
    // corrigido já existisse na TR, duas parcelas "viravam uma". **A regra é falsa.** Medido
    // no estoque oficial da CGE por dois agentes cegos um ao outro: um mesmo processo SGPe
    // carrega várias parcelas do SIGEF em 113 pares (tr, processo) — 78 TRs, 465 PCs.
    //
    // Duas parcelas dividirem um processo é o dado NORMAL, não uma colisão. Manter o abort
    // aqui deixaria este script sem poder rodar justamente nos casos em que ele é necessário
    // — e são estes 11 processos SGPe pendentes que ele existe para consertar.
    //
    // ⚠️ SÓ VALE PARA `processo_pc`. O processo mãe não agrupa parcela nenhuma, e conferir
    // isso nele dá ALARME FALSO garantido: o `processo_pc` daquela TR já foi corrigido para
    // o mesmo valor numa rodada anterior, então a "colisão" é com a própria correção.
    // Aconteceu de verdade em 13/08 — a rodada da coluna mãe abortou com 17 fusões falsas.
    //
    // Continua sendo IMPRESSO: é informação que quem lê o dry-run tem de ver antes de gravar.
    // O que mudou é que ver deixou de ser o mesmo que recusar.
    const convivencias = [];
    if (CAMPO === 'processo_pc') {
      for (const c of certos) {
        for (const tr of c.trs) {
          const { rows } = await cli.query(
            `SELECT DISTINCT processo_pc FROM prestacoes_contas
              WHERE setorial_id='FCEE' AND tr=$1 AND processo_pc <> $2`, [tr, c.bruto]);
          for (const o of rows) {
            const on = L.normalizarProcesso(o.processo_pc);
            if (on && L.formatarProcesso(on) === c.chave) convivencias.push({ tr, de: c.bruto, para: c.proposta });
          }
        }
      }
    }
    console.log(`processos que passam a conviver com outra parcial da TR: ` +
      `${CAMPO === 'processo_pc' ? convivencias.length : 'n/a (processo_mae nao agrupa parcial)'}`);
    if (convivencias.length) {
      console.log(JSON.stringify(convivencias, null, 1));
      console.log('   (legitimo — ver a armadilha 16 do CLAUDE.md. NAO aborta.)');
    }

    // ── 5. a escrita ─────────────────────────────────────────────────────────
    // A foto do inicio: e com ela que as conferencias c1/c3 comparam.
    const fotografar = async () => new Map((await cli.query(
      `SELECT codigo_pc, processo_pc, processo_mae FROM prestacoes_contas WHERE setorial_id='FCEE'`
    )).rows.map(r => [r.codigo_pc, r]));
    const antesDaRodada = await fotografar();

    // Quantos pares (tr, processo_pc) carregam mais de uma parcial. NÃO é mais um defeito —
    // é o dado normal (113 pares no estoque da CGE). Medido antes e depois só para que a
    // rodada mostre o que ela mudou nesse número, em vez de afirmar que ele tem de ser zero.
    const contarSplit = async () => (await cli.query(`SELECT COUNT(*)::int n FROM (
        SELECT tr, processo_pc FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND tipo <> 'final'
         GROUP BY 1,2 HAVING COUNT(DISTINCT parcial_num) > 1) t`)).rows[0].n;
    const splitAntes = await contarSplit();

    await cli.query('BEGIN');
    let tocadas = 0;
    for (const c of certos) {
      // Lista explícita de chaves (regra 12), capturada ANTES — não por `WHERE processo_pc = <texto>`,
      // que é condição derivada e casaria com linha que tenha mudado no meio.
      const { rowCount } = await cli.query(
        `UPDATE prestacoes_contas SET ${CAMPO} = $2, atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [c.pcs, c.proposta]);
      tocadas += rowCount;
      // O rastro, uma linha por texto corrigido.
      await cli.query(
        `INSERT INTO parcela_historico
           (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
         VALUES ($1, NULL, 'FCEE', $5, $2, $3, NULL, $4)`,
        [[...c.trs][0], c.bruto, c.proposta,
         `correção em lote de 13/08 (regra: ${c.regra}, confirmado no SGPe) · ${c.pcs.length} PCs`, CAMPO]);
    }
    console.log(`\nPCs atualizadas: ${tocadas}`);

    // ── 6. validação ─────────────────────────────────────────────────────────
    const un = async (sql, p) => (await cli.query(sql, p)).rows[0];
    const depoisDaRodada = await fotografar();
    const todasPcs = certos.flatMap(c => c.pcs);

    // ⚠️ c1 e c3 comparam com a FOTO DO INÍCIO DESTA RODADA, não com `_backup_..._20260813`.
    //
    // O backup é de antes de TODAS as correções de 13/08. Compará-lo aqui acusaria como
    // "alterado" tudo o que rodadas anteriores já corrigiram de propósito — falso negativo
    // barulhento que esconderia o defeito de verdade. A pergunta certa é "esta rodada mexeu
    // em algo que não devia?", e só a foto do início responde isso.
    const OUTRA = CAMPO === 'processo_pc' ? 'processo_mae' : 'processo_pc';
    const c1 = { n: [...antesDaRodada].filter(([cod, v]) =>
                   !todasPcs.includes(cod) && v[CAMPO] !== depoisDaRodada.get(cod)[CAMPO]).length };
    const c3 = { n: [...antesDaRodada].filter(([cod, v]) =>
                   v[OUTRA] !== depoisDaRodada.get(cod)[OUTRA]).length };
    const c2 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.codigo_pc=p.codigo_pc
                          WHERE p.parcial_num IS DISTINCT FROM b.parcial_num`);
    const splitDepois = await contarSplit();
    const c5 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas WHERE codigo_pc = ANY($1)
                          AND ${CAMPO} !~ '^[A-Z]+[0-9]* [0-9]+/[0-9]{4}$'`, [todasPcs]);

    // ⚠️ 'parcela partida em 2 numeros' SAIU DA LISTA DE CHECKS em 16/08/2026.
    //
    // Ele exigia `COUNT(DISTINCT parcial_num) > 1` == 0 sobre a base INTEIRA — não sobre as
    // linhas que esta rodada tocou. Com a numeração do SIGEF gravada (113 pares), ele passaria
    // a dar FALHA em toda rodada, inclusive numa que não encoste em `parcial_num`, e mandaria
    // ROLLBACK apontando para o lugar errado.
    //
    // ⚠️ E NÃO HÁ CHECK SUCESSOR, de propósito. Este script não escreve em `parcial_num`, e
    // isso quem prova é o `c2` — com `c2 = 0`, corrigir texto de processo não consegue partir
    // nem juntar parcela nenhuma. Inventar um substituto seria encenar uma proteção que o
    // `c2` já dá. O número vira MEDIÇÃO, impressa abaixo dos checks.
    const checks = [
      ['PC fora da lista alterada',              c1.n === 0, c1.n],
      ['parcial_num alterado',                   c2.n === 0, c2.n],
      [(CAMPO === 'processo_pc' ? 'processo_mae' : 'processo_pc') + ' alterado',                  c3.n === 0, c3.n],
      ['corrigida que nao virou processo valido', c5.n === 0, c5.n],
      ['PCs tocadas == esperadas',               tocadas === todasPcs.length, `${tocadas}/${todasPcs.length}`],
    ];
    console.log('\n── VALIDACAO ─────────────────────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      console.log(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(42)} ${v}`); }
    console.log(`   MEDIDO  ${'pares (tr,processo) com 2+ parciais'.padEnd(42)} ` +
      `${splitAntes} -> ${splitDepois}${splitDepois === splitAntes ? ' (inalterado)' : ''}`);

    if (falhou)      { await cli.query('ROLLBACK'); console.log('\n>> VALIDACAO FALHOU: ROLLBACK.'); process.exitCode = 2; }
    else if (GRAVAR) {
      require('fs').writeFileSync('reverter_processo_pc_20260813.json', JSON.stringify(
        { quando: new Date().toISOString(), tabela_backup: TAB_BK,
          correcoes: certos.map(c => ({ de: c.bruto, para: c.proposta, pcs: c.pcs })) }, null, 1));
      await cli.query('COMMIT');
      console.log('\n>> COMMIT.');
      console.log('   lista de reversao em reverter_processo_pc_20260813.json');
      console.log(`\nPara reverter (lista explicita, regra 12):
  UPDATE prestacoes_contas p SET processo_pc = b.processo_pc
    FROM ${TAB_BK} b WHERE b.codigo_pc = p.codigo_pc AND p.codigo_pc = ANY($1);`);
    }
    else { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK. Rode com --gravar para aplicar.'); }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('ERRO — ROLLBACK: ' + e.message);
    process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
