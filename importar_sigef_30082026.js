// CAMINHO: sigpc-api/importar_sigef_30082026.js
//
// IMPORTAÇÃO DAS PCs QUE O SIGEF TEM E O SISTEMA NÃO — relatórios de 30/08/2026.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE SCRIPT FAZ, E O QUE ELE NUNCA FAZ
//
//   FAZ  : INSERT de PC que não existe, numa transação só, com foto antes e conferência
//          depois — comparando com a FOTO, não com o previsto.
//   NUNCA: UPDATE ou DELETE de linha existente. A conferência acha UMA linha da foto alterada
//          ou sumida → ROLLBACK e aborta.
//
// ⚠️ AUSÊNCIA NO RELATÓRIO DO SIGEF NÃO PROVA AUSÊNCIA DE PC (armadilha 26 do `sigpc-gt`).
// Este script só ACRESCENTA. Não existe caminho aqui que remova nada.
//
// ─────────────────────────────────────────────────────────────────────────────
// ESCOPO — a TR manda
//
// São do GT as TRs da planilha da CGE (`Estoque FCEE (4).xlsx`, 1.559 TRs). Dentro delas,
// TUDO o que o SIGEF mostra entra, inclusive o que não estava no Excel. TR fora da planilha
// não entra com nada — e isso inclui as **362 TRs** que a CGE lista e o relatório do SIGEF
// não cobre (são Termo de Colaboração da Lei 13.334/2005, e o relatório não alcança esse
// instrumento; medido em 30/08). Elas são pendência registrada, não entram nesta rodada.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DUPLICIDADE É O RISCO PRINCIPAL — QUATRO PROVAS, E A REPROVAÇÃO É POR PARCELA
//
// PC duplicada infla a produtividade do analista e vai para o relatório da CGE. Antes de
// inserir qualquer linha, o script prova que ela não existe:
//
//   P1 · TR + `parcial_num` — **É A PROVA DE VERDADE.** O número que o SIGEF chama de
//        "Parcial" é o `parcial_num`, e a medição é definitiva: em 1.193 de 1.193 TRs todo
//        `parcial_num` do banco existe na lista do SIGEF (o `parcela_seq` só em 79%).
//   P2 · `parcela_seq` ocupado — NÃO é chave de comparação (armadilha 27 do `sigpc-gt`), é
//        contador de PC dentro da TR: uma parcela pode ter várias PCs, e por isso o índice 24
//        de uma TR pode ser a parcial 13. Quando o índice está ocupado, vale a REGRA:
//          · `parcial_num` da PC que ocupa == número do SIGEF → é a MESMA PC, não entra;
//          · diferente → colisão de índice, a PC do SIGEF não existe, entra com `parcela_seq`
//            NOVO, nunca reaproveitando o ocupado.
//   P3 · `codigo_pc` gerado não pode colidir com nenhum existente.
//   P4 · contagem por TR: depois de inserir, o nº de parcelas distintas NUNCA pode passar o
//        que o SIGEF mostra para aquela TR.
//
// ⚠️ **P1, P2 e P3 reprovam a PARCELA, não a TR.** Reprovar a TR inteira por uma colisão
// custou, na primeira rodada, 1.149 PCs que não colidiam com nada. Só a P4, que é uma
// afirmação sobre o conjunto, pode reprovar a TR — e aí nenhuma linha dela entra.
//
// ─────────────────────────────────────────────────────────────────────────────
// PADRÃO DO `codigo_pc` — GERADO, porque o relatório não traz
//
//   parcial : {TR}-P{parcela em 3 dígitos}    ex.: 2024TR000677-P012   (17 caracteres)
//   final   : {TR}-PFINAL                     ex.: 2024TR000677-PFINAL (18 caracteres)
//
// Três razões: (1) a final JÁ usa `{TR}-PFINAL` nas 1.031 do acervo — a parcial segue o mesmo
// desenho; (2) cabe no `VARCHAR(20)` (o maior código de hoje tem 19); (3) é DETERMINÍSTICO, e
// é isso que dá idempotência e reversão conferível.
//
// ⚠️ NÃO se parece com código do SIGEF (`2024PC001957`) DE PROPÓSITO: quem olhar a tela tem de
// saber, pelo código, que aquela PC não veio do SIGEF com código próprio. O acervo já tem um
// código inventado que se disfarça de real — `2024PC900000`, de 16/08 — e é o que não se
// quer repetir.
//
// ─────────────────────────────────────────────────────────────────────────────
// USO
//   node importar_sigef_30082026.js                dry-run completo, ROLLBACK no fim
//   node importar_sigef_30082026.js --gravar       idem, com COMMIT
//   node importar_sigef_30082026.js --tr=2024TR000677   só uma TR (conferência pontual)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const GRAVAR = process.argv.includes('--gravar');
const argOf = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const SO_TR = argOf('tr') ? argOf('tr').toUpperCase() : null;

