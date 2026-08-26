// CAMINHO: sigpc-api/reabrir_ci_encerradas.js
//
// REABRIR NO C.I. AS PCs QUE O SGPe DEVOLVEU DEPOIS DO ENCERRAMENTO.
//
// ⚠️ DRY-RUN POR PADRÃO. Sem `--gravar` a transação termina em ROLLBACK — mas a mudança e
// TODAS as conferências rodam antes dele. Um dry-run que não escreve não prova nada sobre a
// escrita; este escreve, confere e desfaz.
//
// USO
//   node reabrir_ci_encerradas.js                                   dry-run nos 16 processos
//   node reabrir_ci_encerradas.js --pc=2020PC001898,2020PC002958    dry-run numas PCs
//   node reabrir_ci_encerradas.js --autor=62 --motivo="..." --gravar        GRAVA
//
// ═══ O QUE ELE ESCREVE, E SÓ ═══
//
//   prestacoes_contas   ci_situacao 'encerrado' → 'com_analista'
//                       ci_rodada   GREATEST(ci_rodada,1) + 1
//                       ci_encerrado_em, ci_encerrado_por → NULL
//                       atualizado_em → NOW()
//   ci_mensagem         1 linha por PC, direcao 'ci_para_analista', com o motivo
//   parcela_historico   1 linha por PC, evento 'ci_reabriu'
//
// ⚠️ NÃO TOCA: `baixada` · `data_baixa` · `enviado_ci` · `dt_envio_ci` · `parecer_tipo` ·
// `estornada` · `status` · `analista_id` · **`ci_tecnico_id`** · **`ci_tecnico_em`**.
// As duas últimas por ordem do Richard (26/08/2026): elas continuam com UM caminho de
// escrita em todo o sistema, que é `ci.decidir`, no mesmo UPDATE do parecer. Há conferência
// que compara as onze contra a foto e faz ROLLBACK se qualquer uma mudar.
//
// ⚠️ O SQL NÃO É REESCRITO AQUI. `SQL_REABRIR_ALVO`, `SQL_REABRIR`, `SQL_REABRIR_HISTORICO` e
// `gravarMensagem` vêm de `lib/ci.js` — os mesmos que `POST /ci/reabrir` usa. O que este
// arquivo NÃO faz é chamar `ci.reabrir`: aquela função gerencia a própria transação, e a
// armadilha 11 do CLAUDE.md é exatamente isso — o COMMIT dela confirmaria a transação deste
// script, e o ROLLBACK do dry-run não teria mais o que desfazer. Uma regra só, dois donos de
// transação.
//
// ⚠️ IDEMPOTENTE. O alvo é `ci_situacao = 'encerrado'`; depois de gravar, a segunda passada
// acha zero e termina em ROLLBACK dizendo "nada a fazer". Rodar de novo não soma rodada.
//
// ⚠️ TRÊS CASOS FICAM DE FORA POR CONSTRUÇÃO, e o relatório os nomeia um a um:
//   · SCC 21815/2022 e SCC 20923/2025 — não existem em `prestacoes_contas`, em grafia nenhuma;
//   · 2021PC002214 (SCC 10389/2022) — `ci_situacao` NULA, sem parecer e sem baixa.
// Nenhum deles é tratamento especial: o filtro `ci_situacao = 'encerrado'` simplesmente não
// os alcança. **Não inventar tratamento para eles** — a decisão é do Richard.

const fs = require('fs');
const { Pool } = require('pg');
const ci = require('./lib/ci');
const CF = require('./lib/ci-fila');

const GRAVAR = process.argv.includes('--gravar');
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');

const SIGLA = 'SCC';
const PROCESSOS = [
  '19676/2020', '5892/2022', '10389/2022', '5261/2021', '2877/2021', '11337/2023',
  '21815/2022', '22203/2021', '3033/2022', '6082/2022', '9976/2022', '20923/2025',
  '59/2023', '60/2023', '14766/2022', '14767/2022',
];

