// CAMINHO: sigpc-api/lib/sgpe-vinculo.js
//
// A VINCULAÇÃO MÃE/PARCIAIS DE UM PROCESSO SGPe.  (31/08/2026)
//
// Responde a uma pergunta só: "este processo é a mãe de uma TR ou uma parcial dela — e o que
// mais existe nessa TR?". Serve à faixa de vinculação dentro do modal do SGPe.
//
// ⚠️ ESTA LIB NÃO ESCREVE NADA e não decide nada sobre o dado. Ela normaliza, compara e
// agrupa. Processo que não casa não vira TR aproximada: vira `encontrado: false`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ ESTA É A TERCEIRA CHAVE DE PROCESSO DO REPOSITÓRIO, E ISSO É DE PROPÓSITO — mas quem
// mexer aqui precisa saber das outras duas, porque elas NÃO são intercambiáveis:
//
//   1. `busca.chaveProcesso`  — tira o zero à esquerda de CADA número separadamente.
//      "ADR20 00001233/2017" -> ADR2012332017
//   2. `ci-fila.SQL_SGPE_CHAVE` — devolve "SIGLA/numero/ano", com o ano separado.
//      "ADR20 00001233/2017" -> ADR/1233/2017
//   3. ESTA — letras, depois TODOS os dígitos com o zero à esquerda tirado UMA vez.
//      "ADR20 00001233/2017" -> ADR20000012332017
//
// As três discordam nas regionais, onde a região é dígito colado à sigla. Foi MEDIDO no
// acervo em 31/08/2026, antes de escrever esta lib: dos 7.839 valores distintos de processo,
// os 7.774 grupos formados pela chave (1) **não são partidos em nenhum caso** pela chave (3).
// Ou seja, hoje nenhum processo está gravado nas duas grafias que fariam as duas discordarem.
//
// ⚠️ O DIA EM QUE ESTIVER, esta rota devolve `encontrado: false` para um processo que existe —
// e "não encontrado" é a resposta mais cara que ela pode dar, porque parece definitiva. Se a
// medição acima deixar de dar zero, é sinal de trocar esta chave pela (1), e não de remendar.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chave, em SQL. Aplicada AOS DOIS LADOS — à coluna e ao que a pessoa mandou.
 *
 * ⚠️ O MESMO `expr` APARECE DUAS VEZES, e por isso ele tem de ser uma expressão barata e sem
 * efeito: uma coluna ou um parâmetro. Passar uma subconsulta aqui a executaria duas vezes.
 */
const CHAVE_SQL = (expr) =>
  `(regexp_replace(upper(${expr}), '[^A-Z]', '', 'g') || ` +
  `regexp_replace(regexp_replace(${expr}, '[^0-9]', '', 'g'), '^0+', ''))`;

/**
 * A MESMA chave, em JavaScript.
 *
 * ⚠️ ELA EXISTE PARA UMA COISA SÓ: marcar qual processo da lista é o consultado (`atual`).
 * A COMPARAÇÃO QUE ACHA A TR É A DO BANCO — se esta fosse usada para filtrar, seriam duas
 * implementações da mesma pergunta, e é assim que a `diasEspera` do C.I. divergiu em 6% das
 * linhas. Há teste que roda as duas contra o acervo inteiro e exige empate.
 */
function chave(txt) {
  const s = String(txt == null ? '' : txt);
  return s.toUpperCase().replace(/[^A-Z]/g, '') + s.replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// ⚠️ OS TRÊS MARCADORES DE AUSÊNCIA DO ACERVO. `-1` é o que a carga da CGE gravou onde não
// havia processo, e `-` e `''` vieram da mesma origem — o levantamento de 30/08 conta o
// `processo_pc` preenchido excluindo exatamente estes três. Sem esta lista, uma PC sem
// processo viraria um "processo" chamado `-1` na faixa de vinculação.
const SEM_PROCESSO = ['', '-', '-1'];
const semProcesso = (v) => SEM_PROCESSO.includes(String(v == null ? '' : v).trim());

/**
 * A PC final não é uma parcial (armadilha 15). O teste é por `tipo`, NUNCA pelo texto de
 * `parcial_num`: no acervo há `FINAL` (981), `Final` (39) e `final` (1), e cinco finais
 * gravadas com `parcial_num = '1'`, que se misturariam à parcial 1.
 */
const ehFinal = (l) => String(l && l.tipo || '').trim().toLowerCase() === 'final';

/** Ordena parciais como número quando dá, e joga "final" para o fim — ela fecha a TR. */
function ordenarParciais(a, b) {
  if (a === 'final') return 1;
  if (b === 'final') return -1;
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b), 'pt-BR');
}

/**
 * Monta o bloco a partir das linhas da TR — função PURA, sem banco.
 *
 * ⚠️ RECEBE **TODAS** AS PCs DA TR. Nada de filtrar por analista, por baixada ou por página:
 * a faixa existe para dizer o tamanho da TR, e uma contagem recortada diria um número menor
 * que a pessoa leria como o total. Quem chama garante isso; esta função só soma o que recebe.
 */
function montar(linhas, chaveConsultada, papel) {
  const lista = linhas || [];
  const pcs_sem_processo = lista.filter((l) => semProcesso(l.processo_pc)).length;

  // ⚠️ AGRUPA PELO VALOR CRU, e não pela chave. Duas grafias do mesmo processo na mesma TR
  // são duas linhas na faixa, de propósito: é justamente o que a pessoa precisa VER para
  // decidir corrigir uma delas. Agrupar pela chave esconderia a divergência que a faixa
  // existe para mostrar.
  const mapa = new Map();
  for (const l of lista) {
    if (semProcesso(l.processo_pc)) continue;
    const bruto = String(l.processo_pc);
    if (!mapa.has(bruto)) {
      mapa.set(bruto, {
        processo: bruto,
        qtd: 0,
        parciais: new Set(),
        // ⚠️ `atual` SAI DA CHAVE, e não da igualdade de texto: quem consultou
        // "SCC 3538/2020" tem de ver marcado o "SCC3538/2020" que está gravado.
        atual: chave(bruto) === chaveConsultada,
      });
    }
    const e = mapa.get(bruto);
    e.qtd++;
    e.parciais.add(ehFinal(l) ? 'final' : String(l.parcial_num == null ? '—' : l.parcial_num));
  }

  const processos = [...mapa.values()]
    .map((e) => ({ ...e, parciais: [...e.parciais].sort(ordenarParciais) }))
    .sort((a, b) => (b.atual ? 1 : 0) - (a.atual ? 1 : 0)
                 || ordenarParciais(a.parciais[0], b.parciais[0])
                 || a.processo.localeCompare(b.processo, 'pt-BR'));

  const l0 = lista[0] || {};
  return {
    encontrado: true,
    papel,
    tr: l0.tr || null,
    entidade: l0.entidade || null,
    processo_mae: l0.processo_mae || null,
    total_pcs: lista.length,
    total_processos_parciais: processos.length,
    processos,
    pcs_sem_processo,
  };
}

const NAO_ENCONTRADO = { encontrado: false };

module.exports = { CHAVE_SQL, chave, semProcesso, ehFinal, montar, NAO_ENCONTRADO, SEM_PROCESSO };
