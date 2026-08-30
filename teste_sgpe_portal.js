// CAMINHO: sigpc-api/teste_sgpe_portal.js
//
// O CLIENTE DO PORTAL DO SGPe — a regra mora em `lib/sgpe-portal.js`, e é ela que se testa.
//
// USO: node teste_sgpe_portal.js
//
// ⚠️ SEM REDE. Todo teste aqui usa `interpretar()` sobre um JSON de mentira, ou um `fetchImpl`
// dublê. O portal é sistema de terceiro: um teste que dependesse dele falharia por
// instabilidade alheia, e uma suíte que falha por motivo alheio deixa de ser lida — foi o que
// aconteceu com as 19 checagens do front. A prova contra o portal DE VERDADE está no relatório
// da rodada de 30/08, com três processos reais.

const fs = require('fs');
const p = require('./lib/sgpe-portal');

let ok = 0, falhou = 0;
const conf = (x, r, d) => { x ? ok++ : falhou++; console.log(`  ${x ? 'OK  ' : 'FALHA'}  ${r}${x || !d ? '' : `   [${d}]`}`); };
const secao = (t) => console.log(`\n=== ${t} ===`);

secao('1. O CORPO DO PEDIDO');
{
  const m = p.montarCorpo('SCC', '2146', '2020');
  // ⚠️ O numero vai com padStart(5,'0') — sem os zeros o portal nao acha.
  conf(m.corpo.nuProcessoOficial === '02146', 'o numero vai com padStart(5)');
  // ⚠️ E o cdOrgaoSetor e o CODIGO, nunca a sigla. Sai do mapa ORGAOS da sgpe-link.
  conf(m.corpo.cdOrgaoSetor === 10068, 'o cdOrgaoSetor e o codigo numerico', String(m.corpo.cdOrgaoSetor));
  conf(typeof m.corpo.cdOrgaoSetor === 'number', 'e e numero, nao texto');
  conf(m.corpo.nuAno === 2020, 'o ano vai como numero');
  conf(p.montarCorpo('SCC', '123456', '2020').corpo.nuProcessoOficial === '123456',
       'numero com mais de 5 digitos nao e cortado');
  conf(p.montarCorpo('scc', '00002146', '2020').corpo.nuProcessoOficial === '02146',
       'caixa e zeros a esquerda passam pela normalizacao da sgpe-link');
}

secao('2. A SIGLA FORA DO MAPA NAO VAI A REDE');
{
  // ⚠️ E A REGRA CENTRAL DESTA LIB. O portal NAO distingue "orgao inexistente" de "processo
  // inexistente": as duas coisas voltam como "Nao foi possivel encontrar o Processo". Deixar a
  // sigla desconhecida chegar la faria o sistema dizer que o processo nao existe quando o que
  // falta e a sigla no NOSSO mapa.
  const r = p.montarCorpo('XPTO', '1', '2020');
  conf(r.erro === p.ERROS.SIGLA_NAO_CADASTRADA, 'sigla fora do mapa -> SIGLA_NAO_CADASTRADA');
  conf(r.sigla === 'XPTO', 'e devolve QUAL sigla faltou');
  conf(r.corpo === undefined, 'e nao monta corpo nenhum');
  conf(p.montarCorpo('ADR', '1181', '2017').erro === p.ERROS.SIGLA_NAO_CADASTRADA,
       'o caso real do acervo: "ADR 1181/2017" (ADR nao e orgao; ADR19 e)');
  // ⚠️ A trava da sigla colada da sgpe-link e respeitada, e nao reimplementada aqui.
  conf(p.montarCorpo('ADR223151', '', '2017').erro === p.ERROS.ENTRADA_INVALIDA,
       'a trava da sigla colada vem da sgpe-link, nao e copiada');
}

secao('3. OS QUATRO DESFECHOS');
{
  conf(p.interpretar({ mensagemErro: 'Não foi possível encontrar o Processo.' }, {}).erro
       === p.ERROS.NAO_ENCONTRADO, 'mensagemErro preenchida -> NAO_ENCONTRADO');
  // ⚠️ TUDO NULO **SEM** MENSAGEM E SIGILOSO, e nao "nao achou": o portal so responde depois
  // de casar orgao + ano + numero, entao responder ja prova que o processo foi localizado.
  const sig = p.interpretar({ numero: null, situacao: null, estado: null },
    { sigla: 'SCC', numero: 1, ano: 2020 });
  conf(sig.erro === p.ERROS.SIGILOSO, 'tudo nulo e SEM mensagem -> SIGILOSO');
  conf(sig.sigla === 'SCC' && sig.numero === 1, 'e o sigiloso devolve qual processo era');
  conf(p.interpretar(null, {}).erro === p.ERROS.NAO_ENCONTRADO, 'resposta que nao e objeto nao derruba');
  conf(Object.keys(p.ERROS).length === 5, 'sao cinco codigos de erro, e sao codigos e nao frases');
}

