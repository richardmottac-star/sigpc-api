// CAMINHO: sigpc-api/teste_sgpe_lote.js
//
// Testes do lote (lib/sgpe-lote.js) e da fila do job (job_sgpe_links.js).
// SEM REDE E SEM BANCO: o pg é substituído por um objeto com `.query`, e a fila é função pura.
//
// O que estes testes protegem, em uma frase cada:
//   · a chave do mapa é o valor CRU — é ela que deixa o front sem regex;
//   · a negativa não vira link nem volta para a fila;
//   · erro de rede volta, com recuo, e desiste depois de 5 tentativas.
//
// USO: node teste_sgpe_lote.js

const { montarLinks, linksDeLinhas, chavesDeValores } = require('./lib/sgpe-lote');
const { montarFila, esperaMinutos, rodar, MAX_ERROS_SEGUIDOS } = require('./job_sgpe_links');
const { ProcessoNaoEncontrado } = require('./lib/sgpe-link');

let ok = 0, falhou = 0;

function conf(passou, rotulo, detalhe) {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
}

/** Banco de mentira: devolve as linhas combinadas e guarda o que foi perguntado. */
function bancoFalso(linhas) {
  const chamadas = [];
  return { chamadas, query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: linhas }; } };
}

const URL_2146 = 'https://sgpe.sea.sc.gov.br/cpav/visualizarDocumentosProcesso.do'
  + '?processoPK=2150,10068,2020&itemAba=aba_pecas';

