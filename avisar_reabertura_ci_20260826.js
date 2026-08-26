// CAMINHO: sigpc-api/avisar_reabertura_ci_20260826.js
//
// O SINO DAS 23 REABERTAS — o aviso que `reabrir_ci_encerradas.js` nao dispara.
//
// ⚠️ POR QUE ELE EXISTE. Quem notifica a reabertura e `POST /ci/reabrir`, e o script de
// correcao em lote nao passa por ela. Sem este aviso, 23 PCs aparecem como pendencia na
// Minha Planilha de 7 analistas sem que nada tenha avisado — e `com_analista` e um estado
// que espera acao DELAS. A devolucao por `ressalva`, que e a MESMA transicao de estado,
// notifica desde que existe.
//
// ⚠️ DRY-RUN POR PADRAO. Sem `--gravar`, escreve, confere e faz ROLLBACK.
//
// USO
//   node avisar_reabertura_ci_20260826.js            dry-run
//   node avisar_reabertura_ci_20260826.js --gravar   GRAVA
//
// ═══ O QUE ELE ESCREVE, E SO ═══
//
//   notificacao   1 linha POR PARCELA (nao por PC), para o analista dono da parcela.
//
// ⚠️ NAO TOCA `prestacoes_contas`, `ci_mensagem` nem `parcela_historico`. Ha conferencia que
// compara as tres contra a foto e faz ROLLBACK se qualquer contagem mudar.
//
// ⚠️ UMA POR PARCELA, e nao por PC. A parcela 1 da 2020TR000633 tem NOVE PCs reabertas: nove
// avisos identicos na mesma tarde matam o sino da Geisa. O agrupamento nao e reimplementado
// aqui — vem de `ci.agruparPorParcela`, o mesmo que as outras tres transicoes usam.
//
// ⚠️ IDEMPOTENTE POR CONSTRUCAO, e nao por um `WHERE` deste arquivo: `notificacao.criar` so
// insere quando nao existe outra com o mesmo (destinatario, tipo, ref_id). Rodar de novo
// devolve zero criadas.
//
// ⚠️ E A RODADA DO `ref_id` NAO LEVA `+ 1` AQUI. Na rota o `+1` existe porque `g.rodada` e
// lido ANTES do UPDATE; aqui as PCs JA estao na rodada nova, e somar de novo geraria um
// `ref_id` diferente do da rota — o dedupe deixaria passar um segundo aviso no dia em que
// alguem reabrisse a mesma parcela pela tela. O alvo e o MESMO texto de ref_id.

const fs = require('fs');
const { Pool } = require('pg');
const ci = require('./lib/ci');
const notif = require('./lib/notificacao');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = __dirname + '/reverter_aviso_reabertura_20260826.json';
const ORIGEM = __dirname + '/reverter_ci_reabertura_20260826.json';

