// CAMINHO: sigpc-api/lib/invalidada.js
//
// A PC INVALIDADA — resíduo de carga que nunca deveria ter existido.
// Fase 2 do DESENHO_INVALIDACAO_PC.md. Especificação do Richard, 02/09/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO RESOLVE
//
// A `2021PC002840` (TR 2021TR002375) nasceu com `processo_pc = '-1'`, recebeu por engano o
// SCC da FINAL em 14/08 e a renumeração de 16/08 a fundiu na parcela 1. A analista conferiu
// no SIGEF: não existe prestação de 763,58 naquela TR. Ela impede a TR de ir para as
// concluídas, porque `baixadas >= total_pcs` conta uma PC que não existe.
//
// ⚠️ O ESTORNO NÃO SERVE, e isso foi medido antes de desenhar. Ele é por PARCELA, tem
// `AND baixada = true` no UPDATE (`server.js`, rota `/parcela/estornar`), e a PC alvo está
// `baixada = false` — estornar a parcela 1 desfaria a baixa da PC CORRETA e deixaria o
// resíduo intacto. E `estornada = true` nem sai da contagem: `resumo_tr` faz `COUNT(*)` sem
// filtro, e as 56 estornadas do acervo continuam somando em `total_pcs`.
//
// ⚠️ INVALIDAR NÃO ZERA `baixada` — decisão do Richard. Zerar seria estorno com outro nome:
// inventaria um evento que não houve, apagaria `parecer_tipo` e faria a PC voltar a aparecer
// como trabalho pendente. O par `baixada = true AND invalidada = true` é LEGÍTIMO, e é por
// isso que toda contagem de baixadas precisa do filtro — não é `baixada` que muda de valor.
//
// ⚠️ E É UMA CÓPIA SÓ. Estas expressões são coladas em 27 pontos entre `server.js` e as libs.
// Escrever `AND NOT invalidada` à mão em cada um seria 27 cópias da mesma regra, e a segunda
// cópia é sempre a que fica velha — foi assim com o `MAPA_PLAN_EST` na tela e com as duas
// definições de "livre" que abriram o vão das 87 PCs em 10/08.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Esta PC está ativa?" — o filtro de HOJE, sem recorte de data.
 *
 * @param a  o alias da tabela na consulta ('p', 'q', 'x'…), ou '' quando não há alias.
 *
 * ⚠️ O ALIAS É PARÂMETRO porque os 27 pontos não concordam: uns usam `p.`, o `resumo_tr` usa
 * `p.`, o `SQL_NL_RESIDUAL` usa `q.` na subconsulta, o `acompanhamento` usa `x.`, e várias
 * consultas antigas não têm alias nenhum. Fixar um alias aqui obrigaria a reescrever consulta
 * que não tem nada a ver com esta mudança.
 *
 * ⚠️ `NOT ... invalidada` E NÃO `= false`: a coluna é `NOT NULL DEFAULT false` (fase 1), então
 * não há terceiro estado para o `NOT` engolir. Se um dia ela virar anulável, o `NOT NULL` do
 * banco é que tem de ser revisto — não este arquivo.
 */
const ativa = (a = 'p') => (a ? `NOT ${a}.invalidada` : 'NOT invalidada');

/**
 * A MESMA pergunta, mas "naquela data" — para o relatório cumulativo.
 *
 * ⚠️ ISTO É O QUE IMPEDE DE REESCREVER RELATÓRIO JÁ EMITIDO, e é a razão de a coluna
 * `invalidada_em` existir. Com o filtro simples (`NOT invalidada`), um relatório de julho
 * gerado depois da invalidação perderia as PCs invalidadas — e as 16 baixadas candidatas têm
 * `data_baixa` em AGOSTO de 2026, dentro do período do CGE em aberto. O passado mudaria.
 *
 * É exatamente a forma que o estorno já usa em `GET /prestacoes_contas/produtividade`:
 * `(p.estornada = false OR p.data_estorno > $1)`. Uma regra nova copiando a solução da regra
 * antiga, de propósito — as duas respondem "o que valia naquela data".
 *
 * ⚠️ `invalidada_em > $corte` E NÃO `>=`: o corte é inclusivo do lado do passado. Uma PC
 * invalidada EXATAMENTE no instante do corte já não valia naquele relatório.
 *
 * @param param  o placeholder do corte, como '$1'
 * @param a      o alias da tabela
 */
const ativaAte = (param, a = 'p') => {
  const c = a ? `${a}.` : '';
  return `(${c}invalidada = false OR ${c}invalidada_em > ${param})`;
};

/**
 * O INVERSO — "inclusive as invalidadas".
 *
 * ⚠️ EXISTE PARA UM CASO SÓ, e ele é real: `lib/pc-nova.js` pergunta "esta PC já existe?"
 * antes de cadastrar. Se ela não enxergar a invalidada, o cadastro RECRIA exatamente a PC que
 * acabou de ser tirada de circulação — e a nova nasce sem a marca, então nada a impediria de
 * ser recriada de novo. A duplicidade tem de ver o que a contagem não vê.
 *
 * Não é uma expressão SQL: é a AUSÊNCIA de filtro, escrita com nome para que quem ler a
 * consulta saiba que a ausência é deliberada e não esquecimento.
 */
