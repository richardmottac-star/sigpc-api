// CAMINHO: sigpc-api/lib/auth.js
//
// AUTENTICAÇÃO — conferência de senha e regra de entrada.
//
// ⚠️ POR QUE ESTE ARQUIVO EXISTE (11/08/2026)
//
// Até hoje NÃO HAVIA login no servidor. O `index.html` pedia `GET /usuarios?cpf=X`, recebia
// a linha inteira — com a senha — e comparava em JavaScript, na máquina do usuário.
// Medido em produção antes da correção:
//
//     GET /usuarios  →  HTTP 200 · 50 usuários · 49 senhas · sem nenhuma credencial
//     49 das 50 senhas em TEXTO PURO · 44 pessoas com a MESMA senha
//
// Ou seja: a senha do superadmin saía numa linha de comando. Não era falha a explorar — era
// o comportamento normal da rota, e é o que a abertura aos 47 analistas tornaria grave.
//
// ⚠️ A CONFERÊNCIA ACEITA OS DOIS FORMATOS, E ISSO É DE PROPÓSITO
//
// As 49 senhas em texto puro continuam no banco no momento em que este código sobe. Se a
// conferência só entendesse bcrypt, NINGUÉM entraria no sistema até a migração rodar — e a
// migração é escrita no banco, que depende de autorização do Richard.
//
// Então `conferir` entende os dois e avisa, em `precisaRehash`, quando a senha guardada
// ainda é texto puro. Quem chama decide o que fazer com esse aviso. É o que permite o
// código subir hoje e a migração acontecer quando ele mandar, em qualquer ordem.
//
// ⚠️ NÃO REINTRODUZIR COMPARAÇÃO DE SENHA NO FRONT. A senha nunca mais sai do servidor:
// `senha_hash` foi retirado de `GET /usuarios` e de `GET /usuarios/:id`, e há teste que
// falha se voltar.

const bcrypt = require('bcryptjs');

const CUSTO = 10;

// Tamanho mínimo da senha nova. Não é o ideal de segurança — é o que uma equipe de 47
// pessoas troca no primeiro acesso sem travar a abertura.
const SENHA_MIN = 6;

// As que a varredura de 11/08 encontrou em uso, mais as tentações óbvias. A conferência é
// exata e sem acento: não é uma lista de proibições, é um freio no reflexo.
const SENHAS_OBVIAS = [
  '123456', '1234567', '12345678', '123456789', '1234', '12345',
  'senha', 'senha123', 'mudar123', 'trocar123', 'abcdef', 'qwerty',
  'sigpc', 'sigpc123', 'fcee', 'fcee123', 'admin', 'admin123',
];

/** O valor guardado já é hash bcrypt? */
function ehHash(guardada) {
  return typeof guardada === 'string' && /^\$2[aby]?\$/.test(guardada);
}

/** Gera o hash de uma senha nova. */
async function hashSenha(senha) {
  return bcrypt.hash(String(senha), CUSTO);
}

/**
 * Confere a senha digitada contra o que está guardado.
 *
 * Devolve { ok, precisaRehash }:
 *   ok            — a senha confere
 *   precisaRehash — conferiu, mas o que está no banco é texto puro e devia virar hash
 *
 * O formato antigo `admin|analista` (senha dupla separada por barra) é aceito na leitura
 * porque existiu no sistema, e qualquer uma das duas partes vale. Nenhum usuário estava
 * nesse formato em 11/08 (conferido: 0 de 50), e nada aqui volta a criar um.
 */
async function conferir(digitada, guardada) {
  const d = String(digitada ?? '');
  // Senha vazia nunca entra. Sem esta linha, um usuário com `senha_hash` NULL — existe um,
  // a Grazielly — entraria com string vazia, e o `''.split('|')` daria `['']` casando.
  if (!d || !guardada) return { ok: false, precisaRehash: false };

  if (ehHash(guardada)) {
    return { ok: await bcrypt.compare(d, guardada), precisaRehash: false };
  }

  // Texto puro: comparação direta, e o aviso de que isto precisa virar hash.
  const partes = String(guardada).split('|');
  const ok = partes.some(p => p.length > 0 && p === d);
  return { ok, precisaRehash: ok };
}

