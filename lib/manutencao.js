// CAMINHO: sigpc-api/lib/manutencao.js
//
// MODO MANUTENÇÃO — a janela segura de escrita.
//
// Existe porque, até 12/08/2026, gravar no banco com segurança dependia de pedir no
// WhatsApp e esperar 30 minutos de inércia do `ultimo_acesso`. Isso não escala, e a
// espera era vaga: às 21:47 daquele dia ninguém escrevia havia 17 minutos, mas quatro
// pessoas seguiam com a tela aberta e o critério de "online" não zerava.
//
// Com o interruptor ligado: ninguém além do superadmin entra, e quem já estava dentro cai.
//
// ─────────────────────────────────────────────────────────────────────────────
// MANUTENÇÃO NÃO É PREPARAÇÃO
//
//   preparação  deixa entrar e limita  — a equipe troca a senha, vê o Meu Perfil e espera
//   manutenção  NÃO deixa entrar       — a tela para no login
//
// Isento da preparação: superadmin e coordenador. **Isento da manutenção: só superadmin.**
// Decisão do Richard em 12/08 — coordenador com a tela aberta escreve tanto quanto
// analista, e o objetivo aqui é que NINGUÉM escreva.
//
// Os dois interruptores são independentes. Se os dois estiverem ligados, manutenção vence:
// é a mais restritiva, e quem não entra não chega à tela restrita da preparação.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ ISTO É CORTINA, NÃO TRANCA — igual à preparação.
//
// O sistema ainda não tem camada de autorização: quem souber montar um pedido HTTP à mão
// passa. Para o que se quer — uma janela em que ninguém está trabalhando PELA TELA — a
// cortina basta. Não confundir com controle de acesso, e por isso o `janela_livre.js`
// continua sendo a conferência final antes de gravar.
//
// ⚠️ NA DÚVIDA, O SISTEMA ABRE (falha aberta, de propósito)
//
// Se `config_sistema` não puder ser lida, o modo fica DESLIGADO. Parece o contrário do que
// se quer aqui, mas: se o banco não responde, ninguém escreve nada de qualquer forma — e
// falhar fechado trancaria 53 pessoas fora por causa de uma oscilação de rede.

// Quem atravessa. Perfil que não estiver aqui é barrado, inclusive um perfil novo que
// apareça depois — o lado seguro do engano.
const ISENTOS = ['superadmin'];

const MENSAGEM_PADRAO =
  'O sistema está em manutenção e volta em instantes. ' +
  'Nenhum trabalho seu foi perdido.';

/** Este usuário é barrado pelo modo? */
function barra(config, usuario) {
  if (!config || !config.modo_manutencao) return false;
  if (!usuario || !usuario.perfil) return false;   // sem saber quem é, não barra
  return !ISENTOS.includes(usuario.perfil);
}

/** A frase que quem foi barrado vê. A mensagem é escrita pelo Richard, na tela. */
function recusa(config) {
  const m = (config && config.mensagem_manutencao || '').trim();
  return m || MENSAGEM_PADRAO;
}

/**
 * O carimbo que derruba as sessões, para a rota rodar DENTRO da transação que liga o modo.
 *
 * ⚠️ `clock_timestamp()`, e não `NOW()`: no Postgres o `NOW()` é o instante em que a
 * TRANSAÇÃO começou. Como a rota liga o modo e carimba na mesma transação, com `NOW()` os
 * dois carimbos sairiam iguais e o `sessao_fim < ultimo_acesso` da lista de online não
 * valeria — exatamente o defeito que o logout teve em 12/08.
 *
 * ⚠️ Condição derivada (`perfil <> 'superadmin'`) é aqui aceitável, e a regra 12 do
 * CLAUDE.md continua valendo onde ela nasceu: ela trata de REVERSÃO, e esta escrita não
 * tem reversão a fazer. O valor novo é o mesmo para todos, e o estado se cura sozinho —
 * quem entra de novo passa a ter `ultimo_acesso > sessao_fim` e volta à lista. Autorizado
 * pelo Richard em 12/08.
 */
const SQL_DERRUBAR = `
  UPDATE usuarios SET sessao_fim = clock_timestamp()
   WHERE perfil <> 'superadmin'
   RETURNING id`;

/**
 * A conferência que as rotas de trabalho chamam. Devolve a frase de recusa, ou null.
 *
 * Busca o perfil NO BANCO a partir do id, e não do corpo do pedido — o corpo é escrito
 * pela tela, e a tela é a que estamos cobrindo.
 */
async function bloqueio(db, config, usuarioId) {
  if (!config || !config.modo_manutencao) return null;
  // Sem id não dá para saber se é isento. Deixa passar: barrar aqui derrubaria rota que
  // não manda id nenhum, e a cortina viraria pane.
  if (!usuarioId) return null;
  try {
    const { rows } = await db.query('SELECT perfil FROM usuarios WHERE id = $1',
                                    [parseInt(usuarioId) || 0]);
    if (!rows.length) return null;
    if (!barra(config, rows[0])) return null;
    return recusa(config);
  } catch (e) {
    return null;
  }
}

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (b.modo_manutencao !== undefined && typeof b.modo_manutencao !== 'boolean')
    return 'modo_manutencao precisa ser true ou false.';
  if (b.mensagem_manutencao !== undefined && b.mensagem_manutencao !== null &&
      String(b.mensagem_manutencao).length > 400)
    return 'A mensagem passa de 400 caracteres.';
  return null;
}

module.exports = { ISENTOS, MENSAGEM_PADRAO, SQL_DERRUBAR, barra, recusa, bloqueio, validar };
