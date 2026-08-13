// CAMINHO: sigpc-api/resolver_processos_restantes.js
//
// Resolve os processos SGPe que SOBRARAM depois da correção em lote — os casos que a regra
// determinística recusou de propósito. PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, E POR QUE ELA É MAIS DURA AQUI
//
// A correção em lote exigia leitura determinística + confirmação do SGPe. Aqui a leitura
// NÃO é determinística — por isso estes casos sobraram. Então a peneira muda de forma:
//
//   1. gera VÁRIOS candidatos plausíveis para o mesmo texto;
//   2. pergunta ao SGPe um por um;
//   3. só corrige quando **EXATAMENTE UM** confirma.
//
// ⚠️ DOIS CANDIDATOS CONFIRMANDO É AMBIGUIDADE, NÃO CONFIRMAÇÃO. O `SCC7537` não tem ano no
// texto, e o SGPe tem `SCC 7537` em 2020, 2021, 2022, 2023 E 2024 — cinco processos
// diferentes, todos existentes. Escolher um seria gerar link para o processo errado sem erro
// nenhum na tela: o pior resultado possível, porque ninguém percebe. Esses ficam como estão.
// ─────────────────────────────────────────────────────────────────────────────

const GRAVAR = process.argv.includes('--gravar');
const TAB_BK = '_backup_processo_20260813b';

const { Pool } = require('pg');
const L = require('./lib/sgpe-link');
const { resolverNoSgpe } = require('./lib/sgpe-dwr');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });

const ANO_MIN = 2000, ANO_MAX = 2030;
const ehAno = n => Number.isInteger(n) && n >= ANO_MIN && n <= ANO_MAX;
const REGIONAIS = Object.keys(L.ORGAOS).filter(s => /^(ADR|SDR)\d\d$/.test(s));

/**
 * Todos os candidatos plausíveis para um texto, com o porquê de cada um.
 *
 * É de propósito que ele gere DEMAIS: quem decide é o SGPe, e gerar de menos faz o caso
 * sobrar sem necessidade. Gerar de mais só custa consulta — e a ambiguidade, quando aparece,
 * é informação: significa que o texto realmente não identifica um processo.
 */
