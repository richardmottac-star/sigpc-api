// CAMINHO: sigpc-api/teste_duplicata.js
//
// Testes da DETECCAO DE DUPLICIDADE (lib/duplicata.js). Sem rede e sem banco.
//
// ⚠️ ESTE ARQUIVO EXISTE POR CAUSA DE UM FALSO POSITIVO QUE QUASE PASSOU.
//
// A primeira versao da regra casava por "nome contido" e apontou:
//     "Ana Claudia" (id 22, 106 PCs, 57 baixas)  ~  "Claudia" (id 36, 135 PCs, 53 baixas)
// Sao DUAS PESSOAS: CPFs, grupos e e-mails diferentes. Se o Richard tivesse clicado em
// mesclar, o historico de uma delas seria apagado, sem volta.
//
// A regra que salva: DOIS CPFs presentes e diferentes provam pessoas diferentes, e o nome
// nao tem voto. O nome so fala quando o cadastro antigo NAO TEM CPF — que e exatamente o
// padrao do acervo (nome curto, sem CPF) e a causa real das tres duplicatas de 12/08.
//
// USO: node teste_duplicata.js

const D = require('./lib/duplicata');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// Os dados REAIS de 12/08/2026.
const anaClaudia = { id:22, nome:'Ana Claudia', cpf:'176.042.888-47', grupo:'2', pcs:106, baixas:57, aguardando_aprovacao:true };
const claudia    = { id:36, nome:'Claudia',     cpf:'025.701.209-52', grupo:'3', pcs:135, baixas:53 };
const elisandra  = { id:24, nome:'Elisandra',   cpf:'788.125.269-34', grupo:'2', pcs:210, baixas:68, aguardando_aprovacao:true };
const marleneNova= { id:60, nome:'Marlene Teodoro Ramos da Silva', cpf:'647.516.279-53', pcs:0, aguardando_aprovacao:true };
const marleneVel = { id:46, nome:'Marlene',     cpf:null, grupo:'3', pcs:48, baixas:37 };
const franNova   = { id:65, nome:'Franciani Mary Daniel Pereira',  cpf:'067.856.759-01', pcs:0, aguardando_aprovacao:true, email:'franciani@fcee.sc.gov.br' };
const franVelha  = { id:12, nome:'Franciani',   cpf:null, grupo:'1', pcs:111, baixas:3 };
const letNova    = { id:61, nome:'Ana Letícia Wloch de Oliveira',  cpf:'003.697.369-66', pcs:0, aguardando_aprovacao:true };
const letVelha   = { id:23, nome:'Ana Leticia', cpf:null, grupo:'2', pcs:147, baixas:81 };

console.log('\n═══ 1. O FALSO POSITIVO QUE NAO PODE VOLTAR ═══');
{
  const r = D.avaliar(anaClaudia, claudia);
  conf(r === null, 'ANA CLAUDIA x CLAUDIA nao casa — CPFs diferentes vencem o nome',
       r ? `${r.nivel}: ${r.motivo}` : '');
  conf(D.avaliar(claudia, anaClaudia) === null, 'e nao casa na ordem inversa tambem');
  // A Elisandra nao tem parecido nenhum; se casasse com alguem seria por acidente.
  conf(D.avaliar(elisandra, claudia) === null, 'Elisandra x Claudia nao casa');
  conf(D.avaliar(elisandra, anaClaudia) === null, 'Elisandra x Ana Claudia nao casa');
}

console.log('\n═══ 2. AS TRES DUPLICATAS DE VERDADE ═══');
{
  [[marleneNova, marleneVel, 'Marlene'], [franNova, franVelha, 'Franciani'], [letNova, letVelha, 'Ana Leticia']]
    .forEach(([novo, velho, rot]) => {
      const r = D.avaliar(novo, velho);
      conf(!!r && r.nivel === 'FORTE', `${rot}: cadastro novo casa com o antigo (FORTE)`,
           r ? r.nivel : 'nao casou');
    });
  // O antigo nao tem CPF — e por isso que a busca por CPF do Primeiro Acesso nao os achou.
  conf(!D.digitos(marleneVel.cpf) && !D.digitos(franVelha.cpf) && !D.digitos(letVelha.cpf),
       'e os tres cadastros antigos estao SEM CPF — a causa raiz');
}

