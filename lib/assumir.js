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
//
// ⚠️ A CHAVE É O `usuarios.nome`, SEMPRE — CORRIGIDO EM 16/08/2026.
//
// Três chaves eram o nome CURTO ("Sandra Rocha", "Ana Claudia", "Ana Leticia") e por isso
// **nunca disparavam**: não existe usuário chamado assim, então o `MAPA_NOME[n]` não casava e
// a função caía no `split(' ')[0]`. Medido contra o banco: a Ana Claudia (id 22) e a Ana
// Letícia (id 23) viravam as duas o mesmo "Ana", e a Sandra Rocha (id 19) virava "Sandra" —
// contra 105, 147 e 354 PCs que o acervo já tinha no nome certo.
//
// Uma entrada que não dispara não dá erro: ela só devolve outro nome, e o analista aparece
// com dois rótulos na própria planilha. **Se acrescentar alguém, copie o `usuarios.nome`
// exatamente como está no cadastro, ACENTO INCLUSIVE** — a comparação é literal.
// ⚠️ AS DUAS ÚLTIMAS NÃO ESTAVAM NO MAPA — e divergiam do mesmo jeito. A Goreti é chamada
// pelo SEGUNDO nome (52 PCs no acervo dizem "Goreti", e o primeiro nome dela é Maria), e o
// acervo da Janaína está SEM ACENTO nas 188 PCs. O mapa é a lista de todo mundo cujo rótulo
// não é o primeiro nome do cadastro — não só de quem tem nome composto.
const MAPA_NOME = {
  'Richard Motta Coelho': 'Richard',
  'Nayara Limas Ferreira': 'Nayara',
  'Zadir Teresinha Machado Ferreira': 'Zadir',
  'Sandra Paul': 'Sandra Paul',
  'Sandra Cezária Ronchi Rocha': 'Sandra Rocha',
  'Ana Claudia Carvalho Costa': 'Ana Claudia',
  'Ana Letícia Wloch de Oliveira': 'Ana Leticia',
  'Grace Oliveira': 'Grace Oliveira',
  'Maria Goreti Korb': 'Goreti',
  'Janaína Frederico Dittrich': 'Janaina',
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

// ⚠️ A DEFINIÇÃO DE "LIVRE" MORA AQUI, E SÓ AQUI (16/08/2026).
//
// Livre = **sem dono E sem trabalho começado**. As duas coisas, sempre.
//
// Até hoje a mesma pergunta era respondida em dois lugares, em duas linguagens: esta, em SQL,
// e a da tela do Estoque, em JS — `statusDerivado = !analista_nome ? 'livre' : …`, que olhava
// SÓ o nome. Sem dono e com `status='analise'` caía no vão: a tela mostrava Livre e o assumir
// recusava com "Nenhuma PC livre nesta TR".
//
// Aconteceu de verdade: **87 PCs em 6 TRs** ficaram assim desde 10/08 e ninguém conseguia
// assumi-las. O dado foi corrigido; esta constante é o que impede de voltar.
//
// ⚠️ Quem precisar contar PC livre — a rota, a tela, um script — usa ESTA string. Reescrever
// a condição à mão em outro lugar é recriar o vão com outro nome.
const PC_LIVRE_SQL = `analista_id IS NULL AND status = 'livre'`;

// ⚠️ A LISTA DE PCs É CAPTURADA ANTES DA ESCRITA, com FOR UPDATE (regra 12).
//
// Sem o lock, dois analistas clicando "Assumir" na mesma TR no mesmo segundo leriam as
// mesmas PCs livres e os dois escreveriam — o segundo por cima do primeiro, sem erro nenhum.
// É a condição que a coluna `conflito` existe para não ter.
const SQL_LIVRES = `
  SELECT codigo_pc FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND ${PC_LIVRE_SQL}
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

module.exports = { MAPA_NOME, nomeCurto, validar, PC_LIVRE_SQL, SQL_LIVRES, SQL_ASSUMIR };
