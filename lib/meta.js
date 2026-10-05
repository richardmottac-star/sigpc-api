// CAMINHO: sigpc-api/lib/meta.js
//
// A RÉGUA DE PRODUTIVIDADE DO GT — a única cópia.
//
// Fonte: REGRA_PRODUTIVIDADE_GT_IMPLANTACAO, de 18/09/2026, que traduz a resposta da
// coordenação de 17/09/2026 e foi confirmada por ela em 27/09 sem alterações. Cada constante
// daqui aponta o item do documento que a sustenta — é o que permite responder "de onde saiu
// esse número" sem reabrir a discussão.
//
// ⚠️ A META É CALCULADA, NUNCA DIGITADA (item 2 do documento). É o que permite mudar o valor
// de um mês depois de uma reunião com a CGE e ver o histórico inteiro se recalcular sozinho.
// A tabela `metas_analistas` e a coluna `usuarios.meta_mensal` continuam existindo como
// registro do que valia antes; quem responde "qual é a meta" daqui para a frente é esta lib.
//
// ⚠️ E ELA NÃO LÊ BANCO. Recebe as linhas prontas e devolve número — para poder ser testada
// sem produção, que é onde os quatro defeitos de SQL de 10-11/08 passaram despercebidos.

// O que vale cada mês (item B1 da resposta): 12 de agosto a dezembro de 2025, ZERO em janeiro
// de 2026, 10 de fevereiro de 2026 em diante.
//
// ⚠️ "DE FEVEREIRO EM DIANTE" NÃO TEM FIM, e é por isso que 2027 cai no mesmo 10. A primeira
// versão desta função devolvia zero para ano > 2026, e em janeiro de 2027 a meta do GT
// inteiro pararia de crescer sem erro nenhum na tela.
const INICIO = { ano: 2025, mes: 8 };          // 01/08/2025 — item B2

function metaDoMes(ano, mes) {
  const a = Number(ano), m = Number(mes);
  if (a < 2025 || (a === 2025 && m < INICIO.mes)) return 0;
  if (a === 2025) return 12;
  if (a === 2026 && m === 1) return 0;          // item B1: janeiro de 2026 é zero
  return 10;
}

// Os dias do mês. `Date.UTC(ano, mes, 0)` é o último dia do mês `mes` (1..12) porque o mês do
// JS é base zero — o dia 0 do mês seguinte.
const diasDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

// ⚠️ A PROPORCIONAL É POR DIAS SOBRE BASE 30 (itens B6 e C3), e não sobre os dias do mês.
// Base 30 é a do próprio documento: fevereiro não pode valer mais por dia do que março.
const BASE_PROPORCIONAL = 30;

/** Quebra 'YYYY-MM-DD' (ou Date) em { ano, mes, dia }. Devolve null para vazio. */
function emPartes(v) {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return { ano: +s.slice(0, 4), mes: +s.slice(5, 7), dia: +s.slice(8, 10) };
}

/**
 * A meta de quem entrou em `entrada` e saiu em `saida`, apurada até `ate`.
 *
 * `de` recorta o começo da janela. Sem ele a conta vale desde 01/08/2025 — o acumulado. Com
 * ele vale só o intervalo, que é a leitura do trimestre.
 *
 * ⚠️ AS DUAS LEITURAS SAEM DA MESMA FUNÇÃO, e isso é o ponto. A coordenação pediu as duas
 * no relatório (itens C1, D1 e E1 da resposta de 17/09/2026): o acumulado desde o início e o
 * trimestre. Calcular o trimestre noutro lugar faria as duas divergirem no primeiro mês em que
 * alguém mexesse numa só.
 *
 * `entrada` vazia = integrante desde o início (item 4 do documento: os 35 sem portaria).
 * `saida` vazia = continua no grupo.
 *
 * ⚠️ A META CONGELA NA DATA DE SAÍDA (itens B4 e B8) — o mês seguinte à portaria não soma
 * mais nada. O que NÃO congela é a participação dele no grupo: a produção que ele fez continua
 * contando no total do GT, e é por isso que o dispensado tem de aparecer no relatório.
 */
