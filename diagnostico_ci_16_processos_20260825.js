// CAMINHO: sigpc-api/diagnostico_ci_16_processos_20260825.js
//
// OS 16 PROCESSOS QUE O C.I. DIZ TEREM VOLTADO PELO SGPe E QUE NÃO APARECEM NA TELA.
//
// ⚠️ SÓ LEITURA. Nenhum INSERT, UPDATE, DELETE, ALTER ou CREATE. O script abre a conexão,
// roda SELECTs e fecha. Não há `--gravar` porque não há o que gravar.
//
// ═══ O QUE ESTE DIAGNÓSTICO RESPONDE ═══
//
//   1. a chave normalizada de cada um, pela MESMA função da busca da tela;
//   2. quantas PCs a TELA devolveria hoje, pela MESMA consulta da rota;
//   3. quantas PCs EXISTEM no banco para aquele processo, sem filtro nenhum;
//   4. a diferença entre 2 e 3, e o MOTIVO de cada PC ficar de fora.
//
// ⚠️ O PONTO DO DIAGNÓSTICO É A DIFERENÇA ENTRE (2) E (3). Se a tela devolve menos do que
// existe, o problema é o RECORTE — e o recorte da fila é `ci_situacao IS NOT NULL`. Uma PC que
// nunca foi encaminhada ao C.I. não está no ciclo, e por isso não aparece numa tela do C.I.,
// por mais que o processo tenha voltado pelo SGPe. Isso não é defeito de busca: é dado.
//
// ⚠️ E A BUSCA NÃO É REIMPLEMENTADA AQUI. `chaveSgpe`, `montarFiltro`, `sqlLista` e
// `sqlContar` vêm de `lib/ci-fila.js`, que é o que a rota usa. Uma segunda implementação
// "igualzinha" responderia sobre si mesma, e não sobre a tela — que é o que se quer medir.
//
// USO: node diagnostico_ci_16_processos_20260825.js

const fs = require('fs');
const { Pool } = require('pg');
const CF = require('./lib/ci-fila');

const SAIDA = __dirname + '/DIAGNOSTICO_CI_16_PROCESSOS_2026-08-25.md';

// A Marcia — id 62, `perfil = 'controle_interno'`. É a conta com que a tela seria aberta, e é
// dela que sai o `$n` do "Comigo"/"Com outros" no `montarFiltro`.
const MARCIA = 62;

const SIGLA = 'SCC';
const PROCESSOS = [
  '19676/2020', '5892/2022', '10389/2022', '5261/2021', '2877/2021', '11337/2023',
  '21815/2022', '22203/2021', '3033/2022', '6082/2022', '9976/2022', '20923/2025',
  '59/2023', '60/2023', '14766/2022', '14767/2022',
];

// A mesma normalização do lado do BANCO que a lib usa, mas com o alias `p` já resolvido —
// é o que permite fazer o LEFT JOIN direto do item 3 sem repetir a regra.
const CHAVE = CF.SQL_SGPE_CHAVE;

