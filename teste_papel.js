// CAMINHO: sigpc-api/teste_papel.js
//
// TROCA DE PAPEL DO SUPERADMIN — a regra mora em `lib/papel.js`, e é ela que se testa.
//
// USO: node teste_papel.js

const fs = require('fs');
const p = require('./lib/papel');

let ok = 0, falhou = 0;
const conf = (x, r, d) => { x ? ok++ : falhou++; console.log(`  ${x ? 'OK  ' : 'FALHA'}  ${r}${x || !d ? '' : `   [${d}]`}`) };
const secao = (t) => console.log(`\n═══ ${t} ═══`);

const SUPER_AN  = { id: 4,  nome: 'Richard', perfil: 'superadmin',       papel_ativo: 'analista' };
const SUPER_TEC = { id: 4,  nome: 'Richard', perfil: 'superadmin',       papel_ativo: 'tecnico'  };
const COORD     = { id: 56, nome: 'Gustavo', perfil: 'coordenador',      papel_ativo: 'analista', grupo: '3' };
const ANALISTA  = { id: 22, nome: 'Ana',     perfil: 'analista',         papel_ativo: 'analista' };
const CI        = { id: 62, nome: 'Marcia',  perfil: 'controle_interno', papel_ativo: 'analista' };

secao('1. O PERFIL EFETIVO — a regra que todas as rotas usam');
{
  // ⚠️ No papel analista, o superadmin E analista em TODA parte. Uma regra so, e nao uma
  // condicao a mais em cada rota — que seria onde faltaria uma.
  conf(p.perfilEfetivo(SUPER_AN) === 'analista', 'superadmin no papel analista VIRA analista');
  conf(p.perfilEfetivo(SUPER_TEC) === 'superadmin', 'e no papel tecnico volta a ser superadmin');

  // Para os outros 52 cadastros a coluna nunca muda, e nem e olhada.
  conf(p.perfilEfetivo(COORD) === 'coordenador', 'coordenador e sempre coordenador');
  conf(p.perfilEfetivo(ANALISTA) === 'analista', 'analista e sempre analista');
  conf(p.perfilEfetivo(CI) === 'controle_interno', 'o C.I. tambem nao muda');
  conf(p.perfilEfetivo({ perfil: 'coordenador', papel_ativo: 'tecnico' }) === 'coordenador',
       'papel_ativo em quem nao e superadmin NAO da poder nenhum');

  // Sem a coluna (cadastro antigo, ou leitura que esqueceu de trazer), vale o PADRAO.
  conf(p.perfilEfetivo({ id: 4, perfil: 'superadmin' }) === 'analista',
       'sem papel_ativo, cai no padrao: analista');
  conf(p.perfilEfetivo(null) === null, 'e ninguem nao tem perfil nenhum');
}

secao('2. AS SEIS ROTAS DE "COORDENADOR OU SUPERADMIN"');
{
  // ⚠️ E o ponto que passaria batido: a condicao e
  // ['coordenador','superadmin'].includes(perfil), e o Richard NAO e coordenador de ninguem.
  // Tirar so o superadmin da lista nao bastaria — ele tem de cair fora pelos DOIS lados.
  const aceita = (u) => ['coordenador', 'superadmin'].includes(p.perfilEfetivo(u));
  conf(aceita(SUPER_TEC) === true, 'no papel tecnico, passa');
  conf(aceita(SUPER_AN) === false, 'no papel analista, NAO passa — nem pelo ramo do coordenador');
  conf(aceita(COORD) === true, 'o coordenador de verdade continua passando');
  conf(aceita(ANALISTA) === false, 'e o analista continua fora');
}

