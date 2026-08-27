// CAMINHO: sigpc-api/migracao_sigef_status_20260827.js
//
// O STATUS DO SIGEF, E A DATA EM QUE O ANALISTA REGISTROU O PARECER LA.
//   prestacoes_contas.sigef_status      text  — preenchida por esta rodada (3.466 PCs)
//   prestacoes_contas.sigef_registro_em date  — NASCE VAZIA e fica assim
// Autorizada pelo Richard em 27/08/2026.
//
//   node migracao_sigef_status_20260827.js                  (DRY-RUN — nao grava nada)
//   node migracao_sigef_status_20260827.js --gravar         (grava)
//   node migracao_sigef_status_20260827.js --planilha="C:\...\Baixas FCEE.xlsx"
//
// ─────────────────────────────────────────────────────────────────────────────
// AS DUAS COLUNAS, E POR QUE SAO DUAS
//
// `sigef_status` guarda o rotulo LITERAL da planilha do SIGEF — "Baixa Regular" e "Baixa
// Regular Ressalva" nas parciais, "Regular - Secretario" e "Regular com Ressalvas -
// Secretario" nas finais. Literal de proposito: normalizar aqui apagaria a diferenca entre o
// que o SIGEF diz e o que o nosso `parecer_tipo` diz, que e justamente o que se quer poder
// comparar (as 38 divergencias medidas em 26/08 sairam dessa comparacao).
//
// ⚠️ `sigef_status` NAO SUBSTITUI `parecer_tipo`. Sao duas fontes sobre a mesma PC: uma e o
// SIGEF, a outra e o que a equipe registrou aqui. Quando discordam, a discordancia E o achado
// — e ela desaparece no instante em que as duas virarem uma coluna so.
//
// `sigef_registro_em` e a data em que o ANALISTA informa ter registrado o parecer no SIGEF.
// Ela NAO e a `data_baixa_sigef`: aquela veio da planilha e diz quando o SIGEF foi modificado;
// esta vai ser digitada por quem fez o registro. Nesta rodada ela so passa a existir.
//
// ⚠️ ELA NASCE VAZIA EM TODAS AS 14.658 LINHAS, E ISSO E O CERTO. Nao ha backfill, e nao pode
// haver: deduzi-la da `data_baixa_sigef` seria inventar a resposta de uma pergunta que so o
// analista responde — e a conferencia 14 existe para provar que ninguem a preencheu por
// engano. E a mesma decisao do `estado_anterior` em 26/08.
//
// ⚠️ ESTA RODADA NAO TOCA EM `data_baixa`, `data_baixa_sigef`, `baixada`, `enviado_ci`,
// `parecer_tipo`, NEM EM PRODUTIVIDADE, NEM EM QUALQUER COLUNA QUE JA EXISTIA. As conferencias
// 7 e 8 PROVAM isso com um `md5` de todas as colunas pre-existentes, linha a linha, antes e
// depois — contar linhas nao prova que elas nao mudaram (a licao do aviso id 6, em 17/08).
//
// ⚠️ O CASAMENTO E O MESMO DO `migracao_data_baixa_sigef_20260827.js`: parciais por
// `NR. PC` = `codigo_pc`, finais por `TRANSFERENCIA` = `tr` aplicando a PC final daquela TR.
// E a conferencia 15 exige que o conjunto batido aqui seja EXATAMENTE o mesmo que ganhou
// `data_baixa_sigef` naquela rodada. Se a planilha tiver sido reexportada com outro conteudo,
// as duas colunas passariam a falar de PCs diferentes e ninguem notaria.
//
// ⚠️ A ABA `Parciais -TEVs` TEM DUAS COLUNAS CHAMADAS `Parcial` (indices 8 e 11) — armadilha
// 16-A. Toda leitura aqui e por INDICE, com o nome do cabecalho CONFERIDO antes.

const { Pool } = require('pg');
const fs = require('fs');

let XLSX;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.error('\n  X O pacote `xlsx` nao esta instalado. Rode:  npm i xlsx');
  console.error('    (ele nao esta no package.json de proposito — nenhum script de');
  console.error('     manutencao roda no Railway, e o deploy nao precisa dele.)\n');
  process.exit(1);
}