const DOWNLOADS = 'C:/Users/Richard/Downloads';
const PDF_PARC = path.join(DOWNLOADS, 'Relatorio_30082026163345.pdf');
const PDF_FIN = path.join(DOWNLOADS, 'Relatorio_30082026163505.pdf');
const XLS_CGE = path.join(DOWNLOADS, 'Estoque FCEE (4).xlsx');
const TMP = path.join(__dirname, '.sigef_tmp');
const FOTO = '_backup_pre_import_sigef_20260830';
const MARCA = 'import_sigef_30082026';
const REVERSAO = path.join(__dirname, `reverter_${MARCA}.json`);

// ── situação do SIGEF → status do sistema ────────────────────────────────────
// Regra do Richard, 30/08/2026: Regular e Regular com Ressalvas entram BAIXADAS, com a data da
// situação em `data_baixa_sigef` e o código em `sigef_status`. Em Análise, Diligência e
// Reanálise entram no estado correspondente. Irregular entra como `irregular`.
//
// ⚠️ ED (Em Edição) e DA (Aguardando Documentos) NÃO foram definidos por ele, e a decisão é
// minha: entram como `livre`. Não são estado de análise — a PC ainda não chegou; pôr `analise`
// faria o cartão do analista mostrar trabalho que não existe. Está sinalizado no dry-run.
const MAPA = {
  AV: 'baixada', SV: 'baixada', VA: 'analise', DV: 'diligencia', VR: 'reanalise',
  IC: 'irregular', IP: 'irregular', IS: 'irregular', IF: 'irregular',
  ED: 'livre', DA: 'livre',
  VT: 'analise', DT: 'diligencia', AT: 'baixada', ST: 'baixada',
  CT: 'irregular', PT: 'irregular', LT: 'irregular', FT: 'irregular',
  VS: 'analise', AS: 'baixada', SS: 'baixada',
  CS: 'irregular', PS: 'irregular', LS: 'irregular', FS: 'irregular',
};
// ⚠️ `AR` e `RS` saem nos relatórios e NÃO estão na legenda oficial. Entram `livre` e são
// listados à parte — inventar significado para código desconhecido é decidir regra no escuro.
const FORA_DA_LEGENDA = ['AR', 'RS'];
const NOME = {
  ED: 'Em Edição', DA: 'Aguardando Documentos', VA: 'Em Análise', AV: 'Regular',
  SV: 'Regular com Ressalvas', DV: 'Diligência', VR: 'Em Reanálise',
  IC: 'Irregular Sem Comprovação', IP: 'Irregular Pagto Indevido',
  IS: 'Irregular Saldo Não Recolhido', IF: 'Irregular Desvio Finalidade',
  VT: 'Em Análise - Técnico', ST: 'Regular c/ Ressalvas - Técnico', AT: 'Regular - Técnico',
  DT: 'Diligência - Técnico', CT: 'Irregular Sem Compr. - Técnico', PT: 'Irregular Pagto - Técnico',
  LT: 'Irregular Saldo - Técnico', FT: 'Irregular Desvio - Técnico',
  VS: 'Em Análise - Secretário', SS: 'Regular c/ Ressalvas - Secretário', AS: 'Regular - Secretário',
  CS: 'Irregular Sem Compr. - Secretário', PS: 'Irregular Pagto - Secretário',
  LS: 'Irregular Saldo - Secretário', FS: 'Irregular Desvio - Secretário',
  AR: '(fora da legenda) AR', RS: '(fora da legenda) RS',
};
const CODS_PARC = ['ED', 'DA', 'VA', 'AV', 'SV', 'DV', 'VR', 'IC', 'IP', 'IS', 'IF'];
const CODS_FIN = Object.keys(NOME);

