// CAMINHO: sigpc-api/teste_manutencao.js
//
// MODO MANUTENÇÃO — a regra, e as travas que a sustentam.
//
// Sem rede e sem banco: dublê. ⚠️ O dublê valida a FORMA, não a realidade — foi a lição de
// 10–12/08. Por isso a seção 5 lê o próprio server.js: as travas que importam aqui são de
// ORDEM e de PRESENÇA, e essas o dublê não alcança.

const fs = require('fs');
const manut = require('./lib/manutencao');
const prep  = require('./lib/preparacao');
const auth  = require('./lib/auth');

let ok = 0, falhou = 0;
function conf(cond, nome) {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else      { falhou++; console.log('  FALHA  ' + nome); }
}
function secao(t) { console.log('\n═══ ' + t + ' ═══'); }

// dublê: responde o que a consulta pedir, sem banco
function dublê(porId) {
  return {
    query: async (sql, val) => {
      if (/FROM usuarios WHERE id/.test(sql)) {
        const u = porId[val[0]];
        return { rows: u ? [u] : [] };
      }
      return { rows: [] };
    },
  };
}

const LIGADO   = { modo_manutencao: true,  mensagem_manutencao: 'Voltamos em 15 minutos.' };
const DESLIGADO = { modo_manutencao: false, mensagem_manutencao: null };

// ─────────────────────────────────────────────────────────────
secao('1. QUEM ATRAVESSA');

conf(manut.ISENTOS.length === 1 && manut.ISENTOS[0] === 'superadmin',
     'so o superadmin e isento — coordenador NAO (decisao do Richard, 12/08)');
conf(manut.barra(LIGADO, { perfil: 'analista' }),        'analista e barrado');
conf(manut.barra(LIGADO, { perfil: 'coordenador' }),     'coordenador e barrado');
conf(manut.barra(LIGADO, { perfil: 'controle_interno' }), 'tecnico do C.I. e barrado');
conf(!manut.barra(LIGADO, { perfil: 'superadmin' }),     'superadmin passa');
conf(manut.barra(LIGADO, { perfil: 'perfil_que_nao_existe_ainda' }),
     'perfil novo e barrado — lista de ISENTOS, nao de barrados');
conf(!manut.barra(DESLIGADO, { perfil: 'analista' }),    'desligado, nao barra ninguem');
conf(!manut.barra(null, { perfil: 'analista' }),         'sem config, nao barra (falha aberta)');
conf(!manut.barra(LIGADO, null),                         'sem usuario, nao barra');
conf(!manut.barra(LIGADO, { perfil: null }),             'sem perfil, nao barra');

// ─────────────────────────────────────────────────────────────
secao('2. A MENSAGEM');

conf(manut.recusa(LIGADO) === 'Voltamos em 15 minutos.', 'usa a mensagem escrita pelo Richard');
conf(manut.recusa(DESLIGADO) === manut.MENSAGEM_PADRAO,  'sem mensagem, cai no padrao');
conf(manut.recusa({ mensagem_manutencao: '   ' }) === manut.MENSAGEM_PADRAO,
     'mensagem so de espaco tambem cai no padrao — tela muda e pior que texto generico');
conf(manut.recusa(null) === manut.MENSAGEM_PADRAO,       'sem config, texto padrao');

// ─────────────────────────────────────────────────────────────
secao('3. O BLOQUEIO DAS ROTAS');