const TODAS_INCLUSIVE_INVALIDADAS = 'TRUE /* inclusive invalidadas — ver lib/invalidada.js */';

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 3 — QUEM INVALIDA, COM QUE MOTIVO, E O QUE SE GRAVA
//  Especificação do Richard, 02/09/2026.
// ═════════════════════════════════════════════════════════════════════════════

// ⚠️ SUPERADMIN E COORDENADOR, e o analista NÃO. Invalidar tira uma PC da contagem de todo
// mundo — do estoque, do relatório da CGE e, quando for baixada, da produtividade de alguém.
// É a mesma dupla das seis rotas de "coordenador OU superadmin" já existentes.
const PERFIS = ['superadmin', 'coordenador'];

/**
 * @param perfilEfetivo  o de `papel.perfilEfetivo(u)`, NUNCA `u.perfil` cru.
 *
 * ⚠️ O PERFIL EFETIVO, e não o do cadastro: no papel `analista` o superadmin É analista em
 * toda parte, e esta rota tem de recusá-lo como recusa qualquer outro. É o mesmo ponto que o
 * CLAUDE.md marca como "o que passa batido nas seis rotas de coordenador OU superadmin".
 */
const podeInvalidar = (perfilEfetivo) => PERFIS.includes(perfilEfetivo);

// ⚠️ 15, E NÃO OS 10 DE `correcao.MOTIVO_MIN` — decisão do Richard. Reusar aquele validador
// seria uma linha a menos e o número errado: o mínimo da invalidação é o mesmo do ESTORNO
// (`POST /parcela/estornar`, "motivo deve ter no mínimo 15 caracteres"), porque as duas
// respondem à CGE por trabalho que deixou de contar. A correção de situação é outra conversa.
const MOTIVO_MIN = 15;
const MOTIVO_MAX = 500;

function validarMotivo(texto) {
  const m = (texto ?? '').toString().trim();
  if (!m) return 'Escreva o motivo — ele fica no histórico e a CGE lê.';
  if (m.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;
  if (m.length > MOTIVO_MAX) return `O motivo passa de ${MOTIVO_MAX} caracteres.`;
  return null;
}

// Os dois eventos da trilha. Nomes no padrão dos existentes (`ci_reabriu`,
// `correcao_situacao`, `desfazer_puxar_ci`): substantivo do objeto + o que aconteceu.
const EVENTO_INVALIDAR = 'pc_invalidada';
const EVENTO_DESFAZER  = 'pc_invalidacao_desfeita';

// ⚠️ `FOR UPDATE` — a linha é travada antes de a permissão ser conferida. Conferir antes do
// lock deixa a janela em que outra transação invalida a mesma PC no meio.
const SQL_ALVO = `
  SELECT codigo_pc, tr, parcial_num, setorial_id, analista_id, analista_nome,
         baixada, status, enviado_ci, parecer_tipo, codigo_nl, valor,
         invalidada, invalidada_em, invalidada_por, motivo_invalidacao
    FROM prestacoes_contas
   WHERE codigo_pc = $1
   FOR UPDATE`;

// ⚠️ NÃO TOCA EM `baixada`, `status`, `data_baixa`, `parecer_tipo`, `enviado_ci` NEM EM
// `estornada`. Invalidar não é estornar: o par `baixada = true AND invalidada = true` é
// legítimo, e é por isso que a fase 2 pôs o filtro nas contagens em vez de zerar a baixa.
// Zerar aqui inventaria um evento que não houve — a regra de 16/08 que o `AND baixada = true`
// do estorno existe para proteger. Há teste que falha se um destes nomes voltar a este SQL.
//
// ⚠️ `AND invalidada = false` É A IDEMPOTÊNCIA. A segunda chamada não acha linha, não regrava
// `invalidada_em` (que mentiria sobre quando aconteceu) e não abre segunda linha na trilha.
const SQL_INVALIDAR = `
  UPDATE prestacoes_contas
     SET invalidada = true,
         invalidada_em = NOW(),
         invalidada_por = $2::int,
         motivo_invalidacao = $3::text,
         atualizado_em = NOW()
   WHERE codigo_pc = $1 AND invalidada = false
  RETURNING codigo_pc, tr, parcial_num, setorial_id, invalidada_em`;

// ⚠️ ZERA AS QUATRO COLUNAS, e o histórico FICA. É a mesma escolha da reabertura do C.I., que
// zera `ci_encerrado_em`/`ci_encerrado_por` e grava `ci_reabriu`: as colunas respondem "está
// invalidada agora, e por quem"; a trilha responde "o que já aconteceu com esta PC".
const SQL_DESINVALIDAR = `
  UPDATE prestacoes_contas
     SET invalidada = false,
         invalidada_em = NULL,
         invalidada_por = NULL,
         motivo_invalidacao = NULL,
         atualizado_em = NOW()
   WHERE codigo_pc = $1 AND invalidada = true
  RETURNING codigo_pc, tr, parcial_num, setorial_id`;

module.exports = {
  ativa, ativaAte, TODAS_INCLUSIVE_INVALIDADAS,
  PERFIS, podeInvalidar, MOTIVO_MIN, MOTIVO_MAX, validarMotivo,
  EVENTO_INVALIDAR, EVENTO_DESFAZER,
  SQL_ALVO, SQL_INVALIDAR, SQL_DESINVALIDAR,
};