function metaAcumulada(entrada, saida, ate, de) {
  const d = emPartes(entrada);
  const a = emPartes(saida);
  const fim = emPartes(ate) || emPartes(new Date());
  // O começo da janela: o recorte pedido, ou o início do GT. ⚠️ NUNCA antes de 01/08/2025 —
  // pedir um período que comece em julho não pode inventar meta de um mês que não existia.
  const rec = emPartes(de);
  const ini = rec && (rec.ano > INICIO.ano || (rec.ano === INICIO.ano && rec.mes > INICIO.mes))
    ? { ano: rec.ano, mes: rec.mes, dia: rec.dia }
    : { ano: INICIO.ano, mes: INICIO.mes, dia: 1 };
  let total = 0;
  for (let ano = ini.ano; ano <= fim.ano; ano++) {
    for (let mes = 1; mes <= 12; mes++) {
      if (ano === ini.ano && mes < ini.mes) continue;
      if (ano === fim.ano && mes > fim.mes) break;
      const base = metaDoMes(ano, mes);
      if (!base) continue;
      const antesDaEntrada = d && (ano < d.ano || (ano === d.ano && mes < d.mes));
      const depoisDaSaida = a && (ano > a.ano || (ano === a.ano && mes > a.mes));
      if (antesDaEntrada || depoisDaSaida) continue;
      const mesDaEntrada = d && ano === d.ano && mes === d.mes;
      const mesDaSaida = a && ano === a.ano && mes === a.mes;
      // ⚠️ A JANELA TAMBÉM TEM BORDAS. Um trimestre que comece dia 15 não vale o mês cheio —
      // e esquecer isso daria ao recorte mais meta do que ele tem, sem erro em lugar nenhum.
      const mesDoRecorteIni = rec && ano === ini.ano && mes === ini.mes && ini.dia > 1;
      const mesDoRecorteFim = ano === fim.ano && mes === fim.mes && fim.dia < diasDoMes(ano, mes);
      if (!mesDaEntrada && !mesDaSaida && !mesDoRecorteIni && !mesDoRecorteFim) { total += base; continue; }
      const d1 = Math.max(mesDaEntrada ? d.dia : 1, mesDoRecorteIni ? ini.dia : 1);
      const d2 = Math.min(mesDaSaida ? a.dia : diasDoMes(ano, mes), mesDoRecorteFim ? fim.dia : diasDoMes(ano, mes));
      const dias = Math.max(0, d2 - d1 + 1);
      total += base * dias / BASE_PROPORCIONAL;
    }
  }
  return Math.round(total);
}

// Os quatro que a coordenação informou (item B9). ⚠️ ELES SÃO EXCEÇÃO DECLARADA, E NÃO
// CORREÇÃO DE DEFEITO: o cálculo proporcional dá 36, 17, 14 e 14, e o documento diz, em
// letra, que vale o número informado pela coordenação. A diferença soma 5 PCs no GT inteiro.
//
// ⚠️ O NOME DA CONSTANTE É PARA SER ENCONTRADO: quem varrer esta lib atrás de número que não
// sai da régua acha este bloco e lê por que ele existe. Mudar qualquer linha daqui é mudar o
// que a coordenação informou, e isso não é decisão técnica.
const META_INFORMADA = {
  52: { meta: 35, nome: 'Eduardo Pizolati',     calculada: 36 },
  72: { meta: 17, nome: 'Jeisson Klein Garcia', calculada: 17 },
  75: { meta: 12, nome: 'Carla Goedert Xavier', calculada: 14 },
  74: { meta: 12, nome: 'Fabiana Vieira',       calculada: 14 },
};

