// CAMINHO: sigpc-api/renumerar_sigef.js
//
// RENUMERA `parcial_num` pelo NÚMERO DO SIGEF, a partir do mapa oficial da CGE.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// ─────────────────────────────────────────────────────────────────────────────
// A CAUSA, confirmada contra o banco em 16/08/2026
//
// A migração numerou as parciais pela ORDEM do `PARCELA N°` (que virou `parcela_seq`) em vez
// de copiar a coluna `Parcial` do estoque da CGE, que é o número do SIGEF. Na 2020TR000644
// isso reproduz 10 de 10 o embaralhamento que a Marisa relatou — a parcial que o sistema
// chama de 19 é a 22 no SIGEF.
//
// ⚠️ NÃO HÁ ERRO DE VALOR NEM DE PROCESSO. O processo e o valor andam juntos e corretos; o
// único campo errado é o rótulo colado neles. Por isso a correção é só `parcial_num`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ✅ O SPLIT ENTRA NO LOTE (decisão do Richard, 16/08/2026)
//
// Um processo SGPe carrega VÁRIAS parcelas do SIGEF — 113 pares (TR, processo), 78 TRs,
// 465 PCs, medidos no estoque oficial da CGE por dois agentes cegos um ao outro. Logo o mapa
// NÃO parte processos indevidamente, e o que era o "bloqueio nº 1" era o dado correto.
// Ver a armadilha 16 do CLAUDE.md e o SPLIT_PROCESSO_2026-08-16.md.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE SCRIPT NÃO TOCA
//
// ⚠️ `baixada`, `data_baixa`, `parecer_tipo`, `parecer_ci`, `enviado_ci`, `dt_envio_ci`,
// `ci_situacao`, `ci_rodada`, `ci_encerrado_em`, `ci_encerrado_por`, `valor`, `processo_pc`,
// `analista_id` — as 13 protegidas. A prova NÃO é o lint do item 0: é a conferência coluna a
// coluna contra o backup, DEPOIS de escrever e DENTRO da transação (item 7).
//
// USO:
//   node renumerar_sigef.js                # dry-run: escreve, confere e faz ROLLBACK
//   node renumerar_sigef.js --gravar       # o mesmo, com COMMIT no fim
//   node renumerar_sigef.js --gravar --forcar   # ignora a trava de janela (com motivo)

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const FORCAR = process.argv.includes('--forcar');
const MAPA_CSV = __dirname + '/MAPA_PARCIAL_SIGEF.csv';

// ⚠️ DEFEITO 1 CORRIGIDO — O `--gravar` DESTRUÍA O BACKUP.
//
// A versão anterior fazia `DROP TABLE IF EXISTS _backup_parcial_num_20260816` e recriava a
// tabela com 7 colunas. Só que essa tabela JÁ EXISTE no banco com 11 — é a foto de antes de
// tudo, e é a única prova de que o C.I. não foi tocado. O script apagaria a prova para criar
// uma versão pior dela, sem `parecer_tipo`, `enviado_ci`, `ci_situacao` nem `analista_id`.
//
// Agora: nome NOVO, e `CREATE TABLE` **sem** `DROP` e sem `IF NOT EXISTS` — se já existir, o
// Postgres levanta erro e a transação cai. Backup que se sobrescreve não é backup.
const BACKUP = '_backup_parcial_num_20260816b';
const BACKUP_HIST = '_backup_parcela_historico_20260816b';

// ⚠️ LISTA EXPLÍCITA, escrita à mão a partir da medição — nunca uma condição derivada
// (regra 12). Se uma TR entrar ou sair, é aqui, e aparece no diff.
//
// ⚠️ ESTAS 15 SÃO A DIREÇÃO CONTRÁRIA DO SPLIT, e por isso continuam fora: nelas a correção
// juntaria processos hoje separados DENTRO de uma parcial só. O split (um processo em várias
// parciais) entrou; a fusão (uma parcial com vários processos) não foi decidida. Duas delas
// têm motivo próprio:
//   · 2020TR000761 — é a TR do relato da Noici sobre trabalho que sumiu. Ler
//     `parcela_historico` antes de encostar nela.
//   · 2020TR000699 — a parcial 40 juntaria SEIS processos, de 2021 a 2024, com valores de
//     R$ 31,44 a R$ 30.813,67, e dois deles aparecem TAMBÉM na parcial 33. Isso é rateio ou
//     erro da fonte, não parcela.
const FORA_DO_LOTE = [
  '2022TR000941', '2020TR000823', '2020TR000830', '2022TR001248', '2020TR000683',
  '2020TR000699', '2020TR000648', '2020TR000665', '2020TR000704', '2020TR000761',
  '2020TR000766', '2020TR000793', '2020TR000816', '2021TR002375', '2022TR000927',
];