secao('4. AS DATAS — armadilhas 18 e 25');
{
  conf(p.diasEntre('2026-01-01', '2026-01-31') === 30, 'diasEntre conta dias civis');
  conf(p.diasEntre('2026-01-01', null) === null, 'data invalida vira null, nao 0');
  conf(p.diasEntre(null, null) === null, 'e duas invalidas tambem');
  // ⚠️ ARMADILHA 18: as 23h de Brasilia o UTC ja virou o dia seguinte. Sem o fuso, "ha N dias"
  // ficaria um dia maior a noite inteira — o mesmo motivo do HOJE_BR em lib/datas.js.
  conf(p.hojeBr(new Date('2026-08-31T02:00:00Z')) === '2026-08-30',
       '23h de Brasilia ainda e o dia 30, nao o 31');
  conf(p.hojeBr(new Date('2026-08-31T04:00:00Z')) === '2026-08-31', 'e 01h de Brasilia ja e o 31');
  // ⚠️ ARMADILHA 25: o portal manda texto, e e como texto que fica. `new Date(...)` local
  // puxaria a data para o dia anterior.
  conf(p.diaUtc('2020-03-02') === Date.parse('2020-03-02T00:00:00Z'), 'a data e lida em UTC puro');
  conf(p.diaUtc('02/03/2020') === null, 'formato brasileiro NAO e aceito em silencio');
  conf(p.diaUtc(null) === null && p.diaUtc('') === null, 'nulo e vazio nao viram data');
}

secao('5. A PERMANENCIA POR TRAMITE');
{
  const t = p.lerTramite({ nuTramite: 1, dtRecebto: '2026-01-01', dtEncaminha: '2026-01-10',
    sgOrgaotrami: 'FCEE/SAPRE', nmOrgaotrami: 'Setor X', deParecer: 'ok' }, 0);
  conf(t.permanencia_dias === 9, 'permanencia = do receber ao encaminhar');
  conf(t.recebido === true && t.encaminhado === true, 'e marca os dois marcos');
  // ⚠️ NULL, E NAO ZERO. Zero diria "passou no mesmo dia", que e outra afirmacao.
  const aberto = p.lerTramite({ nuTramite: 2, dtRecebto: '2026-01-01', dtEncaminha: null }, 1);
  conf(aberto.permanencia_dias === null, 'tramite ainda aberto tem permanencia null, nao 0');
  const mesmoDia = p.lerTramite({ nuTramite: 3, dtRecebto: '2026-01-01', dtEncaminha: '2026-01-01' }, 2);
  conf(mesmoDia.permanencia_dias === 0, 'e o que passou no mesmo dia tem ZERO — sao coisas diferentes');
  conf(p.lerTramite({ dtRecebto: null, dtEncaminha: null }, 7).ordem === 8,
       'sem nuTramite a ordem cai no indice');
}

secao('6. ONDE O PROCESSO ESTA — do ULTIMO TRAMITE, nunca do setorAtual');
{
  const brutos = [
    { nuTramite: 1, dtRecebto: '2026-01-01', dtEncaminha: '2026-01-10', sgOrgaotrami: 'SCC/NFLN' },
    { nuTramite: 2, dtRecebto: null, dtEncaminha: null, sgOrgaotrami: 'FCEE/SAPRE' },
  ];
  const ts = brutos.map(p.lerTramite);
  const t = p.ondeEsta(ts, '2026-02-01');
  conf(t.situacao === p.SITUACAO.EM_TRANSITO, 'ultimo SEM dtRecebto -> EM_TRANSITO');
  conf(t.setor_sigla === 'FCEE/SAPRE', 'e o setor e o do ultimo tramite, mesmo sem recebimento');
  // ⚠️ A conta e desde o ENCAMINHAMENTO ANTERIOR: o tramite de agora nao tem data nenhuma.
  conf(t.dias === 22, 'e os dias contam do encaminhamento ANTERIOR', String(t.dias));

  const rec = p.ondeEsta([p.lerTramite({ nuTramite: 1, dtRecebto: '2026-01-20',
    dtEncaminha: null, sgOrgaotrami: 'FCEE/SAPRE' }, 0)], '2026-02-01');
  conf(rec.situacao === p.SITUACAO.ONDE_ESTA, 'ultimo COM dtRecebto -> ONDE_ESTA');
  conf(rec.dias === 12, 'e os dias contam do RECEBIMENTO', String(rec.dias));

  conf(p.ondeEsta([], '2026-02-01') === null, 'sem tramite nao ha onde estar');
  // Em transito sem tramite anterior: nao ha de onde contar.
  const so = p.ondeEsta([p.lerTramite({ nuTramite: 1, dtRecebto: null, dtEncaminha: null,
    sgOrgaotrami: 'X' }, 0)], '2026-02-01');
  conf(so.situacao === p.SITUACAO.EM_TRANSITO && so.dias === null,
       'em transito sem anterior: dias null, nao 0');
}