// ⚠️ O NÚMERO INFORMADO É O ACUMULADO ATÉ 30/09/2026, e não uma meta eterna. A tabela do
// documento imprime a coluna "Meta calculada" até setembro, e é com setembro que a
// coordenação comparou. De outubro em diante a meta deles sobe 10 por mês como a de todo
// mundo — item B4: "acrescido a cada mês mais 10 PCs na meta de todos os técnicos que
// integram os grupos, com exceção dos que já foram substituídos".
//
// ⚠️ SEM ISTO A META DOS QUATRO CONGELA PARA SEMPRE. Medido em 05/10/2026: os outros 45
// já estavam em 150 e eles continuariam em 35, 17, 12 e 12 — e o percentual deles subiria
// sozinho, mês após mês, sem ninguém ter produzido nada. Um número que não cresce no meio de
// 49 que crescem é o tipo de erro que só aparece depois de meses.
const FIM_DA_META_INFORMADA = '2026-10-01';

// Quem NÃO é apurado (item F da resposta, e a mesma regra que a tela já usa em
// `contaProdutividade`). ⚠️ É LISTA DE EXCLUSÃO, e o superadmin NÃO está nela: o documento
// traz o Richard na tabela do item 3, com meta 113. Tirá-lo seria mudar a régua.
const PERFIS_FORA = ['coordenador', 'controle_interno'];

function apura(usuario) {
  return !!usuario && !PERFIS_FORA.includes(usuario.perfil);
}

/**
 * As datas de entrada e saída de cada pessoa, lidas das PORTARIAS (item 3 do documento).
 *
 * ⚠️ A DATA DE PUBLICAÇÃO É ENTRADA DO SUBSTITUTO E SAÍDA DO SUBSTITUÍDO — uma data, dois
 * efeitos. É a única fonte: `usuarios.data_ingresso` está preenchida em 3 dos 49 cadastros e
 * `usuarios.portaria` em 10, e uma segunda fonte com 6% de preenchimento não é fonte, é
 * armadilha esperando a primeira divergência.
 *
 * ⚠️ VALE A PORTARIA MAIS ANTIGA de cada ponta. Quem entrou, saiu e voltou teria duas; o
 * acervo de hoje não tem esse caso, e comparar texto ISO resolve sem inventar regra para o
 * que não existe.
 */
function datasPorPortaria(substituicoes) {
  const mapa = {};
  const linha = (id) => {
    if (!mapa[id]) mapa[id] = { entrada: null, saida: null, portEntrada: null, portSaida: null };
    return mapa[id];
  };
  for (const s of substituicoes || []) {
    const dt = String(s.data_publicacao || '').slice(0, 10);
    if (!dt) continue;
    if (s.substituto_id) {
      const e = linha(Number(s.substituto_id));
      if (!e.entrada || dt < e.entrada) { e.entrada = dt; e.portEntrada = s.portaria || null; }
    }
    if (s.dispensado_id) {
      const v = linha(Number(s.dispensado_id));
      if (!v.saida || dt < v.saida) { v.saida = dt; v.portSaida = s.portaria || null; }
    }
  }
  return mapa;
}

/**
 * A meta de uma pessoa, com a origem do número junto.
 *
 * ⚠️ A ORIGEM VIAJA COM O VALOR, e não é enfeite: é ela que o botão "Fonte" da tela mostra
 * quando alguém perguntar por que a meta dele é 113 e não 150. Número sem origem é número que
 * ninguém consegue conferir — e foi conferindo que se achou o erro de soma do quadro de 18/09.
 */