console.log('\n═══ 3. MESMO CPF E CERTEZA ═══');
{
  const r = D.avaliar({ id:1, nome:'Jose da Silva', cpf:'111.222.333-44' },
                      { id:2, nome:'J. da Silva',   cpf:'11122233344' });
  conf(r && r.nivel === 'CERTEZA', 'mesmo CPF com mascara diferente e CERTEZA');
  conf(r && r.motivo === 'mesmo CPF', 'e o motivo diz isso');
  // Nome completamente diferente nao importa quando o CPF e o mesmo.
  const r2 = D.avaliar({ id:1, nome:'Maria', cpf:'111.222.333-44' },
                       { id:2, nome:'Joao',  cpf:'111.222.333-44' });
  conf(r2 && r2.nivel === 'CERTEZA', 'CPF igual vence nome diferente');
}

console.log('\n═══ 4. ACENTO, MAIUSCULA E ESPACO NAO ATRAPALHAM ═══');
{
  const semCpf = (id, nome) => ({ id, nome, cpf:null });
  conf(!!D.avaliar(semCpf(1,'ANA LETÍCIA WLOCH'), semCpf(2,'ana leticia')), 'acento e maiuscula');
  conf(!!D.avaliar(semCpf(1,'Marlene   Teodoro'), semCpf(2,'marlene')), 'espaco a mais');
  conf(D.norm('Ana Letícia') === 'ana leticia', 'norm tira acento e caixa');
  conf(D.norm('  a   b  ') === 'a b', 'norm colapsa espacos');
}

console.log('\n═══ 5. O QUE NAO DEVE CASAR ═══');
{
  const semCpf = (id, nome) => ({ id, nome, cpf:null });
  conf(D.avaliar(semCpf(1,'Joao Silva'), semCpf(2,'Maria Souza')) === null, 'nomes sem nada em comum');
  // "Claudia" dentro de "Ana Claudia" so casaria se o primeiro nome batesse — nao bate.
  const r = D.avaliar(semCpf(1,'Ana Claudia'), semCpf(2,'Claudia'));
  conf(!r || r.nivel !== 'FORTE', 'sem CPF, "Ana Claudia" x "Claudia" NAO e FORTE', r?r.nivel:'null');
  conf(D.avaliar(null, semCpf(2,'x')) === null, 'nulo nao quebra');
  conf(D.avaliar(semCpf(1,'x'), null) === null, 'nulo do outro lado idem');
  conf(D.avaliar(semCpf(1,'x'), semCpf(1,'x')) === null, 'o mesmo id nao casa consigo');
  conf(D.avaliar(semCpf(1,''), semCpf(2,'')) === null, 'nome vazio nao casa com nome vazio');
}

console.log('\n═══ 6. A ANALISE DOS 5 PENDENTES REAIS ═══');
{
  const todos = [anaClaudia, claudia, elisandra, marleneNova, marleneVel, franNova, franVelha, letNova, letVelha];
  const pend = todos.filter(u => u.aguardando_aprovacao);
  const r = D.analisar(pend, todos);
  conf(r.length === 5, 'cinco pendentes analisados', String(r.length));

  const porId = Object.fromEntries(r.map(x => [x.id, x]));
  conf(porId[22].candidatos.length === 0, 'Ana Claudia (22): SEM aviso — pode aprovar');
  conf(porId[24].candidatos.length === 0, 'Elisandra (24): SEM aviso — pode aprovar');
  conf(porId[60].candidatos.length === 1, 'Marlene (60): 1 aviso');
  conf(porId[61].candidatos.length === 1, 'Ana Leticia (61): 1 aviso');
  conf(porId[65].candidatos.length === 1, 'Franciani (65): 1 aviso');

  // O que o bloco pode aprovar.
  const liberados = r.filter(x => !x.bloqueiaBloco).map(x => x.id);
  conf(JSON.stringify(liberados) === '[22,24]',
       'so 22 e 24 entram na aprovacao em bloco', JSON.stringify(liberados));

  // Dois pendentes nao se resolvem um ao outro.
  conf(!porId[60].candidatos.some(c => c.usuario.aguardando_aprovacao),
       'candidato nunca e outro pendente');
}