function candidatos(bruto, anoTr) {
  const t = String(bruto).trim();
  const out = new Map();   // texto -> motivo
  const por = (sigla, num, ano, motivo) => {
    if (!sigla || !L.siglaConhecida(sigla) || !(num > 0) || !ehAno(ano)) return;
    out.set(`${sigla} ${num}/${ano}`, motivo);
  };

  // ⚠️ O PRÓPRIO TEXTO É O PRIMEIRO CANDIDATO, quando ele já forma um processo com sigla
  // conhecida. Sem isto, um processo CERTO que só não está no cache ficaria "sem candidato"
  // e sem link para sempre — foi o que aconteceu com os `ADR35 xxx/2017` que acabamos de
  // corrigir: o texto estava certo, o SGPe tinha o processo, e o cache não sabia.
  const jaValido = L.normalizarProcesso(t);
  if (jaValido && L.siglaConhecida(jaValido.sigla))
    out.set(L.formatarProcesso(jaValido), 'o texto já está correto — faltava o link no cache');

  const letras = (/^[A-Za-z]+/.exec(t) || [''])[0].toUpperCase();
  const grupos = (t.slice(letras.length).match(/\d+/g) || []);
  const digitos = grupos.join('');

  // As siglas a tentar: a escrita, e — se ela não estiver no mapa — a hipótese "AR = ADR sem
  // o D", provada em 13/08 nos cinco AR35* (todos confirmados, órgão 13710).
  const siglasBase = [];
  if (L.siglaConhecida(letras)) siglasBase.push([letras, 'sigla como está']);
  if (!L.siglaConhecida(letras) && /^A?R$/.test(letras)) siglasBase.push(['ADR', 'AR = ADR sem o D']);
  if (!L.siglaConhecida(letras) && letras.length >= 2) {
    for (const alt of [letras.replace(/^A/, 'AD'), 'A' + letras, letras.slice(0, -1)])
      if (L.siglaConhecida(alt)) siglasBase.push([alt, `letra faltando/sobrando: ${letras} -> ${alt}`]);
    // sigla digitada duas vezes: "SCCSCC3756/2022"
    if (letras.length % 2 === 0) {
      const metade = letras.slice(0, letras.length / 2);
      if (metade === letras.slice(letras.length / 2) && L.siglaConhecida(metade))
        siglasBase.push([metade, `sigla repetida: ${letras} -> ${metade}`]);
    }
  }

  for (const [base, motivoS] of siglasBase) {
    // (a) a regional pode estar colada nos dígitos
    const comRegional = [];
    if (/^(ADR|SDR)$/.test(base)) {
      for (let k = 1; k <= 2; k++) {
        const s = base + digitos.slice(0, k).padStart(2, '0');
        if (L.siglaConhecida(s)) comRegional.push([s, digitos.slice(k), `regional colada (${digitos.slice(0, k)})`]);
      }
      // ...ou não estar em lugar nenhum: tenta TODAS as regionais.
      // Se mais de uma confirmar, vira ambiguidade e o caso fica de fora — que é o certo.
      for (const s of REGIONAIS.filter(x => x.startsWith(base)))
        comRegional.push([s, digitos, `regional ausente: testando ${s}`]);
    }
    comRegional.push([base, digitos, motivoS]);

    for (const [sigla, resto, motivoR] of comRegional) {
      if (!resto) continue;
      // (b) ano de 4 dígitos no fim
      if (resto.length > 4) por(sigla, parseInt(resto.slice(0, -4), 10), parseInt(resto.slice(-4), 10),
                                `${motivoR} · ano nos 4 últimos dígitos`);
      // (c) ano de 2 dígitos + dígito verificador no fim — o padrão NNN|17|5 dos AR35*
      if (resto.length > 3) {
        const aa = parseInt(resto.slice(-3, -1), 10);
        por(sigla, parseInt(resto.slice(0, -3), 10), 2000 + aa, `${motivoR} · ano de 2 dígitos + verificador`);
      }
      // (d) ano de 2 dígitos no fim, sem verificador
      if (resto.length > 2) {
        const aa = parseInt(resto.slice(-2), 10);
        por(sigla, parseInt(resto.slice(0, -2), 10), 2000 + aa, `${motivoR} · ano de 2 dígitos`);
      }
      // (e) o texto tem grupos separados: número e ano já vêm partidos
      if (grupos.length >= 2) {
        const ult = grupos[grupos.length - 1];
        const num = parseInt(grupos[grupos.length - 2], 10);
        if (ult.length === 4) por(sigla, num, parseInt(ult, 10), `${motivoR} · número e ano já separados`);
      }
      // (f) SEM ANO NO TEXTO: testa uma FAIXA de anos, não só o da TR.
      //
      // ⚠️ Testar um ano só produz falsa unanimidade. O `SCC7537` não tem ano, e a primeira
      // versão testou apenas 2020 (o ano da TR): confirmou, e o script ia corrigir como se
      // fosse certeza. Mas o SGPe tem `SCC 7537` em 2020, 2021, 2022, 2023 E 2024 — cinco
      // processos diferentes. Um candidato só escondia a ambiguidade em vez de revelá-la.
      // Com a faixa, vários confirmam, o caso cai em AMBÍGUO e fica de fora. Que é o certo:
      // link para o processo errado não dá erro na tela, e ninguém percebe.
      if (anoTr) for (let y = anoTr - 3; y <= anoTr + 4; y++)
        por(sigla, parseInt(resto, 10), y, `${motivoR} · sem ano no texto, testando ${y}`);
    }
  }
  return [...out.entries()].map(([texto, motivo]) => ({ texto, motivo }));
}

