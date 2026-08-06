// CAMINHO: sigpc-api/lib/sgpe-link.js
//
// LINK DIRETO PARA O PROCESSO NO SGPe — parte PURA: normaliza a entrada, traduz a sigla em
// órgão e monta a URL. Não faz rede, não toca no banco. É o que permite testá-la inteira,
// sem sessão do SGPe.
//
// Portado de `segov-sistema/nextjs_space/lib/sgpe-link.ts` (produção), de onde também saiu o
// `sigpc-gt/sgpe-link-standalone.js`. As três cópias precisam ser mexidas juntas — em especial
// a tabela ORGAOS.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ LEIA ANTES DE USAR: **NÃO EXISTE FÓRMULA.**
//
// O número que vai na URL (`nuProcesso`) NÃO é o número que aparece na tela
// (`nuProcessooficial`). A diferença é o acúmulo de buracos de numeração (processos cancelados)
// dentro de cada órgão+ano — cresce sempre, mas em degraus imprevisíveis:
//
//   SCC/2025: 1328→1328 (0) · 8855→8856 (+1) · 13602→13605 (+3) · 21206→21212 (+6)
//   SCC/2023: 14925→14940 (+15)
//   SES/2025: 135960→137111 (+1151)
//   SED/2023: 114556→114714 (+158)
//
// **NUNCA** calcular, estimar, interpolar nem reaproveitar o deslocamento de um processo vizinho.
// Um número errado NÃO dá erro: abre OUTRO processo, em silêncio. A conversão é sempre por
// consulta ao SGPe (ver `sgpe-dwr.js`), e o resultado fica em cache (`sgpe_processo_ref`).
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ ADR/SDR: A REGIÃO FAZ PARTE DA SIGLA, E SÓ VALE COM SEPARADOR.
//
// As regionais entram na tabela ORGAOS com a região colada na sigla — ADR20, SDR13 — porque
// cada uma é um órgão distinto no SGPe, com cdOrgaosetor próprio. Por isso o PADRAO aceita até
// dois dígitos ao final da sigla.
//
// Só que no acervo do SIGPC a mesma coisa aparece escrita de dois jeitos, e um deles é ambíguo:
//
//   "ADR20 00001233/2017"  ->  região 20, processo 1233   (separador: sem dúvida)
//   "ADR223151/2017"       ->  região 22, processo 3151?  OU  região 2, processo 23151?
//
// Sem separador NÃO DÁ para saber onde a região termina, e errar aqui é o pior resultado
// possível: gera link para um processo que existe, mas é OUTRO, sem erro nenhum na tela.
// Por isso sigla com dígito só é aceita quando há separador explícito (espaço, ponto ou hífen).
// Sem separador, o texto ambíguo devolve null — ver a trava dentro de `normalizarProcesso`.
//
// ⚠️ E o inverso também importa: a esmagadora maioria do acervo é sigla SEM região colada ao
// número — "SCC2146/2020", "FCEE264/2017", "SED75922/2024" — e isso TEM de continuar valendo.
// São ~6.000 processos. Por isso os dígitos só migram para a sigla quando há separador; sem
// separador, a sigla é só letras e todo dígito pertence ao número, como sempre foi.

