// CAMINHO: sigpc-api/executar_16_08.js
//
// A GRAVAÇÃO DE 16/08/2026 — todas as frentes numa transação só.
// PADRÃO = DRY-RUN. Só grava com `--gravar`.
//
// Autorizado pelo Richard em 16/08/2026, com as decisões dele:
//   · as PCs de `processo_pc = '-1'` ENTRAM no lote e recebem o número do SIGEF
//   · PC sem dono no histórico: mantém como está
//   · as fusões legítimas (2022TR000791 / 2022TR000967) entram
//   · histórico de parcela que se parte: duplica por destino, com nota
//   · Andressa 2020TR000623: entra pela CGE
//
// FRENTES:
//   1. renumeração das parciais pelo mapa da CGE
//   2. as 336 PCs ausentes, atribuídas ao analista do CSV
//   3. as PCs do Controle Interno
//   4. as linhas de histórico com `analista_id` vazio
//
// ⚠️ NÃO TOCA em `baixada`, `data_baixa`, `parecer_tipo`, `parecer_ci`, `valor`, nem no
// `analista_id` de PC que já tem dono. Conferido coluna a coluna DEPOIS de escrever.
//
// USO:
//   node executar_16_08.js                 dry-run: escreve, confere e faz ROLLBACK
//   node executar_16_08.js --gravar        idem, com COMMIT — liga e desliga a manutenção
//   node executar_16_08.js --gravar --forcar   ignora a trava de janela

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const FORCAR = process.argv.includes('--forcar');
const D = __dirname + '/';

const BK_PC   = '_backup_exec_pc_20260816';
const BK_HIST = '_backup_exec_hist_20260816';

// ⚠️ As 15 TRs fora do lote — direção contrária do split (uma parcela com vários processos).
// O split entrou; a fusão não foi decidida. Lista explícita (regra 12).
const FORA_DO_LOTE = [
  '2022TR000941', '2020TR000823', '2020TR000830', '2022TR001248', '2020TR000683',
  '2020TR000699', '2020TR000648', '2020TR000665', '2020TR000704', '2020TR000761',
  '2020TR000766', '2020TR000793', '2020TR000816', '2021TR002375', '2022TR000927',
];

// ⚠️ O prefixo `9` marca a PC como NOSSA, não do SIGEF. A faixa 900000+ está livre em todos
// os anos (o maior número real do acervo é 4.137). Sem isso, daqui a seis meses alguém
// procura o código no SIGEF, não acha, e conclui que o sistema está errado.
const FAIXA_INVENTADA = 900000;

// ⚠️ `dt_envio_ci` NÃO entra aqui: é o que a frente 3 grava, de propósito. Ele tem check
// próprio, que confere se mudou SÓ nas PCs do C.I. — proteção estreita e exata, em vez de
// larga e falsa. Pôr a coluna na lista faria a conferência acusar o trabalho da própria rodada.
const PROTEGIDAS = ['baixada', 'data_baixa', 'parecer_tipo', 'parecer_ci', 'valor',
                    'ci_encerrado_em', 'ci_encerrado_por'];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const p4 = (s, n = 4) => String(s).padStart(n);
const nl = (t) => console.log(t);

// ── leitura de CSV com campo entre aspas ────────────────────────────────────
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

