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
// ⚠️ ADR/SDR NÃO SÃO SUPORTADOS — e a razão importa. No acervo do SIGPC a sigla vem com o
// código de região grudado ("ADR17 863/2017", "ADR223151/2017"). Quando há espaço, o PADRAO
// abaixo rejeita e o processo simplesmente fica sem link. Quando NÃO há espaço, ele ACEITA e
// devolve um número inventado pela colagem de região + número:
//
//   ADR223151/2017    -> {sigla:'ADR', numero:223151}   (é região 22, processo 3151)
//   ADR050001027/2017 -> {sigla:'ADR', numero:50001027} (é região 05, processo 1027)
//
// Hoje isso é inofensivo APENAS porque 'ADR' não está na tabela ORGAOS e `orgaoDaSigla` recusa.
// Levantamento de 05/08/2026: 24 processos ADR e 1 SDR de `processo_pc` caem nesse caso.
// **Acrescentar ADR/SDR em ORGAOS sem antes separar a região transforma os dois em links
// silenciosamente errados.** A região tem de virar parte da sigla ANTES da normalização.

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
  // O `0*` come zeros à esquerda; o número volta como inteiro.
  const PADRAO = /^\s*([A-Za-z]{2,12})\s*0*(\d{1,8})\s*\/\s*(\d{4})\s*$/;

  /**
   * Devolve `null` — nunca lança — quando o texto não é um processo.
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
    return { sigla: m[1].toUpperCase(), numero: Number(m[2]), ano: Number(m[3]) };
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
    SCC: 10068, SIE: 6965, SED: 7054, SES: 7059, SEF: 6964,
    SDC: 9650, SAR: 7003, SDS: 7004, SST: 9718, SETUR: 37541,
    SEMAE: 37706, SAPE: 41247, SPAF: 37611, SDE: 32571,
    CBMSC: 9992, SANTUR: 6949, GCE: 10096, DSUST: 7024,
    FCC: 4274, FCEE: 4267, FESPORTE: 4277, EPAGRI: 3465,
    SGG: 35381, GVG: 4449, SSP: 6968,
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
