// CAMINHO: sigpc-api/teste_sgpe_situacao.js
//
// A FASE 3 do SGPe: a sincronização automática. SEM BANCO E SEM REDE — o que se prova aqui é a
// REGRA (lib/sgpe-situacao.js), a TRAVA (lib/trava.js) e a forma do que os dois jobs escrevem.
//
// ⚠️ NÃO SE TESTA `rodar()` CONTRA O BANCO REAL AQUI. Ele abre e fecha transação por conta
// própria, e é exatamente a armadilha 11 do projeto: o COMMIT interno confirmaria a transação
// externa e o ROLLBACK do teste não teria mais o que desfazer. Em 12/08 isso gravou 7 PCs e 14
// mensagens em produção num teste que parecia isolado.

const fs = require('fs');
const path = require('path');
const sit = require('./lib/sgpe-situacao');
const trava = require('./lib/trava');

let ok = 0, falhou = 0;
const conf = (v, r) => { if (v) { ok++; console.log('  OK    ' + r) } else { falhou++; console.log('  FALHA  ' + r) } };

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. O RODIZIO — quem nunca foi checado vem primeiro ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const alvos = new Map([
    ['SCC 100/2024', { sigla: 'SCC', numero: 100, ano: 2024 }],
    ['SCC 200/2024', { sigla: 'SCC', numero: 200, ano: 2024 }],
    ['SCC 300/2024', { sigla: 'SCC', numero: 300, ano: 2024 }],
    ['SCC 400/2024', { sigla: 'SCC', numero: 400, ano: 2024 }],
  ]);
  const checados = new Map([
    ['SCC 100/2024', new Date('2026-08-29T10:00:00Z')],
    ['SCC 300/2024', new Date('2026-08-28T10:00:00Z')],   // o mais antigo dos checados
  ]);
  const f = sit.montarRodizio(alvos, checados);
  conf(f.length === 4, 'a fila tem todo o universo');
  // ⚠️ NULLS FIRST NAO E DETALHE DE ORDENACAO. Na primeira rodada TODOS sao nulos, e e isso
  // que faz o sistema cobrir o acervo inteiro antes de comecar a repetir. Com os nulos no fim,
  // os processos nunca vistos seriam os ultimos da vida.
  conf(f[0].chave === 'SCC 200/2024' && f[1].chave === 'SCC 400/2024',
       'os nunca checados vem primeiro, em ordem de chave');
  conf(f[2].chave === 'SCC 300/2024', 'depois o checado ha mais tempo');
  conf(f[3].chave === 'SCC 100/2024', 'e por ultimo o mais recente');

  // ⚠️ DESEMPATE PELA CHAVE: numa carga inicial centenas ficam com o MESMO carimbo, e sem
  // desempate a ordem entre elas muda a cada leitura — a mesma rodada revisitaria uns e nunca
  // chegaria a outros.
  const mesma = new Date('2026-08-30T00:00:00Z');
  const g = sit.montarRodizio(alvos, new Map([...alvos.keys()].map(k => [k, mesma])));
  conf(g.map(x => x.chave).join('|') === 'SCC 100/2024|SCC 200/2024|SCC 300/2024|SCC 400/2024',
       'com carimbos iguais o desempate e a chave — a ordem nao balanca entre rodadas');
  const g2 = sit.montarRodizio(alvos, new Map([...alvos.keys()].reverse().map(k => [k, mesma])));
  conf(g.map(x => x.chave).join('|') === g2.map(x => x.chave).join('|'),
       'e nao depende da ordem em que o banco devolveu as linhas');

  conf(sit.montarRodizio(new Map(), new Map()).length === 0, 'universo vazio da fila vazia');
  // Quem esta na situacao e sumiu do acervo simplesmente nao entra — nao ha o que consultar.
  const h = sit.montarRodizio(new Map([['SCC 100/2024', { sigla: 'SCC', numero: 100, ano: 2024 }]]),
                              new Map([['SCC 999/1999', new Date()]]));
  conf(h.length === 1 && h[0].chave === 'SCC 100/2024', 'situacao orfa nao entra na fila');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. O QUE SE GRAVA DE CADA RESPOSTA ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const p = { sigla: 'SCC', numero: 9622, ano: 2024 };
  const bom = {
    ok: true,
    processo: { situacao_portal: 'ABERTO', estado_portal: 'Em andamento' },
    atual: { situacao: 'EM_TRANSITO', setor_sigla: 'FCEE/SAPRE', setor_nome: 'Setor de Analise', desde: '2025-01-27', dias: 580, ordem: 2 },
    tramitacoes: [{ ordem: 1 }, { ordem: 2 }],
  };
  const l = sit.linhaDaSituacao(p, bom);
  conf(l.resultado === sit.RESULTADOS.OK, 'a resposta boa vira OK');
  conf(l.situacao_portal === 'ABERTO' && l.estado_portal === 'Em andamento', 'com a situacao do portal');
  conf(l.posicao === 'EM_TRANSITO', 'e a posicao — ONDE_ESTA ou EM_TRANSITO');
  conf(l.setor_sigla === 'FCEE/SAPRE' && l.dias_no_setor === 580, 'o setor e os dias nele');
  conf(l.desde === '2025-01-27', 'e desde quando');
  conf(l.tramitacoes === 2, 'e quantas tramitacoes');
  conf(l.erro_motivo === null, 'sem motivo de erro');

  // ⚠️ `dias` NULO NAO VIRA ZERO — e o transito sem tramite anterior, de onde nao ha de quando
  // contar. Zero afirmaria que o processo saiu hoje.
  const semDias = sit.linhaDaSituacao(p, { ...bom, atual: { situacao: 'EM_TRANSITO', setor_sigla: 'X', dias: null } });
  conf(semDias.dias_no_setor === null, 'dias nulo continua nulo, e nao vira zero');

  for (const erro of ['NAO_ENCONTRADO', 'SIGILOSO', 'SIGLA_NAO_CADASTRADA', 'REDE']) {
    const e = sit.linhaDaSituacao(p, { erro, motivo: 'x' });
    conf(e.resultado === erro, `o erro ${erro} vira resultado ${erro}`);
    conf(e.setor_sigla === null && e.posicao === null, `  e ${erro} nao inventa setor nem posicao`);
  }
  const semNada = sit.linhaDaSituacao(p, null);
  conf(semNada.resultado === sit.RESULTADOS.REDE, 'resposta nenhuma conta como REDE');
  const cortado = sit.linhaDaSituacao(p, { erro: 'REDE', motivo: 'x'.repeat(900) });
  conf(cortado.erro_motivo.length === 300, 'o motivo e cortado em 300 — mensagem de rede pode vir enorme');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 3. REDE NAO APAGA O QUE JA SE SABIA ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ ESTA E A DECISAO MAIS IMPORTANTE DA LIB. Se o portal cair no meio de uma rodada,
  // marcar 300 processos como "sem situacao" apagaria a ultima leitura boa de todos eles de
  // uma vez — e o rodizio so voltaria a cada um depois de um ciclo inteiro.
  conf(!sit.RESULTADOS_QUE_SUBSTITUEM.includes(sit.RESULTADOS.REDE),
       'REDE nao esta na lista dos que substituem a situacao');
  for (const r of ['OK', 'NAO_ENCONTRADO', 'SIGILOSO', 'SIGLA_NAO_CADASTRADA'])
    conf(sit.RESULTADOS_QUE_SUBSTITUEM.includes(r), `${r} substitui — e resposta do portal`);

  const sql = sit.SQL_GRAVAR_SITUACAO;
  conf(/ON CONFLICT \(sigla, numero_oficial, ano\) DO UPDATE/.test(sql),
       'o upsert e por (sigla, numero_oficial, ano) — rodar duas vezes nao duplica');
  // Cada campo da situacao e guardado pelo CASE; so o carimbo e o motivo passam sempre.
  const camposGuardados = ['resultado', 'situacao_portal', 'estado_portal', 'posicao',
                           'setor_sigla', 'setor_nome', 'dias_no_setor', 'desde', 'tramitacoes'];
  for (const c of camposGuardados)
    conf(new RegExp(`${c}\\s*=\\s*CASE WHEN EXCLUDED\\.resultado = ANY`).test(sql),
         `  ${c} so e sobrescrito por uma resposta de verdade`);
  conf(/checado_em      = NOW\(\)/.test(sql), 'o carimbo e sempre atualizado — a tentativa aconteceu');
  conf(/erro_motivo     = EXCLUDED\.erro_motivo/.test(sql), 'e o motivo do erro tambem, sempre');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. A CHAVE DO TRAMITE ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const sql = sit.SQL_GRAVAR_TRAMITE;
  // ⚠️ A ORDEM ENTRA NA CHAVE. Chavear por data de recebimento nao serviria: ha tramite com
  // data nula (o aberto) e ha DOIS tramites no mesmo dia — medidos, tres com permanencia zero.
  conf(/ON CONFLICT \(sigla, numero_oficial, ano, ordem\) DO UPDATE/.test(sql),
       'a chave do tramite inclui a ORDEM — rodar duas vezes nao duplica linha');
  conf(!/dt_recebto\)/.test(sql.split('ON CONFLICT')[1] || ''), 'e nao e a data de recebimento');

  const p = { sigla: 'SCC', numero: 9622, ano: 2024 };
  const t = { ordem: 2, setor_sigla: 'FCEE/SAPRE', setor_nome: 'n', cd_orgao: 7, dt_recebto: null,
              dt_encaminha: null, permanencia_dias: null, quem_encaminhou: 'Fulano', parecer: 'p'.repeat(5000) };
  const par = sit.paramsTramite(p, t);
  conf(par[0] === 'SCC' && par[1] === 9622 && par[2] === 2024 && par[3] === 2, 'os parametros comecam pela chave');
  conf(par[9] === null, 'permanencia nula segue nula — nao vira zero');
  conf(par[11].length === 2000, 'o parecer e cortado em 2000');
  conf(sit.paramsTramite(p, { ...t, parecer: null })[11] === null, 'e parecer nulo continua nulo');

  const ps = sit.paramsSituacao(sit.linhaDaSituacao(p, { erro: 'REDE' }));
  // ⚠️ A LISTA CONTINUA NO INDICE 13 — ou seja, `$14` —, E E ISSO QUE IMPORTA. O `assunto`
  // entrou em 31/08/2026 e foi para o FIM (`$15`) de proposito: posto na posicao 14, ele
  // empurraria o `RESULTADOS_QUE_SUBSTITUEM`, que aparece ONZE vezes no SQL do upsert — onze
  // `CASE` passariam a comparar contra a coluna errada, e sem erro nenhum.
  conf(Array.isArray(ps[13]), 'a lista dos que substituem segue no $14');
  conf(ps.length === 15, 'e o assunto e o $15, no fim', ps.length);
  conf(ps[14] === null, 'que num erro de REDE vem nulo', ps[14]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 5. AS DUAS TABELAS — a forma, e o que NAO tem ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ SEM CHAVE ESTRANGEIRA: o historico tem de sobreviver a qualquer limpeza de
  // sgpe_processo_ref ou de prestacoes_contas. Mesmo motivo do parcela_historico.executado_por.
  conf(!/REFERENCES/i.test(sit.DDL_SITUACAO), 'sgpe_situacao nao tem FK');
  conf(!/REFERENCES/i.test(sit.DDL_TRAMITACAO), 'sgpe_tramitacao nao tem FK');
  conf(/CREATE TABLE IF NOT EXISTS/.test(sit.DDL_SITUACAO) && /CREATE TABLE IF NOT EXISTS/.test(sit.DDL_TRAMITACAO),
       'as duas nascem com IF NOT EXISTS');
  conf(/PRIMARY KEY \(sigla, numero_oficial, ano\)/.test(sit.DDL_SITUACAO), 'a chave da situacao e a tripla');
  conf(/PRIMARY KEY \(sigla, numero_oficial, ano, ordem\)/.test(sit.DDL_TRAMITACAO), 'a do tramite tem a ordem');
  // ⚠️ O NULLS FIRST TEM DE ESTAR NO INDICE, nao so na consulta: um indice ASC comum guarda os
  // nulos no fim, e o planejador o ignoraria justamente na parte que importa.
  conf(/checado_em ASC NULLS FIRST/.test(sit.DDL_INDICE), 'o indice do rodizio e ASC NULLS FIRST');
  for (const ddl of [sit.DDL_SITUACAO, sit.DDL_TRAMITACAO, sit.DDL_INDICE])
    conf(!/DROP|TRUNCATE|DELETE/i.test(ddl), 'nenhum DDL derruba coisa alguma');

  // O universo sao os DOIS campos de processo: 1.421 processos aparecem so na mae.
  conf(/processo_pc/.test(sit.SQL_UNIVERSO) && /processo_mae/.test(sit.SQL_UNIVERSO) && /UNION/.test(sit.SQL_UNIVERSO),
       'o universo e processo_pc UNIAO processo_mae');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 6. A TRAVA DE RODADA UNICA ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const chaves = Object.values(trava.CHAVES);
  conf(chaves.length === new Set(chaves).size, 'as chaves do catalogo sao distintas entre si');
  conf(chaves.every(c => Number.isInteger(c)), 'e sao inteiras');

  // Dublê de pool: prova que a trava pega, solta, e devolve a conexao nos dois caminhos.
  const feito = [];
  const poolFalso = (resposta) => ({
    connect: async () => ({
      query: async (s, p) => { feito.push(s.replace(/\s+/g, ' ').trim() + '|' + (p || []).join(',')); return { rows: [{ ok: resposta }] } },
      release: () => feito.push('release'),
    }),
  });

  (async () => {
    feito.length = 0;
    const t = await trava.tomar(poolFalso(true), trava.CHAVES.SGPE_LINKS);
    conf(t.pegou === true, 'com a trava livre, pegou');
    // ⚠️ `pg_try_advisory_lock`, NUNCA o sem `try`: o sem try FICA ESPERANDO, e num cron isso
    // empilharia processos em vez de descarta-los.
    conf(feito[0].startsWith('SELECT pg_try_advisory_lock'), 'usou pg_try_advisory_lock, nao pg_advisory_lock');
    conf(feito[0].endsWith('|' + trava.CHAVES.SGPE_LINKS), 'com a chave do catalogo');
    // ⚠️ E A CONEXAO FICA PRESA ENQUANTO A TRAVA VIVE. Devolvida ao pool, outro trecho a
    // receberia com a trava presa, e um unlock de qualquer lugar a soltaria no meio da rodada.
    conf(!feito.includes('release'), 'e a conexao NAO foi devolvida ao pool — a trava vive nela');
    await t.soltar();
    conf(feito.some(x => x.startsWith('SELECT pg_advisory_unlock')), 'soltar() devolve a trava');
    conf(feito[feito.length - 1] === 'release', 'e so entao devolve a conexao');
    const antes = feito.length;
    await t.soltar();
    conf(feito.length === antes, 'soltar() duas vezes nao solta duas vezes');

    feito.length = 0;
    const t2 = await trava.tomar(poolFalso(false), trava.CHAVES.SGPE_SITUACAO);
    conf(t2.pegou === false, 'com a trava ocupada, nao pegou');
    conf(feito.includes('release'), 'e a conexao volta ao pool na hora — sem trava ela nao serve');
    await t2.soltar();
    conf(!feito.some(x => x.includes('unlock')), 'e soltar() sem ter pegado nao solta trava alheia');

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n=== 7. OS DOIS JOBS ===');
    // ═══════════════════════════════════════════════════════════════════════
    const jobSit = fs.readFileSync(path.join(__dirname, 'job_sgpe_situacao.js'), 'utf8');
    const jobLnk = fs.readFileSync(path.join(__dirname, 'job_sgpe_links.js'), 'utf8');
    const mig = fs.readFileSync(path.join(__dirname, 'migracao_sgpe_situacao_20260830.js'), 'utf8');

    conf(/trava\.tomar\(db, trava\.CHAVES\.SGPE_SITUACAO\)/.test(jobSit), 'o job da situacao toma a trava');
    // ⚠️ O job_sgpe_links NAO TINHA TRAVA NENHUMA ate 30/08. Uma rodada atrasada era atropelada
    // pela seguinte e as duas resolviam os MESMOS processos.
    conf(/trava\.tomar\(db, trava\.CHAVES\.SGPE_LINKS\)/.test(jobLnk), 'e o dos links tambem passou a tomar');
    conf(/await t\.soltar\(\)/.test(jobSit) && /await t\.soltar\(\)/.test(jobLnk),
         'os dois soltam no finally — inclusive quando a rodada morre no meio');
    conf(/dryRun \? \{ pegou: true/.test(jobLnk),
         'o dry-run dos links nao toma a trava — olhar a fila enquanto o job corre tem de funcionar');

    // ⚠️ O `finally` PROCURADO E O ULTIMO, nao o primeiro. O job da situacao tem um `finally`
    // interno por processo (o `cli.release()` da transacao de cada um) que vem antes; casar no
    // primeiro dava falso negativo e me fez quase "consertar" codigo que estava certo.
    const jobs = { 'job_sgpe_situacao.js': jobSit, 'job_sgpe_links.js': jobLnk };
    for (const [nome, src] of Object.entries(jobs))
      conf(/soltar\(\)/.test(src.slice(src.lastIndexOf('} finally {'))),
           `${nome}: a trava sai no ULTIMO finally — solta mesmo quando a rodada morre no meio`);

    conf(/LOTE_PADRAO = 300/.test(jobSit), 'o lote padrao e 300');
    // ⚠️ 180 ms NAO E ENFEITE: o portal e publico e gratuito, sem contrato por tras.
    conf(/PAUSA_PADRAO = 180/.test(jobSit), 'e a pausa padrao e 180 ms');
    conf(/gravar: argv\.includes\('--gravar'\)/.test(jobSit), 'dry-run e o padrao; so --gravar escreve');
    conf(/if \(!gravar\)/.test(jobSit) && jobSit.indexOf('if (!gravar)') < jobSit.indexOf('portal.consultar'),
         'e o dry-run sai ANTES de consultar o portal — dry-run que bate na rede nao e dry-run');
    conf(/MAX_ERROS_SEGUIDOS = 10/.test(jobSit), 'ha disjuntor de 10 erros seguidos');
    {
      const i = jobSit.indexOf('errosSeguidos = 0');
      conf(i > 0 && /NAO_ENCONTRADO[\s\S]{0,200}errosSeguidos = 0/.test(jobSit),
           'e NAO_ENCONTRADO zera o contador — e o portal respondendo, e respondendo certo');
    }
    // ⚠️ UMA TRANSACAO POR PROCESSO. Uma pela rodada inteira seguraria 10 mil linhas por um
    // minuto de rede e perderia tudo num erro no fim.
    conf(/for \(const \{ chave, p \} of fila\)[\s\S]*?await cli\.query\('BEGIN'\)/.test(jobSit),
         'a transacao e por processo, nao pela rodada');
    conf(/ROLLBACK/.test(jobSit), 'com ROLLBACK no erro');

    // A migracao: dry-run por padrao, conferencias contra a foto, reversao antes do commit.
    conf(/const GRAVAR = process\.argv\.includes\('--gravar'\)/.test(mig), 'a migracao e dry-run por padrao');
    // ⚠️ O DRY-RUN RODA O DDL, e a checagem mudou por isso (30/08). No Postgres o DDL é
    // TRANSACIONAL: criar dentro do BEGIN e desfazer no ROLLBACK não deixa rastro, e é o que
    // permite mostrar as CONFERÊNCIAS DE VERDADE antes de alguém autorizar a gravação. Um
    // dry-run que sai antes de criar só promete o que as conferências fariam.
    // O que separa os dois modos é o COMMIT — então é o COMMIT que se protege aqui.
    conf(mig.indexOf('DDL_SITUACAO') < mig.indexOf('if (!GRAVAR)'),
         'o dry-run roda o DDL e SÓ DEPOIS decide — é assim que ele mostra as conferências');
    conf((mig.match(/cli\.query\('COMMIT'\)/g) || []).length === 1, 'há UM COMMIT só no arquivo');
    {
      const iG = mig.indexOf('if (!GRAVAR)'), iC = mig.indexOf("cli.query('COMMIT')");
      const bloco = mig.slice(iG, iG + 1200);
      conf(iG > 0 && iC > iG, 'e ele vem depois do desvio do dry-run');
      conf(/ROLLBACK/.test(bloco), 'que sai por ROLLBACK');
      // A prova do rollback vem de FORA da transação — perguntar à mesma conexão seria
      // perguntar a quem acabou de desfazer.
      conf(/db\.query\(/.test(bloco), 'e confere por outra conexão se as tabelas sobraram');
    }
    conf(/escreverReversao/.test(mig), 'grava JSON de reversao');
    conf(mig.indexOf('escreverReversao') < mig.lastIndexOf("cli.query('COMMIT')"),
         'e grava ANTES do COMMIT — depois dele o processo pode morrer (armadilha 26)');
    conf(/if \(mau\) \{[\s\S]{0,120}ROLLBACK/.test(mig), 'conferencia que falha derruba a transacao');
    conf(/nenhuma tabela anterior mudou de tamanho/.test(mig), 'e ha conferencia de que nada mais mudou');
    conf(!/DROP TABLE|TRUNCATE/.test(mig.split('desfazer:')[0]), 'a migracao nao derruba nada');

    // ⚠️ A REVERSAO E POR LISTA EXPLICITA DE CHAVES (armadilha 12): reverter por condicao
    // derivada casaria o que rodadas anteriores gravaram. Em 12/08 isso carimbou 14.639 linhas.
    conf(/chaves: fila\.slice\(0, e\.consultados\)\.map/.test(jobSit),
         'a reversao da rodada guarda a LISTA das chaves tocadas, nao uma condicao');

    console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
    process.exit(falhou ? 1 : 0);
  })();
}