// "R$ 14.210,32" -> 14210.32
function moeda(t) {
  const s = String(t || '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (!s) return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const cli = await pool.connect();
  let manutencaoLigada = false;

  // ⚠️ ARMADILHA 23 — O `kill` QUE NÃO PEGA, E AS 53 PESSOAS TRANCADAS FORA.
  //
  // A manutenção liga num COMMIT próprio (tem de ser: dentro da transação grande ninguém
  // cairia). Se o processo morrer entre esse commit e o `finally` — Ctrl+C, queda de rede
  // com o Railway, `kill` —, a transação grande cai sozinha e o dado fica íntegro, mas
  // `modo_manutencao = true` fica commitado e **a equipe não entra mais**.
  //
  // Estes dois handlers desligam antes de sair. Não são infalíveis (um `SIGKILL` não avisa
  // ninguém), e por isso a mensagem diz onde desligar pela tela.
  const sairLimpo = async (sinal) => {
    console.error(`\n🔴 ${sinal} recebido.`);
    if (manutencaoLigada) {
      try {
        await pool.query(`UPDATE config_sistema SET modo_manutencao = false,
                            mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        console.error('   >> manutencao DESLIGADA. Equipe liberada.');
      } catch (e) {
        console.error('   🔴 NAO CONSEGUI DESLIGAR: ' + e.message);
        console.error('   >> DESLIGUE PELA TELA: Configurações -> Modo manutenção.');
      }
    }
    process.exit(130);
  };
  process.on('SIGINT',  () => { sairLimpo('SIGINT (Ctrl+C)'); });
  process.on('SIGTERM', () => { sairLimpo('SIGTERM'); });

  try {
    // ══ JANELA — os 4 sinais do janela_livre.js ═══════════════════════════════
    nl('── JANELA (4 sinais) ─────────────────────────────────────');
    const sinais = [
      ['online (fora superadmin)', `SELECT COUNT(*)::int n FROM usuarios
         WHERE ultimo_acesso >= NOW() - INTERVAL '30 minutes'
           AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso) AND perfil <> 'superadmin'`],
      ['PCs escritas em 30 min', `SELECT COUNT(*)::int n FROM prestacoes_contas
         WHERE atualizado_em >= NOW() - INTERVAL '30 minutes'`],
      ['eventos de parcela em 30 min', `SELECT COUNT(*)::int n FROM parcela_historico
         WHERE criado_em >= NOW() - INTERVAL '30 minutes'`],
      ['mensagens do C.I. em 30 min', `SELECT COUNT(*)::int n FROM ci_mensagem
         WHERE criado_em >= NOW() - INTERVAL '30 minutes'`],
    ];
    // ⚠️ SINAL QUE NÃO PODE SER LIDO NÃO É SINAL LIMPO. A primeira versão fazia
    // `catch { n = 0 }` — um SELECT que falhasse virava "tudo tranquilo". Só a `ci_mensagem`
    // pode faltar (falha aberta, como no `janela_livre.js`); qualquer outra erra alto.
    let ocupado = false;
    for (const [nome, sql] of sinais) {
      let n;
      try { n = (await cli.query(sql)).rows[0].n; }
      catch (e) {
        if (!/ci_mensagem/.test(sql)) throw new Error(`sinal de janela ilegivel (${nome}): ${e.message}`);
        n = 0; nl(`   ${nome.padEnd(32)}   —  (tabela indisponivel)`); continue;
      }
      if (n > 0) ocupado = true;
      nl(`   ${nome.padEnd(32)} ${p4(n)}`);
    }
    nl('   >> ' + (ocupado ? 'OCUPADO' : 'LIVRE'));

    // ⚠️ A TRAVA MEDE DEPOIS DA MANUTENÇÃO, NÃO ANTES — e é por isso que ela existe.
    //
    // Medir antes e recusar tornaria a gravação impossível: a janela está ocupada o dia
    // inteiro, e é exatamente para isso que o modo manutenção foi feito (derruba todos e
    // ABRE a janela). Recusar aqui seria a armadilha 17 ao contrário — dois critérios de
    // "pode gravar" que não são o mesmo.
    //
    // Os três sinais históricos (30 min para trás) NÃO travam depois da manutenção: com a
    // sessão de todo mundo encerrada, ninguém está no meio de uma ação. O que trava é
    // **gente ONLINE depois de derrubada**, que significaria que a manutenção não pegou.
    const contarOnline = async () => (await cli.query(sinais[0][1])).rows[0].n;

    // ══ MODO MANUTENÇÃO — transação PRÓPRIA, senão ninguém cai ════════════════
    //
    // ⚠️ Tem de ser COMMIT separado e ANTES da escrita: dentro da transação grande, o
    // `sessao_fim` só valeria depois do commit — isto é, quando já não adianta.
    if (GRAVAR) {
      nl('\n── MODO MANUTENÇÃO ───────────────────────────────────────');
      await cli.query('BEGIN');
      // ⚠️ `mensagem_manutencao`, NÃO `mensagem`. São duas colunas: `mensagem` é a da
      // PREPARAÇÃO (`lib/preparacao.js`) e guarda hoje o texto de boas-vindas que o Richard
      // gravou em 13/08. Escrever nela não avisaria ninguém (o `lib/manutencao.js` lê a
      // outra) e apagaria o texto dele — que não está em backup nenhum, porque os dois
      // cobrem `prestacoes_contas` e `parcela_historico`.
      await cli.query(`UPDATE config_sistema SET modo_manutencao = true,
                         mensagem_manutencao = 'Gravação da renumeração — 16/08/2026. Volta em minutos.',
                         atualizado_em = NOW() WHERE id = 1`);
      // ⚠️ clock_timestamp(), não NOW(): dentro da transação o NOW() é o instante em que ela
      // começou, e os dois carimbos sairiam iguais (ver CLAUDE.md).
      const { rowCount: derrubados } = await cli.query(
        `UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'`);
      await cli.query('COMMIT');
      manutencaoLigada = true;
      nl(`   >> LIGADO. ${derrubados} sessões encerradas.`);

      // AGORA a trava vale: se ainda houver gente online, a manutenção não pegou.
      const aindaOnline = await contarOnline();
      nl(`   online depois de derrubar: ${aindaOnline}`);
      if (aindaOnline > 0 && !FORCAR) {
        throw new Error(`${aindaOnline} pessoas continuam online depois da manutencao. ` +
          `A manutencao nao pegou — nao gravo. Use --forcar se souber por que.`);
      }
    } else if (ocupado) {
      // ⚠️ O dry-run TAMBÉM escreve (e faz ROLLBACK). Ele segura trava em ~4.100 linhas, e o
      // `lock_timeout` protege ESTE script, não o analista: quem esbarrar espera até o
      // ROLLBACK. Com gente na tela, isso não é de graça.
      nl('   ⚠️ dry-run com a janela ocupada: vai segurar lock em ~4.100 linhas por alguns segundos.');
    }

    // ══════════════════════════════════════════════════════════════════════════
    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);

    // ── BACKUP ────────────────────────────────────────────────────────────────
    // Foto do INÍCIO DESTA RODADA (armadilha 21), dentro da transação: no dry-run o ROLLBACK
    // a descarta junto. `CREATE TABLE` sem DROP — colidir aborta em vez de sobrescrever.
    await cli.query(`CREATE TABLE ${BK_PC} AS SELECT * FROM prestacoes_contas`);
    await cli.query(`CREATE TABLE ${BK_HIST} AS SELECT * FROM parcela_historico`);
    const { rows: [bk] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK_PC}`);
    const { rows: [bkh] } = await cli.query(`SELECT COUNT(*)::int n FROM ${BK_HIST}`);
    nl(`\n── BACKUP ────────────────────────────────────────────────`);
    nl(`   ${BK_PC}: ${bk.n} linhas (tabela inteira)`);
    nl(`   ${BK_HIST}: ${bkh.n} linhas`);

    // ══ FRENTE 1 — RENUMERAÇÃO ════════════════════════════════════════════════
    nl('\n══ FRENTE 1 — RENUMERAÇÃO ════════════════════════════════');
    const mapa = lerCsv(D + 'MAPA_PARCIAL_SIGEF.csv');
    await cli.query(`CREATE TEMP TABLE _mapa (codigo_pc text PRIMARY KEY, parcial_sigef text)
                     ON COMMIT DROP`);
    for (let i = 0; i < mapa.length; i += 500) {
      const lote = mapa.slice(i, i + 500);
      await cli.query(
        `INSERT INTO _mapa VALUES ${lote.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',')}`,
        lote.flatMap(m => [m.codigo_pc, m.parcial_sigef]));
    }
    const { rows: [cf] } = await cli.query(`
      SELECT COUNT(*)::int no_mapa, COUNT(p.codigo_pc)::int casaram
        FROM _mapa m LEFT JOIN prestacoes_contas p ON p.codigo_pc = m.codigo_pc`);
    if (cf.casaram !== cf.no_mapa) throw new Error(`mapa nao casa: ${cf.casaram}/${cf.no_mapa}`);
    nl(`   mapa: ${cf.casaram} de ${cf.no_mapa} casaram`);

    // ⚠️ O `-1` ENTRA (decisão do Richard). Só as 15 TRs continuam fora.
    const { rows: alvo } = await cli.query(`
      SELECT p.codigo_pc, p.tr, p.parcial_num AS antes, m.parcial_sigef AS depois, p.baixada
        FROM _mapa m JOIN prestacoes_contas p ON p.codigo_pc = m.codigo_pc
       WHERE p.parcial_num IS DISTINCT FROM m.parcial_sigef AND NOT (p.tr = ANY($1))
       ORDER BY p.tr, p.codigo_pc`, [FORA_DO_LOTE]);
    const codigos = alvo.map(r => r.codigo_pc);
    nl(`   PCs a renumerar ....... ${codigos.length}`);
    nl(`   parciais .............. ${new Set(alvo.map(r => `${r.tr}|${r.antes}|${r.depois}`)).size}`);
    nl(`   TRs ................... ${new Set(alvo.map(r => r.tr)).size}`);
    nl(`   das quais baixadas .... ${alvo.filter(r => r.baixada).length}`);

    // ── o histórico, capturado ANTES do UPDATE, com o destino da PARCELA INTEIRA
    const { rows: histBruto } = await cli.query(`
      WITH proj AS (
        SELECT p.tr, p.setorial_id, p.parcial_num AS num_antigo,
               CASE WHEN p.codigo_pc = ANY($1) THEN m.parcial_sigef ELSE p.parcial_num END AS destino
          FROM prestacoes_contas p LEFT JOIN _mapa m ON m.codigo_pc = p.codigo_pc
         WHERE p.setorial_id = 'FCEE' AND p.tipo <> 'final'),
      dest AS (SELECT tr, setorial_id, num_antigo,
                      ARRAY_AGG(DISTINCT destino ORDER BY destino) AS destinos
                 FROM proj GROUP BY tr, setorial_id, num_antigo)
      SELECT h.id, h.tr, h.parcial_num AS antes, d.destinos, h.evento, h.setorial_id,
             h.valor_anterior, h.valor_novo, h.analista_id, h.observacao, h.criado_em,
             h.executado_por
        FROM parcela_historico h
        JOIN dest d ON d.tr = h.tr AND d.setorial_id = h.setorial_id AND d.num_antigo = h.parcial_num
       ORDER BY h.tr, h.id`, [codigos]);
    const hist = histBruto.filter(h => !(h.destinos.length === 1 && h.destinos[0] === h.antes));
    const partidas = hist.filter(h => h.destinos.length > 1);
    const copiasPrev = partidas.reduce((n, h) => n + h.destinos.length - 1, 0);
    nl(`   historico: ${hist.length} mudam de lugar (${partidas.length} partidas -> +${copiasPrev} copias)`);

    const { rowCount: renum } = await cli.query(
      `UPDATE prestacoes_contas p SET parcial_num = m.parcial_sigef, atualizado_em = NOW()
         FROM _mapa m WHERE p.codigo_pc = m.codigo_pc AND p.codigo_pc = ANY($1)`, [codigos]);
    if (renum !== codigos.length) throw new Error(`renumeracao: esperava ${codigos.length}, peguei ${renum}`);

    const histIds = hist.map(h => h.id);
    let movidas = 0;
    if (histIds.length) {
      const r = await cli.query(
        `UPDATE parcela_historico h SET parcial_num = m.novo
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS novo) m
          WHERE h.id = m.id AND h.id = ANY($1::int[])`,
        [histIds, hist.map(h => h.destinos[0])]);
      movidas = r.rowCount;
    }
    const idsCopias = [];
    for (const h of partidas) {
      for (const destino of h.destinos.slice(1)) {
        const nota = `[renumeracao SIGEF 16/08/2026] a parcela ${h.antes} desta TR virou ` +
          `${h.destinos.join(' e ')}; esta linha e copia do evento original (id ${h.id}), ` +
          `que valia para todas as PCs da parcela.`;
        const { rows: [ins] } = await cli.query(
          `INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
             valor_novo, analista_id, observacao, criado_em, executado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [h.tr, destino, h.setorial_id, h.evento, h.valor_anterior, h.valor_novo,
           h.analista_id, (h.observacao ? h.observacao + ' · ' : '') + nota,
           h.criado_em, h.executado_por]);
        idsCopias.push(ins.id);
      }
    }
    nl(`   >> ${renum} PCs renumeradas · ${movidas} linhas movidas · ${idsCopias.length} copias`);
    // ⚠️ ASSERT EM TODO UPDATE, não só nos que eu lembrei. `movidas` era impresso e seguia:
    // um UPDATE que pegasse menos linhas que o previsto commitava em silêncio.
    if (idsCopias.length !== copiasPrev) throw new Error('copias divergem do previsto');
    if (movidas !== histIds.length)
      throw new Error(`historico movido: esperava ${histIds.length}, peguei ${movidas}`);

    // ══ FRENTE 2 — DESATIVADA EM 16/08/2026 ═══════════════════════════════════
    //
    // 🔴 O CSV `PCS_AUSENTES_PARA_INCLUIR.csv` ESTÁ CORROMPIDO EM TRÊS EIXOS INDEPENDENTES.
    // Medido pelo revisor e pelo qa-banco, cada um por seu lado:
    //
    //   1. VALOR 100× MAIOR EM 107 DAS 324 — R$ 890.163.228,24 a mais. O CSV mistura formato
    //      brasileiro entre aspas ("R$ 14.210,32") com americano sem aspas (68549.21), e o
    //      `moeda()` apaga o ponto decimal do segundo. Criaria uma PC de R$ 231.414.433
    //      (o certo é R$ 2.314.144,33); a maior do acervo hoje vale R$ 23,9 mi.
    //
    //   2. COLUNA DESLOCADA — 61 linhas têm `parcial` vazio, e o número aparece grudado no
    //      processo ("SCC 18792/2023 51"). Entrariam com `parcial_num = ''`, que o
    //      `faltaChave` recusa: parecer, situação, C.I. e estorno dariam 400, e os botões
    //      sumiriam da tela. Na 2020TR000704 são 7 numa parcela só.
    //
    //   3. FINAIS MISTURADAS COM PARCIAIS — 6 linhas com `parcial` = FINAL/Final entrariam
    //      como `tipo='parcial'` na chave da PFINAL existente. Uma é duplicata exata da
    //      `2021TR002233-PFINAL`: R$ 100.000 em dobro.
    //
    // ⚠️ E HAVIA UM QUARTO, PIOR QUE OS TRÊS: 208 das 324 caem numa parcela que já existe,
    // e 83 dessas estão 100% BAIXADAS. Inserir uma PC não baixada ali **desarma o
    // `if (jaBaixadas.length === pcs.length)` de `server.js`** — o 409 "Parcial já baixada"
    // deixa de disparar, e o próximo parecer reescreve `data_baixa`, `origem_baixa` e
    // `parecer_tipo` de ~200 PCs fechadas em junho. Sem trilha, e ninguém reclama de uma
    // baixa que ficou mais recente.
    //
    // NÃO É AJUSTE DE SCRIPT — É A FONTE QUE PRECISA SER REFEITA. Quando o CSV vier limpo,
    // religar é tirar este `if (false)` e rodar o dry-run de novo.
    const FRENTE_2_LIBERADA = false;
    nl('\n══ FRENTE 2 — DESATIVADA ═════════════════════════════════');
    nl('   o CSV esta corrompido: valor 100x em 107, coluna deslocada em 61, 6 FINAIS.');
    nl('   e 83 parcelas 100% baixadas receberiam PC aberta, desarmando o 409 do parecer.');
    nl('   >> 0 PCs inseridas. Ver EXECUCAO_16-08.md.');
    const inserir = [];
    if (FRENTE_2_LIBERADA) {
    const aus = lerCsv(D + 'PCS_AUSENTES_PARA_INCLUIR.csv');

    // nome curto do CSV -> analista_id. Vem de `usuarios`, e ABORTA se for ambíguo:
    // `analista_nome` da própria base já tem 'Tanimeri' apontando para dois ids diferentes.
    // ⚠️ `superadmin` ENTRA na lista. O Richard é superadmin E analista do Grupo 3, e o CSV
    // traz 7 PCs no nome dele — filtrar por `perfil = 'analista'` recusava as sete como
    // "sem cadastro". É a mesma confusão dos dois papéis que o `perfilEfetivo` resolve nas
    // rotas: aqui o que importa é quem ANALISA, não o perfil de acesso.
    const { rows: us } = await cli.query(
      `SELECT id, nome FROM usuarios WHERE perfil IN ('analista','superadmin') AND ativo = true`);
    // ⚠️ CASA POR TODAS AS PALAVRAS, SEM ACENTO, e aceita só quando resta UM.
    //
    // Casar pelo primeiro nome não serve: "Sandra Rocha" pega Sandra Paul (18) e Sandra
    // Cezária Ronchi Rocha (19); "Ana Claudia" pega Ana Claudia (22) e Ana Letícia (23). E o
    // acento importa — o CSV escreve "Ana Leticia", o cadastro "Ana Letícia".
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const acha = (nomeCsv) => {
      const alvo = semAcento(nomeCsv);
      if (!alvo) return { erro: 'sem analista no CSV' };
      const palavras = alvo.split(/\s+/).filter(Boolean);
      const exatos = us.filter(u => semAcento(u.nome) === alvo);
      const todas = us.filter(u => { const n = semAcento(u.nome); return palavras.every(p => n.split(/\s+/).includes(p)); });
      const c = exatos.length ? exatos : todas;
      if (c.length === 1) return { id: c[0].id, nome: nomeCsv.trim() };
      return { erro: c.length ? `ambiguo (${c.length}: ${c.map(x => x.id).join(',')})` : 'sem cadastro' };
    };

    // o próximo número livre da faixa inventada, por ano
    const { rows: usados } = await cli.query(
      `SELECT LEFT(codigo_pc,4) ano, MAX(SUBSTRING(codigo_pc FROM 7)::int) m
         FROM prestacoes_contas WHERE codigo_pc ~ '^[0-9]{4}PC[0-9]{6}$' GROUP BY 1`);
    const proximo = new Map(usados.map(r => [r.ano, Math.max(r.m + 1, FAIXA_INVENTADA)]));

    const recusadas = [];
    for (const r of aus) {
      const a = acha(r.analista);
      const v = moeda(r.valor);
      // o ano do código vem do processo da PC, como no acervo; cai para o ano da TR
      const anoProc = (String(r.processo_pc).match(/\/(\d{4})/) || [])[1] || String(r.tr).slice(0, 4);
      if (a.erro) { recusadas.push({ ...r, motivo: 'analista: ' + a.erro }); continue; }
      if (v == null) { recusadas.push({ ...r, motivo: 'valor ilegivel' }); continue; }
      const n = proximo.get(anoProc) ?? FAIXA_INVENTADA;
      proximo.set(anoProc, n + 1);
      inserir.push({ codigo_pc: `${anoProc}PC${String(n).padStart(6, '0')}`,
                     tr: r.tr, parcial_num: String(r.parcial).trim(), processo_pc: r.processo_pc,
                     processo_mae: r.processo_mae, entidade: r.entidade, valor: v,
                     analista_id: a.id, analista_nome: a.nome,
                     // ⚠️ `prestacoes_contas.grupo` é INTEGER e `usuarios.grupo` é TEXT.
                     // O CSV escreve "G2": sem tirar o G, o INSERT morre no tipo.
                     grupo: parseInt(String(r.grupo).replace(/\D/g, ''), 10) || null,
                     situacao: r.situacao });
    }
    nl(`   no CSV ................ ${aus.length}`);
    nl(`   a inserir ............. ${inserir.length}`);
    nl(`   recusadas ............. ${recusadas.length}`);
    const motivos = {};
    recusadas.forEach(r => { motivos[r.motivo] = (motivos[r.motivo] || 0) + 1; });
    Object.entries(motivos).forEach(([m, n]) => nl(`      ${m}: ${n}`));
    // as recusadas ficam NOMEADAS — recusa silenciosa é o mesmo que perder a linha
    if (recusadas.length) {
      fs.writeFileSync(D + 'PCS_AUSENTES_RECUSADAS.csv',
        'tr,parcial,analista,processo_pc,valor,motivo\n' +
        recusadas.map(r => [r.tr, r.parcial, r.analista, r.processo_pc, `"${r.valor}"`, r.motivo].join(',')).join('\n'));
      nl(`      >> nomeadas em PCS_AUSENTES_RECUSADAS.csv`);
    }

    // ⚠️ colisão de chave: nenhum dos códigos inventados pode já existir
    const { rows: [col] } = await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas WHERE codigo_pc = ANY($1)`,
      [inserir.map(i => i.codigo_pc)]);
    if (col.n > 0) throw new Error(`${col.n} codigos inventados JA EXISTEM`);

    for (const i of inserir) {
      await cli.query(
        `INSERT INTO prestacoes_contas
           (codigo_pc, tr, parcial_num, tipo, setorial_id, processo_pc, processo_mae, entidade,
            valor, analista_id, analista_nome, grupo, status, situacao_atual, baixada,
            registrado_por, atualizado_em)
         VALUES ($1,$2,$3,'parcial','FCEE',$4,$5,$6,$7,$8,$9,$10,'analise',$11,false,
                 'inclusao 16/08/2026 — PCS_AUSENTES_PARA_INCLUIR.csv', NOW())`,
        [i.codigo_pc, i.tr, i.parcial_num, i.processo_pc, i.processo_mae, i.entidade,
         i.valor, i.analista_id, i.analista_nome, i.grupo, i.situacao || null]);
    }
    nl(`   >> ${inserir.length} PCs inseridas, atribuidas ao analista do CSV`);
    } // fim do if (FRENTE_2_LIBERADA)

    // ══ FRENTE 3 — CONTROLE INTERNO ═══════════════════════════════════════════
    nl('\n══ FRENTE 3 — CONTROLE INTERNO ═══════════════════════════');
    const ci = lerCsv(D + 'PCS_NO_CONTROLE_INTERNO.csv');
    const codsCi = ci.map(r => r.codigo_pc);

    // ⚠️ SÓ AS BAIXADAS. `enviado_ci` SUSTENTA A BAIXA (CLAUDE.md), e o C.I. vem DEPOIS do
    // parecer — decisão registrada em 13/08, com trava no servidor. Marcar PC não baixada
    // faria o relatório contá-la como baixada: criaria trabalho que não existe.
    const { rows: naoBaixadas } = await cli.query(
      `SELECT codigo_pc FROM prestacoes_contas WHERE codigo_pc = ANY($1) AND baixada = false`,
      [codsCi]);
    const alvoCi = codsCi.filter(c => !naoBaixadas.some(n => n.codigo_pc === c));

    // ⚠️ `ci_situacao = 'encerrado'`, NÃO `'na_fila'`. Decisão registrada em 16/08/2026.
    //
    // Estas PCs já foram ao C.I. **por fora do sistema** — é o que o `AUDITORIA` descreve:
    // *"o sistema só conhece encaminhamento feito pela tela, e os históricos foram feitos por
    // fora"*. Marcá-las `na_fila` afirmaria que os três técnicos têm 2.284 PCs esperando
    // decisão, o que é falso, e a fila REAL deles — 572 encaminhamentos de 14 a 16/08 —
    // afundaria embaixo de 1.699 com `dt_envio_ci` de junho, porque `lib/ci.js` ordena por
    // essa data. A tela de trabalho de três pessoas ficaria inutilizável.
    //
    // O que o Richard quer disto é o `enviado_ci = true`: é ele que sustenta a baixa e faz a
    // etiqueta `🏛 N sem C.I.` parar de acusar 2.181 parciais que já foram. Esse fica igual.
    //
    // ⚠️ `ci_encerrado_em` e `ci_encerrado_por` ficam NULOS de propósito — não sei quando nem
    // por quem, e inventar data é pior que não ter. Estão na lista de protegidas.
    const { rowCount: marcadas } = await cli.query(
      `UPDATE prestacoes_contas
          SET enviado_ci = true,
              dt_envio_ci = COALESCE(dt_envio_ci, data_baixa),
              ci_situacao = COALESCE(ci_situacao, 'encerrado'),
              ci_rodada = GREATEST(COALESCE(ci_rodada,0), 1),
              atualizado_em = NOW()
        WHERE codigo_pc = ANY($1) AND enviado_ci = false`, [alvoCi]);
    nl(`   no CSV ................ ${codsCi.length}`);
    nl(`   ja estavam no C.I. .... ${alvoCi.length - marcadas}`);
    nl(`   marcadas agora ........ ${marcadas}  (ci_situacao = 'encerrado')`);
    nl(`   ⚠️ NAO baixadas, fora . ${naoBaixadas.length}  (enviado_ci sustenta a baixa)`);
    if (marcadas > alvoCi.length)
      throw new Error(`C.I.: marcou ${marcadas} de um alvo de ${alvoCi.length}`);

    // ══ FRENTE 4 — HISTÓRICO COM `analista_id` VAZIO ══════════════════════════
    nl('\n══ FRENTE 4 — HISTORICO SEM DONO ═════════════════════════');
    const { rows: semDono } = await cli.query(`
      WITH dono AS (
        SELECT tr, MIN(analista_id) id FROM prestacoes_contas
         WHERE analista_id IS NOT NULL GROUP BY tr HAVING COUNT(DISTINCT analista_id) = 1)
      SELECT h.id, h.tr, d.id AS dono FROM parcela_historico h JOIN dono d ON d.tr = h.tr
       WHERE h.evento IN ('processo_pc','processo_mae') AND h.analista_id IS NULL`);
    let corrigidas = 0;
    if (semDono.length) {
      const r = await cli.query(
        `UPDATE parcela_historico h SET analista_id = m.dono
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::int[]) AS dono) m
          WHERE h.id = m.id AND h.id = ANY($1::int[])`,
        [semDono.map(s => s.id), semDono.map(s => s.dono)]);
      corrigidas = r.rowCount;
    }
    nl(`   linhas com analista_id vazio e dono determinavel: ${semDono.length}`);
    nl(`   >> ${corrigidas} corrigidas`);
    if (corrigidas !== semDono.length)
      throw new Error(`historico sem dono: esperava ${semDono.length}, peguei ${corrigidas}`);

    // ══ CONFERÊNCIA DEPOIS DE ESCREVER ════════════════════════════════════════
    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    const un = async (s, p) => (await cli.query(s, p)).rows[0];
    const novos = inserir.map(i => i.codigo_pc);

    // as protegidas, coluna a coluna, nas linhas que JÁ existiam
    const divergentes = [];
    for (const col2 of PROTEGIDAS) {
      const d = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
        JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
        WHERE b.${col2} IS DISTINCT FROM p.${col2}`);
      if (d.n > 0) divergentes.push(`${col2}=${d.n}`);
    }
    // analista_id de quem JÁ tinha dono não pode mudar
    const c1 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE b.analista_id IS NOT NULL AND b.analista_id IS DISTINCT FROM p.analista_id`);
    // nenhuma PC fora da lista pode ter mudado de número
    const c2 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE p.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (p.codigo_pc = ANY($1))`, [codigos]);
    // as inseridas apareceram, e só elas
    const c3 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas`);
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE codigo_pc = ANY($1) AND analista_id IS NULL`, [novos.length ? novos : ['x']]);
    // C.I.: nenhuma PC não baixada entrou no ciclo
    const c5 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas
      WHERE enviado_ci = true AND baixada = false`);
    // e o `dt_envio_ci` só pode ter mudado nas PCs do C.I. desta rodada
    const c9 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE b.dt_envio_ci IS DISTINCT FROM p.dt_envio_ci AND NOT (p.codigo_pc = ANY($1))`,
      [alvoCi.length ? alvoCi : ['x']]);
    // e `enviado_ci` idem — a coluna que sustenta a baixa não muda fora da lista
    const c10 = await un(`SELECT COUNT(*)::int n FROM ${BK_PC} b
      JOIN prestacoes_contas p ON p.codigo_pc = b.codigo_pc
      WHERE b.enviado_ci IS DISTINCT FROM p.enviado_ci AND NOT (p.codigo_pc = ANY($1))`,
      [alvoCi.length ? alvoCi : ['x']]);
    // histórico: nada sumiu, e nada além de parcial_num/analista_id mudou
    const c6 = await un(`SELECT COUNT(*)::int n FROM parcela_historico`);
    const c7 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
      JOIN ${BK_HIST} b ON b.id = h.id
      WHERE (h.tr,h.setorial_id,h.evento,h.valor_anterior,h.valor_novo,h.criado_em)
         IS DISTINCT FROM (b.tr,b.setorial_id,b.evento,b.valor_anterior,b.valor_novo,b.criado_em)`);
    // toda cópia aponta para parcela que existe
    const c8 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
      WHERE h.id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM prestacoes_contas p
        WHERE p.setorial_id=h.setorial_id AND p.tr=h.tr AND p.parcial_num=h.parcial_num
          AND p.tipo <> 'final')`, [idsCopias.length ? idsCopias : [-1]]);

    const checks = [
      ['colunas protegidas intactas',        divergentes.length === 0, divergentes.join(' ') || '0'],
      ['analista_id de quem tinha dono',     c1.n === 0, c1.n],
      ['PC fora da lista renumerada',        c2.n === 0, c2.n],
      ['total de PCs = antes + inseridas',   c3.n === bk.n + inserir.length, `${bk.n}+${inserir.length}=${c3.n}`],
      ['toda PC inserida tem analista',      c4.n === 0, c4.n],
      ['nenhuma PC no C.I. sem baixa',       c5.n === 0, c5.n],
      ['dt_envio_ci mexido fora da lista',   c9.n === 0, c9.n],
      ['enviado_ci mexido fora da lista',    c10.n === 0, c10.n],
      ['historico = antes + copias',         c6.n === bkh.n + idsCopias.length, `${bkh.n}+${idsCopias.length}=${c6.n}`],
      ['historico: campo alheio mexido',     c7.n === 0, c7.n],
      ['copia aponta p/ parcela existente',  c8.n === 0, c8.n],
    ];
    let falhou = false;
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(38)} ${v}`); }

    if (falhou) {
      await cli.query('ROLLBACK');
      nl('\n>> CONFERENCIA FALHOU: ROLLBACK. Nada gravado.');
      process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(D + 'reverter_exec_20260816.json', JSON.stringify(
        { quando: new Date().toISOString(), backup_pc: BK_PC, backup_hist: BK_HIST,
          renumeradas: codigos, inseridas: novos, copias_historico: idsCopias,
          ci_marcadas: marcadas, hist_dono: semDono.map(s => s.id) }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   reversao: reverter_exec_20260816.json + ${BK_PC} / ${BK_HIST}`);
    } else {
      await cli.query('ROLLBACK');
      nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    // ⚠️ A manutenção SAI mesmo se a gravação abortar — senão a equipe fica trancada fora.
    // ⚠️ NÃO MEXE EM `mensagem` — ela é da PREPARAÇÃO e não é minha. A primeira versão
    // fazia `mensagem = NULL` aqui e apagaria o texto de boas-vindas de 13/08.
    if (manutencaoLigada) {
      try {
        await cli.query(`UPDATE config_sistema SET modo_manutencao = false,
                           mensagem_manutencao = NULL, atualizado_em = NOW() WHERE id = 1`);
        nl('\n── MODO MANUTENCAO DESLIGADO. Equipe liberada.');
        manutencaoLigada = false;
      } catch (e) {
        console.error('🔴 FALHOU DESLIGAR A MANUTENCAO:', e.message);
        console.error('   DESLIGUE PELA TELA: Configurações -> Modo manutenção.');
      }
    }
    cli.release();
    await pool.end();
  }
})();
