// SMOKE TEST DA CAMADA HTTP — express, compressão e as rotas novas, sem tocar no banco.
//
// O `pg` é trocado por um dublê ANTES de carregar o server.js, então:
//   · nenhum ALTER roda (o ALTER de senha_provisoria depende de autorização do Richard);
//   · nenhuma linha real é lida ou escrita.
//
// Isto NÃO substitui o teste contra o Postgres — esse é o _teste_banco_auth.js, que roda o
// SQL de verdade dentro de BEGIN/ROLLBACK. Aqui a pergunta é outra: a rota está pendurada,
// o corpo chega, a resposta sai comprimida e `senha_hash` não vaza.
//
// Roda junto com o resto em `npm run teste`. Sobe o servidor na porta 3999 com o dublê no
// lugar do `pg`, então não precisa de banco nem de rede.

const Module = require('module');
const bcrypt = require('bcryptjs');

// ── Dublê do banco ──────────────────────────────────────────────────────────
const SENHA_TEXTO = 'senha-antiga-em-texto';
const USUARIO = {
  id: 57, nome: 'ZZ TESTE TRAVA', cpf: '000.000.000-00',
  senha_hash: SENHA_TEXTO, perfil: 'analista', setorial_id: 'FCEE', grupo: '3',
  ativo: true, aprovado: true, aguardando_aprovacao: false, senha_provisoria: true,
  email: 'zz@teste', foto_base64: null,
};