let erros = 0;
const L = [];
const say = (s = '') => { console.log(s); L.push(s); };
const conf = (ok, rot, det) => { if (!ok) erros++; say(`  ${ok ? 'OK   ' : 'FALHA'}  ${rot}${ok || !det ? '' : `   [${det}]`}`); };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;

  try {
    // ⚠️ O ALVO SAI DO JSON DE REVERSAO DA GRAVACAO, e nao de uma consulta nova por
    // `ci_situacao = 'com_analista'`. Aquela consulta pegaria tambem as 2 PCs que ja estavam
    // com o analista antes de hoje, que nao tem nada a ver com esta reabertura. A lista
    // explicita e a regra 12 do CLAUDE.md.
    const rev = JSON.parse(fs.readFileSync(ORIGEM, 'utf8'));
    if (rev.gravado !== true) throw new Error(`${ORIGEM} diz gravado=false — nao ha o que avisar.`);
    const cods = rev.pcs.map(p => p.codigo_pc);

    say('═'.repeat(78));
    say(`SINO DA REABERTURA — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN (termina em ROLLBACK)'}`);
    say('═'.repeat(78));
    say(`Alvo: as ${cods.length} PCs de ${ORIGEM.split(/[\\/]/).pop()}`);
    say('');

    await cli.query('BEGIN');

    // ══ FOTO ══════════════════════════════════════════════════════════════════
    const F = `SELECT
        (SELECT COUNT(*)::int FROM notificacao)                                     AS notif,
        (SELECT COALESCE(MAX(id),0)::int FROM notificacao)                          AS notif_max,
        (SELECT COUNT(*)::int FROM ci_mensagem)                                     AS msgs,
        (SELECT COUNT(*)::int FROM parcela_historico)                               AS hist,
        (SELECT COUNT(*) FILTER (WHERE ci_situacao='com_analista') FROM prestacoes_contas)::int AS com_analista,
        (SELECT COUNT(*) FILTER (WHERE baixada IS TRUE OR enviado_ci IS TRUE) FROM prestacoes_contas)::int AS produtivas`;
    const foto = (await cli.query(F)).rows[0];

    // As PCs, com os campos que `agruparPorParcela` le. ORDER BY codigo_pc dentro da parcela:
    // e o `g.pcs[0]` que vira o ref_id, e ele tem de ser o mesmo que a rota produziria.
    const { rows: pcs } = await cli.query(
      `SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.analista_id, p.ci_rodada,
              p.ci_situacao, u.nome AS analista_nome, u.ativo
         FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.analista_id
        WHERE p.codigo_pc = ANY($1) ORDER BY p.tr, p.parcial_num, p.codigo_pc`, [cods]);

    const foraDoEstado = pcs.filter(p => p.ci_situacao !== 'com_analista');
    if (foraDoEstado.length)
      throw new Error(`${foraDoEstado.length} PC(s) nao estao em 'com_analista': `
                    + foraDoEstado.map(p => `${p.codigo_pc}=${p.ci_situacao}`).join(', '));

    const grupos = ci.agruparPorParcela(pcs);
    const semDono = grupos.filter(g => !g.analista_id);

    say('── A FOTO ' + '─'.repeat(66));
    say(`  PCs .................. ${pcs.length}`);
    say(`  parcelas (avisos) .... ${grupos.length}`);
    say(`  analistas ............ ${new Set(grupos.map(g => g.analista_id)).size}`);
    say(`  parcelas sem dono .... ${semDono.length} (nao geram aviso)`);
    say(`  notificacao .......... ${foto.notif} linhas`);
    say('');
    say('| TR | parcela | PCs | analista | ref_id |');
    say('|---|---|---|---|---|');
    for (const g of grupos) {
      const nome = pcs.find(p => p.analista_id === g.analista_id)?.analista_nome || '(sem cadastro)';
      say(`| ${g.tr} | ${g.parcial_num} | ${g.pcs.length} | ${nome} (${g.analista_id ?? '—'}) | `
        + `\`${g.pcs[0]}|ci_reabriu|${g.rodada || 1}\` |`);
    }
    say('');

    // ══ A ESCRITA — o mesmo corpo que POST /ci/reabrir monta ═══════════════════
    const MOTIVO = rev.motivo;
    let criadas = 0, pulados = 0;
    const ids = [];
    for (const g of grupos) {
      if (!g.analista_id) { pulados++; continue; }
      const corpo = [
        `Parcela ${g.parcial_num} — ${g.pcs.length} PC${g.pcs.length > 1 ? 's' : ''}`
          + `${g.entidade ? ` (${g.entidade})` : ''}.`,
        'O processo voltou pelo SGPe depois de o C.I. ter encerrado esta parcela, '
          + 'e ela volta para você. A baixa continua valendo.',
        `Reaberta por ${rev.autor.nome}.`,
        `Motivo do C.I.:\n${MOTIVO}`,
      ].join('\n\n');

      const n = await notif.criar(cli, {
        destinatario_id: g.analista_id,
        tipo: 'diligencia',
        titulo: `C.I. reabriu · ${g.tr}`,
        mensagem: corpo,
        link: `#planilha:${g.tr}:${g.parcial_num}`,
        ref_tipo: 'pc',
        ref_id: `${g.pcs[0]}|ci_reabriu|${g.rodada || 1}`,
      });
      if (n) { criadas++; ids.push(n.id); } else { pulados++; }
    }

    // ══ CONFERENCIAS — contra a foto ══════════════════════════════════════════
    say('── CONFERENCIAS (contra a foto, dentro da mesma transacao) ' + '─'.repeat(18));
    const dep = (await cli.query(F)).rows[0];
    const comDono = grupos.filter(g => g.analista_id).length;

    // ⚠️ `notif.criar` ENGOLE ERRO e devolve null. Sem esta conferencia, um sino quebrado
    // seria indistinguivel de um dedupe — e o script diria "0 criadas" nos dois casos.
    // ⚠️ ZERO CRIADAS COM TUDO PULADO E' IDEMPOTENCIA, NAO FALHA.  (26/08/2026)
    //
    // A primeira versao exigia `criadas === comDono` e nada mais. Na segunda passada o dedupe
    // de `notificacao.criar` barra as 11 — que e' o comportamento CERTO — e o script gritava
    // FALHA sobre ter feito exatamente o que devia. Script que diz FALHA quando acertou ensina
    // quem o roda a ignorar a palavra.
    const jaAvisado = criadas === 0 && pulados === comDono && comDono > 0;
    conf(jaAvisado || criadas === comDono,
         jaAvisado ? `NADA A FAZER — as ${comDono} ja foram avisadas (dedupe por ref_id)`
                   : `uma notificacao por parcela COM dono (${comDono})`,
         `criadas ${criadas}, pulados ${pulados}`);
    conf(dep.notif === foto.notif + criadas,
         `a tabela notificacao cresceu exatamente ${criadas}`, `${foto.notif} → ${dep.notif}`);
    // ⚠️ MAIORES QUE O TOPO DA FOTO, E NAO CONTIGUOS A ELE. A primeira versao desta linha
    // exigia `notif_max === foto.notif_max + criadas`, e ela REPROVOU uma gravacao correta:
    // a sequence do Postgres NAO volta no ROLLBACK, entao a tentativa anterior (que abortou
    // por outro motivo) ja tinha consumido 11 numeros e os ids novos comecaram adiante.
    // Conferir contiguidade de sequence e conferir um detalhe que o banco nunca prometeu.
    conf(ids.every(i => i > foto.notif_max), 'todos os ids novos sao posteriores a foto',
         `topo da foto ${foto.notif_max}, menor id novo ${Math.min(...(ids.length ? ids : [0]))}`);
    conf(ids.length === criadas, 'todos os ids novos foram capturados para a reversao');

    // ⚠️ O AVISO NAO PODE TER TOCADO O CICLO. Tres contagens, todas contra a foto.
    conf(dep.msgs === foto.msgs, 'ci_mensagem NAO mudou', `${foto.msgs} → ${dep.msgs}`);
    conf(dep.hist === foto.hist, 'parcela_historico NAO mudou', `${foto.hist} → ${dep.hist}`);
    conf(dep.com_analista === foto.com_analista, 'com_analista NAO mudou',
         `${foto.com_analista} → ${dep.com_analista}`);
    conf(dep.produtivas === foto.produtivas, 'PRODUTIVIDADE INTACTA',
         `${foto.produtivas} → ${dep.produtivas}`);

    const { rows: novas } = await cli.query(
      `SELECT id, destinatario_id, tipo, titulo, ref_id, lida_em FROM notificacao
        WHERE id = ANY($1) ORDER BY id`, [ids.length ? ids : [0]]);
    conf(novas.every(n => n.tipo === 'diligencia'), 'todas do tipo diligencia — exigem acao');
    conf(novas.every(n => /^C\.I\. reabriu · /.test(n.titulo)), 'todas com o mesmo titulo');
    conf(new Set(novas.map(n => n.ref_id)).size === novas.length,
         'nenhum ref_id repetido — o dedupe do sino continua valendo');
    // ⚠️ A COLUNA E `lida_em`, NAO `lida`. A primeira versao desta linha pediu `lida` e o
    // Postgres recusou o comando inteiro — e o ROLLBACK pegou antes de qualquer escrita, que
    // e exatamente para isso que a conferencia roda DENTRO da transacao.
    conf(novas.every(n => n.lida_em === null), 'todas nascem NAO LIDAS (lida_em nula)');

    say('');
    say(`  ${erros === 0 ? 'TODAS as conferencias passaram.' : `*** ${erros} FALHARAM ***`}`);
    say('');

    // ══ REVERSAO — por lista explicita de ids ═════════════════════════════════
    //
    // ⚠️ UM DRY-RUN NUNCA SOBRESCREVE A REVERSAO DE UMA GRAVACAO.  (26/08/2026)
    //
    // Aconteceu neste arquivo: rodei o dry-run DEPOIS do `--gravar` e ele reescreveu o JSON
    // com `gravado: false` e `notificacao_ids: []`. Os 11 ids da escrita real sumiram do
    // arquivo — a reversao ficou sem o que reverter, e nada acusou. Foram recuperados pelo
    // `ref_id`, que sobreviveu em `avisos[]`, mas so por sorte de ter sobrado por onde
    // procurar. O dry-run agora escreve num arquivo com sufixo proprio.
    const destino = (GRAVAR && erros === 0) ? REVERSAO : REVERSAO.replace(/\.json$/, '_DRYRUN.json');
    if (!GRAVAR && fs.existsSync(REVERSAO)) {
      try {
        if (JSON.parse(fs.readFileSync(REVERSAO, 'utf8')).gravado === true)
          say(`⚠️ ${REVERSAO.split(/[\\/]/).pop()} e de uma GRAVACAO — preservado, intocado.`);
      } catch (_) {}
    }
    fs.writeFileSync(destino, JSON.stringify({
      gerado_em: new Date().toISOString(),
      script: 'avisar_reabertura_ci_20260826.js',
      gravado: GRAVAR && erros === 0,
      origem: 'reverter_ci_reabertura_20260826.json',
      como_reverter: 'DELETE FROM notificacao WHERE id = ANY(notificacao_ids)',
      notificacao_ids: ids,
      avisos: grupos.filter(g => g.analista_id).map(g => ({
        tr: g.tr, parcial_num: g.parcial_num, pcs: g.pcs, analista_id: g.analista_id,
        ref_id: `${g.pcs[0]}|ci_reabriu|${g.rodada || 1}`,
      })),
      contagens_antes: foto,
    }, null, 2), 'utf8');
    say(`Reversao gravada em ${destino}`);

    if (erros > 0) {
      await cli.query('ROLLBACK');
      say('');
      say('*** ROLLBACK — uma conferencia falhou. NADA foi gravado. ***');
      process.exitCode = 1;
    } else if (GRAVAR) {
      await cli.query('COMMIT');
      commitou = true;
      say('');
      say(`*** COMMIT — ${criadas} avisos no sino, para ${new Set(grupos.filter(g => g.analista_id).map(g => g.analista_id)).size} analistas. ***`);
    } else {
      await cli.query('ROLLBACK');
      say('');
      say('ROLLBACK — DRY-RUN. Para gravar:  node avisar_reabertura_ci_20260826.js --gravar');
    }
  } catch (e) {
    if (!commitou) { try { await cli.query('ROLLBACK'); } catch (_) {} }
    say('');
    say(`*** ERRO: ${e.message}`);
    say('*** ROLLBACK. Nada foi gravado.');
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    fs.writeFileSync(__dirname + '/AVISAR_REABERTURA_DRYRUN.md', L.join('\n'), 'utf8');
  }
})();