/**
 * Já tem link hoje? (mapa + cache)
 *
 * ⚠️ O cache inteiro vem numa consulta só. A primeira versão perguntava ao banco por
 * processo — 6.382 idas para responder a mesma pergunta, e o dry-run passou de 10 minutos
 * sem sair da primeira fase. O cache tem 7,7 mil linhas: cabe em memória sem pensar.
 */
function temLink(cacheOk, bruto) {
  const p = L.normalizarProcesso(bruto);
  if (!p || !L.siglaConhecida(p.sigla)) return false;
  return cacheOk.has(L.formatarProcesso(p));
}

;(async () => {
  const cli = await pool.connect();
  try {
    const { rows: bk } = await cli.query(
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [TAB_BK]);
    if (!bk[0].n) { console.log(`>> ${TAB_BK} NÃO EXISTE.`); process.exitCode = 2; return; }

    // ── 1. o que continua sem link, nas DUAS colunas ─────────────────────────
    const { rows: pcs } = await cli.query(
      `SELECT codigo_pc, tr, processo_pc, processo_mae FROM prestacoes_contas WHERE setorial_id='FCEE'`);
    const alvos = new Map();   // `${campo}|${texto}` -> { campo, bruto, pcs[], trs Set }
    for (const p of pcs) {
      for (const campo of ['processo_pc', 'processo_mae']) {
        const b = (p[campo] ?? '').toString();
        if (!b.trim() || b.trim() === '-1') continue;
        const k = `${campo}|${b}`;
        if (!alvos.has(k)) alvos.set(k, { campo, bruto: b, pcs: [], trs: new Set() });
        alvos.get(k).pcs.push(p.codigo_pc); alvos.get(k).trs.add(p.tr);
      }
    }
    const cacheOk = new Set((await cli.query(
      `SELECT sigla, numero_oficial, ano FROM sgpe_processo_ref WHERE nu_processo IS NOT NULL`
    )).rows.map(c => `${c.sigla} ${c.numero_oficial}/${c.ano}`));
    const pendentes = [...alvos.values()].filter(a => !temLink(cacheOk, a.bruto));
    console.log(`sem link hoje: ${pendentes.length} textos · ` +
                `${pendentes.reduce((s, a) => s + a.pcs.length, 0)} PCs (contando as duas colunas)`);

    // ── 2. candidatos, e o SGPe decide ───────────────────────────────────────
    const resolvidos = [], ambiguos = [], semSaida = [];
    let consultas = 0;
    // ⚠️ Memória entre itens: o MESMO texto aparece nas duas colunas (processo_pc e
    // processo_mae da mesma TR), e o `AR355478172` sozinho gera 333 candidatos. Sem isto o
    // SGPe levaria o dobro de perguntas para dar as mesmas respostas — 800 idas a sistema de
    // terceiro por uma rodada. O que se pergunta uma vez não se pergunta de novo.
    const memo = new Map();
    const perguntar = async (texto) => {
      if (memo.has(texto)) return memo.get(texto);
      const p = L.normalizarProcesso(texto);
      if (!p) { memo.set(texto, null); return null; }
      consultas++;
      let r = null;
      try { const x = await resolverNoSgpe(p); if (x && x.nuProcesso) r = { nu: x.nuProcesso, orgao: x.cdOrgaosetor }; }
      catch (e) { r = null; }
      await new Promise(res => setTimeout(res, 650));
      memo.set(texto, r);
      return r;
    };
    for (const a of pendentes) {
      const anoTr = parseInt(String([...a.trs][0] || '').slice(0, 4), 10) || null;
      const cands = candidatos(a.bruto, ehAno(anoTr) ? anoTr : null);
      const confirmados = [];
      for (const c of cands) {
        const r = await perguntar(c.texto);
        if (r) confirmados.push({ ...c, nu: r.nu, orgao: r.orgao });
      }
      // ⚠️ O QUE O SGPe CONFIRMOU VAI PARA O CACHE — é isso que faz o link EXISTIR.
      //
      // Confirmar e não gravar deixa o texto certo e a tela sem link: foi o estado em que as
      // correções de hoje ficaram até aqui. O `job_sgpe_links` chegaria lá sozinho, mas só na
      // próxima passada, e não há motivo para esperar o que já foi perguntado.
      // `origem = 'SGPE'` porque foi o SGPe que respondeu — MANUAL é só o link colado à mão.
      for (const c of confirmados) {
        const p = L.normalizarProcesso(c.texto);
        await cli.query(
          `INSERT INTO sgpe_processo_ref (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, tentativas, ultima_tentativa)
           VALUES ($1,$2,$3,$4,$5,'SGPE',1,NOW())
           ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
             SET nu_processo = EXCLUDED.nu_processo, cd_orgaosetor = EXCLUDED.cd_orgaosetor,
                 origem = 'SGPE', motivo = NULL
           WHERE sgpe_processo_ref.origem NOT IN ('CONFERIDO', 'MANUAL')`,
          [p.sigla, p.numero, p.ano, c.nu, c.orgao]);
      }
      if (confirmados.length === 1) resolvidos.push({ ...a, escolha: confirmados[0], cands: cands.length });
      else if (confirmados.length > 1) ambiguos.push({ ...a, confirmados, cands: cands.length });
      else semSaida.push({ ...a, cands: cands.length });
      console.log(`   ${a.campo.padEnd(13)} ${a.bruto.padEnd(22)} ${cands.length} candidatos -> ` +
                  (confirmados.length === 1 ? `✓ ${confirmados[0].texto}`
                   : confirmados.length ? `AMBIGUO (${confirmados.length})` : 'nenhum confirma'));
    }
    console.log(`\nconsultas ao SGPe: ${consultas}`);
    console.log(`resolvidos: ${resolvidos.length} · ambiguos: ${ambiguos.length} · sem saida: ${semSaida.length}`);

    // ⚠️ TEXTO QUE JÁ ESTAVA CERTO NÃO É CORREÇÃO — era só o cache que não sabia.
    //
    // Esses saem daqui: o UPDATE seria `SET x = x`, e a conferência de fusão os acusaria
    // (o processo "já existe na TR" porque é o da própria PC). Foi o que abortou a primeira
    // rodada com sete fusões falsas, todas com `de` igual a `para`. O que eles precisavam —
    // a linha no `sgpe_processo_ref` — já foi gravado acima.
    const soCache = resolvidos.filter(r => r.bruto.trim() === r.escolha.texto);
    const paraGravar = resolvidos.filter(r => r.bruto.trim() !== r.escolha.texto);
    if (soCache.length) console.log(`\n${soCache.length} textos ja estavam certos — so faltava o link no cache, e ele foi gravado.`);

    if (!paraGravar.length) { console.log('Nenhum TEXTO a corrigir.'); }
    else {
      const resolvidos = paraGravar;   // daqui para baixo, só o que muda de verdade
      // ── 3. fusão: só para processo_pc ──────────────────────────────────────
      const fusoes = [];
      for (const r of resolvidos.filter(x => x.campo === 'processo_pc')) {
        for (const tr of r.trs) {
          const { rows } = await cli.query(
            `SELECT DISTINCT parcial_num FROM prestacoes_contas
              WHERE setorial_id='FCEE' AND tr=$1 AND processo_pc=$2 AND tipo <> 'final'`, [tr, r.escolha.texto]);
          if (rows.length) fusoes.push({ tr, de: r.bruto, para: r.escolha.texto });
        }
      }
      if (fusoes.length) {
        console.log('\n>> ABORTADO: fundiria parcela. ' + JSON.stringify(fusoes));
        process.exitCode = 3; return;
      }

      const foto = async () => new Map((await cli.query(
        `SELECT codigo_pc, processo_pc, processo_mae FROM prestacoes_contas WHERE setorial_id='FCEE'`
      )).rows.map(r => [r.codigo_pc, r]));
      const antes = await foto();

      await cli.query('BEGIN');
      let tocadas = 0;
      for (const r of resolvidos) {
        const { rowCount } = await cli.query(
          `UPDATE prestacoes_contas SET ${r.campo} = $2, atualizado_em = NOW() WHERE codigo_pc = ANY($1)`,
          [r.pcs, r.escolha.texto]);
        tocadas += rowCount;
        await cli.query(
          `INSERT INTO parcela_historico
             (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
           VALUES ($1, NULL, 'FCEE', $2, $3, $4, NULL, $5)`,
          [[...r.trs][0], r.campo, r.bruto, r.escolha.texto,
           `13/08 · unico candidato confirmado pelo SGPe entre ${r.cands} testados (${r.escolha.motivo}) · ${r.pcs.length} PCs`]);
      }
      const depois = await foto();
      const todas = resolvidos.flatMap(r => r.pcs);

      const un = async (s, v) => (await cli.query(s, v)).rows[0];
      const mexeu = (cod, campo) => antes.get(cod)[campo] !== depois.get(cod)[campo];
      const c1 = [...antes.keys()].filter(c => !todas.includes(c) && (mexeu(c, 'processo_pc') || mexeu(c, 'processo_mae'))).length;
      const c2 = (await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.codigo_pc=p.codigo_pc
                             WHERE p.parcial_num IS DISTINCT FROM b.parcial_num`)).n;
      const c3 = (await un(`SELECT COUNT(*)::int n FROM (
                              SELECT tr, processo_pc FROM prestacoes_contas
                               WHERE setorial_id='FCEE' AND tipo <> 'final'
                               GROUP BY 1,2 HAVING COUNT(DISTINCT parcial_num) > 1) t`)).n;

      const checks = [
        ['PC fora da lista alterada',      c1 === 0, c1],
        ['parcial_num alterado',           c2 === 0, c2],
        ['parcela partida em 2 numeros',   c3 === 0, c3],
        ['PCs tocadas == esperadas',       tocadas === todas.length, `${tocadas}/${todas.length}`],
      ];
      console.log('\n── VALIDACAO ─────────────────────────────────────────');
      let falhou = false;
      for (const [n, ok, v] of checks) { if (!ok) falhou = true; console.log(`   ${ok ? 'OK   ' : 'FALHA'}  ${n.padEnd(34)} ${v}`); }

      if (falhou)      { await cli.query('ROLLBACK'); console.log('\n>> ROLLBACK.'); process.exitCode = 2; }
      else if (GRAVAR) { await cli.query('COMMIT');   console.log('\n>> COMMIT.'); }
      else             { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK.'); }
    }

    // ── 4. o que NÃO deu, e por quê ──────────────────────────────────────────
    console.log('\n══════ NAO RESOLVIDOS ══════');
    for (const a of ambiguos) {
      console.log(`\n⚠ ${a.campo} · ${a.bruto} · ${a.pcs.length} PCs · TR ${[...a.trs].join(',')}`);
      console.log(`  AMBIGUO — ${a.confirmados.length} candidatos existem no SGPe:`);
      a.confirmados.forEach(c => console.log(`     ${c.texto.padEnd(20)} (nu ${c.nu}, orgao ${c.orgao}) — ${c.motivo}`));
    }
    for (const a of semSaida) {
      console.log(`\n✗ ${a.campo} · ${a.bruto} · ${a.pcs.length} PCs · TR ${[...a.trs].join(',')}`);
      console.log(`  nenhum dos ${a.cands} candidatos existe no SGPe`);
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('ERRO — ROLLBACK: ' + e.message); process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