(async () => {

  console.log('\n═══ 1. CHAVE CRUA — o ponto da mudança ═══');
  {
    // As duas grafias do MESMO processo têm de virar duas chaves, apontando para a mesma url.
    // É o que permite ao front fazer links[p.processo_pc] sem normalizar nada.
    const db = bancoFalso([{ sigla: 'SCC', numero_oficial: 2146, ano: 2020, nu_processo: 2150, cd_orgaosetor: 10068 }]);
    const { links } = await montarLinks(db, ['SCC2146/2020', 'SCC 00002146/2020']);
    conf(links['SCC2146/2020'] === URL_2146, 'chave é o valor cru colado', JSON.stringify(Object.keys(links)));
    conf(links['SCC 00002146/2020'] === URL_2146, 'a outra grafia é chave própria, mesma url');
    conf(links['SCC 2146/2020'] === undefined, 'a forma canônica NÃO é chave');
    conf(Object.keys(links).length === 2, 'duas chaves para o mesmo processo');
  }

  console.log('\n═══ 2. DEDUPE — o banco recebe a tripla uma vez só ═══');
  {
    const db = bancoFalso([]);
    await montarLinks(db, ['SCC2146/2020', 'SCC 00002146/2020', 'SCC2146/2020', 'FCEE264/2017']);
    const [siglas] = db.chamadas[0].params;
    conf(db.chamadas.length === 1, 'uma query só');
    conf(siglas.length === 2, `2 triplas distintas na query (obtido ${siglas.length})`);
  }

  console.log('\n═══ 3. O QUE NÃO É PROCESSO NEM CHEGA AO BANCO ═══');
  {
    const db = bancoFalso([]);
    const { links, semLink } = await montarLinks(db, ['Aguardando protocolo', '-', null, '', 'SCC 6579']);
    conf(db.chamadas.length === 0, 'nenhuma query disparada');
    conf(Object.keys(links).length === 0 && semLink.length === 0, 'nem links nem semLink');
  }
  {
    // A trava de ambiguidade continua valendo aqui: ADR não é órgão, ADR22 é.
    const db = bancoFalso([]);
    await montarLinks(db, ['ADR223151/2017']);
    conf(db.chamadas.length === 0, 'ambíguo colado não vai ao banco');
  }

  console.log('\n═══ 4. NEGATIVA NÃO VIRA LINK ═══');
  {
    // A query filtra `nu_processo IS NOT NULL`, então a linha de negativa nem volta.
    const db = bancoFalso([]);
    const { links, semLink } = await montarLinks(db, ['SCC18870/2026']);
    conf(/nu_processo IS NOT NULL/.test(db.chamadas[0].sql), 'a query filtra nu_processo IS NOT NULL');
    conf(Object.keys(links).length === 0, 'sem link');
    conf(semLink[0] === 'SCC18870/2026', 'entra em semLink com o valor cru');
  }
  {
    // Cinto e suspensório: se uma linha com NULL escapasse, a url não pode sair com "null".
    const db = bancoFalso([{ sigla: 'SCC', numero_oficial: 18870, ano: 2026, nu_processo: null, cd_orgaosetor: null }]);
    const { links } = await montarLinks(db, ['SCC18870/2026']);
    const url = links['SCC18870/2026'];
    conf(!url || !/null/.test(url), 'nenhuma url com "null" dentro', url);
  }

  console.log('\n═══ 5. linksDeLinhas — o atalho das rotas ═══');
  {
    const db = bancoFalso([{ sigla: 'SCC', numero_oficial: 2146, ano: 2020, nu_processo: 2150, cd_orgaosetor: 10068 }]);
    const linhas = [{ processo_pc: 'SCC2146/2020', processo_mae: 'Aguardando protocolo' }];
    const links = await linksDeLinhas(db, linhas, ['processo_pc', 'processo_mae']);
    conf(links['SCC2146/2020'] === URL_2146, 'colhe processo_pc');
    conf(Object.keys(links).length === 1, 'ignora o campo que não é processo');
  }
  {
    const porBruto = chavesDeValores(['SCC2146/2020', 'lixo', null]);
    conf(porBruto.size === 1 && porBruto.get('SCC2146/2020').numero === 2146, 'chavesDeValores devolve Map por valor cru');
  }

  console.log('\n═══ 6. FILA DO JOB — estados definitivos não voltam ═══');
  {
    const P = { sigla: 'SCC', numero: 1, ano: 2020 };
    const alvos = new Map([
      ['SCC 1/2020', P], ['SCC 2/2020', P], ['SCC 3/2020', P], ['SCC 4/2020', P], ['SCC 5/2020', P],
    ]);
    const agora = new Date('2026-08-08T12:00:00Z');
    const existentes = new Map([
      ['SCC 2/2020', { origem: 'SGPE', tentativas: 1, ultima_tentativa: agora }],
      ['SCC 3/2020', { origem: 'CONFERIDO', tentativas: 0, ultima_tentativa: null }],
      ['SCC 4/2020', { origem: 'NAO_ENCONTRADO', tentativas: 1, ultima_tentativa: agora }],
      ['SCC 5/2020', { origem: 'ERRO', tentativas: 1, ultima_tentativa: new Date('2026-08-08T11:59:00Z') }],
    ]);
    const fila = montarFila(alvos, existentes, { agora }).map(f => f.chave);
    conf(fila.includes('SCC 1/2020'), 'nunca tentado entra');
    conf(!fila.includes('SCC 2/2020'), 'SGPE resolvido não volta');
    conf(!fila.includes('SCC 3/2020'), 'CONFERIDO não volta');
    conf(!fila.includes('SCC 4/2020'), 'NAO_ENCONTRADO não volta — o ponto da negativa');
    conf(!fila.includes('SCC 5/2020'), 'ERRO de 1 min atrás ainda está no recuo');
  }

  console.log('\n═══ 7. FILA DO JOB — erro de rede volta, com recuo ═══');
  {
    const P = { sigla: 'SCC', numero: 1, ano: 2020 };
    const alvos = new Map([['SCC 9/2020', P]]);
    const agora = new Date('2026-08-08T12:00:00Z');
    const erroAntigo = (tentativas, minutosAtras) => new Map([['SCC 9/2020', {
      origem: 'ERRO', tentativas, ultima_tentativa: new Date(agora - minutosAtras * 60000),
    }]]);

    const na = (ex, opts) => montarFila(alvos, ex, { agora, ...opts }).length === 1;
    conf(na(erroAntigo(1, 20)), '1ª falha, 20 min depois -> volta (recuo de 15 min)');
    conf(!na(erroAntigo(2, 20)), '2ª falha, 20 min depois -> espera (recuo de 60 min)');
    conf(na(erroAntigo(2, 90)), '2ª falha, 90 min depois -> volta');
    conf(!na(erroAntigo(5, 99999)), '5 falhas -> desiste, por mais tempo que passe');
    conf(na(erroAntigo(5, 0), { retentarErros: true }), '--retentar-erros ignora recuo e teto');
    conf(!na(erroAntigo(1, 99999), { somenteNovos: true }), '--somente-novos ignora ERRO');
  }

  console.log('\n═══ 8. RECUO ═══');
  {
    conf(esperaMinutos(1) === 15, '1ª tentativa -> 15 min');
    conf(esperaMinutos(2) === 60, '2ª -> 60 min');
    conf(esperaMinutos(3) === 360, '3ª -> 6 h');
    conf(esperaMinutos(4) === 1440, '4ª -> 24 h');
    conf(esperaMinutos(5) === null, '5ª -> desiste');
    conf(esperaMinutos(0) === 15, 'defensivo: 0 tentativas cai no primeiro degrau');
  }

  console.log('\n═══ 9. DISJUNTOR — erro em série aborta a rodada ═══');
  {
    // Banco de mentira que devolve 30 processos como acervo e cache vazio.
    const acervo = Array.from({ length: 30 }, (_, i) => ({ v: `SCC${1000 + i}/2020` }));
    // ⚠️ O DUBLÊ PRECISOU DE `connect` A PARTIR DE 30/08: `rodar()` passou a tomar a trava de
    // rodada única (lib/trava.js), e a trava vive numa CONEXÃO própria, tomada do pool. Um
    // dublê só com `query` deixou de ser um pool. Foi o teste que apanhou a mudança — que é o
    // que se espera dele; o `travas` abaixo guarda o que a trava fez, para o caso (c).
    const travas = [];
    const dbFalso = (pegaTrava = true) => ({
      query: async (sql) => {
        if (/FROM prestacoes_contas/.test(sql)) return { rows: acervo };
        if (/FROM sgpe_processo_ref/.test(sql)) return { rows: [] };
        return { rows: [] };                                  // os INSERTs
      },
      connect: async () => ({
        query: async (sql, p) => {
          travas.push(sql.replace(/\s+/g, ' ').trim() + '|' + (p || []).join(','));
          return { rows: [{ ok: /try_advisory/.test(sql) ? pegaTrava : true }] };
        },
        release: () => travas.push('release'),
      }),
    });
    const calado = () => {};

    // (a) SGPe fora do ar: todo mundo dá erro de rede.
    const e1 = await rodar({
      pool: dbFalso(), log: calado, resolver: async () => { throw new Error('ECONNRESET'); },
    });
    conf(e1.abortadoPorErros === true, `abortou com ${MAX_ERROS_SEGUIDOS} erros seguidos`);
    conf(e1.erros === MAX_ERROS_SEGUIDOS, `parou em ${MAX_ERROS_SEGUIDOS} e não nos 30`, `erros=${e1.erros}`);

    // (b) Erro intercalado com sucesso NÃO pode abortar — instabilidade pontual é normal.
    let n = 0;
    const e2 = await rodar({
      pool: dbFalso(), log: calado,
      resolver: async () => {
        n++;
        if (n % 3 === 0) throw new Error('timeout');
        return { nuProcesso: 1, cdOrgaosetor: 10068, ano: 2020 };
      },
    });
    conf(e2.abortadoPorErros === false, 'erro intercalado não aborta');
    conf(e2.processados === 30, 'processou os 30', `processados=${e2.processados}`);

    // (c) "Não encontrado" é resposta VÁLIDA do SGPe — não conta para o disjuntor.
    const e3 = await rodar({
      pool: dbFalso(), log: calado,
      resolver: async () => { throw new ProcessoNaoEncontrado('nao existe'); },
    });
    conf(e3.abortadoPorErros === false, '30 "não encontrado" seguidos não abortam');
    conf(e3.naoEncontrados === 30, 'todos viraram negativa', `naoEncontrados=${e3.naoEncontrados}`);
  }

  console.log('\n═══ 10. A TRAVA DE RODADA ÚNICA (30/08/2026) ═══');
  {
    // ⚠️ ATÉ 30/08 NÃO HAVIA TRAVA NENHUMA aqui. Uma rodada que passasse da hora era
    // atropelada pela do cron seguinte, e as duas resolviam os MESMOS processos — a fila sai
    // de `montarFila`, que lê o cache, e o cache só muda quando cada processo termina.
    const acervo = Array.from({ length: 5 }, (_, i) => ({ v: `SCC${2000 + i}/2020` }));
    const feito = [];
    const db = (pega) => ({
      query: async (sql) => {
        if (/FROM prestacoes_contas/.test(sql)) return { rows: acervo };
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql, p) => {
          feito.push(sql.replace(/\s+/g, ' ').trim().split('(')[0] + '|' + (p || []).join(','));
          return { rows: [{ ok: /try_advisory/.test(sql) ? pega : true }] };
        },
        release: () => feito.push('release'),
      }),
    });
    const calado = () => {};
    let resolveu = 0;

    // (a) trava livre: a rodada corre, e a trava é tomada e devolvida.
    feito.length = 0; resolveu = 0;
    const a = await rodar({ pool: db(true), log: calado, resolver: async () => { resolveu++; return { nuProcesso: 1, cdOrgaosetor: 1, ano: 2020 } } });
    conf(a.semTrava === false, 'com a trava livre, a rodada corre');
    conf(resolveu === 5, 'e resolve os 5', `resolveu=${resolveu}`);
    conf(feito[0].startsWith('SELECT pg_try_advisory_lock'), 'tomou a trava ANTES de qualquer trabalho');
    conf(feito.some(x => x.startsWith('SELECT pg_advisory_unlock')), 'e a devolveu no fim');

    // (b) trava ocupada: DESISTE, e não toca em nada.
    feito.length = 0; resolveu = 0;
    const b = await rodar({ pool: db(false), log: calado, resolver: async () => { resolveu++; return {} } });
    conf(b.semTrava === true, 'com a trava ocupada, a rodada desiste');
    // ⚠️ É AQUI QUE A TRAVA VALE: zero consultas ao SGPe, e não "as mesmas de novo".
    conf(resolveu === 0, 'e NÃO consulta o SGPe nenhuma vez', `resolveu=${resolveu}`);
    conf(b.processados === 0 && b.resolvidos === 0, 'nem grava nada');
    conf(feito.includes('release'), 'e devolve a conexão ao pool na hora');

    // (c) o dry-run não toma a trava — olhar a fila enquanto o job corre tem de funcionar.
    feito.length = 0;
    const c = await rodar({ pool: db(false), log: calado, dryRun: true });
    conf(c.semTrava === false, 'o dry-run roda mesmo com a trava ocupada');
    conf(!feito.some(x => x.includes('advisory')), 'e nem chega a pedir a trava');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);

})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