secao('7. O setorAtual CRU — vem, mas marcado');
{
  const json = {
    numero: 'SCC 00002146/2020', situacao: 'ARQUIVADO', estado: 'Finalizada',
    setorAtual: 'SCC/NCRI - Nucleo X', setorAbertura: 'SCC/NCRI - Nucleo X',
    orgaoAtual: 'FCEE - Fundacao', tramitacoes: [
      { nuTramite: 1, dtRecebto: '2020-03-02', dtEncaminha: '2020-03-02', sgOrgaotrami: 'SCC/NCRI' },
      { nuTramite: 2, dtRecebto: '2020-04-01', dtEncaminha: null, sgOrgaotrami: 'FCEE/GEESP' },
    ],
  };
  const r = p.interpretar(json, { sigla: 'SCC', numero: 2146, ano: 2020 }, new Date('2026-08-30T12:00:00Z'));
  conf(r.ok === true, 'a resposta boa vem com ok');
  conf(r.setorAtual_CRU === 'SCC/NCRI - Nucleo X', 'o setorAtual vem CRU no retorno');
  // ⚠️ O CASO REAL MEDIDO EM 30/08: o setorAtual repete o setorAbertura e discorda do
  // ultimo tramite. Quem responde "onde esta" e `atual`.
  conf(r.setorAtual_CRU === json.setorAbertura, 'e ele repete o setorAbertura — por isso nao serve');
  conf(r.atual.setor_sigla === 'FCEE/GEESP', 'enquanto o ATUAL vem do ultimo tramite');
  conf(r.atual.setor_sigla !== r.setorAtual_CRU.split(' ')[0], 'os dois DISCORDAM, e e o esperado');
  const src = fs.readFileSync('./lib/sgpe-portal.js', 'utf8');
  conf(/NUNCA PELO CAMPO `setorAtual`/.test(src), 'e a lib diz por extenso para nao usar o campo');
  conf(/NÃO USAR ESTE CAMPO/.test(src), 'inclusive no ponto onde ele e devolvido');
}

secao('8. A CONSULTA — com fetch dublê, sem tocar no portal');
{
  const resposta = (corpo, status) => async () => ({
    ok: status === undefined ? true : status < 400,
    status: status || 200,
    text: async () => JSON.stringify(corpo),
  });
  const roda = (f, s, n, a) => p.consultar(s || 'SCC', n || '2146', a || '2020', { fetchImpl: f });

  (async () => {
    let visto = null;
    const espiao = async (url, opc) => { visto = { url, opc }; return (await resposta({ mensagemErro: 'x' })()); };
    await roda(espiao);
    conf(visto.url === p.ENDPOINT, 'bate no endpoint do portal');
    conf(visto.opc.method === 'POST', 'por POST');
    conf(JSON.parse(visto.opc.body).nuProcessoOficial === '02146', 'com o numero em padStart');
    conf(!!visto.opc.signal, 'e com AbortSignal — o timeout e sempre armado');

    // ⚠️ HTTP != 200 e REDE, nao "nao encontrado": o portal responde 200 ate quando nao acha.
    // Confundir os dois faria uma instabilidade dele virar "o processo nao existe".
    const r500 = await roda(resposta({}, 500));
    conf(r500.erro === p.ERROS.REDE, 'HTTP 500 -> REDE, e nao NAO_ENCONTRADO');
    const rTexto = await roda(async () => ({ ok: true, status: 200, text: async () => '<html>' }));
    conf(rTexto.erro === p.ERROS.REDE, 'resposta que nao e JSON -> REDE');
    const rQueda = await roda(async () => { throw new Error('ECONNRESET'); });
    conf(rQueda.erro === p.ERROS.REDE, 'e a queda de conexao tambem');
    // A sigla fora do mapa nem chega a chamar o fetch.
    let chamou = false;
    await roda(async () => { chamou = true; return resposta({})(); }, 'XPTO');
    conf(chamou === false, 'e com sigla fora do mapa o fetch NAO e chamado');

    console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
    process.exit(falhou ? 1 : 0);
  })();
}
