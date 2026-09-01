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
const path = require('path');
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

    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== 9. A ROTA E A TELA — FASE 2 ===');
    // ═══════════════════════════════════════════════════════════════════════════
    // Leitura de arquivo, sem rede e sem banco: prova a LIGACAO entre a lib, a rota e a tela.
    // E a ligacao que o dublê nao pega e que o teste de unidade nao ve — foi uma funcao
    // apagada e uma chamada orfa que quebraram a tela de 22 analistas em 28/08.
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'sigpc-gt', 'index.html'), 'utf8');

    conf(/app\.get\('\/sgpe\/consulta'/.test(srv), 'existe GET /sgpe/consulta');
    conf(/require\('\.\/lib\/sgpe-portal'\)/.test(srv), 'e a rota usa a lib, nao reimplementa');
    // ⚠️ NENHUMA ESCRITA. A FASE 2 e so leitura — a rota nao grava consulta nenhuma.
    {
      const i = srv.indexOf("app.get('/sgpe/consulta'");
      const bloco = srv.slice(i, i + 2200);
      conf(!/INSERT|UPDATE|DELETE/i.test(bloco), 'a rota nao escreve no banco');
      // Os quatro retornos da lib, cada um com o seu caminho.
      conf(/ENTRADA_INVALIDA/.test(bloco) && /status\(400\)/.test(bloco), 'entrada ilegivel -> 400');
      conf(/ERROS\.REDE/.test(bloco) && /status\(502\)/.test(bloco), 'portal fora do ar -> 502, e nao "nao encontrado"');
      conf(/if \(r\.erro\) return res\.json/.test(bloco),
           'sigla, nao encontrado e sigiloso saem em 200 — sao respostas, nao falhas');
      conf(/montarLinks/.test(bloco), 'o link vem do CACHE, nunca do portal (armadilha 20)');
      conf(/link: null/.test(bloco) || /catch \(_\) \{ link = null/.test(bloco),
           'e a ausencia do link nao derruba a consulta');
    }

    conf(/function sgpeConsultaAbrir\(bruto\)/.test(idx), 'a tela tem a janela de consulta');
    conf(/function sgpeIconeConsulta\(bruto\)/.test(idx), 'e o icone que a abre ja consultada');
    conf(/if\(procVazio\(bruto\)\) return ''/.test(idx), 'o icone SOME onde nao ha processo cadastrado');
    conf(/id="sgpeBtnTopo"/.test(idx), 'ha o botao no cabecalho do sistema');
    conf(/Consultar SGPe/.test(idx), 'com o texto');
    conf(/>F4<\/kbd>/.test(idx), 'e a tecla numa kbd ao lado — nao so no title');

    // ⚠️ F4, E NAO F2: o F2 ja e a busca da fila do C.I. Duas telas na mesma tecla dariam a
    // pessoa uma tecla que faz coisas diferentes conforme onde ela esta.
    conf(/e\.key !== 'F4'/.test(idx), 'o atalho global e o F4');
    {
      const i = idx.indexOf("if(e.key !== 'F4'");
      const bloco = idx.slice(i, i + 500);
      conf(/tag === 'INPUT'/.test(bloco) && /tag === 'TEXTAREA'/.test(bloco),
           'e nao dispara com o foco num campo de texto');
      conf(/isContentEditable/.test(bloco), 'nem numa area editavel');
    }

    // ⚠️ CLICAR FORA NAO FECHA — a janela tem campo digitavel. Todos os outros modais do
    // sistema fecham no clique fora (`e.target === el`); a AUSENCIA disso aqui e a decisao.
    {
      const i = idx.indexOf('function sgpeConsultaAbrir(bruto)');
      const bloco = idx.slice(i, idx.indexOf('function sgpeIconeConsulta'));
      conf(!/e\.target === el/.test(bloco), 'clicar fora NAO fecha — a janela tem campo digitavel');
      conf(/e\.key === 'Escape'/.test(bloco), 'mas o Esc fecha');
      conf(/removeEventListener\('keydown', tecla, true\)/.test(bloco),
           'e o ouvinte do teclado sai junto — senao o Esc seguiria armado com a janela fechada');
      // ⚠️ O z-index SAIU DO ARQUIVO em 31/08/2026, quando este modal virou JANELA FLUTUANTE.
      // O 1300 escrito a mao resolvia o cabecalho fixo (1199/1200) e mais nada: com duas
      // janelas abertas as duas ficavam em 1300, e a ordem passava a ser a do documento — quem
      // clicasse na de baixo continuaria vendo a de cima. Quem empilha agora e a `jfFocar`,
      // que reordena TODAS a cada clique.
      conf(!/el\.style\.zIndex = '1300'/.test(bloco), 'o z-index a mao saiu');
      conf(/jfAbrir\('sgpeMo', el\)/.test(bloco), 'e a janela sobe pela pilha das flutuantes');
      conf(/JF_Z_BASE = 1250/.test(idx) && /\.mo\{[^}]*z-index:1400/.test(idx),
           'que fica acima do cabecalho fixo e abaixo do modal que trava');
      conf(/document\.body\.appendChild\(el\)/.test(bloco), 'e vai portalizado para o body');
      // Os seis estados.
      conf(/SIGLA_NAO_CADASTRADA/.test(bloco), 'estado: sigla nao cadastrada');
      conf(/nao esta no mapa de orgaos do sistema|não está no mapa de órgãos do sistema/.test(bloco),
           'com o texto que diz de quem e o mapa');
      conf(/NAO_ENCONTRADO/.test(bloco) && /a sigla esta cadastrada|a sigla está cadastrada/.test(bloco),
           'estado: nao encontrado — e o texto ja descarta a sigla');
      conf(/SIGILOSO/.test(bloco) && /nao sao publicos|não são públicos/.test(bloco), 'estado: sigiloso');
      conf(/Consultando o portal do SGPe/.test(bloco), 'estado: buscando');
      conf(/bt\.style\.opacity = '\.5'/.test(bloco), 'com o botao em opacidade reduzida');
      conf(/bt\.style\.boxShadow = 'none'/.test(bloco),
           'e SEM o relevo — botao em relevo e apagado parece clicavel e nao e (armadilha 15)');
    }

    // A faixa de posicao — as duas cores dizem coisas diferentes.
    conf(/#EAF3DE/.test(idx) && /#3B6D11/.test(idx), 'a faixa de ONDE ESTA e verde');
    conf(/#FAEEDA/.test(idx) && /#BA7517/.test(idx), 'e a de EM TRANSITO e ambar');
    conf(/ONDE ESTÁ AGORA/.test(idx) && /EM TRÂNSITO PARA/.test(idx), 'com os dois rotulos');
    conf(/dias aqui/.test(idx), 'e o numero de dias');
    {
      const i = idx.indexOf('function sgpeFaixaPosicao');
      const bloco = idx.slice(i, idx.indexOf('function sgpeDado'));
      // ⚠️ `dias` NULO NAO E ZERO — e o transito sem tramite anterior, de onde nao ha de
      // quando contar. "0 dias" ali afirmaria que o processo saiu hoje.
      conf(/a\.dias !== null/.test(bloco), 'e dias NULO nao vira zero na tela');
    }

    // A linha do tempo — invertida, com o atual em cima.
    {
      const i = idx.indexOf('function sgpeLinhaTempo');
      const bloco = idx.slice(i, idx.indexOf('function sgpeData'));
      conf(/t\.slice\(\)\.reverse\(\)/.test(bloco), 'a linha do tempo vem invertida');
      conf(/const atual   = i === 0/.test(bloco), 'e o atual e o primeiro da lista');
      conf(/p\.ordem === 1/.test(bloco), 'a etiqueta "abertura" sai da ORDEM, nao da posicao');
      conf(/permanencia_dias === null \? 'ainda aqui'/.test(bloco),
           'e o tramite aberto diz "ainda aqui", nao "0 dias"');
      conf(/quem_encaminhou/.test(bloco), 'cada passo diz quem encaminhou');
    }

    // ⚠️ O BOTAO "ABRIR NO SGPe" E CONDICIONAL, e o caso que obriga isso e REAL: o
    // SCC 2049/2025 e um dos 7 que o cache marca NAO_ENCONTRADO, e o portal publico ACHA.
    // Botao sempre visivel levaria a um endereco quebrado.
    conf(/\$\{d\.link \? `<a href=/.test(idx), 'o botao "Abrir no SGPe" so aparece se houver link no cache');

    // As recentes — no navegador de quem consultou, com validade por ITEM.
    conf(/SGPE_RECENTES_MAX   = 5/.test(idx), 'as recentes sao 5');
    conf(/SGPE_RECENTES_DIAS  = 7/.test(idx), 'e valem 7 dias');
    {
      const i = idx.indexOf('function sgpeRecentesLer');
      const bloco = idx.slice(i, idx.indexOf('function sgpeRecentesLimpar'));
      // ⚠️ A VALIDADE E POR ITEM, nao da lista: uma validade da lista faria a consulta de
      // hoje morrer junto com a da semana passada.
      conf(/Number\(x\.em\) >= limite/.test(bloco), 'e a validade e conferida item a item');
      conf(/catch\(_\) \{ return \[\] \}/.test(bloco),
           'e o localStorage e sempre protegido — no modo anonimo ele LANCA, e a janela nao abriria');
    }
    conf(/function sgpeRecentesLimpar/.test(idx), 'ha o botao de limpar');

    conf(/F4<\/kbd>\n?\s*abre esta janela de qualquer tela/.test(idx)
      || /abre esta janela de qualquer tela/.test(idx), 'o rodape ensina o F4');
    conf(/Esc<\/kbd> fecha/.test(idx), 'e o Esc');

    // Os dois pontos de acesso nas listas — e SO os dois.
    conf(/procHtml\(l\.processo_pc, l\.codigo_pc, 'processo_pc'\) \+ sgpeIconeConsulta\(l\.processo_pc\)/.test(idx),
         'o icone esta na fila do C.I.');
    conf(/\$\{procHtml\(p\.processo_pc, p\.codigo_pc\)\}\$\{sgpeIconeConsulta\(p\.processo_pc\)\}/.test(idx),
         'e no cartao da parcela da Minha Planilha');
    // ⚠️ E NAO ENTROU NO `procHtml`. Se tivesse entrado, o icone apareceria nas 11 telas que
    // desenham processo — inclusive nas colunas estreitas de tabela, onde 26 px quebram a
    // linha. O pedido foi DOIS lugares.
    {
      const i = idx.indexOf('function procHtml(bruto, codigo_pc, campo)');
      const bloco = idx.slice(i, i + 1600);
      conf(!/sgpeIconeConsulta/.test(bloco), 'e o icone NAO entrou no procHtml — sao dois lugares, nao onze');
    }
    conf((idx.match(/sgpeIconeConsulta\(/g) || []).length === 3,
         'sao 3 ocorrencias: a definicao e os dois pontos de acesso');

    // ⚠️ O LOGO E A IMAGEM OFICIAL, E MORA NUMA CONSTANTE SO. Ate 30/08 era um SVG desenhado
    // de memoria — duas setas verdes e um traco vermelho: parecia o logo e nao era. Marca de
    // orgao publico nao se aproxima. E a constante e unica porque sao TRES pontos que a
    // desenham (cabecalho do sistema, cabecalho do modal, icone das listas); tres copias do
    // mesmo base64 seriam tres coisas para atualizar, e copia que ninguem compara diverge sem
    // dar erro — a mesma razao do MAPA_NOME ter uma dona so.
    // ⚠️ DESDE 31/08 O BASE64 MORA NO TOPO DO ARQUIVO, em `LOGO_SGPE_B64`, porque os campos
    // novos de TR e de processo tambem o desenham. `SGPE_LOGO` ficou como o NOME ANTIGO da
    // mesma constante — apelido, nao copia. O que este teste guarda nao mudou: existe UM
    // base64 do logo no arquivo inteiro, e nao um por ponto de desenho.
    conf(/const LOGO_SGPE_B64  = 'data:image\/png;base64,/.test(idx), 'o logo e a imagem oficial, em PNG');
    conf(/const SGPE_LOGO = LOGO_SGPE_B64/.test(idx), 'e SGPE_LOGO e apelido dela, nao uma segunda copia');
    conf(!/sgpeLogoSvg/.test(idx), 'e o SVG desenhado saiu — nao ficou chamada orfa');
    conf((idx.match(/SGPE_LOGO/g) || []).length === 4,
         'a constante e usada nos tres lugares — definicao + modal/icone + o src do cabecalho');
    // ⚠️ O CABECALHO DO SISTEMA E HTML ESTATICO: ali nao ha template literal, e a chamada da
    // funcao sairia como TEXTO na barra verde. Por isso o `src` e preenchido pelo script.
    conf(/id="sgpeLogoTopo"/.test(idx) && /_lg\.src = SGPE_LOGO/.test(idx),
         'e o cabecalho estatico recebe o src pelo script, sem repetir o base64');

    // ── O TAMANHO DA JANELA (30/08) ──────────────────────────────────────────
    conf(/width:860px;max-width:96vw;max-height:90vh/.test(idx), 'a janela e 860px por 90vh');
    // ⚠️ SO O MIOLO ROLA. O `.mc` do sistema tem overflow-y:auto no bloco inteiro; aqui ele e
    // sobrescrito para hidden e a rolagem desce um nivel. Sem isso, num processo de 34
    // tramites o cabecalho e a identificacao saem da tela junto com o resto.
    conf(/overflow:hidden;display:flex;flex-direction:column/.test(idx), 'a caixa e flex e nao rola inteira');
    conf(/id="sgpeRolagem" style="overflow-y:auto;flex:1;min-height:0/.test(idx), 'so o miolo rola');
    conf(/class="mch" style="background:#F4F8F2;gap:11px;flex-shrink:0;"/.test(idx), 'o cabecalho e fixo');
    conf(/border-bottom:1px solid var\(--cl\);flex-shrink:0;/.test(idx), 'e a linha da busca tambem');

    // ⚠️ A IDENTIFICACAO SUBIU PARA A PARTE FIXA, e por isso saiu do sgpeEncontradoHtml para
    // funcao propria: o que identifica nao pode rolar para fora enquanto se le o detalhe.
    conf(/function sgpeIdentHtml\(d\)/.test(idx), 'a identificacao do processo tem funcao propria');
    conf(/id="sgpeIdent"/.test(idx), 'e vive na linha da busca');
    {
      const i = idx.indexOf('function sgpeEncontradoHtml(d) {');
      const bloco = idx.slice(i, idx.indexOf('// ── OS SEIS ESTADOS'));
      conf(!/numero_oficial/.test(bloco), 'e NAO se repete no corpo que rola');
      conf(/repeat\(4,1fr\)/.test(bloco), 'a grade de dados e de QUATRO colunas');
    }
    // ⚠️ LIMPA A CADA CONSULTA: sem isso o numero do processo anterior ficaria em cima de uma
    // resposta "nao encontrado" — a parte fixa mentiria sobre o miolo.
    conf(/ident\.innerHTML = ''/.test(idx), 'a identificacao e limpa a cada consulta nova');

    // ── O EXPANDIR VIROU O MAXIMIZAR DA JANELA FLUTUANTE (31/08/2026) ────────
    //
    // ⚠️ ESTA SECAO COBRIA O BOTAO ⤢ DESTE MODAL, e ele saiu no mesmo dia em que foi
    // consertado. O modal virou uma das cinco JANELAS FLUTUANTES e ganhou os tres botoes que
    // todas tem — minimizar, maximizar, fechar. Dois botoes de maximizar na mesma barra de
    // titulo seriam dois estados a manter em acordo, e o segundo estaria errado no dia
    // seguinte. `sgpeCheiaLer`, `sgpeCheiaGravar`, `sgpeEstaCheia` e `sgpeAplicarTamanho`
    // foram removidas.
    conf(!/id="sgpeExp"/.test(idx) && !/data-f="exp"/.test(idx), 'o botao ⤢ proprio saiu');
    // ⚠️ PELA DEFINICAO, nao pelo nome: o index.html CITA as quatro num comentario que conta
    // por que elas sairam, e uma busca pelo nome cru acharia o proprio obituario delas.
    conf(!/function (sgpeAplicarTamanho|sgpeEstaCheia|sgpeCheiaLer|sgpeCheiaGravar)/.test(idx),
         'e as quatro funcoes dele tambem');
    conf(/data-jf="max"/.test(idx), 'quem maximiza agora e o botao da janela');

    // ⚠️ MAS A LICAO QUE ELE CUSTOU CONTINUA DE PE, e e por ela que esta secao existe. Medido
    // no navegador, na versao publicada: com o armazenamento bloqueado — janela anonima,
    // cookies de terceiros barrados — o `lerEstado()` devolvia `false` para sempre, o `!` do
    // clique dava `true` toda vez, e a janela expandia no primeiro clique e NUNCA MAIS voltava:
    // quatro cliques seguidos, 1711px nos quatro. Quem sabe se a janela esta grande e A JANELA.
    conf(/function jfEstaMax\(mc\)\s*\{\s*return !!mc && mc\.dataset\.jfMax === '1'/.test(idx),
         'o estado de maximizada sai do ELEMENTO, nunca do armazenamento');
    conf(/if\(jfEstaMax\(mc\)\)/.test(idx), 'e o clique alterna a partir dele');
    {
      // ⚠️ E O ARMAZENAMENTO CONTINUA PROTEGIDO POR `try`. Mudou de prazo — de `sessionStorage`
      // para `localStorage`, porque a janela agora guarda POSICAO e quem arrastou para o canto
      // quer acha-la ali amanha — mas nao mudou de risco: ele LANCA no modo anonimo, e sem o
      // `try` a janela deixaria de abrir por causa de uma preferencia de posicao.
      const i = idx.indexOf('function jfLerDisco()');
      const bloco = idx.slice(i, idx.indexOf('const JF_MARGEM'));
      conf(/localStorage/.test(bloco), 'a posicao e o tamanho vivem no localStorage');
      conf((bloco.match(/catch\s*\(_\)/g) || []).length >= 2,
           'e as duas pontas — ler e gravar — estao protegidas');
    }

    console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
    process.exit(falhou ? 1 : 0);
  })();
}
