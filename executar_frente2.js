// CAMINHO: sigpc-api/executar_frente2.js
//
// FRENTE 2 — AS PCs AUSENTES, a partir do `PCS_AUSENTES_v2.csv`.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// ⚠️ SCRIPT SEPARADO DE PROPÓSITO. As frentes 1, 3 e 4 já foram COMMITADAS em 16/08/2026 —
// rodar o `executar_16_08.js` de novo abortaria no `CREATE TABLE` do backup, e no melhor
// caso repetiria trabalho já feito. Frente que já gravou não volta ao forno.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE O v1 FOI RECUSADO, E O QUE MUDOU
//
// O `PCS_AUSENTES_PARA_INCLUIR.csv` foi reprovado pelo revisor e pelo qa-banco em quatro
// pontos, todos confirmados pelo Richard:
//   · 107 de 324 com valor 100× maior (R$ 890 milhões a mais)
//   · 61 linhas com a coluna deslocada — `parcial` vazio, número grudado no processo
//   · 6 FINAIS entrando como `tipo='parcial'`, uma duplicando a PFINAL existente
//   · 208 caindo em parcela existente, 83 delas 100% baixadas
//
// O v2 corrige na fonte: valor convertido pelos dois formatos, FINAIS já na base removidas,
// as 64 sem parcial fora (em `PCS_AUSENTES_SEM_PARCIAL.csv`), `parecer_tipo` em coluna
// própria, e as duplicatas Franciani/Gislainy da 2020TR000612 resolvidas.
//
// ⚠️ O QUARTO PONTO CONTINUA SENDO TRATADO AQUI, por decisão do Richard: **PC que cai em
// parcela 100% baixada FICA DE FORA** e sai em lista de conferência. Não é o CSV que
// resolve isso — é o estado do banco no momento da gravação.
//
// USO:
//   node executar_frente2.js              dry-run: insere, confere e faz ROLLBACK
//   node executar_frente2.js --gravar     idem, com COMMIT — liga e desliga a manutenção

const fs = require('fs');
const { Pool } = require('pg');
const sgpe = require('./lib/sgpe-link');

const GRAVAR = process.argv.includes('--gravar');
const FORCAR = process.argv.includes('--forcar');
const D = __dirname + '/';
const CSV = D + 'PCS_AUSENTES_v2.csv';
const BK_PC = '_backup_frente2_20260816';
const FAIXA_INVENTADA = 900000;

// ⚠️ AS 15 TRs QUE FICARAM FORA DA RENUMERAÇÃO — E POR ISSO FICAM FORA DAQUI TAMBÉM.
//
// A coluna `parcial` do CSV é o número do SIGEF (vem da planilha do analista, mesma origem
// da coluna `Parcial` do estoque da CGE). Nas TRs renumeradas hoje, banco e CSV falam a
// mesma língua. **Nestas 15 não** — elas ficaram fora do lote, o banco continua com a
// numeração antiga, e o número do SIGEF do CSV apontaria para outra parcela.
//
// São 11 linhas: 2020TR000665 (4, Daiana) · 2020TR000704 (2, Sandra Rocha) ·
// 2020TR000761 (1, Noici) · 2020TR000766 (2, Valderi) · 2022TR000927 (2, Elisandra).
// Voltam quando as 15 TRs forem resolvidas — é a mesma frente, não outra.
const FORA_DO_LOTE = [
  '2022TR000941', '2020TR000823', '2020TR000830', '2022TR001248', '2020TR000683',
  '2020TR000699', '2020TR000648', '2020TR000665', '2020TR000704', '2020TR000761',
  '2020TR000766', '2020TR000793', '2020TR000816', '2021TR002375', '2022TR000927',
];

// ⚠️ TETO DE PLAUSIBILIDADE. A maior PC do acervo vale R$ 23,9 mi; o v1 teria criado uma de
// R$ 231 milhões e as 11 conferências passaram, porque o check de `valor` faz JOIN contra o
// backup e **linha nova não está no backup**. Um teto absoluto é a única guarda que enxerga
// a linha que acabou de nascer.
const TETO_VALOR = 30000000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