(async () => {
  const db = dublê({
    7:  { perfil: 'analista' },
    56: { perfil: 'coordenador' },
    1:  { perfil: 'superadmin' },
    62: { perfil: 'controle_interno' },
  });

  conf(await manut.bloqueio(db, LIGADO, 7),      'analista barrado por id');
  conf(await manut.bloqueio(db, LIGADO, 56),     'coordenador barrado por id');
  conf(await manut.bloqueio(db, LIGADO, 62),     'C.I. barrado por id');
  conf(!await manut.bloqueio(db, LIGADO, 1),     'superadmin passa por id');
  conf(!await manut.bloqueio(db, DESLIGADO, 7),  'desligado, ninguem e barrado');
  conf(!await manut.bloqueio(db, LIGADO, null),  'sem id, deixa passar — barrar viraria pane');
  conf(!await manut.bloqueio(db, LIGADO, 999),   'id inexistente, deixa passar');

  // o perfil vem do BANCO, nunca do corpo do pedido: o corpo é escrito pela tela, e a tela
  // é justamente a que estamos cobrindo
  const mentiroso = dublê({ 7: { perfil: 'analista' } });
  conf(await manut.bloqueio(mentiroso, LIGADO, 7),
       'o perfil vem do banco — dizer-se superadmin no corpo nao ajuda');

  // banco fora do ar não pode virar pane: falha aberta
  const quebrado = { query: async () => { throw new Error('banco fora'); } };
  conf(!await manut.bloqueio(quebrado, LIGADO, 7), 'banco fora: falha ABERTA, nao tranca');

  // ─────────────────────────────────────────────────────────────
  secao('4. A ENTRADA (auth.podeEntrar)');

  const analista = { ativo: true, perfil: 'analista', setorial_id: 'FCEE' };
  conf(auth.podeEntrar(analista, 'FCEE') === null, 'sem manutencao, entra normalmente');
  conf(auth.podeEntrar(analista, 'FCEE', 'Voltamos em 15 min.') === 'Voltamos em 15 min.',
       'com manutencao, recusa com a mensagem do sistema');

  // ⚠️ a manutenção vem ANTES das regras sobre a PESSOA: quem está barrado pelo sistema não
  // deve ler "usuário inativo" e abrir chamado para um problema que não existe
  const inativo = { ativo: false, perfil: 'analista', setorial_id: 'FCEE' };
  conf(auth.podeEntrar(inativo, 'FCEE') === 'Usuário inativo. Entre em contato com o administrador.',
       'sem manutencao, o inativo le a razao dele');
  conf(auth.podeEntrar(inativo, 'FCEE', 'Em manutencao.') === 'Em manutencao.',
       'com manutencao, a razao do SISTEMA vem primeiro');

  const pendente = { ativo: true, aguardando_aprovacao: true, perfil: 'analista', setorial_id: 'FCEE' };
  conf(auth.podeEntrar(pendente, 'FCEE', 'Em manutencao.') === 'Em manutencao.',
       'idem para quem aguarda aprovacao');

  // CPF inexistente continua vindo antes de tudo: não há usuário sobre quem decidir
  conf(auth.podeEntrar(null, 'FCEE', 'Em manutencao.') === 'CPF não encontrado.',
       'CPF inexistente ainda responde por si');

  // ─────────────────────────────────────────────────────────────
  secao('5. TRAVAS NO server.js — o que o duble nao alcanca');

  const src = fs.readFileSync('./server.js', 'utf8');

  // ⚠️ A TRAVA MAIS IMPORTANTE DESTE ARQUIVO.
  // Sem barrar o PATCH /usuarios/:id, o heartbeat de qualquer aba aberta levanta
  // `ultimo_acesso` acima do `sessao_fim` carimbado e a pessoa reaparece online — a janela
  // de escrita se fecharia sozinha em ate cinco minutos.
  const patchUsuario = src.slice(src.indexOf("app.patch('/usuarios/:id'"),
                                 src.indexOf("app.patch('/usuarios/:id'") + 1600);
  conf(/manut\.bloqueio/.test(patchUsuario),
       'PATCH /usuarios/:id barra em manutencao — e o heartbeat, sem isso o modo nao segura');
  conf(/503/.test(patchUsuario), 'e responde 503, que a tela trata derrubando a sessao');

  // o logout NUNCA pode ser barrado: se a rota de sair recusasse, sair() falharia
  // justamente quando e' mais necessaria
  const logout = src.slice(src.indexOf("app.post('/usuarios/logout'"),
                           src.indexOf("app.post('/usuarios/logout'") + 900);
  conf(!/manut\.bloqueio|barrouPreparacao/.test(logout), 'POST /usuarios/logout NUNCA e barrado');

  // manutenção antes de preparação: são respostas diferentes, e a mais restritiva manda
  const barrou = src.slice(src.indexOf('async function barrouPreparacao'),
                           src.indexOf('async function barrouPreparacao') + 900);
  conf(barrou.indexOf('manut.bloqueio') < barrou.indexOf('prep.bloqueio'),
       'manutencao e conferida ANTES da preparacao');

  // ligar o modo e derrubar as sessões têm de ser UMA transação
  const patchCfg = src.slice(src.indexOf("app.patch('/config_sistema'"),
                             src.indexOf("app.patch('/config_sistema'") + 3200);
  conf(/BEGIN/.test(patchCfg) && /COMMIT/.test(patchCfg) && /ROLLBACK/.test(patchCfg),
       'PATCH /config_sistema e transacional');
  conf(/SQL_DERRUBAR/.test(patchCfg), 'e derruba as sessoes ao ligar');
  conf(/b\.modo_manutencao === true/.test(patchCfg),
       'so ao LIGAR — desligar nao precisa desfazer carimbo nenhum');

  // o par (informou, valor), como na preparação: sem ele, desligar pela tela seria impossível
  conf(/modo_manutencao\s*=\s*CASE WHEN \$\d+::boolean THEN \$\d+::boolean ELSE modo_manutencao\s+END/.test(src),
       'o PATCH usa par (informou, valor) — da para DESLIGAR');
  conf(!/modo_manutencao\s*=\s*COALESCE/.test(src), 'e nao usa COALESCE');

  // ⚠️ clock_timestamp(), nao NOW(): o NOW() e o instante da TRANSACAO, e como o modo liga
  // e o carimbo acontecem na MESMA transacao, com NOW() os dois sairiam iguais e o
  // `sessao_fim < ultimo_acesso` nao valeria. Mesmo defeito do logout de 12/08.
  conf(/clock_timestamp\(\)/.test(manut.SQL_DERRUBAR), 'o carimbo usa clock_timestamp(), nao NOW()');
  conf(!/SET sessao_fim = NOW\(\)/.test(manut.SQL_DERRUBAR), 'e nao usa NOW()');
  conf(/perfil <> 'superadmin'/.test(manut.SQL_DERRUBAR), 'o carimbo poupa o superadmin');

  // ⚠️ a coluna nasce DESLIGADA: publicar isto nao pode trancar ninguem
  conf(/ADD COLUMN IF NOT EXISTS modo_manutencao\s+BOOLEAN NOT NULL DEFAULT false/.test(src),
       'a coluna nasce DESLIGADA');
  // e vem por ALTER: CREATE TABLE IF NOT EXISTS nao altera tabela existente (armadilha 2)
  conf(/ALTER TABLE config_sistema[\s\S]{0,200}ADD COLUMN IF NOT EXISTS modo_manutencao/.test(src),
       'e vem por ALTER — CREATE TABLE IF NOT EXISTS nao alteraria a tabela que ja existe');

  // a manutenção é conferida no login, depois da senha
  const login = src.slice(src.indexOf("app.post('/usuarios/login'"),
                          src.indexOf("app.post('/usuarios/login'") + 3000);
  conf(/manut\.barra/.test(login), 'o login confere a manutencao');
  conf(login.indexOf('auth.conferir') < login.indexOf('manut.barra'),
       'e confere DEPOIS da senha — nao contar o estado do sistema a quem nem provou quem e');

  // ─────────────────────────────────────────────────────────────
  secao('6. A CONFIG LIDA (preparacao.ler devolve os campos novos)');

  const cfgDb = { query: async () => ({ rows: [{
    modo_preparacao: false, mensagem: null,
    modo_manutencao: true,  mensagem_manutencao: 'Volto ja.',
    atualizado_em: null, atualizado_por_nome: null }] }) };
  const lido = await prep.ler(cfgDb);
  conf(lido.modo_manutencao === true,             'ler() devolve modo_manutencao');
  conf(lido.mensagem_manutencao === 'Volto ja.',  'ler() devolve mensagem_manutencao');
  conf(prep.PADRAO.modo_manutencao === false,     'o padrao e DESLIGADO (falha aberta)');

  const semTabela = { query: async () => { throw new Error('sem tabela'); } };
  const l2 = await prep.ler(semTabela);
  conf(l2.modo_manutencao === false, 'sem tabela: modo DESLIGADO, o sistema abre');

  // ─────────────────────────────────────────────────────────────
  secao('7. VALIDACAO DO QUE A TELA MANDA');

  conf(manut.validar({ modo_manutencao: true }) === null,  'booleano passa');
  conf(manut.validar({ modo_manutencao: false }) === null, 'false tambem passa');
  conf(manut.validar({ modo_manutencao: 'sim' }) !== null, 'texto no lugar de booleano e recusado');
  conf(manut.validar({ mensagem_manutencao: 'x'.repeat(400) }) === null, '400 caracteres passa');
  conf(manut.validar({ mensagem_manutencao: 'x'.repeat(401) }) !== null, '401 e recusado');
  conf(manut.validar({ mensagem_manutencao: null }) === null, 'mensagem nula passa');
  conf(manut.validar({}) === null, 'corpo sem os campos passa — pode ser PATCH so da preparacao');
  conf(manut.validar(null) !== null, 'corpo vazio e recusado');

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
  process.exit(falhou ? 1 : 0);
})();