/**
 * Pode entrar? Devolve a mensagem de recusa, ou null se pode.
 *
 * Esta regra vivia no `index.html` (função `login`), onde o usuário podia contorná-la
 * abrindo o DevTools. Passou para cá inteira — é a mesma decisão, no lugar onde ela vale.
 *
 * `setorial` é o que a tela de login oferece: 'ADMIN' ou a sigla da setorial.
 */
function podeEntrar(u, setorial, manutencao) {
  if (!u) return 'CPF não encontrado.';
  // ⚠️ A MANUTENÇÃO VEM ANTES DE TUDO QUE É SOBRE A PESSOA.
  //
  // Quem está barrado pela manutenção não precisa saber se o cadastro está inativo ou se
  // errou a setorial: a resposta é a mesma para todos e é sobre o SISTEMA, não sobre ele.
  // Se viesse depois, um analista inativo leria "usuário inativo" durante a manutenção e
  // abriria chamado para um problema que não existe.
  //
  // `manutencao` é opcional: quem chamar sem ele (teste antigo, rota que não leu a config)
  // segue com o comportamento de antes. Falha aberta, como o resto do modo.
  if (manutencao) return manutencao;
  if (u.aguardando_aprovacao)
    return 'Seu cadastro está aguardando aprovação. Aguarde o contato do seu coordenador.';
  if (!u.ativo) return 'Usuário inativo. Entre em contato com o administrador.';
  // Só o superadmin entra pelo modo ADMIN. Antes esta conferência não existia deste lado:
  // o front decidia sozinho, e um analista que trocasse `perfil` no localStorage entrava
  // como se fosse.
  if (setorial === 'ADMIN' && u.perfil !== 'superadmin')
    return 'Este acesso é exclusivo do administrador.';
  // Superadmin entra em qualquer setorial; os demais, só na sua.
  if (setorial !== 'ADMIN' && u.perfil !== 'superadmin' && u.setorial_id !== setorial)
    return 'Você não tem acesso a esta setorial.';
  return null;
}

/**
 * A senha nova serve? Devolve a mensagem de erro, ou null.
 *
 * `atual` é a senha que a pessoa está trocando — a nova não pode ser a mesma. Em 11/08,
 * 44 dos 50 usuários compartilhavam UMA senha: sem esta conferência, a troca obrigatória
 * viraria teatro, com todo mundo redigitando a mesma coisa.
 */
function validarSenhaNova(nova, atual) {
  const n = String(nova ?? '');
  if (!n.trim()) return 'Digite a senha nova.';
  if (n.length < SENHA_MIN) return `A senha precisa de ao menos ${SENHA_MIN} caracteres.`;
  if (SENHAS_OBVIAS.includes(n.toLowerCase()))
    return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  if (atual != null && n === String(atual))
    return 'A senha nova precisa ser diferente da atual.';
  return null;
}

/**
 * A linha do usuário sem nada que não deva sair do servidor.
 *
 * ⚠️ Lista de EXCLUSÃO, não de inclusão, de propósito: coluna nova em `usuarios` passa a
 * sair sozinha. O contrário faria um campo novo sumir da tela sem ninguém entender por quê —
 * e o risco que importa aqui tem nome e é um só.
 */
function semSegredo(u) {
  if (!u) return null;
  const { senha_hash, ...resto } = u;
  return resto;
}

module.exports = {
  CUSTO, SENHA_MIN, SENHAS_OBVIAS,
  ehHash, hashSenha, conferir, podeEntrar, validarSenhaNova, semSegredo,
};