function lerCsv(arq) {
  const linhas = fs.readFileSync(arq, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  const cab = linhas[0].split(',');
  return linhas.slice(1).map(l => {
    const v = []; let cur = '', dentro = false;
    for (const ch of l) {
      if (ch === '"') { dentro = !dentro; continue; }
      if (ch === ',' && !dentro) { v.push(cur); cur = ''; continue; }
      cur += ch;
    }
    v.push(cur);
    return Object.fromEntries(cab.map((k, i) => [k, (v[i] ?? '').trim()]));
  });
}

// ⚠️ A CONVERSÃO QUE CUSTOU R$ 890 MILHÕES NO v1.
//
// A planilha mistura DOIS formatos na mesma coluna: 2.967 células já numéricas
// (`45000.0`, `8891.5`) e 1.662 como texto brasileiro (`"R$ 8.891,50"`). A versão anterior
// tratava tudo como texto e fazia `replace(/\./g,'')` — o que come a casa decimal do formato
// numérico: `45000.0` virava `450000`.
//
// A regra aqui é pela ORIGEM, não por adivinhação: se tem `R$` ou vírgula, é o texto
// brasileiro; senão é número puro. Não há caso ambíguo entre as duas, porque a célula
// numérica nunca traz vírgula nem cifrão.
function moeda(t) {
  const s = String(t ?? '').trim();
  if (!s) return null;
  const brasileiro = /R\$/i.test(s) || s.includes(',');
  const limpo = s.replace(/R\$/gi, '').replace(/\s/g, '');
  const n = brasileiro
    ? parseFloat(limpo.replace(/\./g, '').replace(',', '.'))
    : parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ⚠️ `SCC 6544/21` NÃO É PROCESSO MALFORMADO — é ano de dois dígitos, e a planilha do
// analista está cheia deles. Uma versão desta guarda recusou ~70 PCs legítimas por isso.
//
// ⚠️ E QUEM DECIDE O QUE É PROCESSO É A `lib/sgpe-link.js`, NÃO EU.
//
// Escrevi um regex próprio na primeira versão e ele recusou `FCEE 3770/2021` como "número
// inválido": o `\d{0,3}` da regional comia os dígitos do número (`377` virava sigla e sobrava
// `0`). Duas regras para "o que é um processo" é como a tela e o script passam a discordar.
//
// Aqui só faço a ÚNICA coisa que a canônica não faz: expandir o ano de 2 dígitos. Depois
// delego. E a trava da sigla ambígua dela (`ADR223151/2017` — região 22 ou processo 23151?)
// passa a valer para o CSV também, que é o que se quer.
function normalizarProcessoCsv(bruto) {
  const t = String(bruto ?? '').trim();
  if (!t) return { erro: 'vazio' };
  if (/\se\s/i.test(t)) return { erro: 'dois processos na mesma celula' };
  if ((t.match(/\//g) || []).length !== 1) return { erro: 'nao forma um processo unico' };

  // `/21` -> `/2021`. Determinístico: o acervo vai de 2016 a 2024, não há `19xx`.
  const comAno = t.replace(/\/\s*(\d{2})\s*$/, (_, aa) => `/20${aa}`);
  const p = sgpe.normalizarProcesso(comAno);
  if (!p) return { erro: 'a lib nao reconhece como processo' };
  if (!(p.ano >= 2015 && p.ano <= 2030)) return { erro: `ano implausivel (${p.ano})` };
  return { texto: sgpe.formatarProcesso(p), ano: String(p.ano) };
}

(async () => {
  const cli = await pool.connect();
  let manutencaoLigada = false;
  const sairLimpo = async (sinal) => {
    console.error(`\n🔴 ${sinal} recebido.`);
    if (manutencaoLigada) {
      try {
        await pool.query(`UPDATE config_sistema SET modo_manutencao = false,
                            mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        console.error('   >> manutencao DESLIGADA.');
      } catch (e) { console.error('   🔴 DESLIGUE PELA TELA: Configurações -> Modo manutenção.'); }
    }
    process.exit(130);
  };
  process.on('SIGINT', () => sairLimpo('SIGINT'));
  process.on('SIGTERM', () => sairLimpo('SIGTERM'));

  try {
    const linhas = lerCsv(CSV);
    nl(`── ${CSV.split('/').pop()}: ${linhas.length} linhas ─────────────`);

    const onlineSql = `SELECT COUNT(*)::int n FROM usuarios
       WHERE ultimo_acesso >= NOW() - INTERVAL '30 minutes'
         AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso) AND perfil <> 'superadmin'`;
    nl(`   online agora: ${(await cli.query(onlineSql)).rows[0].n}`);

    if (GRAVAR) {
      await cli.query('BEGIN');
      await cli.query(`UPDATE config_sistema SET modo_manutencao = true,
        mensagem_manutencao = 'Inclusão de PCs — 16/08/2026. Volta em minutos.',
        atualizado_em = NOW() WHERE id = 1`);
      const { rowCount: d } = await cli.query(
        `UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'`);
      await cli.query('COMMIT');
      manutencaoLigada = true;
      nl(`\n── MANUTENÇÃO LIGADA. ${d} sessões encerradas.`);
      const ainda = (await cli.query(onlineSql)).rows[0].n;
      nl(`   online depois de derrubar: ${ainda}`);
      if (ainda > 0 && !FORCAR) throw new Error(`${ainda} continuam online — a manutencao nao pegou.`);
    }

    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);
    await cli.query(`CREATE TABLE ${BK_PC} AS SELECT * FROM prestacoes_contas`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK_PC}`);
    nl(`\n── BACKUP ${BK_PC}: ${bk.n} linhas`);

    // ── quem é quem ───────────────────────────────────────────────────────────
    const { rows: us } = await cli.query(
      `SELECT id, nome FROM usuarios WHERE perfil IN ('analista','superadmin') AND ativo = true`);
    const acha = (nomeCsv) => {
      const alvo = semAcento(nomeCsv);
      if (!alvo) return { erro: 'sem analista no CSV' };
      const pal = alvo.split(/\s+/).filter(Boolean);
      const ex = us.filter(u => semAcento(u.nome) === alvo);
      const td = us.filter(u => { const n = semAcento(u.nome).split(/\s+/); return pal.every(p => n.includes(p)); });
      const c = ex.length ? ex : td;
      return c.length === 1 ? { id: c[0].id, nome: nomeCsv.trim() }
                            : { erro: c.length ? `ambiguo (${c.map(x => x.id).join(',')})` : 'sem cadastro' };
    };

    // ── o estado ATUAL das parcelas de destino ────────────────────────────────
    //
    // ⚠️ ESTA É A GUARDA DO BLOQUEIO 2, e ela mora AQUI e não no CSV: se todas as PCs de uma
    // `(tr, parcial_num)` já estão baixadas, uma PC nova ABERTA ali desarma o
    // `if (jaBaixadas.length === pcs.length)` de `POST /parcela/parecer`, e o próximo parecer
    // reescreve `data_baixa`/`origem_baixa`/`parecer_tipo` das antigas. Fica de fora.
    const { rows: parcelas } = await cli.query(`
      SELECT tr, parcial_num, COUNT(*)::int pcs, COUNT(*) FILTER (WHERE baixada)::int baix
        FROM prestacoes_contas WHERE setorial_id='FCEE' AND tipo <> 'final'
       GROUP BY tr, parcial_num`);
    const todaBaixada = new Set(parcelas.filter(p => p.pcs === p.baix).map(p => `${p.tr}|${p.parcial_num}`));

    // ── as PCs finais que já existem ──────────────────────────────────────────
    const { rows: finais } = await cli.query(
      `SELECT DISTINCT tr FROM prestacoes_contas WHERE tipo = 'final'`);
    const temFinal = new Set(finais.map(f => f.tr));

    const { rows: usadosPor } = await cli.query(
      `SELECT LEFT(codigo_pc,4) ano, MAX(SUBSTRING(codigo_pc FROM 7)::int) m
         FROM prestacoes_contas WHERE codigo_pc ~ '^[0-9]{4}PC[0-9]{6}$' GROUP BY 1`);
    const proximo = new Map(usadosPor.map(r => [r.ano, Math.max(r.m + 1, FAIXA_INVENTADA)]));

    const inserir = [], fora = [];
    for (const r of linhas) {
      const rej = (motivo) => fora.push({ ...r, motivo });
      const parcial = String(r.parcial ?? '').trim();
      const a = acha(r.analista);
      const v = moeda(r.valor);

      if (!parcial) { rej('sem numero de parcial'); continue; }
      // ⚠️ AS 15 TRs FORAM RENUMERADAS em 16/08/2026 (`executar_15_trs.js`, 281 PCs). O CSV e
      // o banco voltaram a falar a mesma língua nelas, e as 11 linhas que estavam de fora por
      // desalinhamento entraram de volta. A lista fica aqui, vazia de efeito, como registro.
      if (false && FORA_DO_LOTE.includes(r.tr)) { rej('TR fora da renumeracao'); continue; }
      const proc = normalizarProcessoCsv(r.processo_pc);
      if (proc.erro) { rej('processo: ' + proc.erro + ' — ' + r.processo_pc); continue; }
      if (/^final$/i.test(parcial)) { rej(temFinal.has(r.tr) ? 'FINAL e a TR ja tem PFINAL' : 'FINAL — fora do escopo'); continue; }
      if (a.erro) { rej('analista: ' + a.erro); continue; }
      if (v == null) { rej('valor ilegivel'); continue; }
      if (v > TETO_VALOR) { rej(`valor implausivel (${v.toFixed(2)} > teto)`); continue; }
      if (v <= 0) { rej('valor zero ou negativo'); continue; }
      // ⚠️ o ano do código sai do processo JÁ NORMALIZADO — é ele que garante a faixa
      // 2015-2030. O v1 criaria `2924PC900000` a partir do `SCC 8486/2924` da planilha.
      const ano = proc.ano;
      if (todaBaixada.has(`${r.tr}|${parcial}`)) { rej('parcela ja 100% baixada — CONFERIR'); continue; }

      const n = proximo.get(ano) ?? FAIXA_INVENTADA;
      proximo.set(ano, n + 1);
      inserir.push({
        codigo_pc: `${ano}PC${String(n).padStart(6, '0')}`, tr: r.tr, parcial_num: parcial,
        processo_pc: proc.texto, processo_mae: r.processo_mae, entidade: r.entidade,
        valor: v, analista_id: a.id, analista_nome: a.nome,
        grupo: parseInt(String(r.grupo).replace(/\D/g, ''), 10) || null,
        situacao: r.situacao || null, parecer_tipo: r.parecer_tipo || null,
      });
    }

    nl(`\n── O RECORTE ─────────────────────────────────────────────`);
    nl(`   no CSV ................ ${linhas.length}`);
    nl(`   a inserir ............. ${inserir.length}`);
    nl(`   fora .................. ${fora.length}`);
    const mot = {};
    fora.forEach(f => { mot[f.motivo] = (mot[f.motivo] || 0) + 1; });
    Object.entries(mot).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => nl(`      ${m}: ${n}`));
    if (fora.length) {
      fs.writeFileSync(D + 'PCS_AUSENTES_CONFERIR.csv',
        'tr,parcial,analista,processo_pc,valor,motivo\n' +
        fora.map(f => [f.tr, f.parcial, f.analista, f.processo_pc, f.valor, f.motivo].join(',')).join('\n'));
      nl(`      >> nomeadas em PCS_AUSENTES_CONFERIR.csv`);
    }
    nl(`   valor somado .......... R$ ${inserir.reduce((s, i) => s + i.valor, 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`);
    nl(`   maior PC .............. R$ ${Math.max(...inserir.map(i => i.valor), 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`);
    nl(`   TRs ................... ${new Set(inserir.map(i => i.tr)).size}`);
    nl(`   analistas ............. ${new Set(inserir.map(i => i.analista_id)).size}`);

    if (!inserir.length) { await cli.query('ROLLBACK'); nl('\nNada a inserir.'); return; }

    const { rows: [col] } = await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE codigo_pc = ANY($1)`,
      [inserir.map(i => i.codigo_pc)]);
    if (col.n > 0) throw new Error(`${col.n} codigos inventados JA EXISTEM`);

    for (const i of inserir) {
      await cli.query(
        `INSERT INTO prestacoes_contas
           (codigo_pc, tr, parcial_num, tipo, setorial_id, processo_pc, processo_mae, entidade,
            valor, analista_id, analista_nome, grupo, status, situacao_atual, parecer_tipo,
            baixada, registrado_por, atualizado_em)
         VALUES ($1,$2,$3,'parcial','FCEE',$4,$5,$6,$7,$8,$9,$10,'analise',$11,$12,false,
                 'inclusao 16/08/2026 — PCS_AUSENTES_v2.csv', NOW())`,
        [i.codigo_pc, i.tr, i.parcial_num, i.processo_pc, i.processo_mae, i.entidade,
         i.valor, i.analista_id, i.analista_nome, i.grupo, i.situacao, i.parecer_tipo]);
    }
    nl(`\n>> ${inserir.length} PCs inseridas`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER ────────────────────────────────────────
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const novos = inserir.map(i => i.codigo_pc);

    // ⚠️ O CHECK QUE FALTAVA NO v1: as linhas NOVAS conferidas contra o CSV, uma a uma.
    // O JOIN contra o backup é cego para elas — elas não estão no backup.
    const { rows: gravadas } = await cli.query(
      `SELECT codigo_pc, valor::float v FROM prestacoes_contas WHERE codigo_pc = ANY($1)`, [novos]);
    const mapaEsperado = new Map(inserir.map(i => [i.codigo_pc, i.valor]));
    const valorErrado = gravadas.filter(g => Math.abs(g.v - mapaEsperado.get(g.codigo_pc)) > 0.005).length;
    const acimaTeto = gravadas.filter(g => g.v > TETO_VALOR).length;

    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE (b.baixada,b.data_baixa,b.parecer_tipo,b.valor,b.parcial_num,b.analista_id)
         IS DISTINCT FROM (p.baixada,p.data_baixa,p.parecer_tipo,p.valor,p.parcial_num,p.analista_id)`);
    const c2 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);
    // nenhuma parcela pode ter ficado mista por causa desta rodada
    const c3 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr, parcial_num FROM prestacoes_contas
       WHERE setorial_id='FCEE' AND tipo <> 'final' AND (tr,parcial_num) IN (
         SELECT tr, parcial_num FROM prestacoes_contas WHERE codigo_pc = ANY($1))
       GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE baixada) > 0
                       AND COUNT(*) FILTER (WHERE NOT baixada) > 0
                       AND COUNT(*) FILTER (WHERE NOT baixada AND NOT (codigo_pc = ANY($1))) = 0) t`,
      [novos]);
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE codigo_pc = ANY($1) AND (analista_id IS NULL OR parcial_num IS NULL
        OR parcial_num = '' OR tipo <> 'parcial' OR baixada <> false)`, [novos]);
    const c5 = await un(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM prestacoes_contas WHERE analista_id IS NOT NULL
       GROUP BY tr HAVING COUNT(DISTINCT analista_id) > 1) t`);
    const { rows: [c5b] } = await cli.query(`SELECT COUNT(*)::int n FROM (
      SELECT tr FROM ${BK_PC} WHERE analista_id IS NOT NULL
       GROUP BY tr HAVING COUNT(DISTINCT analista_id) > 1) t`);

    const checks = [
      ['valor gravado == valor do CSV',      valorErrado === 0, valorErrado],
      ['nenhuma acima do teto de plausib.',  acimaTeto === 0, acimaTeto],
      ['nenhuma PC ANTIGA alterada',         c1.n === 0, c1.n],
      ['total = antes + inseridas',          c2.n === bk.n + inserir.length, `${bk.n}+${inserir.length}=${c2.n}`],
      ['parcela virou mista por esta rodada', c3.n === 0, c3.n],
      ['toda inserida completa e aberta',    c4.n === 0, c4.n],
      ['TRs com 2+ analistas nao aumentou',  c5.n <= c5b.n, `${c5b.n} -> ${c5.n}`],
    ];
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(38)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_frente2_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup: BK_PC, inseridas: novos }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   reversao: DELETE FROM prestacoes_contas WHERE codigo_pc = ANY(<inseridas>);`);
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    if (manutencaoLigada) {
      try {
        await cli.query(`UPDATE config_sistema SET modo_manutencao = false,
          mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        nl('\n── MANUTENÇÃO DESLIGADA. Equipe liberada.');
      } catch (e) { console.error('🔴 DESLIGUE PELA TELA: Configurações -> Modo manutenção.'); }
    }
    cli.release(); await pool.end();
  }
})();