function metaDe(usuario, datas, ate, de) {
  const id = Number(usuario && usuario.id);
  const d = (datas && datas[id]) || { entrada: null, saida: null, portEntrada: null, portSaida: null };
  const calculada = metaAcumulada(d.entrada, d.saida, ate);
  const inf = META_INFORMADA[id];
  // O que o informado ganha depois de setembro, pela régua comum.
  const desdeOutubro = inf ? metaAcumulada(d.entrada, d.saida, ate, FIM_DA_META_INFORMADA) : 0;
  // ⚠️ A META DO PERÍODO NÃO HERDA A EXCEÇÃO DO ITEM B9, e não é descuido: os quatro números
  // que a coordenação informou são o ACUMULADO de cada um até setembro. Aplicá-los a um
  // trimestre afirmaria que ela informou uma coisa que não informou.
  const doPeriodo = de ? metaAcumulada(d.entrada, d.saida, ate, de) : null;
  return {
    analista_id: id,
    meta: inf ? inf.meta + desdeOutubro : calculada,
    meta_calculada: calculada,
    meta_informada_ate_set: inf ? inf.meta : null,
    informada: !!inf,
    meta_periodo: doPeriodo,
    entrada: d.entrada,
    saida: d.saida,
    portaria_entrada: d.portEntrada,
    portaria_saida: d.portSaida,
    desde_o_inicio: !d.entrada,
    origem: inf
      ? 'informada pela coordenação até setembro/2026 (item B9), mais a régua comum de outubro em diante (item B4)'
      : (d.entrada || d.saida)
        ? 'calculada pela régua, proporcional pelas portarias'
        : 'calculada pela régua, integrante desde 01/08/2025',
  };
}

/** A régua inteira para uma lista de pessoas. Devolve mapa por id, só de quem é apurado. */
function metasDe(usuarios, substituicoes, ate, de) {
  const datas = datasPorPortaria(substituicoes);
  const saida = {};
  for (const u of usuarios || []) {
    if (!apura(u)) continue;
    saida[Number(u.id)] = metaDe(u, datas, ate, de);
  }
  return saida;
}

// O fim do mês de apuração corrente, em 'YYYY-MM-DD'. ⚠️ É O QUE FAZ A META SUBIR SOZINHA
// (item 2 do documento): em outubro o acumulado passa a 150 sem ninguém digitar nada, e foi
// para isso que a régua deixou de ser um número gravado.
function ateHoje(hoje) {
  const d = hoje ? new Date(hoje) : new Date();
  const ano = d.getUTCFullYear(), mes = d.getUTCMonth() + 1;
  return ano + '-' + String(mes).padStart(2, '0') + '-' + String(diasDoMes(ano, mes)).padStart(2, '0');
}

// AS BAIXAS SEM DATA CONFIÁVEL — item D2 da resposta de 17/09/2026, que a coordenação
// confirmou com a observação "essas podem ser puxadas no acumulado".
//
// ⚠️ A DATA DELAS É O DIA DA CARGA, NÃO O DIA DO TRABALHO. São 3.560 PCs com `data_baixa`
// em junho de 2026, todas da recarga de 05/08/2026. Um relatório trimestral que inclua aquele
// mês leva as 3.560 de uma vez; um que não inclua perde todas. As duas leituras mentem.
//
// ⚠️ POR ISSO ELAS FICAM SÓ NO ACUMULADO: lá a data não decide nada, e o trabalho aparece.
// No trimestre elas saem — é a única leitura em que a data importa.
//
// ⚠️ A LISTA É POR ORIGEM, E NÃO POR DATA. Cortar "tudo que foi baixado em junho de 2026"
// levaria junto a baixa de verdade feita naquele mês — e há 13 do 'secretario' e 11 do SIGEF
// com data de junho. O que não é confiável é a carga, não o mês.
const ORIGENS_SEM_DATA_CONFIAVEL = ['carga_historica', 'recarga_parcial_20260805'];

/** Esta baixa tem data de trabalho, ou data de carga? */
function dataDeBaixaConfiavel(pc) {
  return !!pc && !ORIGENS_SEM_DATA_CONFIAVEL.includes(pc.origem_baixa);
}

module.exports = {
  INICIO, BASE_PROPORCIONAL, META_INFORMADA, FIM_DA_META_INFORMADA, PERFIS_FORA, ORIGENS_SEM_DATA_CONFIAVEL,
  dataDeBaixaConfiavel,
  metaDoMes, diasDoMes, metaAcumulada, datasPorPortaria, metaDe, metasDe, apura, ateHoje,
};