// O texto que o dry-run usa quando ninguém passou `--motivo`. É deliberadamente feio: o
// motivo é a fala do C.I., e inventar uma frase plausível faria o dry-run parecer pronto.
const MOTIVO_FALSO = '[DRY-RUN — motivo nao informado, nada disto sera gravado]';

const REVERSAO = __dirname + '/reverter_ci_reabertura_20260826.json';

// As onze colunas que a reabertura NÃO pode tocar. A conferência compara cada uma contra a
// foto, valor a valor. Contar linhas não prova que elas não mudaram (lição de 17/08).
const INTOCADAS = ['baixada', 'data_baixa', 'enviado_ci', 'dt_envio_ci', 'parecer_tipo',
                   'estornada', 'status', 'analista_id', 'ci_tecnico_id', 'ci_tecnico_em',
                   'setorial_id'];

const iso = (v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const igual = (a, b) => iso(a) === iso(b);

let erros = 0;
const L = [];
const say = (s = '') => { console.log(s); L.push(s); };
const conf = (passou, rotulo, detalhe) => {
  if (!passou) erros++;
  say(`  ${passou ? 'OK   ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;

  try {
    // ══ 0. QUEM ASSINA, E O QUE ELE ESCREVE ═══════════════════════════════════
    //
    // ⚠️ O AUTOR É CONFERIDO CONTRA O BANCO, pelo mesmo critério da rota: perfil
    // `controle_interno` e cadastro ativo. Sem isto o script seria a porta lateral que a
    // guarda da rota fecha — e a mensagem sairia assinada por quem não é do C.I.
    let autor = null;
    const autorId = parseInt(arg('autor')) || 0;
    if (autorId) {
      const { rows } = await cli.query(
        `SELECT id, nome, perfil, ativo FROM usuarios WHERE id = $1`, [autorId]);
      autor = rows[0] || null;
      if (!autor) throw new Error(`--autor=${autorId}: usuario nao existe.`);
      if (autor.perfil !== 'controle_interno')
        throw new Error(`--autor=${autorId} (${autor.nome}) tem perfil '${autor.perfil}'. `
                      + `So o Controle Interno reabre — a mesma regra de POST /ci/reabrir.`);
      if (autor.ativo !== true)
        throw new Error(`--autor=${autorId} (${autor.nome}) esta com cadastro inativo.`);
    }

    const motivo = (arg('motivo') || '').trim();
    if (GRAVAR) {
      if (!autor) throw new Error('--gravar exige --autor=<id de um tecnico do C.I.>.');
      const eM = ci.validar({ codigos_pc: ['x'], texto: motivo, exigeTexto: true });
      if (eM) throw new Error(`--motivo: ${eM}`);
    }
    const texto = motivo || MOTIVO_FALSO;

    say('═'.repeat(78));
    say(`REABRIR NO C.I. — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN (termina em ROLLBACK)'}`);
    say('═'.repeat(78));
    say(`autor  : ${autor ? `${autor.nome} (id ${autor.id}, ${autor.perfil})` : '(nenhum — dry-run)'}`);
    say(`motivo : ${motivo ? `"${motivo}"` : '(nenhum — dry-run usa um texto marcado)'}`);
    say('');

    // ══ 1. O ALVO ═════════════════════════════════════════════════════════════
    let codigos;
    const porPc = arg('pc');
    if (porPc) {
      codigos = porPc.split(',').map(s => s.trim()).filter(Boolean);
      say(`Alvo pedido por --pc: ${codigos.length} codigo(s).`);
    } else {
      const chaves = PROCESSOS.map(p => {
        const [n, a] = p.split('/');
        return { rot: `${SIGLA} ${p}`, chave: CF.chaveSgpe(SIGLA, n, a) };
      });
      const { rows } = await cli.query(
        `SELECT codigo_pc, ${CF.SQL_SGPE_CHAVE} AS chave, ci_situacao
           FROM prestacoes_contas p WHERE ${CF.SQL_SGPE_CHAVE} = ANY($1)`,
        [chaves.map(c => c.chave)]);
      codigos = rows.map(r => r.codigo_pc);

      say('Os 16 processos, e o que cada um traz:');
      say('');
      say('| processo | PCs no banco | encerradas (alvo) | fora do alcance |');
      say('|---|---|---|---|');
      for (const c of chaves) {
        const minhas = rows.filter(r => r.chave === c.chave);
        const enc = minhas.filter(r => r.ci_situacao === 'encerrado');
        const fora = minhas.filter(r => r.ci_situacao !== 'encerrado');
        say(`| ${c.rot} | ${minhas.length || '**0 — nao existe no banco**'} | ${enc.length} | `
          + `${fora.length ? fora.map(f => `${f.codigo_pc} (ci_situacao ${f.ci_situacao === null ? 'NULA' : f.ci_situacao})`).join('; ') : '—'} |`);
      }
      say('');
    }

    await cli.query('BEGIN');

    // ══ 2. A FOTO — antes de qualquer escrita ═════════════════════════════════
    const { rows: foto } = await cli.query(ci.SQL_REABRIR_ALVO, [codigos]);

    // ⚠️ O MD5 DAS OUTRAS LINHAS. Contar 14.658 depois de gravar prova que nada sumiu, e
    // NADA sobre o que mudou. Esta soma cobre as colunas do ciclo e da baixa de TODA linha
    // que NAO esta no alvo — se uma delas se mexer, a soma muda e a transacao cai.
    const SQL_MD5_FORA = `
      SELECT md5(string_agg(x, '|' ORDER BY x))::text AS h, COUNT(*)::int AS n FROM (
        SELECT codigo_pc || ';' || COALESCE(ci_situacao,'~') || ';' || COALESCE(ci_rodada::text,'~')
            || ';' || COALESCE(ci_encerrado_em::text,'~') || ';' || COALESCE(ci_encerrado_por::text,'~')
            || ';' || COALESCE(ci_tecnico_id::text,'~') || ';' || COALESCE(ci_tecnico_em::text,'~')
            || ';' || COALESCE(baixada::text,'~') || ';' || COALESCE(enviado_ci::text,'~')
            || ';' || COALESCE(parecer_tipo,'~') || ';' || COALESCE(estornada::text,'~') AS x
          FROM prestacoes_contas WHERE NOT (codigo_pc = ANY($1))) t`;
    const SQL_CONTAGENS = `
      SELECT COUNT(*) FILTER (WHERE ci_situacao = 'encerrado')::int    AS encerrado,
             COUNT(*) FILTER (WHERE ci_situacao = 'com_analista')::int AS com_analista,
             COUNT(*) FILTER (WHERE ci_situacao = 'na_fila')::int      AS na_fila,
             COUNT(*) FILTER (WHERE ci_situacao IS NULL)::int          AS fora_ciclo,
             COUNT(*) FILTER (WHERE baixada IS TRUE OR enviado_ci IS TRUE)::int AS produtivas,
             COUNT(*)::int AS total
        FROM prestacoes_contas`;

    const fotoFora = (await cli.query(SQL_MD5_FORA, [codigos])).rows[0];
    const fotoCont = (await cli.query(SQL_CONTAGENS)).rows[0];
    const fotoMsg = (await cli.query(`SELECT COALESCE(MAX(id),0)::int AS m, COUNT(*)::int AS n FROM ci_mensagem`)).rows[0];
    const fotoHist = (await cli.query(`SELECT COALESCE(MAX(id),0)::int AS m, COUNT(*)::int AS n FROM parcela_historico`)).rows[0];

    say('── A FOTO ' + '─'.repeat(66));
    say(`  PCs pedidas ......... ${codigos.length}`);
    say(`  ALVO (encerradas) ... ${foto.length}`);
    say(`  fora do alcance ..... ${codigos.length - foto.length}`);
    say(`  acervo: encerrado ${fotoCont.encerrado} · com_analista ${fotoCont.com_analista} · `
      + `na_fila ${fotoCont.na_fila} · fora ${fotoCont.fora_ciclo} · total ${fotoCont.total}`);
    say(`  produtivas (baixada OR enviado_ci) ... ${fotoCont.produtivas}`);
    say(`  ci_mensagem ${fotoMsg.n} linhas · parcela_historico ${fotoHist.n} linhas`);
    say('');

    if (!foto.length) {
      say('NADA A FAZER — nenhuma das PCs pedidas esta em ci_situacao = \'encerrado\'.');
      say('(E o que se espera numa segunda passada: o script e idempotente.)');
      await cli.query('ROLLBACK');
      say('');
      say('ROLLBACK. Nada foi gravado.');
      // ⚠️ SO `return`. Soltar a conexao aqui e deixar o `finally` solta-la de novo derruba o
      // processo com "double release" do pg-pool — quem fecha e o `finally`, e so ele.
      return;
    }

    say('── O QUE MUDA, PC A PC ' + '─'.repeat(53));
    say('');
    say('| codigo_pc | TR | parcial | analista | rodada | ci_tecnico_id | baixada | enviado_ci |');
    say('|---|---|---|---|---|---|---|---|');
    for (const r of foto) {
      say(`| ${r.codigo_pc} | ${r.tr} | ${r.parcial_num} | ${r.analista_nome || '—'} (${r.analista_id}) | `
        + `${r.ci_rodada} → ${Math.max(r.ci_rodada, 1) + 1} | ${r.ci_tecnico_id ?? '—'} (intocado) | `
        + `${r.baixada} (intocado) | ${r.enviado_ci} (intocado) |`);
    }
    say('');

    // ══ 3. A MUDANÇA — as mesmas tres escritas de POST /ci/reabrir ═════════════
    const codigosAlvo = foto.map(r => r.codigo_pc);

    // ⚠️ A MENSAGEM VEM ANTES DO UPDATE, como em `ci.reabrir`: `gravarMensagem` le a rodada
    // da PC, e antes do UPDATE ela ainda e a rodada em que o C.I. estava quando escreveu.
    const nMsg = await ci.gravarMensagem(cli, codigosAlvo, {
      direcao: 'ci_para_analista', texto, autor,
    });
    const { rows: mudadas } = await cli.query(ci.SQL_REABRIR, [codigosAlvo]);
    for (const r of foto) {
      await cli.query(ci.SQL_REABRIR_HISTORICO,
        [r.codigo_pc, autor?.id ?? null, ci.textoReabertura(autor?.nome, r.codigo_pc, texto)]);
    }

    // ══ 4. AS CONFERÊNCIAS — contra a FOTO, nunca contra numero literal ════════
    say('── CONFERENCIAS (contra a foto, dentro da mesma transacao) ' + '─'.repeat(18));

    const { rows: depoisArr } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, setorial_id, analista_id, analista_nome, entidade,
              ci_situacao, ci_rodada, ci_encerrado_em, ci_encerrado_por, ci_tecnico_id, ci_tecnico_em,
              baixada, data_baixa, enviado_ci, dt_envio_ci, parecer_tipo, estornada, status
         FROM prestacoes_contas WHERE codigo_pc = ANY($1)`, [codigosAlvo]);
    const depois = new Map(depoisArr.map(r => [r.codigo_pc, r]));

    conf(mudadas.length === foto.length,
         `o UPDATE alcancou exatamente o alvo da foto (${foto.length})`, `mudou ${mudadas.length}`);
    conf(depoisArr.length === foto.length,
         'nenhuma PC do alvo sumiu nem se multiplicou', `${depoisArr.length} vs ${foto.length}`);

    let mau = [];
    for (const a of foto) {
      const d = depois.get(a.codigo_pc);
      if (!d) { mau.push(`${a.codigo_pc}: sumiu`); continue; }
      if (d.ci_situacao !== 'com_analista') mau.push(`${a.codigo_pc}: ci_situacao=${d.ci_situacao}`);
      if (d.ci_rodada !== Math.max(a.ci_rodada, 1) + 1)
        mau.push(`${a.codigo_pc}: rodada ${a.ci_rodada}→${d.ci_rodada}`);
      if (d.ci_encerrado_em !== null) mau.push(`${a.codigo_pc}: ci_encerrado_em nao zerou`);
      if (d.ci_encerrado_por !== null) mau.push(`${a.codigo_pc}: ci_encerrado_por nao zerou`);
    }
    conf(!mau.length, 'as QUATRO colunas mudaram exatamente como previsto', mau.slice(0, 4).join(' · '));

    mau = [];
    for (const a of foto) {
      const d = depois.get(a.codigo_pc);
      for (const c of INTOCADAS) if (d && !igual(a[c], d[c]))
        mau.push(`${a.codigo_pc}.${c}: ${iso(a[c])} → ${iso(d[c])}`);
    }
    conf(!mau.length, `as ${INTOCADAS.length} colunas intocadas ficaram IDENTICAS a foto`,
         mau.slice(0, 4).join(' · '));
    conf(!mau.some(m => /ci_tecnico/.test(m)),
         'ci_tecnico_id e ci_tecnico_em NAO foram tocados — a escrita deles e so de ci.decidir');
    conf(!mau.some(m => /baixada|enviado_ci|estornada|parecer_tipo/.test(m)),
         'baixada, enviado_ci, parecer_tipo e estornada NAO foram tocados');

    const foraDepois = (await cli.query(SQL_MD5_FORA, [codigos])).rows[0];
    conf(foraDepois.h === fotoFora.h && foraDepois.n === fotoFora.n,
         `NENHUMA outra linha da tabela mudou (md5 de ${fotoFora.n} linhas fora do alvo)`,
         `${fotoFora.h} → ${foraDepois.h}`);

    const cont = (await cli.query(SQL_CONTAGENS)).rows[0];
    conf(cont.total === fotoCont.total, 'o total de PCs nao mudou', `${fotoCont.total} → ${cont.total}`);
    conf(cont.encerrado === fotoCont.encerrado - foto.length,
         `encerrado caiu exatamente ${foto.length}`, `${fotoCont.encerrado} → ${cont.encerrado}`);
    conf(cont.com_analista === fotoCont.com_analista + foto.length,
         `com_analista subiu exatamente ${foto.length}`, `${fotoCont.com_analista} → ${cont.com_analista}`);
    conf(cont.na_fila === fotoCont.na_fila, 'na_fila ficou igual', `${fotoCont.na_fila} → ${cont.na_fila}`);
    conf(cont.fora_ciclo === fotoCont.fora_ciclo, 'fora do ciclo ficou igual',
         `${fotoCont.fora_ciclo} → ${cont.fora_ciclo}`);
    // ⚠️ A CONFERENCIA QUE RESPONDE A PERGUNTA DO RICHARD: produtividade intacta.
    conf(cont.produtivas === fotoCont.produtivas,
         'PRODUTIVIDADE INTACTA — (baixada OR enviado_ci) nao mudou',
         `${fotoCont.produtivas} → ${cont.produtivas}`);

    const { rows: msgNovas } = await cli.query(
      `SELECT id, codigo_pc, rodada, direcao, autor_id FROM ci_mensagem WHERE id > $1 ORDER BY id`,
      [fotoMsg.m]);
    conf(msgNovas.length === foto.length && nMsg === foto.length,
         `ci_mensagem: exatamente 1 linha nova por PC (${foto.length})`, `${msgNovas.length}`);
    conf(msgNovas.every(m => m.direcao === 'ci_para_analista'),
         'todas as mensagens sao ci_para_analista');
    conf(msgNovas.every(m => {
           const a = foto.find(f => f.codigo_pc === m.codigo_pc);
           return a && m.rodada === Math.max(a.ci_rodada, 1);
         }), 'a mensagem ficou na rodada ANTERIOR ao UPDATE — como no ramo ressalva');

    const { rows: histNovas } = await cli.query(
      `SELECT id, tr, parcial_num, evento, valor_anterior, valor_novo, analista_id, executado_por
         FROM parcela_historico WHERE id > $1 ORDER BY id`, [fotoHist.m]);
    conf(histNovas.length === foto.length,
         `parcela_historico: exatamente 1 linha nova por PC (${foto.length})`, `${histNovas.length}`);
    conf(histNovas.every(h => h.evento === 'ci_reabriu'
           && h.valor_anterior === 'encerrado' && h.valor_novo === 'com_analista'),
         "todas com evento 'ci_reabriu', de 'encerrado' para 'com_analista'");

    say('');
    say(`  ${erros === 0 ? 'TODAS as conferencias passaram.' : `*** ${erros} CONFERENCIA(S) FALHARAM ***`}`);
    say('');

    // ══ 5. A REVERSÃO — gravada ANTES de terminar ══════════════════════════════
    //
    // ⚠️ POR LISTA EXPLICITA DE CHAVES (armadilha 12). O `WHERE` da reversao e
    // `codigo_pc = ANY(...)` e `id = ANY(...)`, com as listas capturadas aqui — nunca uma
    // condicao derivada, que em 12/08 carimbou 14.639 linhas no lugar de 7.
    const reversao = {
      gerado_em: new Date().toISOString(),
      script: 'reabrir_ci_encerradas.js',
      gravado: GRAVAR && erros === 0,
      autor: autor ? { id: autor.id, nome: autor.nome } : null,
      motivo,
      como_reverter: [
        "UPDATE prestacoes_contas SET ci_situacao='encerrado', ci_rodada=$rodada_antes,",
        "  ci_encerrado_em=$encerrado_em_antes, ci_encerrado_por=$encerrado_por_antes,",
        '  atualizado_em=NOW() WHERE codigo_pc = $codigo_pc   -- uma por PC, pelos valores abaixo',
        'DELETE FROM ci_mensagem      WHERE id = ANY(ci_mensagem_ids)',
        'DELETE FROM parcela_historico WHERE id = ANY(parcela_historico_ids)',
      ],
      pcs: foto.map(a => ({
        codigo_pc: a.codigo_pc, tr: a.tr, parcial_num: a.parcial_num,
        antes: { ci_situacao: a.ci_situacao, ci_rodada: a.ci_rodada,
                 ci_encerrado_em: iso(a.ci_encerrado_em), ci_encerrado_por: a.ci_encerrado_por },
        depois: { ci_situacao: 'com_analista', ci_rodada: Math.max(a.ci_rodada, 1) + 1,
                  ci_encerrado_em: null, ci_encerrado_por: null },
        // As intocadas viajam junto: quem reverter meses depois precisa saber o que NAO
        // deve encontrar mudado, sem ter de acreditar no comentario do script.
        intocadas: Object.fromEntries(INTOCADAS.map(c => [c, iso(a[c])])),
      })),
      ci_mensagem_ids: msgNovas.map(m => m.id),
      parcela_historico_ids: histNovas.map(h => h.id),
      md5_fora_do_alvo: fotoFora.h,
      contagens_antes: fotoCont,
    };
    fs.writeFileSync(REVERSAO, JSON.stringify(reversao, null, 2), 'utf8');
    say(`Reversao gravada em ${REVERSAO}`);

    // ══ 6. COMMIT ou ROLLBACK ═════════════════════════════════════════════════
    if (erros > 0) {
      await cli.query('ROLLBACK');
      say('');
      say('*** ROLLBACK — uma conferencia falhou. NADA foi gravado. ***');
      process.exitCode = 1;
    } else if (GRAVAR) {
      await cli.query('COMMIT');
      commitou = true;
      say('');
      say(`*** COMMIT — ${foto.length} PCs reabertas, ${msgNovas.length} mensagens, `
        + `${histNovas.length} linhas de historico. ***`);
      say('⚠️ O SINO NAO FOI DISPARADO: quem notifica e POST /ci/reabrir, e este script nao');
      say('   passa por ela. As analistas veem a pendencia ao abrir a Minha Planilha.');
    } else {
      await cli.query('ROLLBACK');
      say('');
      say('ROLLBACK — DRY-RUN. A mudanca e as conferencias rodaram e foram desfeitas.');
      say('Para gravar:  node reabrir_ci_encerradas.js --autor=<id> --motivo="..." --gravar');
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
    fs.writeFileSync(__dirname + '/REABRIR_CI_DRYRUN.md', L.join('\n'), 'utf8');
  }
})();
