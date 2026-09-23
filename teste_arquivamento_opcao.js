// CAMINHO: sigpc-api/teste_arquivamento_opcao.js
//
// A OPCAO DO C.I. QUE A ANALISTA LE NO CARTAO — decidida, ou deduzida?  (22/09/2026)
//
// ⚠️ O QUE ELE GUARDA: que a tela nunca afirme "o C.I. esta de acordo" sobre uma parcial que
// NINGUEM decidiu. A `estadoDaLinha` DEDUZ a opcao das antigas (decisao do Richard, 14/09 — a
// parcial precisa seguir para o arquivamento), e essa deducao e correta; o erro seria
// apresenta-la como decisao registrada. Medido em 22/09/2026: das 1.496 PCs `encerrado`,
// **1.405 nao tem tecnico** — 788 parciais em 234 TRs. Nas `com_analista`, 308 de 332.
//
// ⚠️ E O DEFEITO NAO DAVA ERRO: o cartao mostrava a frase do acordo, a pilula verde "De acordo"
// e, logo abaixo, "Nada ainda" na conversa — sem nome, sem data, sem mensagem. Foi o Richard
// quem viu na tela: "parcial 4 tem a mensagem do ci porem nao tem o tecnico que mandou".
//
// USO: node teste_arquivamento_opcao.js

const fs = require('fs');
const path = require('path');
const arq = require('./lib/arquivamento');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

// A linha que a `sqlEstado` devolve, no minimo que a `estadoDaLinha` le.
//
// ⚠️ OS CINCO ARRAYS DE FATOS VAO VAZIOS, e nao e enfeite: a `bloqueioDeFatos` le
// `f.dilig.length` direto, sem COALESCE em JS — no SQL eles chegam com `'{}'` garantido. Sem
// eles aqui o teste morre com TypeError, que e exatamente o que aconteceu na primeira versao
// deste arquivo.
const linha = (extra) => ({
  s: 'FCEE', t: '2020TR000738', n: '4', n_pcs: 2, tem_final: false, so_final: false,
  arquivada: false, ci_situacao: null, ci_col_em: null, ci_ultimo_em: null, ci_ultimo_evento: null,
  tem_tecnico: false, ci_opcao: null, ci_opcao_texto: null,
  dilig: [], nao_baixadas: [], sem_ci: [], na_fila: [], fora: [], com_analista: false,
  n_parciais: 5, n_parciais_arquivadas: 0, pendentes: [], tr_arquivada: false,
  todas_baixadas: true, ...extra,
});

S('1. A DEDUCAO CONTINUA — a parcial precisa seguir para o arquivamento');
{
  const e = arq.estadoDaLinha(linha({ ci_situacao: 'encerrado' }));
  conf(e.ci_opcao === 'de_acordo', 'encerrada sem opcao gravada ainda deduz "de_acordo"', e.ci_opcao);
  const p = arq.estadoDaLinha(linha({ ci_situacao: 'com_analista' }));
  conf(p.ci_opcao === 'com_pendencia', 'e com_analista deduz "com_pendencia"', p.ci_opcao);
  // ⚠️ A REABERTA ANTIGA FICA SEM OPCAO — decisao do Richard, 14/09. Reabrir nao e decidir.
  const r = arq.estadoDaLinha(linha({ ci_situacao: 'com_analista', ci_ultimo_evento: 'ci_reabriu' }));
  conf(r.ci_opcao === null, 'a reaberta pelo C.I. continua sem opcao', String(r.ci_opcao));
}

S('2. MAS A DEDUCAO VEM ETIQUETADA');
{
  const enc = arq.estadoDaLinha(linha({ ci_situacao: 'encerrado' }));
  conf(enc.ci_opcao_deduzida === true,
       'a encerrada pela carga marca ci_opcao_deduzida', String(enc.ci_opcao_deduzida));
  const pend = arq.estadoDaLinha(linha({ ci_situacao: 'com_analista' }));
  conf(pend.ci_opcao_deduzida === true, 'a com_analista sem opcao gravada, idem');

  // ⚠️ E A DECIDIDA DE VERDADE NAO E MARCADA: quando o tecnico registrou a opcao, a frase do
  // cartao pode afirmar o acordo — e o nome dele aparece na conversa.
  const real = arq.estadoDaLinha(linha({
    ci_situacao: 'encerrado', ci_opcao: 'de_acordo', ci_opcao_texto: null,
    tem_tecnico: true, ci_col_em: '2026-09-16',
  }));
  conf(real.ci_opcao === 'de_acordo' && real.ci_opcao_deduzida === false,
       'a opcao REGISTRADA pelo tecnico nao e marcada como deduzida');

  // A reaberta nao tem opcao nenhuma — logo nao ha o que etiquetar.
  const r = arq.estadoDaLinha(linha({ ci_situacao: 'com_analista', ci_ultimo_evento: 'ci_reabriu' }));
  conf(r.ci_opcao_deduzida === false, 'sem opcao, nao ha deducao a etiquetar');
}

S('3. A MARCA VIAJA ATE A TELA, junto da opcao');
{
  const src = fs.readFileSync(path.join(__dirname, 'lib/arquivamento.js'), 'utf8');
  conf(/ci_opcao: e\.ci_opcao, ci_opcao_deduzida: e\.ci_opcao_deduzida/.test(src),
       'o anexarEstado manda as duas juntas — opcao sem marca e o que fazia a tela afirmar demais');
  // ⚠️ `ci_devolveu_carga` CONTINUA SENDO OUTRA COISA: ele responde "ha data de devolucao?", e
  // so existe no ramo `encerrado`. A marca nova responde "alguem registrou a opcao?" — e
  // cobre tambem as `com_analista`, que sao 308.
  conf(/ci_devolveu_carga: !ciDevolveuEm && r\.ci_situacao === 'encerrado'/.test(src),
       'e a marca antiga, de data ausente, segue intacta');
}

S('4. A TELA DEIXA DE AFIRMAR O ACORDO QUE NINGUEM DEU');
{
  const html = fs.readFileSync('C:/Users/Richard/sigpc-gt/index.html', 'utf8');
  conf(/const texto = a\.ci_opcao_deduzida/.test(html),
       'a frase da faixa olha a marca ANTES de escolher o texto');
  conf(/Encerrada no C\.I\. pela carga de 16\/08\/2026/.test(html),
       'e diz de onde veio a situacao, em vez de afirmar o acordo');
  conf(/sem decisão registrada no sistema/.test(html),
       'o mesmo vale para a ressalva deduzida');
  // ⚠️ O TEXTO DO ACORDO DE VERDADE CONTINUA LA, para quando o tecnico decidiu.
  conf(/<b>O C\.I\. está de acordo\.<\/b>/.test(html),
       'a frase do acordo registrado continua existindo');
  conf(/ci_opcao_deduzida \? ' · deduzida' : ''/.test(html), 'a pilula marca a deducao');
  conf(/sem técnico registrado/.test(html), 'e ha a etiqueta que explica a ausencia do nome');
  conf(/function pCiConversaHtml\(msgs, deduzida\)/.test(html),
       'a conversa vazia sabe distinguir "nao houve" de "ainda nao"');
  // ⚠️ O FLUXO NAO MUDA: o botao de arquivar continua no mesmo lugar, para os dois casos.
  conf(/Arquivar parcial/.test(html), 'e o caminho do arquivamento segue igual');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
