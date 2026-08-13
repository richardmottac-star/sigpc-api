// CAMINHO: sigpc-api/lib/processo-edit.js
//
// CORRIGIR O PROCESSO SGPe DE UMA PC — sigla, número e ano.
//
// Existe porque havia erro de digitação no acervo e nenhum caminho para consertar: em 13/08
// eram 506 PCs com texto que não formava processo e 40 com sigla fora do mapa. A correção em
// lote resolveu 347; o resto depende de conferência humana, e é para isso que esta rota serve.
//
// ⚠️ A ORDEM IMPORTA — decisão do Richard: PRIMEIRO tenta resolver sozinho (mapa de órgãos +
// cache + SGPe ao vivo); só se NÃO resolver é que a tela oferece colar o link à mão. Oferecer
// o manual antes faria o analista colar link para processo que o sistema acharia sozinho.
//
// ⚠️ EDITAR `processo_pc` MUDA O AGRUPAMENTO DA PARCIAL. A regra do sistema é
// "uma parcial = (tr, processo_pc)", e o `parcial_num` foi renumerado em 12/08 sobre esse par.
// Se o processo corrigido já existir na mesma TR, duas parcelas viram uma — por isso a rota
// AVISA antes (`fusao` na prévia) e só junta com confirmação explícita.

const CAMPOS = ['processo_pc', 'processo_mae'];

const ANO_MIN = 2000, ANO_MAX = 2030;

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (!b.codigo_pc) return 'codigo_pc é obrigatório.';
  if (!b.usuario_id) return 'usuario_id é obrigatório.';
  if (!CAMPOS.includes(b.campo)) return `campo deve ser um de: ${CAMPOS.join(', ')}`;

  const sigla = (b.sigla ?? '').toString().trim().toUpperCase();
  if (!sigla) return 'Informe a sigla do órgão.';
  if (!/^[A-Z]{2,10}\d{0,3}$/.test(sigla)) return 'Sigla inválida.';

  const numero = parseInt(b.numero, 10);
  if (!Number.isInteger(numero) || numero <= 0) return 'Informe o número do processo.';
  if (String(b.numero).replace(/\D/g, '').length > 9) return 'Número longo demais.';

  const ano = parseInt(b.ano, 10);
  if (!Number.isInteger(ano) || ano < ANO_MIN || ano > ANO_MAX)
    return `Ano deve estar entre ${ANO_MIN} e ${ANO_MAX}.`;
  return null;
}

/** O texto final, no formato que o resto do sistema entende. */
function montar(b) {
  return `${String(b.sigla).trim().toUpperCase()} ${parseInt(b.numero, 10)}/${parseInt(b.ano, 10)}`;
}

// ── LINK COLADO À MÃO ────────────────────────────────────────────────────────
//
// A URL do SGPe carrega exatamente os três números que `sgpe_processo_ref` guarda:
//   ...visualizarDocumentosProcesso.do?processoPK=137111,7059,2025&itemAba=aba_pecas
//                                                 nu     cd    ano
// Então colar o link é despedaçá-lo nas colunas que já existem — sem coluna nova, e o link
// passa a valer para TODAS as PCs daquele processo, não só a que foi corrigida.

const HOST_SGPE = 'sgpe.sea.sc.gov.br';

/**
 * Lê o link colado. Devolve { nu_processo, cd_orgaosetor, ano } ou { erro }.
 *
 * ⚠️ Confere o HOST. Sem isso, qualquer endereço com `processoPK=` na query entraria no
 * cache e viraria um link que a equipe clicaria confiando no sistema.
 */
function lerLink(url) {
  const t = (url ?? '').toString().trim();
  if (!t) return { erro: 'Cole o endereço do processo.' };
  let u;
  try { u = new URL(t); } catch (e) { return { erro: 'Isso não é um endereço válido.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { erro: 'O endereço precisa começar com http.' };
  if (u.hostname.toLowerCase() !== HOST_SGPE)
    return { erro: `O endereço precisa ser do SGPe (${HOST_SGPE}).` };

  const pk = u.searchParams.get('processoPK');
  if (!pk) return { erro: 'O endereço não tem o "processoPK". Abra o processo no SGPe e copie a barra do navegador.' };
  const partes = pk.split(',').map(x => parseInt(x.trim(), 10));
  if (partes.length !== 3 || partes.some(x => !Number.isInteger(x) || x <= 0))
    return { erro: 'O "processoPK" do endereço não tem os três números esperados.' };

  const [nu_processo, cd_orgaosetor, ano] = partes;
  if (ano < ANO_MIN || ano > ANO_MAX) return { erro: `O ano do endereço (${ano}) não parece válido.` };
  return { nu_processo, cd_orgaosetor, ano };
}

// ⚠️ `origem = 'MANUAL'` É IMUNE AO JOB.
//
// O `job_sgpe_links.js` reprocessa o que está sem link. Sem esta marca ele passaria por cima
// do link colado à mão e o trabalho do analista se perderia em silêncio — ninguém reclama de
// um link que voltou a não existir, porque ninguém percebe. Ver a trava em `montarFila`.
const ORIGEM_MANUAL = 'MANUAL';

module.exports = { CAMPOS, ANO_MIN, ANO_MAX, HOST_SGPE, ORIGEM_MANUAL, validar, montar, lerLink };