// ⚠️ AS "2 LINHAS DA ANDRESSA NA 2020TR000623" — SÃO 2 LINHAS, MAS 3 PCs.
//
// "Linha" aqui é linha do `DIVERGENCIAS_21_RESOLVIDAS.csv`, e cada uma é um par
// (TR, processo) — não uma PC. Os dois processos, marcados
// "OLHAR — valores muito distintos, não é deslocamento":
//
//   SCC 25403/2021   planilha 16 · CGE 17   valor planilha 34.975,89 · CGE 800,00
//   SCC 8135/2024    planilha 43 · CGE 42   valor planilha 109.855,70 · CGE 21.429,55
//
// No banco eles são TRÊS PCs, porque o SCC25403/2021 tem duas: 607,76 + 192,24 = 800,00,
// que é exatamente o `valor_cge` da linha. Confere pelos dois lados.
//
// ⚠️ A minha primeira tentativa filtrou por `analista_nome ILIKE '%andressa%'` naquela TR e
// achou 22 PCs — a Andressa tem 74 PCs em 44 parciais ali. **Nome não identifica linha**, e
// "2 linhas" não queria dizer 2 PCs. Daí a lista ser de `codigo_pc` (regra 12) e a
// conferência abaixo recalcular pelos processos, para as duas leituras terem de bater.
// ⚠️ VAZIO desde 16/08/2026: o Richard decidiu que as 2 linhas ENTRAM no lote, pela CGE.
// A lista e a conferência ficam de pé — se um dia voltar a haver PC a excluir nominalmente,
// é aqui, e a conferência abaixo obriga a lista a bater com o que o banco tem.
const FORA_PCS = [];
const FORA_PCS_TR = '2020TR000623';
const FORA_PCS_PROCESSOS = ['SCC 25403/2021', 'SCC 8135/2024'];

// Normaliza como o resto do sistema: maiúscula, sem espaço, sem zero à esquerda do número.
const normProc = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/(\D)0+(\d)/g, '$1$2');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ⚠️ O UPDATE, isolado numa constante para poder ser CONFERIDO antes de rodar.
const SQL_RENUMERAR = `
  UPDATE prestacoes_contas p
     SET parcial_num = m.parcial_sigef,
         atualizado_em = NOW()
    FROM _mapa m
   WHERE p.codigo_pc = m.codigo_pc
     AND p.codigo_pc = ANY($1)
  RETURNING p.codigo_pc`;

const PROIBIDAS = ['baixada', 'data_baixa', 'parecer_tipo', 'parecer_ci', 'enviado_ci',
                   'dt_envio_ci', 'ci_situacao', 'ci_rodada', 'ci_encerrado_em',
                   'ci_encerrado_por', 'valor', 'processo_pc', 'analista_id'];