const codigoDe = (tr, tipo, n) =>
  tipo === 'FINAL' ? `${tr}-PFINAL` : `${tr}-P${String(n).padStart(3, '0')}`;
const dataIso = br => {
  const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const up = s => String(s == null ? '' : s).trim().toUpperCase();

// ── leitura dos PDFs ─────────────────────────────────────────────────────────
//
// ⚠️ `-table` E NÃO `-layout`. O relatório é montado em colunas independentes: no modo layout
// a coluna da TR anda mais rápido que a do beneficiário (que quebra em duas linhas) e a data
// de uma PC aparece na linha de outra. Com `-table` a linha do PDF é a linha do registro —
// conferido: 8.587 + 1.314 linhas, 100% casadas com o padrão, zero descartes.
function extrair(pdf, saida) {
  if (fs.existsSync(saida)) return fs.readFileSync(saida, 'utf8');
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);
  execFileSync('pdftotext', ['-table', '-enc', 'UTF-8', pdf, saida], { stdio: 'pipe' });
  return fs.readFileSync(saida, 'utf8');
}
function parsePdf(txt, comParcial, cods) {
  const re = comParcial
    ? /^\s*(\d{4}TR\d{6})\s+(\d{6})\s+(.*?)(?:\s+(\d{2}\/\d{2}\/\d{4}))?\s+([A-Z]{2})\s*$/
    : /^\s*(\d{4}TR\d{6})\s+()(.*?)(?:\s+(\d{2}\/\d{2}\/\d{4}))?\s+([A-Z]{2})\s*$/;
  const out = [], ruins = [];
  for (const l of txt.split(/\r?\n/)) {
    if (!/^\s*\d{4}TR\d{6}\s/.test(l)) continue;
    const m = l.match(re);
    if (m && cods.includes(m[5]))
      out.push({ tr: m[1], parcela: comParcial ? parseInt(m[2], 10) : null, cod: m[5],
        data: m[4] || null, benef: m[3].replace(/\s+/g, ' ').replace(/\s*Termo\s+de.*$/i, '').trim().slice(0, 80) });
    else ruins.push(l.slice(0, 120));
  }
  return { out, ruins };
}

const fmt = (n, w) => String(n).padStart(w);

