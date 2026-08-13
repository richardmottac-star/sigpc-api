// CAMINHO: sigpc-api/lib/assumir.js
//
// ASSUMIR A TR INTEIRA — numa transação.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
//
// Até 13/08/2026 o "assumir" era um PATCH por PC, em série, disparado pelo navegador:
//
//     for (const pc of PCS_ASSUMIR) {
//       await fetch(`/prestacoes_contas/${pc.codigo_pc}`, { method:'PATCH', ... })
//     }
//
// Uma TR tem até 83 PCs. Se a rede caísse no meio, metade ficava assumida e metade livre —
// e o próprio código já contava com isso: "⚠️ ok/83 PCs assumidas. Erros: ...". É o mesmo
// defeito que a devolução tinha e que foi corrigido em 12/08; este era o último lugar do
// sistema com esse padrão.
//
// Pior que na devolução: a TRAVA DE LIMITE era conferida A CADA PATCH. Numa TR de 83 PCs,
// 83 consultas para responder a mesma pergunta — e se o limite estourasse no meio (porque a
// PC 1 já contava como assumida), as primeiras entravam e as últimas eram recusadas.
//
// Agora: uma chamada, uma transação, a trava conferida UMA vez. Ou a TR inteira é assumida,
// ou nada é.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ NÃO TOCA em `baixada`, `data_baixa`, `enviado_ci`, `parecer_tipo`, `valor` nem em `ci_*`.
// Assumir é sobre quem vai analisar, não sobre o que já foi analisado. Há teste que falha se
// o UPDATE daqui mencionar qualquer uma delas.

// ⚠️ NOME CURTO, NÃO O COMPLETO — armadilha 1 do CLAUDE.md.
//
// `prestacoes_contas.analista_nome` guarda "Richard", não "Richard Motta Coelho". O mapa
// vivia no `index.html`, onde a tela decidia sozinha o nome que ia para o banco; veio para cá
// para ter um dono só. Quem não está no mapa entra pelo primeiro nome, como antes.
const MAPA_NOME = {
  'Richard Motta Coelho': 'Richard',
  'Nayara Limas Ferreira': 'Nayara',
  'Zadir Teresinha Machado Ferreira': 'Zadir',
  'Sandra Paul': 'Sandra Paul',
  'Sandra Rocha': 'Sandra Rocha',
  'Ana Claudia': 'Ana Claudia',
  'Ana Leticia': 'Ana Leticia',
  'Grace Oliveira': 'Grace Oliveira',
};

/** O nome como ele é gravado em `prestacoes_contas.analista_nome`. */
function nomeCurto(nomeCompleto) {
  const n = String(nomeCompleto ?? '').trim();
  if (!n) return null;
  return MAPA_NOME[n] || n.split(' ')[0];
}

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (!b.tr || !String(b.tr).trim()) return 'tr é obrigatório.';
  if (!b.usuario_id) return 'usuario_id é obrigatório.';
  return null;
}

// ⚠️ A LISTA DE PCs É CAPTURADA ANTES DA ESCRITA, com FOR UPDATE (regra 12).
//
// Sem o lock, dois analistas clicando "Assumir" na mesma TR no mesmo segundo leriam as
// mesmas PCs livres e os dois escreveriam — o segundo por cima do primeiro, sem erro nenhum.
// É a condição que a coluna `conflito` existe para não ter.
const SQL_LIVRES = `
  SELECT codigo_pc FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND status = 'livre' AND analista_id IS NULL
   ORDER BY codigo_pc
   FOR UPDATE`;

// ⚠️ `dt_assumida` SEM COALESCE e `dt_inicio_analise` COM — são perguntas diferentes.
// A primeira é "quando ESTE analista pegou a TR" e reinicia a cada assunção; a segunda é o
// relógio da análise, que não reinicia (ver o PATCH e o CLAUDE.md).
const SQL_ASSUMIR = `
  UPDATE prestacoes_contas
     SET analista_id = $2,
         analista_nome = $3,
         status = 'analise',
         dt_assumida = NOW(),
         dt_inicio_analise = COALESCE(dt_inicio_analise, NOW()),
         atualizado_em = NOW()
   WHERE codigo_pc = ANY($1)
  RETURNING codigo_pc`;

module.exports = { MAPA_NOME, nomeCurto, validar, SQL_LIVRES, SQL_ASSUMIR };