function lerCsv(arq) {
  const linhas = fs.readFileSync(arq, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  const cab = linhas[0].split(',');
  return linhas.slice(1).map(l => {
    const v = l.split(',');
    return Object.fromEntries(cab.map((k, i) => [k, v[i]]));
  });
}

// ── DEFEITO 4 CORRIGIDO: OS QUATRO SINAIS DA JANELA ──────────────────────────
//
// A versão anterior olhava DOIS (gente online + PC escrita). O `janela_livre.js` olha QUATRO.
// Uma analista registrando resposta de diligência escreve em `parcela_historico` e não toca
// em `prestacoes_contas`: o `janela_livre` diria OCUPADO e este script diria LIVRE.
//
// ⚠️ É a armadilha 17 ao contrário, e ela já custou uma recusa real em 12/08: se houver dois
// critérios de "pode gravar", eles têm de ser O MESMO.
const JANELA = '30 minutes';

const SINAIS = [
  { nome: 'online agora (fora superadmin)', sql: `
      SELECT COUNT(*)::int n, NULL::text ultima FROM usuarios
       WHERE ultimo_acesso >= NOW() - INTERVAL '${JANELA}'
         AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso)
         AND perfil <> 'superadmin'` },
  { nome: 'PCs escritas em 30 min', sql: `
      SELECT COUNT(*)::int n,
             to_char((MAX(atualizado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
        FROM prestacoes_contas WHERE atualizado_em >= NOW() - INTERVAL '${JANELA}'` },
  { nome: 'eventos de parcela em 30 min', sql: `
      SELECT COUNT(*)::int n,
             to_char((MAX(criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
        FROM parcela_historico WHERE criado_em >= NOW() - INTERVAL '${JANELA}'` },
  { nome: 'mensagens do C.I. em 30 min', sql: `
      SELECT COUNT(*)::int n,
             to_char((MAX(criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
        FROM ci_mensagem WHERE criado_em >= NOW() - INTERVAL '${JANELA}'` },
];

const ONLINE_DETALHE = `
  SELECT nome, perfil,
         to_char((ultimo_acesso AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') visto
    FROM usuarios
   WHERE ultimo_acesso >= NOW() - INTERVAL '${JANELA}'
     AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso)
     AND perfil <> 'superadmin'
   ORDER BY ultimo_acesso DESC`;

const p4 = (s, n = 4) => String(s).padStart(n);

(async () => {
  // ── 0. LINT DO PRÓPRIO SQL ─────────────────────────────────────────────────
  //
  // ⚠️ DEFEITO 2 CORRIGIDO — ISTO É LINT, NÃO GUARDA, E AGORA DIZ ISSO.
  //
  // A versão anterior rodava este regex sobre `SQL_RENUMERAR`, uma constante deste próprio
  // arquivo, e imprimia um `✓` como se tivesse conferido alguma coisa. Não pode disparar com
  // dado nenhum: só dispararia se alguém editasse a constante logo acima. Vale como trava de
  // edição — e é só isso que ele é.
  //
  // A GUARDA DE VERDADE é o item 7: comparação coluna a coluna contra o backup, depois de
  // escrever, dentro da transação, com ROLLBACK se qualquer uma das 13 divergir.
  const suja = PROIBIDAS.filter(col => new RegExp(`\\b${col}\\b`).test(SQL_RENUMERAR));
  if (suja.length) {
    console.error('ABORTADO: o UPDATE menciona coluna proibida: ' + suja.join(', '));
    process.exit(1);
  }
  console.log('── LINT DO UPDATE (nao e prova — ver item 7) ─────────');
  console.log('   o texto do UPDATE toca em: parcial_num, atualizado_em');
  console.log(`   e nao cita nenhuma das ${PROIBIDAS.length} colunas protegidas`);

  const cli = await pool.connect();
  try {
    // ── 1. A JANELA, com os QUATRO sinais ────────────────────────────────────
    console.log('\n── JANELA (mesmos 4 sinais do janela_livre.js) ───────');
    let ocupado = false;
    for (const s of SINAIS) {
      let r;
      // Falha aberta só para o C.I.: tabela que não existe não pode derrubar a foto — mesmo
      // tratamento que o `janela_livre.js` dá a ela.
      try { r = (await cli.query(s.sql)).rows[0]; }
      catch (e) { r = { n: 0, ultima: null, indisponivel: true }; }
      if (r.n > 0) ocupado = true;
      console.log(`   ${s.nome.padEnd(34)} ${p4(r.n)}` +
        `${r.ultima ? '   ultima ' + r.ultima : ''}${r.indisponivel ? '   (tabela indisponivel)' : ''}`);
    }
    const { rows: quem } = await cli.query(ONLINE_DETALHE);
    quem.forEach(u => console.log(`      · ${u.nome} (${u.perfil}) — visto ${u.visto}`));
    console.log('   >> ' + (ocupado ? 'OCUPADO' : 'LIVRE'));

    if (GRAVAR && ocupado && !FORCAR) {
      console.log('\n>> RECUSADO: ha gente trabalhando. Nada gravado.');
      console.log('   ⚠️ Os numeros trocam sob os pes de quem esta com a Minha Planilha aberta.');
      console.log('   Rode `node janela_livre.js` ate dar LIVRE, ou force com --forcar.');
      process.exitCode = 3;
      return;
    }

    // ⚠️ MEDIDO ANTES DE ESCREVER — e a armadilha 21 é o motivo.
    //
    // A primeira versão do item 7 exigia ZERO linha de histórico órfã e o dry-run REPROVOU o
    // lote. Só que o órfão já existia: `id=370, 2020TR000818, parcial 24, evento processo_pc,
    // 14/08` — nasceu de outra rodada, antes desta. Check absoluto sobre a base inteira acusa
    // o passado e esconde o presente. A pergunta certa é "ESTA rodada criou órfão?".
    const contarOrfaos = async () => (await cli.query(`
      SELECT COUNT(*)::int n FROM parcela_historico h
       WHERE h.parcial_num ~ '^[0-9]+$'
         AND NOT EXISTS (SELECT 1 FROM prestacoes_contas p
                          WHERE p.setorial_id = h.setorial_id AND p.tr = h.tr
                            AND p.parcial_num = h.parcial_num AND p.tipo <> 'final')`)).rows[0].n;
    const orfaosAntes = await contarOrfaos();

    // ⚠️ O 1..N: MEDIR E REPORTAR, NÃO BLOQUEAR (decisão do Richard, 16/08/2026).
    //
    // O antecessor `renumerar_parcial_num.js` media isso e o sucessor tinha perdido — o
    // revisor pegou. Não vira check porque a quebra **não é do lote**: o mapa da CGE atribui
    // números do SIGEF acima do total de parcelas que a base tem, ou seja, o furo já existe
    // na realidade e hoje está mascarado por uma numeração compactada. Bloquear seria
    // recusar o dado certo para preservar a aparência do errado.
    const SQL_NAO_FECHAM = `
      SELECT tr FROM prestacoes_contas
       WHERE setorial_id='FCEE' AND tipo <> 'final' AND parcial_num ~ '^[0-9]+$'
       GROUP BY tr HAVING MAX(parcial_num::int) <> COUNT(DISTINCT parcial_num)`;
    const contarNaoFecham = async () =>
      (await cli.query(`SELECT COUNT(*)::int n FROM (${SQL_NAO_FECHAM}) t`)).rows[0].n;
    const naoFechamAntes = await contarNaoFecham();

    if (!GRAVAR && ocupado)
      console.log('\n   ⚠️ O dry-run ESCREVE e faz ROLLBACK: ele segura lock nas linhas do lote\n' +
                  '      por alguns segundos, e ha gente na tela. E' + "' rapido, mas nao e' de graca.");

    await cli.query('BEGIN');

    // ── 2. O MAPA, numa tabela temporária ────────────────────────────────────
    const mapa = lerCsv(MAPA_CSV);
    await cli.query(`CREATE TEMP TABLE _mapa (codigo_pc text PRIMARY KEY, tr text,
                       parcial_sigef text, afetada text) ON COMMIT DROP`);
    for (let i = 0; i < mapa.length; i += 500) {
      const lote = mapa.slice(i, i + 500);
      await cli.query(
        `INSERT INTO _mapa VALUES ${lote.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4})`).join(',')}`,
        lote.flatMap(m => [m.codigo_pc, m.tr, m.parcial_sigef, m.tr_afetada]));
    }
    console.log(`\n── MAPA ──────────────────────────────────────────────`);
    console.log(`   linhas do CSV ......... ${mapa.length}`);

    const { rows: [conf] } = await cli.query(`
      SELECT COUNT(*)::int no_mapa, COUNT(p.codigo_pc)::int casaram,
             COUNT(*) FILTER (WHERE p.tr IS DISTINCT FROM m.tr)::int tr_divergente
        FROM _mapa m LEFT JOIN prestacoes_contas p ON p.codigo_pc = m.codigo_pc`);
    console.log(`   casaram no banco ...... ${conf.casaram} de ${conf.no_mapa}`);
    console.log(`   TR divergente ......... ${conf.tr_divergente}`);
    if (conf.casaram !== conf.no_mapa || conf.tr_divergente > 0) {
      await cli.query('ROLLBACK');
      console.error('\nABORTADO: o mapa nao casa 100% com o banco.');
      process.exitCode = 1; return;
    }

    // ── 3. O CANDIDATO BRUTO ─────────────────────────────────────────────────
    const { rows: bruto } = await cli.query(`
      SELECT p.codigo_pc, p.tr, p.parcial_num AS antes, m.parcial_sigef AS depois,
             p.analista_nome, p.processo_pc, p.baixada,
             p.parecer_tipo IS NOT NULL AS tem_parecer,
             p.ci_situacao IS NOT NULL AS no_ci
        FROM _mapa m JOIN prestacoes_contas p ON p.codigo_pc = m.codigo_pc
       WHERE p.parcial_num IS DISTINCT FROM m.parcial_sigef
         AND NOT (p.tr = ANY($1))
       ORDER BY p.tr, p.codigo_pc`, [FORA_DO_LOTE]);

    // ── 4. OS TRÊS RECORTES QUE O RICHARD MANDOU (16/08/2026) ────────────────
    //
    // ⚠️ Cada um vira LISTA EXPLÍCITA de `codigo_pc`, capturada aqui e impressa. A regra 12
    // vale para a exclusão também: excluir por condição derivada dentro do UPDATE esconderia
    // o que ficou de fora, e é justamente isso que se quer enxergar.
    const setBruto = new Set(bruto.map(r => r.codigo_pc));

    // 4a. As PCs do processo degenerado '-1' — entrariam numa parcela real.
    const foraMenos1 = bruto.filter(r => String(r.processo_pc).trim() === '-1').map(r => r.codigo_pc);

    // 4b. ⚠️ O RECORTE DAS "PARCELAS MISTAS" FOI REMOVIDO EM 16/08/2026 — ele era artefato.
    //
    // Ele projetava o estado futuro usando o candidato BRUTO (`setBruto`), incluindo as 45 PCs
    // do processo `-1` — que o recorte 4a exclui logo em seguida. Ou seja, perguntava "e se o
    // `-1` se movesse?", e ele não se move. Medido dos dois jeitos, por dois agentes cegos:
    //
    //     projetando o bruto inteiro (o que ele fazia) ... 19 PCs em 12 parcelas
    //     projetando só quem realmente entra ............. 0 PCs, 0 parcelas
    //
    // **Nenhuma parcela mista é criada por este lote.** Das 19, 17 já saíam pelo `-1`; as
    // outras 2 eram PCs BAIXADAS da `2022TR001707` sendo excluídas da correção sem motivo —
    // ficariam empilhadas na parcial 1 no meio de uma TR recém-renumerada, sem nada avisar.
    //
    // ⚠️ A conferência do item 7 continua exigindo `mistas criadas = 0`. É lá que a garantia
    // mora agora, e ela é medida DEPOIS de escrever, sobre o estado real.
    const foraMistas = [];
    const parcelasMistas = new Set();

    // 4c. A lista nominal — as 2 linhas (3 PCs) da Andressa na 2020TR000623.
    //
    // ⚠️ DUAS LEITURAS TÊM DE BATER: a lista explícita de `codigo_pc` e o que os DOIS
    // processos do CSV devolvem no banco agora. Se divergirem, a lista envelheceu (uma PC
    // mudou de processo pelo lápis, por exemplo) e o recorte deixou de recortar o que devia.
    const foraPcs = bruto.filter(r => FORA_PCS.includes(r.codigo_pc)).map(r => r.codigo_pc);
    const alvosProc = FORA_PCS_PROCESSOS.map(normProc);
    const { rows: porProcesso } = await cli.query(
      `SELECT codigo_pc, processo_pc FROM prestacoes_contas
        WHERE setorial_id='FCEE' AND tr = $1 AND tipo <> 'final'`, [FORA_PCS_TR]);
    const derivada = porProcesso.filter(r => alvosProc.includes(normProc(r.processo_pc)))
                                .map(r => r.codigo_pc).sort();
    // Com a lista vazia não há o que conferir — a conferência existe para a lista NÃO
    // envelhecer, e lista vazia não envelhece.
    const bate = FORA_PCS.length === 0 ||
                 (derivada.length === FORA_PCS.length &&
                  derivada.every((c, i) => c === [...FORA_PCS].sort()[i]));

    const excluir = new Set([...foraMenos1, ...foraMistas, ...foraPcs]);
    const alvo = bruto.filter(r => !excluir.has(r.codigo_pc));
    const codigos = alvo.map(r => r.codigo_pc);

    console.log('\n── OS RECORTES ───────────────────────────────────────');
    console.log(`   candidato bruto ....... ${bruto.length} PCs`);
    console.log(`   (-) processo '-1' ..... ${foraMenos1.length} PCs`);
    console.log(`   (-) parcelas mistas ... ${foraMistas.length} PCs em ${parcelasMistas.size} parcelas`);
    [...parcelasMistas].forEach(k => console.log(`         ${k}`));
    console.log(`   (-) Andressa ${FORA_PCS_TR} .. ${foraPcs.length} PCs  [${foraPcs.join(', ')}]`);
    console.log(`         2 linhas do CSV = ${FORA_PCS_PROCESSOS.join(' + ')}`);
    console.log(`         conferencia pelos processos: ${bate ? 'BATE' : 'DIVERGE'} (${derivada.join(', ')})`);
    console.log(`   (-) 15 TRs fora do lote (fusao, nao split)`);
    console.log(`   ======================= ${codigos.length} PCs entram`);
    if (!bate) {
      await cli.query('ROLLBACK');
      console.error(`\nABORTADO: a lista FORA_PCS nao bate com o que os processos do CSV devolvem hoje.`);
      console.error(`   lista: ${[...FORA_PCS].sort().join(', ')}`);
      console.error(`   banco: ${derivada.join(', ')}`);
      process.exitCode = 1; return;
    }

    if (!codigos.length) {
      await cli.query('ROLLBACK');
      console.log('\nNada a fazer.'); return;
    }

    const parciais = new Set(alvo.map(r => `${r.tr}|${r.antes}|${r.depois}`)).size;
    const trs = new Set(alvo.map(r => r.tr)).size;
    console.log('\n── O QUE MUDA ────────────────────────────────────────');
    console.log(`   PCs ................... ${codigos.length}`);
    console.log(`   parciais .............. ${parciais}`);
    console.log(`   TRs ................... ${trs}`);
    console.log(`   das quais baixadas .... ${alvo.filter(r => r.baixada).length}`);
    console.log(`   com parecer ........... ${alvo.filter(r => r.tem_parecer).length}`);
    console.log(`   no ciclo do C.I. ...... ${alvo.filter(r => r.no_ci).length}`);

    // ── 5. O HISTÓRICO, capturado ANTES do UPDATE das PCs ────────────────────
    //
    // ⚠️ `parcela_historico` guarda (tr, parcial_num) em TEXTO, não `codigo_pc`. Renumerar
    // sem mexer aqui deixa a linha apontando para um número que passou a ser de OUTRA
    // parcela — 61 parciais ficariam com o histórico de PCs alheias, e as diligências
    // voltariam a ser cobradas pelo sino no lugar errado.
    //
    // ⚠️ LIDO ANTES, e aplicado por LISTA DE IDs (regra 12). Depois do UPDATE o
    // `h.parcial_num` já não casa, e um UPDATE em cascata (3→4, 4→5) moveria a mesma linha
    // duas vezes. Só entra linha cujo (tr, parcial_num) resolve para UM único número novo.
    // ⚠️ O `HAVING COUNT(DISTINCT ...) = 1` DE ANTES ERA FALSO, e o revisor mediu o estrago.
    //
    // Ele tinha `WHERE p.codigo_pc = ANY($1)` — o filtro do LOTE — ANTES do agregado. O
    // `COUNT(DISTINCT)` contava só os destinos das PCs que SAEM; as que FICAM (as já certas,
    // as 45 do `-1`, as excluídas) eram invisíveis. Uma parcela em que 1 PC sai e 2 ficam
    // contava "1 destino" e passava. Medido: 69 parcelas se partem, 6 linhas de histórico
    // caem nelas, 2 eram movidas erradas e 4 ficavam paradas — e os 6 checks aprovavam.
    //
    // Agora o destino é calculado sobre a PARCELA INTEIRA: cada PC leva `parcial_sigef` se
    // está no lote, e o próprio `parcial_num` se não está.
    //
    // ⚠️ E A LINHA É DUPLICADA POR DESTINO — decisão do Richard, 16/08/2026.
    //
    // Não existe "a PC que originou a linha": `parcela_historico` não guarda PC (11 colunas,
    // nenhuma identifica a PC; 0 de 743 citam um `codigo_pc` no texto). E a evidência mostra
    // que o evento cobriu a parcela inteira — nas 6 linhas, todas as PCs têm o MESMO
    // `processo_pc`, o mesmo `parecer_tipo`, a mesma `data_baixa` e o mesmo `dt_envio_ci`.
    // Logo, seguir a PC significa **seguir todas**: uma cópia por destino.
    const { rows: histBruto } = await cli.query(`
      WITH proj AS (
        SELECT p.tr, p.setorial_id, p.parcial_num AS num_antigo,
               CASE WHEN p.codigo_pc = ANY($1) THEN m.parcial_sigef ELSE p.parcial_num END AS destino
          FROM prestacoes_contas p
          LEFT JOIN _mapa m ON m.codigo_pc = p.codigo_pc
         WHERE p.setorial_id = 'FCEE' AND p.tipo <> 'final'
      ),
      dest AS (
        SELECT tr, setorial_id, num_antigo, ARRAY_AGG(DISTINCT destino) AS destinos
          FROM proj GROUP BY tr, setorial_id, num_antigo
      )
      SELECT h.id, h.tr, h.parcial_num AS antes, d.destinos, h.evento,
             h.setorial_id, h.valor_anterior, h.valor_novo, h.analista_id,
             h.observacao, h.criado_em, h.executado_por
        FROM parcela_historico h
        JOIN dest d ON d.tr = h.tr AND d.setorial_id = h.setorial_id
                   AND d.num_antigo = h.parcial_num
       ORDER BY h.tr, h.id`, [codigos]);

    // Só interessa quem realmente muda de lugar.
    const hist = histBruto.filter(h => !(h.destinos.length === 1 && h.destinos[0] === h.antes));
    const simples = hist.filter(h => h.destinos.length === 1);
    const partidas = hist.filter(h => h.destinos.length > 1);
    const copiasPrevistas = partidas.reduce((n, h) => n + h.destinos.length - 1, 0);

    console.log(`   parcela_historico — linhas que mudam de lugar: ${hist.length}`);
    console.log(`      movidas (1 destino) .................... ${simples.length}`);
    console.log(`      em parcela que se PARTE ................ ${partidas.length}` +
                ` → viram ${partidas.length + copiasPrevistas} linhas (+${copiasPrevistas} copias)`);
    partidas.forEach(h => console.log(
      `         id=${p4(h.id)} ${h.tr} p${h.antes} ${h.evento} -> ${h.destinos.join(', ')}`));
    simples.slice(0, 6).forEach(h =>
      console.log(`         id=${p4(h.id)} ${h.tr}  ${h.antes} -> ${h.destinos[0]}`));
    if (simples.length > 6) console.log(`         ... e mais ${simples.length - 6} movidas`);

    // ── 6. A ESCRITA — sempre acontece; o COMMIT é que depende do --gravar ───
    //
    // ⚠️ O dry-run TAMBÉM escreve e confere, e só então faz ROLLBACK. A versão anterior
    // pulava a escrita inteira sem `--gravar`: o dry-run não provava nada, e a primeira vez
    // que a conferência rodasse seria com o COMMIT engatilhado.
    await cli.query(`CREATE TABLE ${BACKUP} AS
      SELECT id, codigo_pc, tr, parcial_num, ${PROIBIDAS.join(', ')}
        FROM prestacoes_contas`);
    await cli.query(`CREATE TABLE ${BACKUP_HIST} AS SELECT * FROM parcela_historico`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`);
    console.log(`\n>> BACKUP ${BACKUP}: ${bk.n} linhas, ${PROIBIDAS.length + 4} colunas`);

    const { rows: feitas } = await cli.query(SQL_RENUMERAR, [codigos]);
    console.log(`>> RENUMERADAS: ${feitas.length} PCs`);
    if (feitas.length !== codigos.length) {
      await cli.query('ROLLBACK');
      console.error(`ABORTADO: esperava ${codigos.length}, o UPDATE pegou ${feitas.length}.`);
      process.exitCode = 1; return;
    }

    // ── o histórico: move o original, e DUPLICA quando a parcela se parte ────
    //
    // ⚠️ Aplicado por LISTA DE IDs (regra 12). O original vai para `destinos[0]`; cada destino
    // a mais ganha uma CÓPIA, com a nota na observação dizendo de onde veio e por quê — sem a
    // nota, quem abrir a linha solta veria o mesmo parecer em duas parcelas sem explicação.
    const histIds = hist.map(r => r.id);
    let movidas = { rowCount: 0 };
    if (histIds.length) {
      movidas = await cli.query(`
        UPDATE parcela_historico h
           SET parcial_num = m.novo
          FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS novo) m
         WHERE h.id = m.id AND h.id = ANY($1::int[])`,
        [histIds, hist.map(r => r.destinos[0])]);
    }

    let copias = 0;
    for (const h of partidas) {
      for (const destino of h.destinos.slice(1)) {
        const nota = `[renumeracao SIGEF 16/08/2026] a parcela ${h.antes} desta TR virou ` +
          `${h.destinos.join(' e ')}; esta linha e copia do evento original (id ${h.id}), ` +
          `que valia para todas as PCs da parcela.`;
        await cli.query(
          `INSERT INTO parcela_historico
             (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo,
              analista_id, observacao, criado_em, executado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [h.tr, destino, h.setorial_id, h.evento, h.valor_anterior, h.valor_novo,
           h.analista_id, (h.observacao ? h.observacao + ' · ' : '') + nota,
           h.criado_em, h.executado_por]);
        copias++;
      }
    }

    console.log(`>> HISTORICO: ${movidas.rowCount} movidas · ${copias} copias inseridas`);
    if (movidas.rowCount !== histIds.length || copias !== copiasPrevistas) {
      await cli.query('ROLLBACK');
      console.error(`ABORTADO: esperava ${histIds.length} movidas e ${copiasPrevistas} copias, ` +
                    `peguei ${movidas.rowCount} e ${copias}.`);
      process.exitCode = 1; return;
    }

    // ── 7. A CONFERÊNCIA DE VERDADE — as 13 colunas, dentro da transação ─────
    //
    // ⚠️ DEFEITO 3 CORRIGIDO. A versão anterior comparava UMA coluna (`baixada`) de 13,
    // porque o backup dela só guardava 7. Provava quase nada e dizia "conferência ✓".
    const divergentes = [];
    for (const col of PROIBIDAS) {
      const { rows: [d] } = await cli.query(
        `SELECT COUNT(*)::int n FROM ${BACKUP} b
           JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
          WHERE b.${col} IS DISTINCT FROM p.${col}`);
      if (d.n > 0) divergentes.push(`${col}=${d.n}`);
    }

    // e o histórico: nada além de `parcial_num`, e nenhuma linha fora da lista
    const { rows: [h1] } = await cli.query(`
      SELECT COUNT(*)::int n FROM parcela_historico h JOIN ${BACKUP_HIST} b ON b.id = h.id
       WHERE (h.tr, h.setorial_id, h.evento, h.valor_anterior, h.valor_novo, h.analista_id,
              h.criado_em) IS DISTINCT FROM
             (b.tr, b.setorial_id, b.evento, b.valor_anterior, b.valor_novo, b.analista_id,
              b.criado_em)`);
    const { rows: [h2] } = await cli.query(`
      SELECT COUNT(*)::int n FROM parcela_historico h JOIN ${BACKUP_HIST} b ON b.id = h.id
       WHERE h.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (h.id = ANY($1::int[]))`,
      [histIds.length ? histIds : [-1]]);
    // nenhuma linha de histórico pode ficar apontando para parcela que não existe —
    // POR CAUSA DESTA RODADA. O órfão pré-existente (id 370) não é dela e não a reprova.
    const orfaosDepois = await contarOrfaos();
    // e nenhuma PC fora da lista pode ter mudado de número
    const { rows: [p1] } = await cli.query(`
      SELECT COUNT(*)::int n FROM ${BACKUP} b JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
       WHERE p.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (p.codigo_pc = ANY($1))`,
      [codigos]);
    // as parcelas mistas que o recorte existe para evitar: têm de continuar em zero
    const { rows: [p2] } = await cli.query(`
      SELECT COUNT(*)::int n FROM (
        SELECT tr, parcial_num FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND tipo <> 'final'
         GROUP BY 1,2
        HAVING COUNT(*) FILTER (WHERE baixada) > 0 AND COUNT(*) FILTER (WHERE NOT baixada) > 0) t`);

    // nenhuma linha de histórico pode ter SUMIDO, e só podem ter entrado as cópias previstas
    const { rows: [h4] } = await cli.query(`SELECT COUNT(*)::int n FROM parcela_historico`);
    const { rows: [h5] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BACKUP_HIST}`);
    // e toda cópia tem de apontar para uma parcela que EXISTE
    const { rows: [h6] } = await cli.query(`
      SELECT COUNT(*)::int n FROM parcela_historico h
       WHERE h.id NOT IN (SELECT id FROM ${BACKUP_HIST})
         AND NOT EXISTS (SELECT 1 FROM prestacoes_contas p
                          WHERE p.setorial_id = h.setorial_id AND p.tr = h.tr
                            AND p.parcial_num = h.parcial_num AND p.tipo <> 'final')`);

    const checks = [
      ['as 13 colunas protegidas intactas', divergentes.length === 0, divergentes.join(' ') || '0'],
      ['PC fora da lista renumerada',       p1.n === 0, p1.n],
      ['parcelas mistas criadas',           p2.n === 0, p2.n],
      ['historico: campo alem de parcial_num', h1.n === 0, h1.n],
      ['historico fora da lista alterado',  h2.n === 0, h2.n],
      ['historico orfao NAO aumentou',      orfaosDepois <= orfaosAntes, `${orfaosAntes} -> ${orfaosDepois}`],
      ['historico: nenhuma linha sumiu',    h4.n === h5.n + copias, `${h5.n} + ${copias} = ${h4.n}`],
      ['toda copia aponta para parcela que existe', h6.n === 0, h6.n],
    ];
    console.log('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      console.log(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(44)} ${v}`); }

    // ── O 1..N: a lista inteira, com o número que falta em cada TR ───────────
    const naoFechamDepois = await contarNaoFecham();
    console.log(`   MEDIDO  ${'TRs que NAO fecham 1..N'.padEnd(44)} ${naoFechamAntes} -> ${naoFechamDepois}`);
    const { rows: buracos } = await cli.query(`
      WITH t AS (${SQL_NAO_FECHAM}),
      g AS (SELECT p.tr, generate_series(1, MAX(p.parcial_num::int)) v
              FROM prestacoes_contas p JOIN t ON t.tr = p.tr
             WHERE p.setorial_id='FCEE' AND p.tipo <> 'final' AND p.parcial_num ~ '^[0-9]+$'
             GROUP BY p.tr)
      SELECT g.tr, MAX(p2.analista_nome) analista, COUNT(*)::int faltam,
             string_agg(g.v::text, ',' ORDER BY g.v) numeros
        FROM g LEFT JOIN prestacoes_contas p2
          ON p2.tr = g.tr AND p2.parcial_num = g.v::text AND p2.tipo <> 'final'
       WHERE p2.codigo_pc IS NULL
       GROUP BY g.tr ORDER BY 3 DESC, 1`);
    console.log(`\n── AS ${buracos.length} TRs COM BURACO NO 1..N (medido, nao bloqueia) ──`);
    buracos.forEach(b => console.log(
      `   ${b.tr}  ${String(b.analista || '(sem analista)').padEnd(20)} faltam ${p4(b.faltam, 2)}: ${b.numeros}`));
    const so2024um = buracos.filter(b => /^2024TR/.test(b.tr) && b.numeros === '1').length;
    console.log(`   >> ${so2024um} delas sao TRs de 2024 sem analista faltando SO o numero 1 —`);
    console.log(`      o SIGEF tem uma parcela 1 que a base nao tem. Mesma familia da armadilha 16.`);

    // ── 8. AS TRÊS TRs, ANTES E DEPOIS — lidas JÁ RENUMERADAS ───────────────
    const { rows: amostra } = await cli.query(`
      SELECT DISTINCT ON (p.analista_nome) p.tr, p.analista_nome, COUNT(*) OVER (PARTITION BY p.tr) n
        FROM prestacoes_contas p
       WHERE p.codigo_pc = ANY($1) AND p.analista_nome IS NOT NULL
       ORDER BY p.analista_nome, n DESC`, [codigos]);
    const tresTr = amostra.sort((a, b) => b.n - a.n).slice(0, 3);

    for (const t of tresTr) {
      const { rows: linhas } = await cli.query(`
        SELECT b.parcial_num antes, p.parcial_num depois, p.processo_pc,
               COUNT(*)::int pcs, SUM(p.valor)::numeric(14,2) valor, BOOL_OR(p.baixada) baixada
          FROM ${BACKUP} b JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
         WHERE p.tr = $1 AND p.tipo <> 'final'
         GROUP BY 1,2,3
         ORDER BY NULLIF(regexp_replace(b.parcial_num,'[^0-9]','','g'),'')::int NULLS LAST`, [t.tr]);
      console.log(`\n── ${t.tr} · ${t.analista_nome} ─────────────────────────`);
      linhas.forEach(l => {
        const marca = l.antes === l.depois ? '   ' : ' -> ';
        console.log(`   ${p4(l.antes)}${marca}${String(l.depois).padEnd(4)} ` +
          `${String(l.processo_pc).padEnd(22)} ${p4(l.pcs, 2)} PC  ` +
          `${String(l.valor).padStart(12)}${l.baixada ? '  [baixada]' : ''}`);
      });
    }

    // ── 9. COMMIT ou ROLLBACK ────────────────────────────────────────────────
    if (falhou) {
      await cli.query('ROLLBACK');
      console.log('\n>> CONFERENCIA FALHOU: ROLLBACK. Nada gravado.');
      process.exitCode = 2;
    } else if (GRAVAR) {
      await cli.query('COMMIT');
      console.log('\n>> COMMIT. Gravado.');
      console.log(`   Para reverter:  UPDATE prestacoes_contas p SET parcial_num = b.parcial_num`);
      console.log(`                     FROM ${BACKUP} b WHERE p.codigo_pc = b.codigo_pc;`);
      console.log(`                   UPDATE parcela_historico h SET parcial_num = b.parcial_num`);
      console.log(`                     FROM ${BACKUP_HIST} b WHERE h.id = b.id;`);
    } else {
      await cli.query('ROLLBACK');
      console.log('\n>> DRY-RUN: ROLLBACK. Nada gravado — e os backups foram descartados junto.');
      console.log('   A escrita e a conferencia ACONTECERAM: e por isso que os numeros acima valem.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