(async () => {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(` IMPORTAÇÃO SIGEF 30/08/2026 → prestacoes_contas    ${GRAVAR ? '*** MODO GRAVAR ***' : 'DRY-RUN (ROLLBACK no fim)'}`);
  console.log(`${'═'.repeat(80)}`);

  // ── fontes ────────────────────────────────────────────────────────────────
  const P = parsePdf(extrair(PDF_PARC, path.join(TMP, 'parciais.txt')), true, CODS_PARC);
  const F = parsePdf(extrair(PDF_FIN, path.join(TMP, 'finais.txt')), false, CODS_FIN);
  if (P.ruins.length || F.ruins.length) {
    console.error(`⛔ linhas do PDF não reconhecidas: parciais ${P.ruins.length}, finais ${F.ruins.length}`);
    P.ruins.slice(0, 5).forEach(l => console.error('   ', l));
    process.exit(1);
  }
  console.log(` SIGEF: ${P.out.length} parciais · ${F.out.length} finais · ${new Set(P.out.map(x => x.tr)).size} TRs`);

  const wb = XLSX.readFile(XLS_CGE, { cellDates: true });
  const trsDaAba = (aba, col) => {
    const m = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
    const i = m[0].map(x => String(x || '').trim()).indexOf(col);
    const s = new Set();
    for (const l of m.slice(1)) if (l && l[i]) s.add(up(l[i]));
    return s;
  };
  const ESCOPO = new Set([...trsDaAba('Parcial', 'NR. TRANS / NT. TE'), ...trsDaAba('Final', 'TRANSFERÊNCIA')]);
  console.log(` CGE  : ${ESCOPO.size} TRs no escopo do GT`);

  let sParc = P.out.filter(x => ESCOPO.has(x.tr));
  let sFin = F.out.filter(x => ESCOPO.has(x.tr));
  if (SO_TR) { sParc = sParc.filter(x => x.tr === SO_TR); sFin = sFin.filter(x => x.tr === SO_TR); }
  console.log(` no escopo: ${sParc.length} parciais · ${sFin.length} finais`);
  console.log(` fora do escopo (não entram): ${P.out.length - sParc.length} parciais · ${F.out.length - sFin.length} finais`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();

  // ── o banco ───────────────────────────────────────────────────────────────
  const trs = [...new Set([...sParc.map(x => x.tr), ...sFin.map(x => x.tr)])];
  const { rows: bPcs } = await cli.query(`
    SELECT codigo_pc, tr, parcial_num, parcela_seq, tipo, status, baixada,
           analista_id, analista_nome, grupo, setorial_id, entidade, cnpj_cpf, processo_mae
      FROM prestacoes_contas WHERE tr = ANY($1)`, [trs]);
  const porTr = new Map();
  for (const r of bPcs) {
    const a = porTr.get(r.tr) || { pcs: [], nums: new Set(), seqs: new Set(), codigos: new Set(), temFinal: false, porSeq: new Map() };
    a.pcs.push(r);
    if (/^\d+$/.test(String(r.parcial_num))) a.nums.add(parseInt(r.parcial_num, 10));
    if (r.parcela_seq != null) {
      a.seqs.add(Number(r.parcela_seq));
      a.porSeq.set(Number(r.parcela_seq), (a.porSeq.get(Number(r.parcela_seq)) || []).concat([r]));
    }
    a.codigos.add(up(r.codigo_pc));
    if (String(r.tipo).toLowerCase() === 'final' || up(r.codigo_pc).endsWith('-PFINAL')) a.temFinal = true;
    porTr.set(r.tr, a);
  }
  const todosCodigos = new Set((await cli.query('SELECT codigo_pc FROM prestacoes_contas')).rows.map(r => up(r.codigo_pc)));

  // ── candidatas + as quatro provas, TR a TR ────────────────────────────────
  const sPorTr = new Map();
  for (const p of sParc) { const a = sPorTr.get(p.tr) || { parc: new Map(), fin: null }; a.parc.set(p.parcela, p); sPorTr.set(p.tr, a); }
  for (const f of sFin) { const a = sPorTr.get(f.tr) || { parc: new Map(), fin: null }; a.fin = f; sPorTr.set(f.tr, a); }

  const aInserir = [], puladas = [], semMapa = [], foraLegenda = [];
  const rejeitadas = { p1: [], p2mesma: [], p3: [], p2indeterminado: [] };
  const colisoesSeq = { total: 0, mesma: 0, indice: 0, indeterminado: 0 };
  for (const [tr, s] of sPorTr) {
    const b = porTr.get(tr) || { pcs: [], nums: new Set(), seqs: new Set(), codigos: new Set(), temFinal: false, porSeq: new Map() };
    const cand = [];

    // ── P1 · TR + parcial_num ── reprova a PARCELA
    for (const [n, p] of s.parc) {
      if (b.nums.has(n)) { rejeitadas.p1.push({ tr, n }); continue; }
      cand.push({ ...p, tipo: 'PARCIAL', n });
    }
    if (s.fin && !b.temFinal) cand.push({ ...s.fin, tipo: 'FINAL', n: null });

    // ── P2 · índice ocupado ── a REGRA decide, e reprova a PARCELA
    //
    // ⚠️ O `parcial_num == n` aqui é, na prática, impossível: a P1 já teria tirado a candidata.
    // O ramo fica porque a regra é do Richard e tem de estar escrita onde se aplica — e porque
    // o dia em que a P1 mudar, este ramo é o que impede a duplicata.
    let proximoSeq = Math.max(0, ...[...b.seqs].filter(x => x !== 999)) + 1;
    const ocupados = new Set([...b.seqs]);
    const sobrevivem = [];
    for (const x of cand) {
      if (x.tipo !== 'PARCIAL' || !ocupados.has(x.n)) { sobrevivem.push(x); continue; }
      colisoesSeq.total++;
      const donos = (b.porSeq.get(x.n) || []);
      const nums = donos.map(r => (/^\d+$/.test(String(r.parcial_num)) ? +r.parcial_num : null));
      if (nums.some(v => v === null)) {
        colisoesSeq.indeterminado++;
        rejeitadas.p2indeterminado.push({ tr, n: x.n, ocupantes: donos.map(r => r.codigo_pc) });
        continue;                       // a regra não decide → não entra, e sai contada
      }
      if (nums.includes(x.n)) {          // mesma PC
        colisoesSeq.mesma++;
        rejeitadas.p2mesma.push({ tr, n: x.n, ocupantes: donos.map(r => r.codigo_pc) });
        continue;
      }
      colisoesSeq.indice++;              // colisão de índice → entra com seq NOVO
      while (ocupados.has(proximoSeq)) proximoSeq++;
      x._seqNovo = proximoSeq;
      ocupados.add(proximoSeq);
      proximoSeq++;
      sobrevivem.push(x);
    }

    // ── P3 · colisão de codigo_pc ── reprova a PARCELA
    const finais = [];
    for (const x of sobrevivem) {
      if (todosCodigos.has(up(codigoDe(tr, x.tipo, x.n)))) { rejeitadas.p3.push({ tr, n: x.n, cod: codigoDe(tr, x.tipo, x.n) }); continue; }
      finais.push(x);
    }
    if (!finais.length) continue;

    // ── P4 · contagem por TR ── esta reprova a TR INTEIRA
    const depois = new Set([...b.nums, ...finais.filter(x => x.tipo === 'PARCIAL').map(x => x.n)]);
    if (depois.size > s.parc.size) {
      puladas.push({ tr, candidatas: finais.length,
        falhas: [`P4 (contagem): depois ficariam ${depois.size} parcelas e o SIGEF mostra ${s.parc.size}`],
        banco_nums: [...b.nums].sort((a, z) => a - z), banco_seqs: [...b.seqs].sort((a, z) => a - z),
        sigef: [...s.parc.keys()].sort((a, z) => a - z),
        entidade: (b.pcs[0] || {}).entidade || finais[0].benef, analista: (b.pcs[0] || {}).analista_nome });
      continue;
    }

    const dono = b.pcs.find(r => r.analista_id != null);
    const info = b.pcs[0] || {};
    for (const x of finais) {
      let st = MAPA[x.cod];
      if (!st) {
        if (FORA_DA_LEGENDA.includes(x.cod)) { st = 'livre'; foraLegenda.push(x); }
        else { semMapa.push(x); continue; }
      }
      const baixada = st === 'baixada';
      aInserir.push({
        codigo_pc: codigoDe(tr, x.tipo, x.n), tr,
        tipo: x.tipo === 'FINAL' ? 'final' : 'parcial',
        parcial_num: x.tipo === 'FINAL' ? 'FINAL' : String(x.n),
        // ⚠️ `parcela_seq` fica NULO por padrão — ele não é o número do SIGEF e inventar uma
        // ordem é pior que não ter (mesma razão do `lib/pc-nova.js`). A exceção é a colisão de
        // índice resolvida pela regra da P2, que exige um seq novo, nunca o ocupado.
        parcela_seq: x.tipo === 'FINAL' ? 999 : (x._seqNovo ?? null),
        status: st, baixada,
        data_baixa: baixada ? dataIso(x.data) : null,
        origem_baixa: baixada ? MARCA : null,
        sigef_status: x.cod, data_baixa_sigef: dataIso(x.data),
        analista_id: dono ? dono.analista_id : null,
        analista_nome: dono ? dono.analista_nome : null,
        grupo: dono ? dono.grupo : null,
        setorial_id: info.setorial_id || 'FCEE',
        entidade: info.entidade || x.benef || null,
        cnpj_cpf: info.cnpj_cpf || null,
        processo_mae: info.processo_mae || null,
        _cod: x.cod, _tipoSigef: x.tipo,
      });
    }
  }

  // ══ DRY-RUN ══════════════════════════════════════════════════════════════
  const cont = (arr, f) => arr.reduce((a, x) => (a[f(x)] = (a[f(x)] || 0) + 1, a), {});
  console.log(`\n── 1. QUANTAS ENTRAM ─────────────────────────────────────────────────────────`);
  console.log(`   a inserir ................. ${aInserir.length}`);
  console.log(`      parciais ............... ${aInserir.filter(x => x.tipo === 'parcial').length}`);
  console.log(`      finais ................. ${aInserir.filter(x => x.tipo === 'final').length}`);
  console.log(`   TRs atendidas ............. ${new Set(aInserir.map(x => x.tr)).size}`);
  console.log(`   TRs PULADAS por prova ..... ${puladas.length}  (${puladas.reduce((a, p) => a + p.candidatas, 0)} PCs não entram)`);
  if (semMapa.length) console.log(`   ⚠ situação sem mapeamento: ${semMapa.length} — ${[...new Set(semMapa.map(x => x.cod))]}`);
  if (foraLegenda.length) console.log(`   ⚠ código fora da legenda (entram 'livre'): ${foraLegenda.length} — ${[...new Set(foraLegenda.map(x => x.cod))]}`);

  console.log(`\n── 2. POR SITUAÇÃO DO SIGEF ──────────────────────────────────────────────────`);
  Object.entries(cont(aInserir, x => x._cod)).sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
    console.log(`   ${k}  ${fmt(n, 5)}  ${(NOME[k] || '').padEnd(34)} → status '${MAPA[k] || 'livre'}'`));
  console.log(`   ── resultado: ${JSON.stringify(cont(aInserir, x => x.status))}`);

  console.log(`\n── 3. PRODUTIVIDADE POR ANALISTA (PCs baixadas) ──────────────────────────────`);
  const antes = new Map((await cli.query(
    `SELECT COALESCE(analista_nome,'(sem analista)') a, COUNT(*) FILTER (WHERE baixada)::int b
       FROM prestacoes_contas GROUP BY 1`)).rows.map(r => [r.a, r.b]));
  const delta = {};
  for (const x of aInserir) {
    const k = x.analista_nome || '(sem analista)';
    delta[k] = delta[k] || { bx: 0, tot: 0 };
    delta[k].tot++; if (x.baixada) delta[k].bx++;
  }
  console.log(`   ${'analista'.padEnd(22)} ${'antes'.padStart(7)} ${'entram'.padStart(7)} ${'depois'.padStart(7)} ${'PCs +'.padStart(7)}`);
  Object.entries(delta).sort((a, b) => b[1].bx - a[1].bx || b[1].tot - a[1].tot).forEach(([nome, d]) => {
    const a = antes.get(nome) || 0;
    console.log(`   ${nome.slice(0, 22).padEnd(22)} ${fmt(a, 7)} ${fmt(d.bx, 7)} ${fmt(a + d.bx, 7)} ${fmt(d.tot, 7)}`);
  });

  console.log(`\n── 4. SEM ANALISTA RESPONSÁVEL ───────────────────────────────────────────────`);
  const semDono = aInserir.filter(x => !x.analista_id);
  console.log(`   ${semDono.length} de ${aInserir.length} entram LIVRES, em ${new Set(semDono.map(x => x.tr)).size} TRs`);
  console.log(`   dessas, baixadas no SIGEF: ${semDono.filter(x => x.baixada).length}  ⚠ baixa sem analista não conta produtividade`);

  console.log(`\n── 5. O QUE AS PROVAS BARRARAM ───────────────────────────────────────────────`);
  console.log(`   P1 · já existe TR + parcial_num ............... ${rejeitadas.p1.length} parcelas`);
  console.log(`   P3 · codigo_pc gerado já existe .............. ${rejeitadas.p3.length} parcelas`);
  console.log(`   P2 · índice (parcela_seq) ocupado ............ ${colisoesSeq.total} parcelas`);
  console.log(`        ├ mesma PC (parcial_num == nº do SIGEF) → NÃO entram: ${colisoesSeq.mesma}`);
  console.log(`        ├ colisão de índice → ENTRAM com seq novo: ${colisoesSeq.indice}`);
  console.log(`        └ a regra não decide (ocupante sem parcial_num numérico): ${colisoesSeq.indeterminado}`);
  if (rejeitadas.p2indeterminado.length)
    rejeitadas.p2indeterminado.forEach(r => console.log(`             ${r.tr} parcela ${r.n} — ocupantes: ${r.ocupantes}`));
  console.log(`   P4 · TRs reprovadas INTEIRAS por contagem .... ${puladas.length}`);
  // ⚠️ Lista INTEIRA, sem `.slice()`. Lista de conferência cortada mente — foi assim que se
  // leu "o SIGEF mostra 20 parcelas" numa TR que tem 26 (armadilha 27 do `sigpc-gt`).
  puladas.forEach(p => {
    console.log(`   ${p.tr}  (${p.candidatas} PCs)  ${String(p.entidade || '')}  [${p.analista || 'sem dono'}]`);
    p.falhas.forEach(f => console.log(`        ✗ ${f}`));
    console.log(`        banco parcial_num [${p.banco_nums}]`);
    console.log(`        banco parcela_seq [${p.banco_seqs}]`);
    console.log(`        SIGEF             [${p.sigef}]`);
  });

  console.log(`\n── 6. TRs QUE MAIS RECEBEM ───────────────────────────────────────────────────`);
  const trRec = {};
  aInserir.forEach(x => { const t = trRec[x.tr] = trRec[x.tr] || { n: 0, bx: 0, ent: x.entidade, an: x.analista_nome };
    t.n++; if (x.baixada) t.bx++; });
  Object.entries(trRec).sort((a, b) => b[1].n - a[1].n).slice(0, 20).forEach(([tr, t]) =>
    console.log(`   ${tr}  ${fmt(t.n, 3)} PCs (${t.bx} baixadas)  ${(t.an || 'sem dono').padEnd(14)} ${String(t.ent || '').slice(0, 44)}`));
  console.log(`   … ${Object.keys(trRec).length} TRs no total`);

  console.log(`\n── 7. O QUE ESTAS PCs NÃO TÊM (completar depois) ─────────────────────────────`);
  console.log(`   codigo_nl ... NULA em todas — o relatório do SIGEF não traz NL.`);
  console.log(`                 ⚠ a regra do projeto é 1 PC = 1 NL. Estas ${aInserir.length} nascem sem.`);
  console.log(`   valor ....... NULO em todas — o relatório não traz valor.`);
  console.log(`   processo_pc . NULO em todas — o relatório não traz o processo da PC.`);
  console.log(`   Para achá-las depois:`);
  console.log(`      SELECT * FROM prestacoes_contas WHERE registrado_por = '${MARCA}';`);

  // ══ TRANSAÇÃO ════════════════════════════════════════════════════════════
  console.log(`\n── 8. TRANSAÇÃO ──────────────────────────────────────────────────────────────`);
  try {
    await cli.query('BEGIN');
    const antesTotal = (await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas')).rows[0].n;
    console.log(`   linhas antes ............... ${antesTotal}`);

    await cli.query(`DROP TABLE IF EXISTS ${FOTO}`);
    await cli.query(`CREATE TABLE ${FOTO} AS SELECT * FROM prestacoes_contas`);
    console.log(`   foto ....................... ${FOTO} (${(await cli.query(`SELECT COUNT(*)::int n FROM ${FOTO}`)).rows[0].n} linhas)`);

    const COLS = ['codigo_pc', 'codigo_nl', 'tipo', 'tr', 'parcela_seq', 'parcial_num', 'valor',
      'processo_pc', 'processo_mae', 'entidade', 'cnpj_cpf', 'status', 'baixada', 'data_baixa',
      'origem_baixa', 'sigef_status', 'data_baixa_sigef', 'analista_id', 'analista_nome', 'grupo',
      'setorial_id', 'registrado_por', 'criado_em', 'atualizado_em'];
    let inseridas = 0;
    for (let i = 0; i < aInserir.length; i += 200) {
      const lote = aInserir.slice(i, i + 200);
      const vals = [], par = []; let p = 1;
      for (const x of lote) {
        vals.push(`(${COLS.map(() => '$' + (p++)).join(',')})`);
        par.push(x.codigo_pc, null, x.tipo, x.tr, x.parcela_seq, x.parcial_num, null, null,
          x.processo_mae, x.entidade, x.cnpj_cpf, x.status, x.baixada, x.data_baixa, x.origem_baixa,
          x.sigef_status, x.data_baixa_sigef, x.analista_id, x.analista_nome, x.grupo,
          x.setorial_id, MARCA, new Date(), new Date());
      }
      // ⚠️ `DO NOTHING` é a rede de segurança da idempotência, não a trava: a trava são as
      // quatro provas. Se ele engolir alguma linha, a conferência de contagem acusa.
      const r = await cli.query(
        `INSERT INTO prestacoes_contas (${COLS.join(',')}) VALUES ${vals.join(',')}
         ON CONFLICT (codigo_pc) DO NOTHING RETURNING codigo_pc`, par);
      inseridas += r.rowCount;
    }
    console.log(`   inseridas .................. ${inseridas}`);

    // ⚠️ CONFERE CONTRA A FOTO, DENTRO DA MESMA TRANSAÇÃO. Conferir só o previsto prova o que
    // se esperava, não o que aconteceu.
    const depoisTotal = (await cli.query('SELECT COUNT(*)::int n FROM prestacoes_contas')).rows[0].n;
    const alteradas = (await cli.query(`
      SELECT COUNT(*)::int n FROM ${FOTO} f JOIN prestacoes_contas p USING (id)
       WHERE md5(f::text) IS DISTINCT FROM md5(p::text)`)).rows[0].n;
    const sumidas = (await cli.query(`
      SELECT COUNT(*)::int n FROM ${FOTO} f
       WHERE NOT EXISTS (SELECT 1 FROM prestacoes_contas p WHERE p.id = f.id)`)).rows[0].n;
    const dupNum = (await cli.query(`
      SELECT COUNT(*)::int n FROM (
        SELECT tr, parcial_num FROM prestacoes_contas WHERE tr = ANY($1)
         GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE registrado_por = $2) > 1) x`, [trs, MARCA])).rows[0].n;

    const ok = [], mal = [];
    (depoisTotal === antesTotal + inseridas ? ok : mal).push(`total ${antesTotal} + ${inseridas} = ${depoisTotal}`);
    (inseridas === aInserir.length ? ok : mal).push(`inseridas ${inseridas} == previstas ${aInserir.length}`);
    (alteradas === 0 ? ok : mal).push(`linhas preexistentes ALTERADAS: ${alteradas} (tem de ser 0)`);
    (sumidas === 0 ? ok : mal).push(`linhas preexistentes SUMIDAS: ${sumidas} (tem de ser 0)`);
    (dupNum === 0 ? ok : mal).push(`(TR,parcial_num) duplicado por esta carga: ${dupNum} (tem de ser 0)`);
    ok.forEach(m => console.log(`   ✓ ${m}`));
    mal.forEach(m => console.log(`   ✗ ${m}`));

    // ⚠️ O JSON DE REVERSÃO É ESCRITO ANTES DE TERMINAR, com lista EXPLÍCITA de chaves —
    // nunca condição derivada (armadilha 11 do projeto: um `WHERE` derivado pegou 14.639
    // linhas onde deviam ser 7).
    const rev = {
      quando: new Date().toISOString(), marca: MARCA, foto: FOTO, gravado: GRAVAR && !mal.length,
      total: aInserir.length, inseridas: aInserir.map(x => x.codigo_pc),
      desfazer: `DELETE FROM prestacoes_contas WHERE codigo_pc = ANY($1) AND registrado_por = '${MARCA}'`,
      aviso: 'lista explícita de chaves; conferir o COUNT antes e depois do DELETE',
    };
    fs.writeFileSync(GRAVAR && !mal.length ? REVERSAO : REVERSAO.replace('.json', '_DRYRUN.json'),
      JSON.stringify(rev, null, 1));

    if (mal.length) {
      await cli.query('ROLLBACK');
      console.log(`\n   ⛔ CONFERÊNCIA FALHOU — ROLLBACK. Nada gravado.`);
      console.log(`   ⚠️ Se falhou "linhas preexistentes ALTERADAS", PARE: algo fora deste script`);
      console.log(`      mexeu na tabela durante a transação.`);
      cli.release(); await pool.end(); process.exit(1);
    }
    if (GRAVAR) {
      await cli.query('COMMIT');
      console.log(`\n   ✅ COMMIT — ${inseridas} PCs inseridas.`);
      console.log(`   foto em ${FOTO} · reversão em ${REVERSAO}`);
    } else {
      await cli.query('ROLLBACK');
      console.log(`\n   ↩ ROLLBACK (dry-run). NADA foi gravado — nem a foto.`);
      console.log(`   prévia da reversão em ${REVERSAO.replace('.json', '_DRYRUN.json')}`);
      console.log(`   para gravar: node importar_sigef_30082026.js --gravar`);
    }
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error(`\n   ⛔ ERRO — ROLLBACK. Nada gravado.\n   ${e.message}`);
    cli.release(); await pool.end(); process.exit(1);
  }
  cli.release(); await pool.end();
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