(function (raiz) {
  'use strict';

  // ── ERROS ───────────────────────────────────────────────────────────────────
  // Sigla que não dá para resolver é ERRO explícito, nunca chute silencioso.
  class ProcessoInvalido extends Error {}
  class SiglaDesconhecida extends Error {}
  class SiglaAmbigua extends Error {}
  class ProcessoNaoEncontrado extends Error {}
  class SessaoExpirada extends Error {}

  // ── 1. NORMALIZAR A ENTRADA ─────────────────────────────────────────────────
  // Aceita "SCC 8855/2025", "sie 32578/2021" (minúsculo) e "SED75922/2024" (sem espaço).
  // Aceita também a região na sigla, DESDE QUE separada do número: "ADR20 00001233/2017",
  // "ADR20-1233/2017", "SDR13.1028/2013".
  //
  // Os dois caminhos do meio do padrão são a regra inteira:
  //   (2) dígitos da região + separador OBRIGATÓRIO  -> os dígitos vão para a SIGLA
  //   (3) separador opcional, sem dígitos na sigla   -> todo dígito vai para o NÚMERO
  // Como (2) exige o separador, "ADR223151/2017" não casa por ali e cai em (3) — onde a trava
  // abaixo o rejeita. O `0*` come zeros à esquerda; o número volta como inteiro.
  const PADRAO = /^\s*([A-Za-z]{2,12})(?:([0-9]{1,2})[\s.\-]+|([\s.\-]*))0*(\d{1,8})\s*\/\s*(\d{4})\s*$/;

  /**
   * Devolve `null` — nunca lança — quando o texto não é um processo ou é ambíguo.
   * A base tem muito valor que NÃO é processo e não pode virar link:
   *   "Aguardando protocolo" · "-" · "Pendência" · "/2025" · "SDC" (sem número) ·
   *   "SCC 6579" (sem ano) · "SCC 7229 2024" (sem barra) · "9223/2026" (sem sigla) · vazio.
   *
   * @param {string|null|undefined} bruto
   * @returns {{sigla: string, numero: number, ano: number}|null}
   */
  function normalizarProcesso(bruto) {
    const m = String(bruto == null ? '' : bruto).match(PADRAO);
    if (!m) return null;

    const letras = m[1].toUpperCase();
    const regiao = m[2];            // só existe quando veio seguida de separador
    const separador = m[3];         // '' quando a sigla está colada ao número
    const numero = m[4];

    // ⚠️ TRAVA — NÃO REMOVER. Texto colado em que a sigla sozinha não é órgão, mas
    // sigla + 2 primeiros dígitos é: "ADR223151/2017" (ADR não é órgão, ADR22 é).
    // Não dá para saber se é a região 22 processo 3151 ou a região 2 processo 23151, e
    // chutar geraria link para um processo REAL porém ERRADO, em silêncio — pior que não
    // gerar link. Devolve null e o número fica texto puro.
    if (regiao === undefined && separador === ''
        && !ORGAOS[letras] && ORGAOS[letras + numero.slice(0, 2)]) {
      return null;
    }

    // A região entra na sigla como veio: "ADR7" não vira "ADR07". O mapa só tem chave de dois
    // dígitos, então a de um dígito não resolve e o processo fica sem link — que é o resultado
    // seguro. Completar o zero seria adivinhar qual regional o autor quis dizer.
    return {
      sigla: regiao === undefined ? letras : letras + regiao,
      numero: Number(numero),
      ano: Number(m[5]),
    };
  }

  /**
   * Mesma coisa a partir das três partes guardadas separadas (sigla / número / ano).
   * Passa pela MESMA regex de propósito: texto colado e campo estruturado nunca podem
   * divergir — há uma regra só, não duas.
   */
  function normalizarPartes(sigla, numero, ano) {
    return normalizarProcesso(
      (sigla == null ? '' : sigla) + ' ' + (numero == null ? '' : numero) + '/' + (ano == null ? '' : ano)
    );
  }

  /** "SCC 8855/2025" — a forma canônica, usada como chave de cache e para exibir. */
  function formatarProcesso(p) {
    return p.sigla + ' ' + p.numero + '/' + p.ano;
  }

  // ── 2. SIGLA → cdOrgaosetor ─────────────────────────────────────────────────
  // Tabela fixa, conferida no cadastro do SGPe. Sigla fora dela é ERRO, não chute.
  const ORGAOS = {
    APSFS: 45, SANTUR: 6949, ADR01: 13265, ADR02: 13287, ADR03: 13296,
    ADR04: 13307, ADR05: 13317, ADR06: 13327, ADR07: 13337, ADR08: 13347,
    ADR09: 13357, ADR10: 13375, ADR11: 13385, ADR12: 13277, ADR13: 13407,
    ADR14: 13417, ADR15: 13427, ADR16: 13437, ADR17: 13447, ADR18: 13457,
    ADR19: 13467, ADR20: 13477, ADR21: 13570, ADR22: 13580, ADR23: 13590,
    ADR24: 13600, ADR25: 13610, ADR26: 13620, ADR27: 13630, ADR28: 13640,
    ADR29: 13650, ADR30: 13660, ADR31: 13670, ADR32: 13680, ADR33: 13690,
    ADR34: 13700, ADR35: 13710, BADESC: 13185, ARESC: 13109, AGESAN: 8240,
    AGESC: 157, BESCOR: 2106, CEASASC: 14073, CIASC: 2209, 'CMDO-G': 2338,
    CODESC: 2252, CODISC: 2258, COHAB: 2424, HIDRO: 34172, CIDASC: 2262,
    CGE: 18139, CBMSC: 9992, DPE: 11005, DC: 20033, DEASE: 41678,
    DETER: 3031, DEINFRA: 3028, DETRAN: 3291, DILF: 3363, EPAGRI: 3465,
    FCC: 4274, FCD: 4276, FCEE: 4267, FESPORTE: 4277, FAPESC: 4305,
    SCPREV: 14593, FATMA: 4283, ENA: 8227, GABCM: 4327, GCE: 10096,
    CV: 4375, GVG: 4449, IAZPE: 5764, IOESC: 5765, IPESC: 5785,
    IMETRO: 5790, IPREV: 10151, IMA: 15508, IGP: 10252, JUCESC: 5874,
    MPC: 15639, SGPE: 37013, SIGEF: 37144, SIGRH: 19580, PCI: 34986,
    PCSC: 10704, PMSC: 6141, PPSC: 41921, PIMB: 13771, PROCON: 6642,
    PGE: 6604, PGJTC: 8789, PGTC: 6562, SCTUR: 18558, SAPIENS: 31525,
    SCPARCERIAS: 6955, SCPAR: 10542, INVESTSC: 40861, PSFS: 16559,
    SEJC: 7037, SEA: 7000, SAP: 20140, SAR: 7003, SAPE: 41247,
    SAS: 37576, SCC: 10068, SCTI: 37399, SEI: 7056, SECOM: 37855,
    SED: 7054, SEF: 6964, SICOS: 37454, SIE: 6965, SJC: 9208,
    SDC: 9650, SES: 7059, SSP: 6968, SST: 9718, SEC: 9382,
    SDR01: 6994, SDR02: 6992, SDR03: 6972, SDR04: 6980, SDR05: 6990,
    SDR06: 6981, SDR07: 6997, SDR08: 6975, SDR09: 6996, SDR10: 6978,
    SDR11: 6976, SDR12: 6971, SDR13: 6991, SDR14: 6983, SDR15: 6995,
    SDR16: 6977, SDR17: 6999, SDR18: 6988, SDR19: 6986, SDR20: 6989,
    SDR21: 6982, SDR22: 6973, SDR23: 6984, SDR24: 6974, SDR25: 6987,
    SDR26: 6979, SDR27: 6985, SDR28: 6993, SDR29: 6998, SDR30: 6970,
    SDR31: 7026, SDR32: 7046, SDR33: 7045, SDR34: 6962, SDR35: 7028,
    SDR36: 7027, SEJURI: 40349, SOL: 6969, SDE: 32571, DSUST: 7024,
    SDS: 7004, SEMAE: 37706, SEPLAN: 37405, SPG: 7001, SETUR: 37541,
    SPAF: 37611, SAQ: 37754, SCM: 10087, SAN: 7007, SAE: 9344,
    SAI: 7043, SEHRF: 14839, SIG: 15535, SSR: 9368, SEMA: 19223,
    SPR: 10288, SGG: 35381, PTEC: 8296, SUDERF: 12867, SUDESC: 38471,
    UDESC: 12022, UDSC: 4302, UNOPAR: 12939, SAPIENS_EXTERNO_INAT: 15073,
  };

  // Siglas que o cadastro do SGPe devolve com DOIS órgãos. Não dá para escolher sozinho — quem
  // resolve é uma pessoa, definindo a sigla na tabela acima.
  const SIGLAS_AMBIGUAS = ['DC', 'SAN', 'SAP', 'SAS', 'SC'];
  // Sigla que não existe no SGPe, mas aparece na base.
  const SIGLAS_INEXISTENTES = ['SSC'];

  function orgaoDaSigla(sigla) {
    const s = String(sigla == null ? '' : sigla).toUpperCase();
    if (SIGLAS_AMBIGUAS.indexOf(s) !== -1) {
      throw new SiglaAmbigua(
        'A sigla "' + s + '" corresponde a mais de um órgão no SGPe — precisa ser definida à mão antes de gerar link.');
    }
    const cd = ORGAOS[s];
    if (!cd) {
      throw new SiglaDesconhecida(
        'Sigla "' + s + '" não está na tabela de órgãos'
        + (SIGLAS_INEXISTENTES.indexOf(s) !== -1 ? ' (não existe no SGPe)' : '') + '.');
    }
    return cd;
  }

  /** true se dá para tentar o link — usado pela tela para não oferecer o que vai falhar. */
  function siglaConhecida(sigla) {
    return !!ORGAOS[String(sigla == null ? '' : sigla).toUpperCase()];
  }

  // ── 3. MONTAR A URL ─────────────────────────────────────────────────────────
  // A aba PEÇAS é a ÚNICA que funciona como link colado no navegador. A de Processo
  // (`visualizarProcesso.do`) só funciona navegando dentro da sessão: colada direto, o SGPe
  // redireciona para a tela de consulta. Por isso é esta a URL padrão.
  //
  // `nuProcesso` é o ID INTERNO do SGPe — ver o aviso no topo do arquivo. Passar aqui o número
  // que aparece na tela abre outro processo, sem erro nenhum.
  function montarUrlSgpe(nuProcesso, cdOrgaosetor, ano) {
    return 'https://sgpe.sea.sc.gov.br/cpav/visualizarDocumentosProcesso.do'
      + '?processoPK=' + nuProcesso + ',' + cdOrgaosetor + ',' + ano + '&itemAba=aba_pecas';
  }

  // Demais abas, registradas por terem sido verificadas — nenhuma serve como link direto.
  // Tramitações usa OUTRO estilo de parâmetros, não o `processoPK` composto:
  //   visualizarTramitacaoProcesso.do?entity.processoPK.cdOrgaosetor=7059
  //     &entity.processoPK.nuAno=2025&entity.processoPK.nuProcesso=137111&itemAba=aba_tramitacoes

  // ── EXPORTAÇÃO ──────────────────────────────────────────────────────────────
  // Global no navegador (window.SgpeLink) e module.exports em Node — sem bundler, sem build.
  const api = {
    PADRAO,
    ORGAOS,
    SIGLAS_AMBIGUAS,
    SIGLAS_INEXISTENTES,
    ProcessoInvalido,
    SiglaDesconhecida,
    SiglaAmbigua,
    ProcessoNaoEncontrado,
    SessaoExpirada,
    normalizarProcesso,
    normalizarPartes,
    formatarProcesso,
    orgaoDaSigla,
    siglaConhecida,
    montarUrlSgpe,
  };

  raiz.SgpeLink = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