const escritas = [];
class PoolFake {
  async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(UPDATE|INSERT|DELETE|ALTER|CREATE)/i.test(s)) {
      escritas.push({ sql: s.slice(0, 70), params });
      if (/RETURNING/i.test(s)) return { rows: [{ ...USUARIO, senha_provisoria: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
    if (/FROM usuarios/i.test(s)) {
      // Login busca por dígitos do CPF; o resto busca por id.
      if (params && params.length && String(params[0]).replace(/\D/g, '') === '00000000000')
        return { rows: [USUARIO], rowCount: 1 };
      if (params && Number(params[0]) === 57) return { rows: [USUARIO], rowCount: 1 };
      if (params && params.length) return { rows: [], rowCount: 0 };
      return { rows: [USUARIO], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  connect() { return Promise.resolve({ query: this.query.bind(this), release() {} }); }
  on() {}
}

const origLoad = Module._load;
Module._load = function (req, ...resto) {
  if (req === 'pg') return { Pool: PoolFake };
  return origLoad.call(this, req, ...resto);
};

process.env.PORT = process.env.PORT || '3999';
process.env.DATABASE_URL = 'postgres://dublê/nao-usado';
require('./server.js');

// ── Testes ──────────────────────────────────────────────────────────────────
let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const pedir = async (rota, opts = {}) => {
  const r = await fetch(BASE + rota, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', ...(opts.headers || {}) },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = JSON.parse(texto); } catch (_) {}
  return { status: r.status, corpo, texto, cabecalhos: r.headers };
};

setTimeout(async () => {
  try {
    console.log('\n═══ 1. GET /usuarios NAO DEVOLVE MAIS SENHA ═══');
    {
      const r = await pedir('/usuarios');
      conf(r.status === 200, 'responde 200');
      conf(!/senha_hash/.test(r.texto), 'a palavra senha_hash nao aparece na resposta');
      conf(!r.texto.includes(SENHA_TEXTO), 'A SENHA NAO APARECE NA RESPOSTA');
      conf(r.corpo.data[0].nome === 'ZZ TESTE TRAVA', 'e o resto do usuario continua vindo');
      conf(r.corpo.data[0].perfil === 'analista', 'inclusive perfil e grupo');
    }

    console.log('\n═══ 2. GET /usuarios/:id TAMBEM NAO ═══');
    {
      const r = await pedir('/usuarios/57');
      conf(r.status === 200 && !r.texto.includes(SENHA_TEXTO), 'a senha nao aparece');
    }

    console.log('\n═══ 3. LOGIN — SENHA ERRADA ═══');
    {
      const r = await pedir('/usuarios/login', { method: 'POST',
        body: JSON.stringify({ cpf: '000.000.000-00', senha: 'chute', setorial: 'FCEE' }) });
      conf(r.status === 401, 'recusa com 401', `veio ${r.status}`);
      conf(/CPF ou senha incorretos/.test(r.corpo.error.message), 'com a mensagem generica');
      conf(!r.texto.includes(SENHA_TEXTO), 'e sem deixar a senha escapar na recusa');
    }

    console.log('\n═══ 4. LOGIN — CPF QUE NAO EXISTE ═══');
    {
      const r = await pedir('/usuarios/login', { method: 'POST',
        body: JSON.stringify({ cpf: '999.999.999-99', senha: 'x', setorial: 'FCEE' }) });
      conf(r.status === 401, 'recusa com 401');
      // Mesma frase da senha errada: frases diferentes contariam quais CPFs existem.
      conf(/CPF ou senha incorretos/.test(r.corpo.error.message),
           'com a MESMA frase da senha errada — nao conta quais CPFs existem');
    }

    console.log('\n═══ 5. LOGIN — SENHA CERTA, AINDA EM TEXTO PURO ═══');
    {
      escritas.length = 0;
      const r = await pedir('/usuarios/login', { method: 'POST',
        body: JSON.stringify({ cpf: '000.000.000-00', senha: SENHA_TEXTO, setorial: 'FCEE' }) });
      conf(r.status === 200, 'entra', `veio ${r.status} ${r.texto.slice(0, 90)}`);
      conf(r.corpo.data && r.corpo.data.id === 57, 'devolve o usuario');
      conf(r.corpo.data && r.corpo.data.senha_hash === undefined, 'SEM senha_hash na resposta');
      conf(!r.texto.includes(SENHA_TEXTO), 'a senha nao aparece em lugar nenhum da resposta');
      conf(r.corpo.data.senha_provisoria === true, 'e avisa que a senha e provisoria');

      // O rehash: a senha em texto puro vira hash no login que a provou.
      const rehash = escritas.find(e => /UPDATE usuarios SET senha_hash/.test(e.sql));
      conf(!!rehash, 'o login converteu a senha para hash');
      conf(rehash && bcrypt.compareSync(SENHA_TEXTO, rehash.params[0]),
           'e o hash gravado confere com a senha original');
      conf(rehash && rehash.params[0] !== SENHA_TEXTO, 'o que foi gravado NAO e a senha');
    }

    console.log('\n═══ 6. LOGIN — MODO ADMIN BARRA ANALISTA ═══');
    {
      const r = await pedir('/usuarios/login', { method: 'POST',
        body: JSON.stringify({ cpf: '000.000.000-00', senha: SENHA_TEXTO, setorial: 'ADMIN' }) });
      conf(r.status === 403, 'analista nao entra pelo ADMIN', `veio ${r.status}`);
      conf(/exclusivo do administrador/i.test(r.corpo.error.message), 'com a frase certa');
    }

    console.log('\n═══ 7. LOGIN — SETORIAL DE OUTRA CASA ═══');
    {
      const r = await pedir('/usuarios/login', { method: 'POST',
        body: JSON.stringify({ cpf: '000.000.000-00', senha: SENHA_TEXTO, setorial: 'SED' }) });
      conf(r.status === 403, 'recusa setorial que nao e a dele');
    }

    console.log('\n═══ 8. TROCAR SENHA ═══');
    {
      const ruim = await pedir('/usuarios/trocar_senha', { method: 'POST',
        body: JSON.stringify({ id: 57, senha_atual: 'errada', senha_nova: 'kx7mq2' }) });
      conf(ruim.status === 401, 'senha atual errada e recusada');

      const obvia = await pedir('/usuarios/trocar_senha', { method: 'POST',
        body: JSON.stringify({ id: 57, senha_atual: SENHA_TEXTO, senha_nova: '123456' }) });
      conf(obvia.status === 400, 'senha nova obvia e recusada');
      conf(/adivinhar/i.test(obvia.corpo.error.message), 'com frase que explica');

      const igual = await pedir('/usuarios/trocar_senha', { method: 'POST',
        body: JSON.stringify({ id: 57, senha_atual: SENHA_TEXTO, senha_nova: SENHA_TEXTO }) });
      conf(igual.status === 400, 'senha nova igual a atual e recusada');

      escritas.length = 0;
      const boa = await pedir('/usuarios/trocar_senha', { method: 'POST',
        body: JSON.stringify({ id: 57, senha_atual: SENHA_TEXTO, senha_nova: 'kx7mq2' }) });
      conf(boa.status === 200, 'senha nova valida e aceita', `veio ${boa.status}`);
      conf(boa.corpo.data && boa.corpo.data.senha_hash === undefined, 'e a resposta nao traz senha');
      const grav = escritas.find(e => /UPDATE usuarios SET senha_hash/.test(e.sql));
      conf(!!grav && bcrypt.compareSync('kx7mq2', grav.params[0]), 'gravou o hash da senha nova');
      conf(!!grav && /senha_provisoria = false/.test(grav.sql), 'e desligou a senha provisoria');
    }

    console.log('\n═══ 8b. ROTAS DE NOME FIXO NAO CAEM EM /usuarios/:id ═══');
    {
      // ⚠️ Dublê não roteia — quem roteia é o Express. Este teste sobe o servidor de
      // verdade, e por isso enxerga o que os outros não enxergam: em 12/08,
      // '/usuarios/pendentes' caía em '/usuarios/:id' com id = "pendentes" e devolvia
      // HTTP 500 em produção. Toda rota de nome fixo sob /usuarios entra aqui.
      for (const rota of ['/usuarios/pendentes']) {
        const r = await pedir(rota);
        conf(r.status === 200, `GET ${rota} responde 200, nao cai no /:id`, `veio ${r.status}`);
        conf(!/invalid input syntax for type integer/.test(r.texto),
             `e nao vaza erro de tipo do Postgres`);
      }
    }

    console.log('\n═══ 8-A. GET /notificacao CONFERE QUEM PEDE (24/08/2026) ═══');
    {
      // ⚠️ O DUBLE responde a linha do usuario 57 (ZZ TESTE TRAVA, analista) para o id 57 e
      // rows vazio para qualquer outro id — entao `lerUsuario` devolve o analista, e a regra
      // de `notif.podeLer` decide.
      const sem = await pedir('/notificacao?destinatario_id=57');
      conf(sem.status === 401, 'sem usuario_id: 401, e nao a caixa de alguem', `status ${sem.status}`);
      conf(!/titulo/.test(sem.texto), 'e nao vaza notificacao nenhuma');

      const proprio = await pedir('/notificacao?destinatario_id=57&usuario_id=57');
      conf(proprio.status === 200, 'lendo as PROPRIAS: 200', `status ${proprio.status}`);

      // ⚠️ O ANALISTA PEDINDO A CAIXA DE OUTRO. Era exatamente isto que a rota entregava sem
      // perguntar nada — medido contra a producao com o id 19, a Sandra.
      const alheia = await pedir('/notificacao?destinatario_id=19&usuario_id=57');
      conf(alheia.status === 403, 'analista pedindo a de outro: 403', `status ${alheia.status}`);
      conf(!/titulo|mensagem/.test(alheia.texto), 'e a resposta nao traz conteudo nenhum');

      // ⚠️ E O `perfil` NA QUERY NAO AJUDA: quem decide e o perfil lido do BANCO.
      const mentindo = await pedir('/notificacao?destinatario_id=19&usuario_id=57&perfil=superadmin');
      conf(mentindo.status === 403, 'declarar-se superadmin na query nao abre a caixa de ninguem',
           `status ${mentindo.status}`);

      // Usuario que nao existe: 401, e nao 500.
      const fantasma = await pedir('/notificacao?destinatario_id=57&usuario_id=99999');
      conf(fantasma.status === 401, 'usuario_id inexistente: 401', `status ${fantasma.status}`);

      // ⚠️ E o 400 de sempre continua vindo antes de tudo.
      const semDest = await pedir('/notificacao?usuario_id=57');
      conf(semDest.status === 400, 'sem destinatario_id: 400', `status ${semDest.status}`);
    }

    console.log('\n═══ 8-B. AS ROTAS DA FILA DO C.I. EXISTEM E SAO GUARDADAS (24/08/2026) ═══');
    {
      // ⚠️ ISTO E O QUE O DUBLE NAO PEGA: duble nao roteia. A armadilha 13 nasceu assim —
      // `/usuarios/pendentes` declarada depois de `/usuarios/:id` caiu nela em producao com
      // HTTP 500, e os 220 testes com duble passavam. Aqui o servidor sobe de verdade.
      //
      // 404 significaria rota inexistente ou engolida por outra; 403 prova que ela existe,
      // foi alcancada, e que a guarda rodou.
      const g = await pedir('/ci/fila_trabalho?usuario_id=57');
      conf(g.status === 403, 'GET /ci/fila_trabalho existe e recusa quem nao e do C.I.', `status ${g.status}`);
      conf(/Controle Interno/.test(g.texto), 'e a recusa diz de quem e a fila');

      // ⚠️ O ANALISTA E RECUSADO MESMO MANDANDO O PROPRIO id: quem decide e o perfil LIDO DO
      // BANCO, nunca o que vem no pedido. Quatro rotas deste servidor ja confiaram no corpo.
      const s = await pedir('/ci/fila_trabalho?usuario_id=57&perfil=controle_interno');
      conf(s.status === 403, 'e mandar perfil na query nao ajuda ninguem a entrar', `status ${s.status}`);

      // Sem usuario nenhum: 403 tambem, e nao 500.
      const v = await pedir('/ci/fila_trabalho');
      conf(v.status === 403, 'sem usuario_id devolve 403, e nao estoura', `status ${v.status}`);

      for (const acao of ['assumir', 'devolver', 'passar']) {
        const r = await pedir(`/ci/tr/${acao}`, { method: 'POST', body: JSON.stringify({ tr: '2020TR000657', usuario_id: 57 }) });
        conf(r.status === 403, `POST /ci/tr/${acao} existe e e guardada`, `status ${r.status}`);
        conf(!/Cannot POST/.test(r.texto), `e nao caiu no 404 do Express`);
      }

      // ⚠️ `/ci/tr/...` NAO PODE SER ENGOLIDA por `/ci/fila` nem por `/ci/decidir`: nenhuma
      // delas tem parametro de rota, mas se um dia alguem declarar `/ci/:algo` antes, estas
      // tres passam a cair la. O teste acima quebra no dia em que isso acontecer.
      const src = require('fs').readFileSync('./server.js', 'utf8');
      conf(!/app\.(get|post|patch)\('\/ci\/:/.test(src),
           'nao ha rota /ci/:param que possa engolir /ci/tr/...');
    }

    console.log('\n═══ 9. COMPRESSAO ═══');
    {
      // corpo pequeno não é comprimido por padrão (limiar de 1KB), então o que se confere é
      // o cabeçalho de negociação.
      const r = await pedir('/usuarios');
      conf(r.cabecalhos.get('vary') === 'Accept-Encoding' || /Accept-Encoding/.test(r.cabecalhos.get('vary') || ''),
           'responde Vary: Accept-Encoding — o middleware esta no caminho',
           `vary=${r.cabecalhos.get('vary')}`);
    }

  } catch (e) {
    console.error('\n  ERRO:', e.message, e.stack);
    falhou++;
  }

  console.log(`\n═══ RESULTADO HTTP: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
}, 700);