console.log('\n═══ 7. O PLANO DA MESCLAGEM ═══');
{
  const p = D.planoMesclagem(franNova, franVelha);
  conf(!p.erro, 'mesclagem valida nao dá erro', p.erro || '');
  conf(p.copiar.cpf === '067.856.759-01', 'copia o CPF, que o antigo nao tem');
  conf(p.copiar.email === 'franciani@fcee.sc.gov.br', 'copia o e-mail');

  // ⚠️ So copia o que FALTA no antigo. O antigo carrega as PCs; sobrescrever dado dele
  // por dado digitado seria trocar informacao conferida por informacao nova.
  const velhoCompleto = { ...franVelha, cpf:'999.999.999-99', email:'ja@tem.com' };
  const p2 = D.planoMesclagem(franNova, velhoCompleto);
  conf(p2.copiar.cpf === undefined, 'NAO sobrescreve o CPF que o antigo ja tem');
  conf(p2.copiar.email === undefined, 'nem o e-mail');

  // ⚠️ A trava que evita o desastre.
  const p3 = D.planoMesclagem(anaClaudia, claudia);
  conf(!!p3.erro && /106 PC/.test(p3.erro),
       'RECUSA mesclar quem tem PCs — diz quantas', p3.erro || 'passou!');
  const p4 = D.planoMesclagem({ ...franNova, aguardando_aprovacao:false }, franVelha);
  conf(!!p4.erro, 'recusa mesclar quem nao esta aguardando aprovacao');
  conf(!!D.planoMesclagem(franNova, franNova).erro, 'recusa mesclar consigo mesmo');
  conf(!!D.planoMesclagem(null, franVelha).erro, 'nulo nao quebra');
}

console.log('\n═══ 8. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  // CPF que ja existe e recusado em QUALQUER estado — antes so o "completo e ativo" era.
  conf(/ja_cadastrado: true/.test(src), 'o Primeiro Acesso devolve a marca ja_cadastrado');
  conf(/Você já tem cadastro no SIGPC-GT/.test(src), 'com a frase que explica o caminho');
  conf(!/Cadastro atualizado! Aguarde a aprovação/.test(src),
       'e o caminho antigo, que atualizava em silencio, saiu');
  conf(/app\.get\('\/usuarios\/pendentes'/.test(src), 'GET /usuarios/pendentes existe');
  // ⚠️ ORDEM DE ROTA. O Express casa na ordem de declaracao: com '/usuarios/:id' antes,
  // '/usuarios/pendentes' cai nela com id = "pendentes" e o Postgres responde
  // "invalid input syntax for type integer". Deu HTTP 500 em producao em 12/08.
  const iPend = src.indexOf("app.get('/usuarios/pendentes'");
  const iId   = src.indexOf("app.get('/usuarios/:id'");
  conf(iPend > 0 && iId > 0 && iPend < iId,
       "'/usuarios/pendentes' e declarada ANTES de '/usuarios/:id'",
       `pendentes em ${iPend}, :id em ${iId}`);
  conf(/app\.post\('\/usuarios\/mesclar'/.test(src), 'POST /usuarios/mesclar existe');
  // A mesclagem apaga — e apagar so por id explicito.
  conf(/DELETE FROM usuarios WHERE id = \$1`, \[novo\.id\]/.test(src),
       'o DELETE e por id explicito, nunca por condicao derivada');
  conf(/dup\.planoMesclagem\(novo, velho\)[\s\S]{0,200}?plano\.erro[\s\S]{0,120}?ROLLBACK/.test(src),
       'e so acontece depois de o plano aprovar');
  conf(/FOR UPDATE/.test(src.slice(src.indexOf("app.post('/usuarios/mesclar'"), src.indexOf("app.post('/usuarios/mesclar'") + 1400)),
       'as duas linhas sao travadas na transacao');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
