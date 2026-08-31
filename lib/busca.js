// CAMINHO: sigpc-api/lib/busca.js
//
// NORMALIZAÇÃO DE TERMO DE BUSCA — acento e número de processo do SGPe.
//
// Vive numa lib para poder ser testada sem subir o servidor, e para que a mesma regra sirva
// às rotas e aos testes. As mesmas funções existem em `sigpc-gt/index.html`, para as buscas
// que filtram no cliente — há teste de paridade comparando as duas contra o acervo real.

// ── ACENTO ──────────────────────────────────────────────────────────────────
// Tira o acento DO TERMO DIGITADO, não da coluna. Funciona porque o acervo está inteiro sem
// acento (conferido em 09/08/2026: 0 de 14.652 linhas com `[À-ÿ]` nos campos buscáveis).
// Se um dia entrar dado acentuado, isto não o alcança — aí seria `CREATE EXTENSION unaccent`.
const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/\p{Diacritic}/gu, '');

// ── NÚMERO DE PROCESSO ──────────────────────────────────────────────────────
// O mesmo processo aparece escrito de quatro jeitos no acervo, todos em volume:
//
//   separador + zeros ...... "SCC 00019172/2020"   6.942 linhas em processo_pc
//   colado, sem zeros ...... "ADR2226792017"       5.154   (sem separador E sem barra)
//   separador, sem zeros ... "ADR03 395/2017"      2.198
//   colado + zeros ......... "ADR0108102017"         276
//
// Quem digitava de um jeito não achava o outro: "SCC 2511" devolvia 0 embora "SCC2511/2020"
// exista em 77 linhas.
//
// A chave reduz as variantes a uma forma só, em DUAS ETAPAS — a ordem importa:
//   1. tira os zeros à esquerda de cada número, ANTES de remover os separadores;
//   2. remove espaço, ponto, hífen e barra.
//
// Invertida, a região das regionais quebra: "ADR20 00001233/2017" viraria "ADR2000001233..."
// e os zeros deixariam de ser "à esquerda" (passariam a vir depois do 0 de ADR20).
//
//   "SCC 00019172/2020" · "SCC19172/2020" · "SCC 19172/2020"  ->  SCC191722020
//   "ADR22 2679/2017"   · "ADR2226792017"                     ->  ADR2226792017
//
// ⚠️ POR QUE A BARRA SAI. Sem tirá-la, os 543 valores de `processo_pc` e 428 de
// `processo_mae` que estão gravados SEM barra ficariam inalcançáveis por quem digita a forma
// completa: "ADR22 2679/2017" acharia 0 em vez de 20.
//
// O preço é que número e ano passam a ser vizinhos, então um termo numérico curto pode casar
// atravessando a fronteira: "19172" casa "AR19  1727/2017" (19+1727) e "SCC21917/2021"
// (21917+2021). Medido sobre 9 termos típicos: 20 linhas a mais legítimas, 2 de ruído,
// nenhuma perdida. Achado a mais é visível na tela; achado a menos é silencioso — por isso
// a escolha é pelo superconjunto.
//
// ⚠️ Resíduo conhecido: "ADR0108102017" (colado E com zeros) é ambíguo — não dá para saber
// onde a região termina, então não converge com "ADR01 810/2017". É o mesmo caso que a trava
// de `lib/sgpe-link.js` recusa a linkar.
//
// Escrita SEM lookbehind de propósito: o Safari só passou a suportá-lo na versão 16.4, e a
// gêmea desta função roda no navegador.
const chaveProcesso = (s) => String(s == null ? '' : s).toUpperCase()
  .split(/[\s.\-]+/)
  .map(t => t.replace(/\d+/g, d => d.replace(/^0+/, '') || '0'))
  .join('')
  .replace(/\//g, '');

// A MESMA redução, em SQL, para aplicar à coluna. O `(?<![0-9])` é o que garante a etapa 1:
// só tira zero que não vem depois de dígito — o equivalente de limpar token a token.
// Postgres suporta lookbehind (conferido em produção); o JS acima não usa por causa do Safari.
const CHAVE_PROC_SQL = (expr) =>
  `translate(regexp_replace(upper(${expr}), '(?<![0-9])0+([0-9])', '\\1', 'g'), ' .-/', '')`;

// Os campos que uma busca livre cobre. A mesma lista existe no `index.html` — se divergirem,
// a mesma palavra digitada em duas telas dá resultados diferentes.
const CAMPOS_BUSCA = ['tr', 'processo_mae', 'processo_pc', 'entidade', 'codigo_nl', 'codigo_pc'];
const CAMPOS_PROCESSO = ['processo_mae', 'processo_pc'];

/**
 * Monta o pedaço de WHERE da busca livre e empurra os parâmetros em `values`.
 * Devolve a condição já entre parênteses.
 *
 * @param {string} busca      termo cru digitado
 * @param {Array}  values     array de parâmetros da query (é modificado)
 * @param {number} proximo    número do próximo $N disponível
 * @returns {{condicao: string, proximo: number}}
 */
function condicaoBusca(busca, values, proximo) {
  let i = proximo;
  const p = `$${i++}`;
  values.push(`%${semAcento(busca)}%`);

  // Os seis campos por ILIKE — nada que era achado antes deixa de ser.
  const partes = CAMPOS_BUSCA.map(c => `${c} ILIKE ${p}`);

  // E os dois de processo TAMBÉM pela chave. Só entra se sobrar algo do termo:
  // `position('' in x)` devolve 1, e casaria todas as linhas.
  const chave = chaveProcesso(semAcento(busca));
  if (chave) {
    const pc = `$${i++}`;
    values.push(chave);
    for (const c of CAMPOS_PROCESSO) {
      partes.push(`position(${pc} in ${CHAVE_PROC_SQL(`coalesce(${c},'')`)}) > 0`);
    }
  }
  return { condicao: `(${partes.join(' OR ')})`, proximo: i };
}

/**
 * Filtro de TR — coluna direta, por ILIKE, para aceitar o pedaço ("2021TR", "000411").
 *
 * ⚠️ ESTA NÃO PRECISA DE SUBCONSULTA, e a de baixo precisa. Todas as linhas de uma TR têm o
 * MESMO valor em `tr`: filtrar por ele no `WHERE` externo tira TRs inteiras, nunca pedaços de
 * uma, e as contagens do `GROUP BY` continuam vendo todas as PCs da TR que ficou.
 *
 * Devolve `null` quando não há o que filtrar — ausente ou vazio NÃO filtra.
 */
// ⚠️ `prefixo` EXISTE PORQUE NEM TODA CONSULTA TEM UMA TABELA SÓ. O C.I. chama a coluna de
// `p.tr` e o Acompanhamento a alcança por `x.` dentro de um EXISTS; sem qualificar, o Postgres
// ou escolhe a errada ou recusa por ambiguidade — e o primeiro caso é o que estraga calado.
// Vazio por padrão: quem tem uma tabela só continua chamando sem pensar nisso.
function condicaoTr(tr, values, proximo, prefixo = '') {
  const t = String(tr == null ? '' : tr).trim();
  if (!t) return null;
  const p = `$${proximo}`;
  values.push(`%${semAcento(t).replace(/[%_]/g, (m) => '\\' + m)}%`);
  return { condicao: `${prefixo}tr ILIKE ${p}`, proximo: proximo + 1 };
}

/**
 * Filtro de PROCESSO — só os dois campos de processo, e pela CHAVE.
 *
 * ⚠️ PELA CHAVE, e não por ILIKE do texto cru: o mesmo processo está gravado de quatro jeitos
 * no acervo ("SCC 00019172/2020", "SCC19172/2020", "SCC 19172/2020", colado sem barra). Quem
 * digita um jeito tem de achar os quatro — é a mesma redução que a `condicaoBusca` usa, e
 * normalizar só um dos dois lados faria a mesma tela responder diferente conforme o campo.
 *
 * ⚠️ E QUEM USA ISTO NUMA CONSULTA AGREGADA TEM DE ENVOLVER EM `tr IN (SELECT ...)`, como a
 * `condicaoBusca` já é envolvida. Aplicada direto no `WHERE` de um `GROUP BY tr`, ela deixaria
 * passar só as LINHAS cujo processo casou, e o `total_pcs` da TR passaria a contar 3 de 44 —
 * um número menor, plausível e errado, que ninguém desconfia.
 */
function condicaoProcesso(processo, values, proximo, prefixo = '') {
  const chave = chaveProcesso(semAcento(String(processo == null ? '' : processo).trim()));
  if (!chave) return null;
  let i = proximo;
  const p = `$${i++}`;
  values.push(chave);
  const partes = CAMPOS_PROCESSO.map(
    (c) => `position(${p} in ${CHAVE_PROC_SQL(`coalesce(${prefixo}${c},'')`)}) > 0`);
  return { condicao: `(${partes.join(' OR ')})`, proximo: i };
}

module.exports = {
  semAcento, chaveProcesso, CHAVE_PROC_SQL,
  CAMPOS_BUSCA, CAMPOS_PROCESSO, condicaoBusca, condicaoTr, condicaoProcesso,
};
