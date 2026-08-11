// CAMINHO: sigpc-api/teste_auth.js
//
// Testes da AUTENTICACAO (lib/auth.js) e das travas que impedem a senha de voltar a sair
// do servidor. Sem rede e sem banco.
//
// ⚠️ O QUE ESTES TESTES PROTEGEM, e por que existem (11/08/2026)
//
// Ate a vespera da abertura aos 47 analistas, NAO HAVIA login no servidor: o `index.html`
// pedia `GET /usuarios?cpf=X`, recebia a linha inteira — com a senha — e comparava em
// JavaScript, na maquina do usuario. Medido em producao:
//
//     GET /usuarios  →  HTTP 200 · 50 usuarios · 49 senhas · sem nenhuma credencial
//     49 das 50 senhas em TEXTO PURO · 44 pessoas com a MESMA senha
//
// Estes testes existem para isso nao voltar por descuido. Tres deles leem o proprio
// server.js e falham se `senha_hash` reaparecer numa resposta.
//
// USO: node teste_auth.js

const A = require('./lib/auth');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

(async () => {

  console.log('\n═══ 1. A SENHA VIRA HASH, E O HASH CONFERE ═══');
  {
    const h = await A.hashSenha('704342');
    conf(A.ehHash(h), 'hashSenha devolve algo que ehHash reconhece');
    conf(h !== '704342', 'o hash nao e a senha');
    conf(h.length > 50, 'hash bcrypt tem tamanho de bcrypt');
    const h2 = await A.hashSenha('704342');
    conf(h !== h2, 'a mesma senha gera hashes diferentes (sal por linha)');
    // Sem sal, duas pessoas com a mesma senha teriam a mesma coluna — e em 11/08 eram 44.
    conf((await A.conferir('704342', h)).ok, 'a senha certa confere');
    conf((await A.conferir('704342', h2)).ok, 'confere no outro hash tambem');
    conf(!(await A.conferir('704341', h)).ok, 'a senha errada nao confere');
    conf(!(await A.conferir('', h)).ok, 'senha vazia nao confere');
  }

  console.log('\n═══ 2. AS 49 SENHAS EM TEXTO PURO CONTINUAM ENTRANDO ═══');
  // Se a conferencia so entendesse bcrypt, NINGUEM entraria ate a migracao rodar — e a
  // migracao depende de autorizacao do Richard. Os dois formatos convivem de proposito.
  {
    const r = await A.conferir('704342', '704342');
    conf(r.ok, 'senha em texto puro ainda entra');
    conf(r.precisaRehash, 'e avisa que precisa virar hash');
    const r2 = await A.conferir('errada', '704342');
    conf(!r2.ok, 'texto puro errado nao entra');
    conf(!r2.precisaRehash, 'e nao pede rehash do que nao conferiu');
    const r3 = await A.conferir('704342', await A.hashSenha('704342'));
    conf(r3.ok && !r3.precisaRehash, 'quem ja e hash nao pede rehash');
  }

  console.log('\n═══ 3. SENHA NULA NAO ENTRA COM NADA ═══');
  // A Grazielly (id 42) esta com senha_hash NULL no banco. Sem esta trava, o split('|') de
  // uma string vazia daria [''] e a comparacao casaria com string vazia.
  {
    conf(!(await A.conferir('qualquer', null)).ok, 'senha guardada NULL recusa');
    conf(!(await A.conferir('', null)).ok, 'vazia contra NULL recusa');
    conf(!(await A.conferir('', '')).ok, 'vazia contra vazia recusa');
    conf(!(await A.conferir(null, null)).ok, 'null contra null recusa');
  }

  console.log('\n═══ 4. O FORMATO ANTIGO admin|analista AINDA E LIDO ═══');
  {
    conf((await A.conferir('chefe', 'chefe|peao')).ok, 'a primeira parte entra');
    conf((await A.conferir('peao', 'chefe|peao')).ok, 'a segunda parte entra');
    conf(!(await A.conferir('outra', 'chefe|peao')).ok, 'o que nao e parte nenhuma nao entra');
    conf(!(await A.conferir('', 'chefe|')).ok, 'parte vazia nao vira senha vazia valida');
  }

  console.log('\n═══ 5. REGRA DE ENTRADA — SAIU DO NAVEGADOR, VEIO PARA O SERVIDOR ═══');
  const base = { id: 7, perfil: 'analista', setorial_id: 'FCEE', ativo: true, aguardando_aprovacao: false };
  {
    conf(A.podeEntrar(base, 'FCEE') === null, 'analista da FCEE entra na FCEE');
    conf(A.podeEntrar(null, 'FCEE') !== null, 'usuario inexistente nao entra');
    conf(A.podeEntrar({ ...base, ativo: false }, 'FCEE') !== null, 'inativo nao entra');
    conf(A.podeEntrar({ ...base, aguardando_aprovacao: true }, 'FCEE') !== null, 'aguardando aprovacao nao entra');
    conf(/aprova/i.test(A.podeEntrar({ ...base, aguardando_aprovacao: true }, 'FCEE')),
         'e a mensagem diz que e aprovacao, nao "senha incorreta"');
    conf(A.podeEntrar(base, 'OUTRA') !== null, 'analista nao entra em setorial que nao e a dele');

    // ⚠️ A trava que nao existia deste lado: o front decidia sozinho quem era superadmin, e
    // `perfil` morava num JSON editavel do localStorage.
    conf(A.podeEntrar(base, 'ADMIN') !== null, 'ANALISTA NAO ENTRA PELO MODO ADMIN');
    conf(A.podeEntrar({ ...base, perfil: 'coordenador' }, 'ADMIN') !== null, 'coordenador tambem nao');
    conf(A.podeEntrar({ ...base, perfil: 'superadmin' }, 'ADMIN') === null, 'superadmin entra pelo ADMIN');
    conf(A.podeEntrar({ ...base, perfil: 'superadmin' }, 'FCEE') === null, 'superadmin entra por qualquer setorial');
  }

  console.log('\n═══ 6. A SENHA NOVA PRECISA SER OUTRA, E NAO PODE SER OBVIA ═══');
  // 44 dos 50 usuarios compartilhavam UMA senha. Sem esta regra, a troca obrigatoria vira
  // teatro: todo mundo redigita a mesma coisa.
  {
    conf(A.validarSenhaNova('704342', '704342') !== null, 'a nova nao pode ser a atual');
    conf(A.validarSenhaNova('nova123', '704342') === null, 'senha diferente e razoavel passa');
    conf(A.validarSenhaNova('123456', null) !== null, '123456 e recusada');
    conf(A.validarSenhaNova('SENHA', null) !== null, 'a lista de obvias ignora maiuscula');
    conf(A.validarSenhaNova('12345', null) !== null, 'curta demais e recusada');
    conf(A.validarSenhaNova('', null) !== null, 'vazia e recusada');
    conf(A.validarSenhaNova('   ', null) !== null, 'so espaco e recusada');
    conf(A.validarSenhaNova('kx7mq2', null) === null, 'seis caracteres passa');
    conf(A.validarSenhaNova('abcdef', null) !== null, 'abcdef tem seis, mas esta na lista de obvias');
  }

  console.log('\n═══ 7. semSegredo TIRA A SENHA E NAO LEVA MAIS NADA JUNTO ═══');
  {
    const u = { id: 4, nome: 'Richard', cpf: '038.237.359-69', senha_hash: '704342',
                perfil: 'superadmin', grupo: '3', email: 'r@x.com', coluna_futura: 'vale' };
    const s = A.semSegredo(u);
    conf(s.senha_hash === undefined, 'senha_hash sai');
    conf(s.nome === 'Richard' && s.perfil === 'superadmin' && s.grupo === '3', 'o resto fica');
    // Lista de EXCLUSAO, nao de inclusao: coluna nova passa a sair sozinha, em vez de sumir
    // da tela sem ninguem entender por que.
    conf(s.coluna_futura === 'vale', 'coluna nova passa sozinha');
    conf(A.semSegredo(null) === null, 'null nao quebra');
    conf(u.senha_hash === '704342', 'o objeto original nao e alterado');
  }

  console.log('\n═══ 8. TRAVA: A SENHA NAO PODE VOLTAR A SAIR DO SERVIDOR ═══');
  {
    const src = fs.readFileSync('./server.js', 'utf8');

    // A trava de verdade: TODO comando que traz a linha inteira de `usuarios` — `SELECT *`
    // ou `RETURNING *` — precisa ter `semSegredo` entre ele e a resposta.
    //
    // A janela e por posicao, e nao por rota: dividir o arquivo por `app.get(` juntava o fim
    // de uma rota com o comeco da outra e acusava rotas que nem mexem em usuario (foi o que
    // aconteceu na primeira versao deste teste — tres falsos positivos).
    const ALVO = /(SELECT \* FROM usuarios|(?:UPDATE|INSERT INTO) usuarios[\s\S]{0,700}?RETURNING \*)/g;
    const semFiltro = [];
    let m;
    while ((m = ALVO.exec(src)) !== null) {
      const depois = src.slice(m.index, m.index + 900);
      // Onde essa linha vira resposta? Se nao vira (e o caso do login, que le para conferir),
      // nao ha o que filtrar.
      const iResp = depois.search(/res\.json\(/);
      if (iResp === -1) continue;
      const ateResposta = depois.slice(0, iResp + 120);
      if (!/semSegredo/.test(ateResposta)) {
        semFiltro.push(src.slice(m.index, m.index + 60).replace(/\s+/g, ' '));
      }
    }
    conf(semFiltro.length === 0,
         'nenhuma linha inteira de usuarios chega a resposta sem semSegredo',
         semFiltro.join(' | '));

    // E as duas rotas que devolviam as 49 senhas ao mundo, nomeadas: se alguem reescrever a
    // consulta e o teste acima deixar de alcanca-la, estas duas ainda cobram.
    const trechoDe = (marca, tam) => {
      const i = src.indexOf(marca);
      return i === -1 ? '' : src.slice(i, i + tam);
    };
    conf(/semSegredo/.test(trechoDe('SELECT * FROM usuarios ${where} ORDER BY nome', 400)),
         'GET /usuarios passa por semSegredo');
    conf(/semSegredo/.test(trechoDe("SELECT * FROM usuarios WHERE id = $1', [req.params.id]", 300)),
         'GET /usuarios/:id passa por semSegredo');

    conf(/app\.post\('\/usuarios\/login'/.test(src), 'a rota de login existe no servidor');
    conf(/app\.post\('\/usuarios\/trocar_senha'/.test(src), 'a rota de troca de senha existe');
    // Login e a unica rota que pode ler senha_hash para conferir.
    conf(/auth\.conferir\(senha, u\.senha_hash\)/.test(src), 'o login confere pelo lib/auth');
  }

  console.log('\n═══ 9. TRAVA: COMPRESSAO LIGADA ═══');
  {
    const src = fs.readFileSync('./server.js', 'utf8');
    conf(/app\.use\(compression\(\)\)/.test(src), 'compression() esta ligado');
    // 11,3 MB por chamada, seis telas chamando, 47 pessoas na mesma manha.
    const posComp = src.indexOf('app.use(compression())');
    const posRota = src.search(/app\.(get|post|patch|delete)\('/);
    conf(posComp > 0 && posComp < posRota, 'vem antes das rotas, senao nao envolve a resposta');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})();