secao('3. QUEM PODE TROCAR, E O QUE E TROCA VALIDA');
{
  conf(p.podeTrocar(SUPER_AN) === true, 'so o superadmin tem dois papeis');
  conf(p.podeTrocar(COORD) === false, 'coordenador nao troca');
  conf(p.podeTrocar(ANALISTA) === false, 'analista nao troca');

  conf(p.validarTroca(SUPER_AN, 4, 'tecnico') === null, 'trocar o proprio para tecnico vale');
  conf(p.validarTroca(SUPER_AN, '4', 'analista') === null, 'id como texto e o mesmo id');
  // ⚠️ NINGUEM TROCA O PAPEL DE OUTRO: seria mudar o que a pessoa pode fazer sem ela saber.
  conf(/proprio papel|próprio papel/.test(p.validarTroca(SUPER_AN, 22, 'tecnico') || ''),
       'ninguem troca o papel DE OUTRO');
  conf(p.validarTroca(COORD, 56, 'tecnico') !== null, 'coordenador nao vira tecnico');
  conf(/Papel inválido/.test(p.validarTroca(SUPER_AN, 4, 'chefe') || ''), 'papel fora da lista recusa');
  conf(p.validarTroca(null, 4, 'tecnico') !== null, 'sem usuario, recusa');
}

secao('4. O RESET NO LOGIN');
{
  // ⚠️ O papel SEMPRE volta para analista ao entrar. Se sobrevivesse a sessao, uma entrada de
  // manha continuaria com o acesso de ontem a noite, e trocar deixaria de ser deliberado.
  conf(/papel_ativo = 'analista'/.test(p.SQL_RESETAR_NO_LOGIN), 'o reset grava o padrao');
  conf(/perfil = 'superadmin'/.test(p.SQL_RESETAR_NO_LOGIN), 'e so mexe no superadmin');
  // O `papel_ativo <> 'analista'` evita gravar historico em todo login normal: sem ele, a
  // trilha encheria de ruido e a troca deliberada — o que se quer enxergar — sumiria.
  conf(/papel_ativo <> 'analista'/.test(p.SQL_RESETAR_NO_LOGIN),
       'e so retorna linha quando REALMENTE mudou');
  conf(p.PADRAO === 'analista', 'o padrao e analista');
}

secao('5. O QUE O SERVIDOR FAZ COM ISSO');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  // A guarda tem de estar em TODAS as conferencias de perfil, e nao em algumas.
  conf(!/\bquem\.perfil !== 'superadmin'/.test(src), 'nenhuma rota confere `perfil` cru de superadmin');
  conf(!/\bautor\.perfil\b(?!.*perfilEfetivo)/.test(src.replace(/papel\.perfilEfetivo\(autor\)/g, '')),
       'nem `autor.perfil` solto');
  conf(/papel\.perfilEfetivo/.test(src), 'o server usa o perfil efetivo');
  conf((src.match(/papel\.perfilEfetivo/g) || []).length >= 10,
       'em pelo menos dez pontos', String((src.match(/papel\.perfilEfetivo/g) || []).length));

  // ⚠️ O `perfil` do CORPO nao decide mais nada nas rotas de exclusao e estorno: o corpo
  // nunca provou nada, e com a troca de papel passaria por cima da guarda inteira.
  conf(!/const \{ perfil \} = req\.body/.test(src), 'nenhuma rota le o perfil do corpo');
  conf(!/b\.perfil !== 'coordenador'/.test(src), 'nem o estorno por parcela');

  // O papel volta ao padrao no login, e a troca fica registrada na MESMA transacao.
  conf(/SQL_RESETAR_NO_LOGIN/.test(src), 'o login reseta o papel');
  conf(/SQL_REGISTRAR, \[quem\.id, b\.papel, 'troca'\]/.test(src), 'e a troca e registrada');
  const iRota = src.indexOf("app.patch('/usuarios/:id/papel'");
  const bRota = src.slice(iRota, iRota + 1500);
  conf(/BEGIN[\s\S]*SQL_TROCAR[\s\S]*SQL_REGISTRAR[\s\S]*COMMIT/.test(bRota),
       'troca e registro na MESMA transacao — papel trocado sem registro seria trilha furada');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