const GRAVAR = process.argv.includes('--gravar');
const TABELA = 'prestacoes_contas';
const COL_STATUS = 'sigef_status';
const COL_REGISTRO = 'sigef_registro_em';

// ⚠️ O DRY-RUN NUNCA SOBRESCREVE A REVERSAO DA GRAVACAO. Sao dois nomes de arquivo, e nao um
// com flag: um dry-run rodado depois da gravacao apagaria o unico registro de como voltar.
const ARQ_REVERSAO = GRAVAR
  ? 'reverter_sigef_status_20260827.json'
  : 'reverter_sigef_status_20260827_DRYRUN.json';

// ── A PLANILHA ───────────────────────────────────────────────────────────────
// Caminhos tentados, em ordem. Nenhum e adivinhado: ou e um destes, ou vem por --planilha.
// O confirmado pelo Richard em 27/08 e o de `Downloads`, com espaco no nome.
const CANDIDATOS = [
  'C:\\Users\\Richard\\Downloads\\Baixas FCEE.xlsx',
  'C:\\Users\\Richard\\Downloads\\Baixas_FCEE.xlsx',
  'C:\\Users\\Richard\\Baixas FCEE.xlsx',
  'C:\\Users\\Richard\\Baixas_FCEE.xlsx',
];

// ⚠️ INDICE E NOME ESPERADO, os dois. O indice e o que le; o nome e o que confere. Se a
// planilha for reexportada com outra ordem de colunas, o script PARA em vez de gravar a
// coluna errada em milhares de linhas.
const ABAS = [
  {
    aba: 'Parciais -TEVs',
    iChave: 9, nomeChave: 'NR. PC',
    iStatus: 29, nomeStatus: 'Status 07-08-26',
    esperado: 3359,
  },
  {
    aba: 'Finais',
    iChave: 8, nomeChave: 'TRANSFERÊNCIA',
    iStatus: 12, nomeStatus: 'Status 07-08-26',
    esperado: 107,
  },
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const linha = (t) => console.log(t);
const passo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

let confOk = 0, confFalhou = 0;
function conferir(nome, cond, detalhe) {
  if (cond) { confOk++; linha(`   OK    ${nome}`); }
  else { confFalhou++; linha(`   FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
  return cond;
}

function acharPlanilha() {
  const arg = process.argv.find((a) => a.startsWith('--planilha='));
  if (arg) {
    const p = arg.slice('--planilha='.length).replace(/^"|"$/g, '');
    if (!fs.existsSync(p)) throw new Error(`--planilha aponta para arquivo inexistente: ${p}`);
    return p;
  }
  const achado = CANDIDATOS.find((p) => fs.existsSync(p));
  if (!achado) {
    throw new Error(
      'planilha nao encontrada. Tentados:\n     ' + CANDIDATOS.join('\n     ')
      + '\n   Passe o caminho com --planilha="C:\\...\\Baixas FCEE.xlsx"');
  }
  return achado;
}

function lerAba(wb, spec) {
  const ws = wb.Sheets[spec.aba];
  if (!ws) throw new Error(`a aba "${spec.aba}" nao existe na planilha`);
  const rg = XLSX.utils.decode_range(ws['!ref']);

  // Confere o CABECALHO nos dois indices antes de ler uma linha sequer.
  const cab = (i) => {
    const c = ws[XLSX.utils.encode_cell({ r: rg.s.r, c: i })];
    return c ? String(c.v).trim() : null;
  };
  if (cab(spec.iChave) !== spec.nomeChave) {
    throw new Error(`aba "${spec.aba}": a coluna [${spec.iChave}] deveria ser `
      + `"${spec.nomeChave}" e e "${cab(spec.iChave)}"`);
  }
  if (cab(spec.iStatus) !== spec.nomeStatus) {
    throw new Error(`aba "${spec.aba}": a coluna [${spec.iStatus}] deveria ser `
      + `"${spec.nomeStatus}" e e "${cab(spec.iStatus)}"`);
  }

  const itens = [];
  const problemas = [];
  let comEspacoSobrando = 0;
  for (let r = rg.s.r + 1; r <= rg.e.r; r++) {
    const cK = ws[XLSX.utils.encode_cell({ r, c: spec.iChave })];
    const chave = cK ? String(cK.v).trim() : '';
    const cS = ws[XLSX.utils.encode_cell({ r, c: spec.iStatus })];
    const bruto = cS && cS.v !== null && cS.v !== undefined ? String(cS.v) : '';
    const status = bruto.trim();

    if (!chave) { problemas.push({ linha: r + 1, erro: 'chave vazia' }); continue; }
    if (!status) { problemas.push({ linha: r + 1, chave, erro: 'status vazio' }); continue; }
    // ⚠️ So o espaco das PONTAS sai. O rotulo de dentro fica LITERAL: trocar "Baixa Regular
    // Ressalva" por "Ressalvas" para "ficar igual ao parecer_tipo" apagaria a divergencia que
    // esta coluna existe para expor.
    if (bruto !== status) comEspacoSobrando++;
    itens.push({ linha: r + 1, chave, status });
  }
  return { itens, problemas, comEspacoSobrando };
}

// ─────────────────────────────────────────────────────────────────────────────
// A FOTO DA TABELA
//
// ⚠️ O `md5` COBRE TODAS AS COLUNAS PRE-EXISTENTES, uma a uma, com separador, EXCLUINDO as
// DUAS colunas novas. Um `md5` de `to_jsonb(linha)` mudaria sozinho quando elas entrassem — e
// a conferencia que deveria provar "nada mais mudou" acusaria a propria migracao.
// ─────────────────────────────────────────────────────────────────────────────
function sqlFoto(listaColunas) {
  const meta = (col, apelido) => `
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${col}')            AS tem_${apelido},
    (SELECT data_type FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${col}')            AS tipo_${apelido},
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${col}')            AS nullable_${apelido},
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${col}')            AS default_${apelido},`;
  return `
  SELECT ${meta(COL_STATUS, 'status')} ${meta(COL_REGISTRO, 'registro')}
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}')                                       AS n_colunas,
    (SELECT COUNT(*)::int FROM ${TABELA})                                   AS n_linhas,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE baixada = true)              AS n_baixadas,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE enviado_ci = true)           AS n_enviado_ci,
    (SELECT COUNT(*)::int FROM ${TABELA}
      WHERE baixada = true OR enviado_ci = true)                            AS n_produtividade,
    (SELECT COUNT(*)::int FROM ${TABELA}
      WHERE data_baixa::date = DATE '2026-06-30')                           AS n_data_baixa_3006,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE parecer_tipo IS NOT NULL)    AS n_com_parecer,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE data_baixa_sigef IS NOT NULL) AS n_com_data_sigef,
    -- o md5 das colunas que esta rodada promete nao tocar, explicito e legivel.
    -- ⚠️ data_baixa_sigef ENTROU NESTA LISTA: ela e de ontem, e continua intocavel.
    -- (sem crase aqui: uma crase dentro de template literal fecha a string — armadilha 10)
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), codigo_pc, data_baixa, data_baixa_sigef, baixada, enviado_ci,
                  parecer_tipo),
        chr(30) ORDER BY codigo_pc), '')) FROM ${TABELA})                   AS md5_intocaveis,
    -- e o md5 de TUDO que ja existia, que e a conferencia que fecha a porta de verdade
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.codigo_pc), ''))
       FROM (SELECT codigo_pc, concat_ws(chr(31), ${listaColunas}) AS a
               FROM ${TABELA}) t)                                           AS md5_conteudo`;
}

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha(`  O STATUS DO SIGEF — ${TABELA}.${COL_STATUS} text`);
    linha(`  E O REGISTRO DO ANALISTA — ${TABELA}.${COL_REGISTRO} date (nasce vazia)`);
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    // ── 1. A PLANILHA ────────────────────────────────────────────────────────
    passo('1. A PLANILHA');
    const arq = acharPlanilha();
    linha(`   arquivo ....................... ${arq}`);
    const wb = XLSX.readFile(arq, { cellDates: true });
    linha(`   abas .......................... ${wb.SheetNames.join(' · ')}`);

    const lido = {};
    for (const spec of ABAS) {
      const { itens, problemas, comEspacoSobrando } = lerAba(wb, spec);
      lido[spec.aba] = { spec, itens, problemas };
      linha(`   ${spec.aba.padEnd(16)} ......... ${String(itens.length).padStart(5)} linhas lidas`
        + (problemas.length ? `  ⚠️ ${problemas.length} PROBLEMAS` : '   (0 problemas)'));
      if (problemas.length) {
        problemas.slice(0, 10).forEach((p) => linha(`      ⚠️  ${JSON.stringify(p)}`));
        throw new Error(`a aba "${spec.aba}" tem ${problemas.length} linha(s) que nao deram para ler com seguranca`);
      }
      if (itens.length !== spec.esperado) {
        linha(`      ⚠️  esperava ${spec.esperado} linhas nesta aba e vieram ${itens.length}`
          + ' — a planilha mudou de tamanho');
      }
      if (comEspacoSobrando) {
        linha(`      (${comEspacoSobrando} status vinham com espaco nas pontas — so as pontas saem)`);
      }
      // Chave repetida com status diferente e ambiguidade: qual rotulo valeria?
      const cont = {};
      itens.forEach((x) => { cont[x.chave] = (cont[x.chave] || 0) + 1; });
      const reps = Object.entries(cont).filter(([, n]) => n > 1);
      if (reps.length) {
        const comConflito = reps.filter(([k]) =>
          new Set(itens.filter((x) => x.chave === k).map((x) => x.status)).size > 1);
        linha(`      ⚠️  ${reps.length} chave(s) repetida(s), ${comConflito.length} com STATUS DIFERENTES`);
        if (comConflito.length) {
          throw new Error(`a aba "${spec.aba}" tem chave repetida com status diferente — `
            + 'qual rotulo vale e decisao de regra, nao do script');
        }
      }
      // Os rotulos, como estao na planilha.
      const dist = {};
      itens.forEach((x) => { dist[x.status] = (dist[x.status] || 0) + 1; });
      Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
        linha(`      · ${String(n).padStart(5)}  "${k}"`));
    }

    await cli.query('BEGIN');

    // ── 2. A FOTO, ANTES ─────────────────────────────────────────────────────
    passo('2. FOTO DE ANTES');
    const { rows: cols } = await cli.query(
      `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS lista
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name <> ALL($2::text[])`,
      [TABELA, [COL_STATUS, COL_REGISTRO]]);
    const SQL_FOTO = sqlFoto(cols[0].lista);

    const { rows: a } = await cli.query(SQL_FOTO);
    const antes = a[0];
    linha(`   coluna ${COL_STATUS} existe? ....... ${antes.tem_status ? 'SIM (' + antes.tipo_status + ')' : 'nao'}`);
    linha(`   coluna ${COL_REGISTRO} existe? .. ${antes.tem_registro ? 'SIM (' + antes.tipo_registro + ')' : 'nao'}`);
    linha(`   colunas na tabela ............. ${antes.n_colunas}`);
    linha(`   linhas (PCs) .................. ${antes.n_linhas}`);
    linha(`   baixada = true ................ ${antes.n_baixadas}`);
    linha(`   enviado_ci = true ............. ${antes.n_enviado_ci}`);
    linha(`   produtividade (baixada OU ci) . ${antes.n_produtividade}`);
    linha(`   data_baixa = 30/06/2026 ....... ${antes.n_data_baixa_3006}`);
    linha(`   com parecer_tipo .............. ${antes.n_com_parecer}`);
    linha(`   com data_baixa_sigef .......... ${antes.n_com_data_sigef}   (a rodada de ontem)`);
    linha(`   md5 das intocaveis ............ ${antes.md5_intocaveis}`);
    linha(`   md5 de tudo que ja existia .... ${antes.md5_conteudo}`);

    // ── 3. AS COLUNAS ────────────────────────────────────────────────────────
    passo('3. AS DUAS COLUNAS');
    const DDL_STATUS = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COL_STATUS} text`;
    const DDL_REGISTRO = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COL_REGISTRO} date`;
    linha(`   ${DDL_STATUS}`);
    linha(`   ${DDL_REGISTRO}`);
    if (antes.tem_status) linha(`   (${COL_STATUS} JA EXISTE — ${antes.tipo_status}. O IF NOT EXISTS nao faz nada.)`);
    if (antes.tem_registro) linha(`   (${COL_REGISTRO} JA EXISTE — ${antes.tipo_registro}. O IF NOT EXISTS nao faz nada.)`);
    await cli.query(DDL_STATUS);
    await cli.query(DDL_REGISTRO);

    // ── 4. O PLANO ───────────────────────────────────────────────────────────
    passo('4. O PLANO — o que casa, e o que nao casa');

    // 4a. PARCIAIS: casam por codigo_pc.
    const par = lido['Parciais -TEVs'].itens;
    const { rows: achadosPar } = await cli.query(
      `SELECT codigo_pc, parecer_tipo FROM ${TABELA} WHERE codigo_pc = ANY($1)`,
      [par.map((x) => x.chave)]);
    const mapaPar = new Map(achadosPar.map((r) => [r.codigo_pc, r]));

    // 4b. FINAIS: casam por tr, e o status vai na PC final DAQUELA TR.
    //     ⚠️ Resolvido pelo BANCO (`tipo = 'final'`), e nao pela suposicao de que o codigo e
    //     `tr || '-PFINAL'` — quem responde "qual e a PC final desta TR" e a tabela.
    const fin = lido['Finais'].itens;
    const { rows: achadosFin } = await cli.query(
      `SELECT tr, COUNT(*)::int AS n, MIN(codigo_pc) AS codigo_pc,
              MIN(parecer_tipo) AS parecer_tipo
         FROM ${TABELA} WHERE tr = ANY($1) AND tipo = 'final' GROUP BY tr`,
      [fin.map((x) => x.chave)]);
    const mapaFin = new Map(achadosFin.map((r) => [r.tr, r]));
    const trsMultiplas = achadosFin.filter((r) => r.n > 1);
    if (trsMultiplas.length) {
      throw new Error(`${trsMultiplas.length} TR(s) tem MAIS DE UMA PC final — a qual delas o `
        + 'status se aplica e decisao de regra: ' + trsMultiplas.map((r) => r.tr).join(', '));
    }

    // 4c. O plano, e as sobras.
    const plano = [];
    const semCorrespondencia = [];
    for (const x of par) {
      const r = mapaPar.get(x.chave);
      if (!r) {
        semCorrespondencia.push({ origem: 'parcial', chave: x.chave, linha: x.linha,
          motivo: 'codigo_pc nao existe em prestacoes_contas' });
        continue;
      }
      plano.push({ codigo_pc: r.codigo_pc, status: x.status, origem: 'parcial', parecer_aqui: r.parecer_tipo });
    }
    for (const x of fin) {
      const r = mapaFin.get(x.chave);
      if (!r) {
        semCorrespondencia.push({ origem: 'final', chave: x.chave, linha: x.linha,
          motivo: 'a TR nao tem PC final em prestacoes_contas' });
        continue;
      }
      plano.push({ codigo_pc: r.codigo_pc, status: x.status, origem: 'final', parecer_aqui: r.parecer_tipo });
    }

    // Uma PC nao pode aparecer duas vezes no plano com status diferentes.
    const porPc = new Map();
    for (const p of plano) {
      if (porPc.has(p.codigo_pc) && porPc.get(p.codigo_pc).status !== p.status) {
        throw new Error(`a PC ${p.codigo_pc} recebeu dois status diferentes no plano `
          + `("${porPc.get(p.codigo_pc).status}" e "${p.status}")`);
      }
      porPc.set(p.codigo_pc, p);
    }

    linha(`   parciais da planilha .......... ${String(par.length).padStart(5)}  ->  casaram `
      + plano.filter((p) => p.origem === 'parcial').length);
    linha(`   finais da planilha ............ ${String(fin.length).padStart(5)}  ->  casaram `
      + plano.filter((p) => p.origem === 'final').length);
    linha(`   TOTAL a preencher ............. ${String(plano.length).padStart(5)} PCs`);
    linha('');
    linha(`   ⚠️  SEM CORRESPONDENCIA ....... ${semCorrespondencia.length}`);
    if (semCorrespondencia.length) {
      const porOrigem = {};
      semCorrespondencia.forEach((s) => { porOrigem[s.origem] = (porOrigem[s.origem] || 0) + 1; });
      linha(`      por origem: ${JSON.stringify(porOrigem)}`);
      semCorrespondencia.slice(0, 25).forEach((s) =>
        linha(`      · ${s.origem} ${s.chave} (linha ${s.linha}) — ${s.motivo}`));
      if (semCorrespondencia.length > 25) {
        linha(`      · ... e mais ${semCorrespondencia.length - 25} — a lista inteira vai no JSON de reversao`);
      }
    }

    // 4d. O que muda de fato (idempotencia).
    const codigos = plano.map((p) => p.codigo_pc);
    const status = plano.map((p) => p.status);
    const { rows: antesValores } = await cli.query(
      `SELECT codigo_pc, ${COL_STATUS} AS atual FROM ${TABELA} WHERE codigo_pc = ANY($1)`,
      [codigos]);
    const mapaAtual = new Map(antesValores.map((r) => [r.codigo_pc, r.atual]));
    const aGravar = plano.filter((p) => mapaAtual.get(p.codigo_pc) !== p.status);
    const jaCertas = plano.length - aGravar.length;
    linha('');
    linha(`   ja estao com o status certo ... ${jaCertas}  (nada a fazer nelas)`);
    linha(`   vao ser escritas .............. ${aGravar.length}`);
    if (aGravar.length === 0) linha('   -> IDEMPOTENTE: nada mudou desde a ultima rodada.');

    // 4e. O contraste com o `parecer_tipo` — nao muda nada, so mostra o que a coluna serve.
    //     ⚠️ ILIKE '%ressalva%' dos dois lados, nunca igualdade: o banco tem
    //     "Parecer Regular com Ressalva" E "...Ressalvas", e a igualdade exata separaria as
    //     duas como se fossem pareceres diferentes.
    const temRessalva = (s) => !!s && /ressalva/i.test(s);
    const comParecer = plano.filter((p) => p.parecer_aqui);
    const divergem = comParecer.filter((p) => temRessalva(p.status) !== temRessalva(p.parecer_aqui));
    linha('');
    linha(`   (so leitura) das ${plano.length}, tem parecer_tipo aqui ... ${comParecer.length}`);
    linha(`   (so leitura) SIGEF e parecer discordam em ressalva . ${divergem.length}`);
    linha('      Nada e corrigido por causa disso. A coluna existe para deixar ver.');

    // ── 5. A ESCRITA ─────────────────────────────────────────────────────────
    passo('5. O COMANDO DE ESCRITA');
    const SQL_UPDATE = `
      UPDATE ${TABELA} p
         SET ${COL_STATUS} = v.st
        FROM (SELECT unnest($1::text[]) AS cpc, unnest($2::text[]) AS st) v
       WHERE p.codigo_pc = v.cpc
         AND p.${COL_STATUS} IS DISTINCT FROM v.st`;
    linha('   UPDATE prestacoes_contas p');
    linha(`      SET ${COL_STATUS} = v.st`);
    linha('     FROM (SELECT unnest($1::text[]) cpc, unnest($2::text[]) st) v');
    linha('    WHERE p.codigo_pc = v.cpc');
    linha(`      AND p.${COL_STATUS} IS DISTINCT FROM v.st         -- ${plano.length} pares`);
    linha('');
    linha(`   ⚠️  UMA coluna no SET, e ${COL_REGISTRO} NAO APARECE em UPDATE nenhum:`);
    linha('       ela so passa a existir, vazia. Ver o cabecalho deste arquivo.');

    const res = await cli.query(SQL_UPDATE, [codigos, status]);
    linha(`   linhas afetadas ............... ${res.rowCount}`);

    // ── 6. AS CONFERENCIAS, CONTRA A FOTO, DEPOIS DE ESCREVER ────────────────
    passo('6. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO);
    const depois = d[0];

    conferir(`1. ${COL_STATUS} passou a existir, tipo text`,
      depois.tem_status === 1 && depois.tipo_status === 'text', `veio ${depois.tipo_status}`);
    conferir(`2. ${COL_STATUS} aceita NULL e nao tem DEFAULT`,
      depois.nullable_status === 'YES' && depois.default_status === null,
      `nullable=${depois.nullable_status} default=${depois.default_status}`);
    conferir(`3. ${COL_REGISTRO} passou a existir, tipo date`,
      depois.tem_registro === 1 && depois.tipo_registro === 'date', `veio ${depois.tipo_registro}`);
    conferir(`4. ${COL_REGISTRO} aceita NULL e nao tem DEFAULT`,
      depois.nullable_registro === 'YES' && depois.default_registro === null,
      `nullable=${depois.nullable_registro} default=${depois.default_registro}`);

    const ganhou = (antes.tem_status ? 0 : 1) + (antes.tem_registro ? 0 : 1);
    conferir(`5. a tabela ganhou exatamente ${ganhou} coluna(s)`,
      depois.n_colunas === antes.n_colunas + ganhou,
      `${antes.n_colunas} -> ${depois.n_colunas}`);
    conferir('6. o numero de PCs nao mudou',
      depois.n_linhas === antes.n_linhas, `${antes.n_linhas} -> ${depois.n_linhas}`);

    // ⚠️ AS DUAS QUE FECHAM A PORTA DE VERDADE.
    conferir('7. md5 das intocaveis IDENTICO — data_baixa, data_baixa_sigef, baixada, enviado_ci, parecer_tipo',
      depois.md5_intocaveis === antes.md5_intocaveis,
      `${antes.md5_intocaveis} -> ${depois.md5_intocaveis}`);
    conferir('8. md5 de TODAS as colunas pre-existentes IDENTICO — so as colunas novas mudaram',
      depois.md5_conteudo === antes.md5_conteudo,
      `${antes.md5_conteudo} -> ${depois.md5_conteudo}`);

    conferir('9. a produtividade nao se moveu (baixada OU enviado_ci)',
      depois.n_produtividade === antes.n_produtividade,
      `${antes.n_produtividade} -> ${depois.n_produtividade}`);
    conferir('10. a data_baixa_sigef de ontem continua igual',
      depois.n_com_data_sigef === antes.n_com_data_sigef,
      `${antes.n_com_data_sigef} -> ${depois.n_com_data_sigef}`);

    // Contra o PREVISTO no plano — nunca contra numero literal.
    const { rows: nn } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} WHERE ${COL_STATUS} IS NOT NULL`);
    conferir('11. o total com status do SIGEF e exatamente o previsto no plano',
      nn[0].n === plano.length, `previsto ${plano.length}, veio ${nn[0].n}`);

    const { rows: div } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} p
         JOIN (SELECT unnest($1::text[]) AS cpc, unnest($2::text[]) AS st) v
           ON v.cpc = p.codigo_pc
        WHERE p.${COL_STATUS} IS DISTINCT FROM v.st`, [codigos, status]);
    conferir('12. nenhuma PC do plano ficou com status diferente da planilha',
      div[0].n === 0, `${div[0].n} divergentes`);

    const { rows: fora } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA}
        WHERE ${COL_STATUS} IS NOT NULL AND NOT (codigo_pc = ANY($1))`, [codigos]);
    conferir('13. nenhuma PC de fora do plano ganhou status',
      fora[0].n === 0, `${fora[0].n} PCs de fora com valor`);

    // ⚠️ A conferencia que prova que a segunda coluna NAO foi preenchida por engano.
    const { rows: vazia } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} WHERE ${COL_REGISTRO} IS NOT NULL`);
    conferir(`14. ${COL_REGISTRO} esta VAZIA em todas as linhas`,
      vazia[0].n === 0, `${vazia[0].n} com valor`);

    // ⚠️ E a que amarra esta rodada na de ontem: as duas colunas tem de falar das MESMAS PCs.
    const { rows: mesmo } = await cli.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${COL_STATUS} IS NOT NULL AND data_baixa_sigef IS NULL)::int AS so_status,
         COUNT(*) FILTER (WHERE ${COL_STATUS} IS NULL AND data_baixa_sigef IS NOT NULL)::int AS so_data
       FROM ${TABELA}`);
    conferir('15. as PCs com status sao exatamente as que tem data_baixa_sigef',
      mesmo[0].so_status === 0 && mesmo[0].so_data === 0,
      `so com status: ${mesmo[0].so_status} · so com data: ${mesmo[0].so_data}`);

    // A idempotencia, PROVADA dentro da propria transacao: rodar de novo nao muda nada.
    const res2 = await cli.query(SQL_UPDATE, [codigos, status]);
    conferir('16. rodar o UPDATE de novo afeta ZERO linhas (idempotente)',
      res2.rowCount === 0, `afetou ${res2.rowCount}`);

    // ── 7. REVERSAO ──────────────────────────────────────────────────────────
    passo('7. JSON DE REVERSAO');
    // ⚠️ A reversao vai por LISTA EXPLICITA DE CHAVES, com o valor ANTERIOR de cada uma —
    // nunca por condicao derivada (armadilha 12). Um `WHERE sigef_status IS NOT NULL`
    // apagaria tambem o que uma rodada posterior tiver escrito.
    const reversao = {
      script: 'migracao_sigef_status_20260827.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 27/08/2026',
      planilha: arq,
      coluna_fonte: 'Status 07-08-26',
      alterou: {
        tabela: TABELA,
        colunas: [
          { coluna: COL_STATUS, tipo: 'text', ddl: DDL_STATUS, preenchida: true },
          { coluna: COL_REGISTRO, tipo: 'date', ddl: DDL_REGISTRO, preenchida: false },
        ],
      },
      resumo: {
        parciais_planilha: par.length,
        finais_planilha: fin.length,
        casaram: plano.length,
        sem_correspondencia: semCorrespondencia.length,
        ja_estavam_certas: jaCertas,
        escritas: res.rowCount,
        sigef_registro_em_preenchidas: 0,
        discordam_do_parecer_tipo_em_ressalva: divergem.length,
      },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      sem_correspondencia: semCorrespondencia,
      // o valor ANTERIOR de cada PC tocada — e por ele que se volta
      valores_anteriores: aGravar.map((p) => ({
        codigo_pc: p.codigo_pc,
        de: mapaAtual.get(p.codigo_pc) === undefined ? null : mapaAtual.get(p.codigo_pc),
        para: p.status,
      })),
      reverter_com:
        'UPDATE prestacoes_contas SET sigef_status = v.de FROM (VALUES ...) '
        + 'AS v(codigo_pc, de) WHERE prestacoes_contas.codigo_pc = v.codigo_pc   '
        + '-- monte o VALUES a partir de `valores_anteriores` deste arquivo',
      reverter_as_colunas_inteiras: [
        `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COL_STATUS}`,
        `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COL_REGISTRO}`,
      ],
      aviso_reversao:
        'O DROP de sigef_registro_em apaga o que os analistas tiverem digitado desde a '
        + 'gravacao. Conferir antes: SELECT COUNT(*) FROM prestacoes_contas WHERE '
        + 'sigef_registro_em IS NOT NULL; se for > 0, NAO derrubar a coluna.',
    };
    fs.writeFileSync(ARQ_REVERSAO, JSON.stringify(reversao, null, 2), 'utf8');
    linha(`   escrito: ${ARQ_REVERSAO}`);
    linha(`   ${reversao.valores_anteriores.length} chaves com o valor anterior de cada uma`);

    // ── 8. DESFECHO ──────────────────────────────────────────────────────────
    passo('8. DESFECHO');
    linha(`   conferencias: ${confOk} passaram · ${confFalhou} falharam`);

    if (confFalhou > 0) {
      await cli.query('ROLLBACK');
      linha('\n   X ROLLBACK — alguma conferencia falhou. Nada foi gravado.');
      process.exitCode = 1;
      return;
    }
    if (!GRAVAR) {
      await cli.query('ROLLBACK');
      linha('\n   ROLLBACK — DRY-RUN. Nada foi gravado.');
      linha('   Para gravar: node migracao_sigef_status_20260827.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha(`\n   OK COMMIT — ${res.rowCount} PCs com o status do SIGEF, `
      + `e ${COL_REGISTRO} criada vazia.`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* a transacao pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   As duas colunas sao NOVAS e ninguem le elas ainda: nenhuma tela, nenhuma');
      linha('   rota, nenhum relatorio mudou de comportamento. Nao precisa reiniciar a API.');
    }
  }
})();