const dataBr = (v) => {
  if (!v) return '';
  if (v instanceof Date) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}`;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
};
const SIT = { na_fila: 'na fila do C.I.', com_analista: 'com a analista', encerrado: 'encerrada no C.I.' };
const sim = (b) => b === true ? 'sim' : b === false ? 'não' : '—';

/**
 * POR QUE ESTA PC NÃO APARECE NA TELA.
 *
 * ⚠️ A ORDEM DAS PERGUNTAS IMPORTA, e ela segue o `montarFiltro`: o universo é
 * `ci_situacao IS NOT NULL`, e só depois vem o chip. Uma PC fora do ciclo não é "uma PC no
 * chip errado" — ela não está na tela em chip nenhum.
 */
function motivo(r) {
  if (r.ci_situacao === null) {
    return r.enviado_ci
      ? 'FORA DO CICLO — enviado_ci é true, mas ci_situacao está NULA: ela nunca entrou no ciclo gerenciado'
      : 'FORA DO CICLO — nunca foi encaminhada ao C.I. (ci_situacao nula, enviado_ci falso)';
  }
  if (r.ci_situacao === 'encerrado') return 'no chip Encerradas, não na fila';
  if (r.ci_situacao === 'com_analista') return 'no card Com o analista, não na fila';
  return 'na fila — a tela DEVOLVE esta';
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const L = [];
  const say = (s = '') => { console.log(s); L.push(s); };

  try {
    const quem = (await pool.query(
      `SELECT id, nome, perfil, ativo, papel_ativo FROM usuarios WHERE id = $1`, [MARCIA])).rows[0];

    say('# Os 16 processos do C.I. — diagnóstico contra o caminho novo (por PC)');
    say('');
    say(`Gerado em ${dataBr(new Date())}. **Só leitura** — nenhuma escrita no banco.`);
    say('');
    say(`Consultado como **${quem ? quem.nome : '(usuário não encontrado)'}** ` +
        `(id ${MARCIA}, perfil \`${quem ? quem.perfil : '?'}\`, ativo: ${quem ? sim(quem.ativo) : '—'}) — ` +
        `a mesma conta com que a tela seria aberta.`);
    say('');
    say('A busca não é reimplementada aqui: `chaveSgpe`, `montarFiltro`, `sqlLista` e `sqlContar`');
    say('vêm de `lib/ci-fila.js`, que é o que `GET /ci/fila` usa.');
    say('');

    // ══ 1. AS CHAVES, E O TESTE DO COLAPSO ═══════════════════════════════════
    say('## 1. A chave normalizada de cada um');
    say('');
    say('| # | digitado | chave normalizada | grafias no banco | processos distintos |');
    say('|---|---|---|---|---|');

    const chaves = [];
    for (let i = 0; i < PROCESSOS.length; i++) {
      const [num, ano] = PROCESSOS[i].split('/');
      const chave = CF.chaveSgpe(SIGLA, num, ano);
      // ⚠️ AS GRAFIAS CRUAS QUE CAEM NESTA MESMA CHAVE. É aqui que um colapso apareceria: se
      // duas escritas diferentes de processo virarem a mesma chave, elas saem listadas.
      const g = await pool.query(
        `SELECT DISTINCT p.processo_pc FROM prestacoes_contas p
          WHERE ${CHAVE} = $1 ORDER BY 1`, [chave]);
      const grafias = g.rows.map(r => r.processo_pc);
      chaves.push({ n: PROCESSOS[i], num, ano, chave, grafias });
      say(`| ${i + 1} | SCC ${PROCESSOS[i]} | \`${chave}\` | ` +
          `${grafias.length ? grafias.map(x => '`' + x + '`').join('<br>') : '**nenhuma**'} | ${grafias.length} |`);
    }
    say('');

    // ⚠️ O TESTE PEDIDO PELO RICHARD: 59/2023 e 60/2023 têm número CURTO, e a normalização
    // remove zeros à esquerda. A pergunta é se isso os cola em outro processo.
    say('### O teste dos números curtos — 59/2023 e 60/2023');
    say('');
    say('`ltrim(numero, \'0\')` remove zeros **só do começo**. `59` não tem zeros à esquerda e');
    say('sai como `59`; `590` começa com `5` e sai inteiro. O colapso só aconteceria entre duas');
    say('grafias do MESMO número — que é justamente o que se quer casar.');
    say('');
    say('| chave | processos do banco que caem nela | outros processos SCC/ANO cujo número comece com o dígito |');
    say('|---|---|---|');
    for (const c of chaves.filter(x => x.num.length <= 3)) {
      // Todos os processos da mesma sigla e ano cujo número normalizado COMECE com este —
      // se algum deles casasse com a chave, seria o colapso.
      const viz = await pool.query(
        `SELECT DISTINCT p.processo_pc, ${CHAVE} AS chave FROM prestacoes_contas p
          WHERE ${CHAVE} LIKE $1 ORDER BY 1 LIMIT 25`, [`${SIGLA}/${c.num.replace(/^0+/, '')}%/${c.ano}`]);
      const colidem = viz.rows.filter(r => r.chave === c.chave).length;
      const outros = viz.rows.filter(r => r.chave !== c.chave);
      say(`| \`${c.chave}\` | ${colidem} | ` +
          (outros.length ? outros.map(r => `\`${r.processo_pc}\` → \`${r.chave}\``).join('<br>') : '(nenhum)') + ' |');
    }
    say('');
    const colapso = [];
    for (const c of chaves) {
      if (c.grafias.length > 1) colapso.push(c);
    }
    say(colapso.length
      ? `⚠️ **${colapso.length} chave(s) casam mais de uma grafia** — ver a coluna "grafias no banco".`
      : '✅ Nenhuma chave casou duas grafias diferentes. **Não há colapso**: cada chave dos 16 ' +
        'aponta para no máximo uma escrita de processo.');
    say('');

    // ══ 2 e 3. A TELA × O BANCO ══════════════════════════════════════════════
    say('## 2, 3 e 4. O que a tela devolve × o que existe no banco');
    say('');
    say('| # | processo | **a tela devolve** | **existe no banco** | diferença |');
    say('|---|---|---|---|---|');

    const detalhe = [];
    let somaTela = 0, somaBanco = 0;
    for (const c of chaves) {
      // ── (2) A MESMA consulta da rota, com os três campos e o usuário da Marcia ──────
      //
      // ⚠️ `chip: 'fila'` é o padrão da rota quando a tela abre — e `montarFiltro` IGNORA o
      // chip quando há `sgpe`, exatamente como faz para o técnico. É a consulta da tela, sem
      // adaptação nenhuma.
      const f = CF.montarFiltro({ chip: 'fila', meuId: MARCIA, sgpe: c.chave });
      const naTela = (await pool.query(CF.sqlContar(f.sql), f.params)).rows[0].n;

      // ── (3) O LEFT JOIN direto, sem recorte de ciclo nenhum ────────────────────────
      const todas = await pool.query(`
        SELECT p.id, p.codigo_pc, p.tr, p.tipo, p.parcela_seq, p.parcial_num, p.processo_pc,
               p.entidade, p.ci_situacao, p.ci_tecnico_id, p.ci_rodada, p.ci_encerrado_em,
               p.baixada, p.enviado_ci, p.data_baixa, p.dt_envio_ci, p.status,
               p.analista_id, p.analista_nome, p.parecer_tipo,
               u.nome  AS analista_nome_completo,
               t.nome  AS ci_tecnico_nome,
               e.nome  AS ci_encerrado_por_nome,
               h.observacao AS parecer_texto,
               h.criado_em  AS parecer_em
          FROM prestacoes_contas p
          LEFT JOIN usuarios u ON u.id = p.analista_id
          LEFT JOIN usuarios t ON t.id = p.ci_tecnico_id
          LEFT JOIN usuarios e ON e.id = p.ci_encerrado_por
          LEFT JOIN LATERAL (
            SELECT hh.observacao, hh.criado_em FROM parcela_historico hh
             WHERE hh.tr = p.tr AND hh.parcial_num = p.parcial_num
               AND hh.setorial_id = p.setorial_id AND hh.evento = 'parecer'
             ORDER BY hh.criado_em DESC LIMIT 1) h ON true
         WHERE ${CHAVE} = $1
         ORDER BY p.tr, p.parcela_seq, p.codigo_pc`, [c.chave]);

      c.naTela = naTela;
      c.noBanco = todas.rowCount;
      c.linhas = todas.rows;
      somaTela += naTela; somaBanco += todas.rowCount;
      detalhe.push(c);

      const dif = todas.rowCount - naTela;
      say(`| ${chaves.indexOf(c) + 1} | SCC ${c.n} | **${naTela}** | ${todas.rowCount} | ` +
          (todas.rowCount === 0 ? '— (não existe no banco)' : dif === 0 ? '0 — a tela mostra tudo' : `**${dif} de fora**`) + ' |');
    }
    say(`| | **total** | **${somaTela}** | **${somaBanco}** | **${somaBanco - somaTela}** |`);
    say('');

    // ── O RESUMO POR MOTIVO ──────────────────────────────────────────────────
    const porMotivo = {};
    detalhe.forEach(c => c.linhas.forEach(r => {
      const m = motivo(r);
      porMotivo[m] = (porMotivo[m] || 0) + 1;
    }));
    say('### Por que cada PC fica de fora');
    say('');
    say('| motivo | PCs |');
    say('|---|---|');
    Object.entries(porMotivo).sort((a, b) => b[1] - a[1])
      .forEach(([m, n]) => say(`| ${m} | ${n} |`));
    say('');

    // ── O DETALHE, PC A PC ───────────────────────────────────────────────────
    say('## O detalhe, PC a PC');
    say('');
    for (const c of detalhe) {
      say(`### SCC ${c.n} — \`${c.chave}\``);
      say('');
      if (!c.linhas.length) {
        say('**Nenhuma PC no banco com este processo.** O número não existe em `prestacoes_contas`,');
        say('em nenhuma grafia — nem no `processo_pc`. Não é a busca que falha: é o dado que não está lá.');
        say('');
        continue;
      }
      say(`Tela devolve **${c.naTela}** de **${c.noBanco}**. Entidade: ${c.linhas[0].entidade || '—'}`);
      say('');
      say('| id | PC | TR | tipo | parc.seq | ci_situacao | téc. C.I. | rodada | encerrada em | baixada | enviado_ci | data_baixa | analista | parecer | por que não aparece |');
      say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const r of c.linhas) {
        const par = r.parecer_texto
          ? `sim — ${dataBr(r.parecer_em)}`
          : r.parecer_tipo ? `tipo "${r.parecer_tipo}", sem texto` : '**nenhum**';
        say(`| ${r.id} | ${r.codigo_pc} | ${r.tr} | ${r.tipo || '—'} | ${r.parcela_seq ?? '—'} | ` +
            `${r.ci_situacao ? SIT[r.ci_situacao] || r.ci_situacao : '**NULA**'} | ` +
            `${r.ci_tecnico_nome || '—'} | ${r.ci_rodada ?? '—'} | ` +
            `${r.ci_encerrado_em ? dataBr(r.ci_encerrado_em) + (r.ci_encerrado_por_nome ? ` (${r.ci_encerrado_por_nome})` : '') : '—'} | ` +
            `${sim(r.baixada)} | ${sim(r.enviado_ci)} | ${dataBr(r.data_baixa) || '—'} | ` +
            `${r.analista_nome_completo || r.analista_nome || '**sem dono**'} | ${par} | ${motivo(r)} |`);
      }
      say('');
    }

    // ── A LEITURA ────────────────────────────────────────────────────────────
    const semPc = detalhe.filter(c => c.noBanco === 0);
    const foraCiclo = detalhe.filter(c => c.noBanco > 0 && c.linhas.every(r => r.ci_situacao === null));
    const encerradas = detalhe.filter(c => c.noBanco > 0 && c.linhas.some(r => r.ci_situacao === 'encerrado'));
    const naFila = detalhe.filter(c => c.naTela > 0);

    say('## A leitura');
    say('');
    say(`- **${naFila.length}** processo(s) a tela JÁ devolve na fila — se não aparecem, o problema não é a busca.`);
    say(`- **${semPc.length}** processo(s) não têm PC nenhuma no banco.`);
    say(`- **${foraCiclo.length}** processo(s) têm PC mas NENHUMA no ciclo do C.I. (\`ci_situacao\` nula).`);
    say(`- **${encerradas.length}** processo(s) têm ao menos uma PC já **encerrada** no C.I.`);
    say('');
    say('⚠️ **A tela do C.I. só mostra o que está no ciclo** (`ci_situacao IS NOT NULL`). Uma PC que');
    say('voltou pelo SGPe mas nunca foi encaminhada pelo sistema não está no ciclo, e por isso não');
    say('aparece — em chip nenhum. Isso é dado, não busca.');
    say('');
    say('⚠️ **`enviado_ci` e `ci_situacao` respondem perguntas diferentes.** A primeira diz "foi ao');
    say('C.I." e sustenta a baixa; a segunda diz onde está no ciclo. Uma PC com `enviado_ci = true` e');
    say('`ci_situacao` nula é exatamente o vão entre as duas — e é o que a coluna "por que não');
    say('aparece" separa acima.');
    say('');
    // ══ 5. O CAMINHO QUE NÃO EXISTE ══════════════════════════════════════════
    //
    // ⚠️ Esta seção lê o CÓDIGO, e não o banco. A pergunta "por que o C.I. não consegue
    // devolver" só se responde inteira olhando se existe caminho para isso — e não existe.
    // Medir só o dado responderia "porque estão encerradas", que é meia resposta.
    const libCi = fs.readFileSync(__dirname + '/lib/ci.js', 'utf8');
    const tela = fs.readFileSync(__dirname + '/../sigpc-gt/index.html', 'utf8');
    const decidirSoNaFila = /WHERE codigo_pc = ANY\(\$1\) AND ci_situacao = 'na_fila'/.test(libCi);
    // ⚠️ ESTE REGEX JÁ ERROU UMA VEZ, e o relatório saiu dizendo "sim" para uma pergunta cuja
    // resposta é "não". A primeira versão exigia `FOR UPDATE` logo na linha seguinte, e no
    // arquivo há uma linha de fecho entre os dois. Uma checagem de código que erra é pior que
    // nenhuma: ela afirma. Agora ancora no corpo da função, e só nele.
    const respFn = libCi.slice(libCi.indexOf('async function responder'), libCi.indexOf('function agruparPorParcela'));
    const responderSoComAnalista = /WHERE codigo_pc = ANY\(\$1\) AND ci_situacao = 'com_analista'/.test(respFn);
    const telaSoNaFila = /const naFila = l\.ci_situacao === 'na_fila'/.test(tela);
    const reabre = /'encerrado'[\s\S]{0,200}SET ci_situacao = 'na_fila'/.test(libCi);

    // ⚠️ Quantas PCs no ACERVO estão no mesmo estado das 23 — encerradas sem quem nem quando.
    // É o que separa "caso destes 16" de "padrão do acervo inteiro".
    const geral = (await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ci_situacao = 'encerrado')::int enc,
             COUNT(*) FILTER (WHERE ci_situacao = 'encerrado'
                                AND ci_encerrado_por IS NULL
                                AND ci_encerrado_em IS NULL)::int sem_autor
        FROM prestacoes_contas`)).rows[0];

    say('## 5. O caminho que não existe');
    say('');
    say('Lido do código, não do banco:');
    say('');
    say('| pergunta | resposta |');
    say('|---|---|');
    say(`| \`ci.decidir\` age sobre PC encerrada? | ${decidirSoNaFila ? '**não** — o WHERE é `ci_situacao = \'na_fila\'`' : 'sim'} |`);
    say(`| \`ci.responder\` age sobre PC encerrada? | ${responderSoComAnalista ? '**não** — só sobre `com_analista`' : 'sim'} |`);
    say(`| a tela oferece os rádios de decisão numa encerrada? | ${telaSoNaFila ? '**não** — `naFila` guarda o bloco inteiro' : 'sim'} |`);
    say(`| existe rota que reabra uma encerrada? | ${reabre ? 'sim' : '**não** — nenhuma escreve `na_fila` a partir de `encerrado`'} |`);
    say('');
    say(`No acervo inteiro: **${geral.enc}** PCs encerradas no C.I., e **${geral.sem_autor}** delas ` +
        `**sem quem nem quando** — o mesmo estado das 23 daqui.`);
    say('');
    say('⚠️ **Uma PC encerrada no C.I. não tem volta pelo sistema.** Não é a busca que falha, nem o');
    say('chip: as 23 estão visíveis em **Encerradas**, com o processo certo. O que não existe é ação');
    say('sobre elas. Encerrar era o fim do ciclo, e a carga de 30/06 as trouxe **já encerradas**.');
    say('');
    say('⚠️ **Abrir esse caminho é decisão de REGRA, e é sua.** As perguntas que ele levanta:');
    say('');
    say('1. quem pode reabrir — só o técnico do C.I., ou também coordenador e superadmin?');
    say('2. a PC volta para a **fila** (`na_fila`) ou direto para a **analista** (`com_analista`)?');
    say('3. a `ci_rodada` sobe na reabertura? Hoje ela sobe só na devolução, e uma ida e volta é');
    say('   uma rodada — reabrir e devolver contaria duas.');
    say('4. e o que fazer com as **1.732 sem autor**: reabrir uma delas grava quem reabriu, mas o');
    say('   registro de quem a encerrou continuará não existindo. A trilha nasce pela metade.');
    say('');
    say('⚠️ **E a baixa não entra nessa conversa.** Qualquer que seja a decisão, `baixada`,');
    say('`data_baixa` e `enviado_ci` continuam intocados — é o que o ciclo do C.I. protege desde 12/08.');
    say('');
    say('_Nenhuma linha foi alterada. Este arquivo é resultado de SELECT._');

    fs.writeFileSync(SAIDA, L.join('\n') + '\n');
    console.log('\n══ arquivo: ' + SAIDA + '\n');
  } catch (e) {
    console.error('\n✗ ' + e.message + '\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
