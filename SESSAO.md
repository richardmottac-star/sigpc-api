# SIGPC-API — ESTADO EM 11/08/2026

Cole no início do chat novo.

---

## A LIÇÃO DE 10–11/08: TESTE COM DUBLÊ NÃO É TESTE DE SQL

**Quatro defeitos em dois dias, todos passando por 220 testes verdes, todos aparecendo no
primeiro contato com o Postgres.** O dublê de banco aceita qualquer string como SQL.

| defeito | onde |
|---|---|
| `inconsistent types deduced for parameter $2` | INSERT do pedido de vaga |
| `operator is not unique: date + unknown` | `CURRENT_DATE + $1` no job |
| `dt_situacao` NULL fazia o NOT EXISTS nunca casar | cobrança da diligência |
| coluna `date` chega como objeto `Date` | `String(d).slice(0,10)` → `"Fri Aug 14"` |

**Duas regras que saíram disso, e valem para código novo:**

1. **Todo parâmetro em conta aritmética leva o tipo escrito** — `$1::int`, `$2::text`.
   Há teste que falha se sobrar parâmetro sem tipo na consulta do job.
2. **Coluna `date` não é texto.** Use `dataIso()` (em `job_notificacoes.js`), que usa getters
   locais — `toISOString()` empurra o dia para trás em fuso negativo.

E a terceira, de método: **rodar contra o banco antes de publicar.** Foi assim que os quatro
apareceram. O Richard autoriza escrita caso a caso; leitura é livre.

---

## ⚠️ RITMO: EM BLOCO, NÃO PASSO A PASSO (a partir de 12/08/2026)

**Em 10/08 o passo a passo — mockup, parar, implementar uma tela, parar, reportar — consumiu
o dia inteiro e cansou o Richard sem necessidade.** A partir de 12/08:

- agrupar frentes relacionadas num **único ciclo**;
- **parar só** quando a decisão for realmente dele: regra de negócio, prioridade, dado de
  analista real;
- **não parar** por detalhe de implementação, texto de mensagem ou escolha técnica — decidir,
  seguir, reportar depois;
- **reportar em bloco no fim**, não a cada etapa.

Rodar contra o banco antes de publicar **continua valendo**.
E isto não afrouxa a autorização de escrita — muda o ritmo, não a permissão.

---

## MÉTODO DE TRABALHO (mudou em 11/08)

- **SELECT e testes: rodar direto**, sem pedir. `DATABASE_URL` já está no ambiente da máquina.
- **INSERT / UPDATE / DELETE / ALTER / CREATE: mostrar o comando e ESPERAR.** Autorizado,
  quem executa sou eu — o Richard não roda mais nada à mão.
- **Nunca alterar dado de analista real sem autorização expressa.** Para teste, existe o
  usuário **`ZZ TESTE TRAVA` (id 57)**, criado para isso.
- Mockup antes de implementar. Parar entre as partes.

---

## CONCLUÍDO EM 11/08

### Reserva de TR, expiração e cancelamento
Pedido pendente **segura a TR** — sem isso o analista pede, espera e um colega leva.
A checagem vem **antes da conta do limite**: quem tem 1 TR de 5 também não fura a fila.
Expira em 3 dias; **o que solta a TR é o filtro de tempo NA CONSULTA**, não o UPDATE — senão
a TR ficaria presa o fim de semana inteiro porque ninguém abriu o sistema. O UPDATE existe
para o estado gravado alcançar a realidade, e a linha fica como `'expirada'`, que é o que dá
ao analista com que cobrar.
**Uma pendente por TR, garantida DENTRO do INSERT** (`INSERT ... SELECT ... WHERE NOT EXISTS`):
conferir e depois inserir deixava a fresta de dois cliques simultâneos.

### Sino de notificações
Quatro tipos: `aprovacao`, `prazo`, `diligencia`, `recado`. **Gravadas no evento**, nunca
calculadas na leitura.
**O dedupe (`destinatario_id + tipo + ref_id`) é o que mantém o sino vivo** — sem ele o job
horário geraria 24 avisos por dia por PC.
Notificação lida **sai da vista na hora** e é apagada em `DIAS_GUARDA_LIDA = 15` dias **após a
leitura**; não lida nunca é apagada. `limparLidas` roda no mesmo job.
⚠️ **O dedupe mora na tabela `notificacao`**: apagá-la faz o job esquecer o que já avisou.

### Prazo da diligência (canal novo)
Três avisos por PC: −3 dias, no dia, +7 dias. **A cobrança não sai** se houve
`resposta_diligencia` ou `situacao` em `parcela_historico` depois de `dt_situacao`.
**Teto de 21 dias**, e ele existe porque o dedupe some junto com a notificação lida — sem
teto, a PC esquecida viraria cobrança a cada 15 dias, para sempre.
`POST /parcela/resposta_diligencia` **não muda a situação**: a parcial segue em Diligência
enquanto o analista avalia. Sem coluna nova — `parcela_historico` aceita qualquer `evento`.

---

## POR QUE OS CANAIS DE PRAZO ESTÃO MUDOS (e devem ficar)

Não é defeito. **`dt_limite_pc` histórico não é prazo — é cálculo em lote** (decisão do
Richard, 10/08): 29/07/2024 é a data mais recente de *todos* os 44 analistas e as 231 de 2027
caem *todas* em 30/01/2027. Daí `CORTE_PRAZO = '2026-08-01'`.
**`prazo_diligencia` está vazio nas 14.652 linhas** porque as 1.236 diligências vieram da
carga; a tela existe e **exige** o prazo, então a primeira diligência registrada pelo sistema
já nasce válida.

**Não baixar o `CORTE_PRAZO`.** Baixá-lo faz o sino cobrar prazo que ninguém definiu.

---

## CRON NO RAILWAY

| job | agenda | comando |
|---|---|---|
| `job_sgpe_links` | de hora em hora | `node job_sgpe_links.js --limite=200` |
| `job_notificacoes` | de hora em hora, **minuto 20** | `npm run job:notif` |

Minuto 20 para não disputar conexão com o outro no início da hora.

---

## CONCLUÍDO EM 10/08 — trava de TRs por analista (`a3e9ee3`, no ar)

Commitado, empurrado e **publicado no Railway** (confirmado por `GET /limite_tr/situacao`).

### As decisões, que valem mais que o código

| decisão | valor | por quê |
|---|---|---|
| limite padrão | **5** | mas fica **NULL no banco** — o Richard digita na tela |
| quando confere | **só no ato de assumir** | ligar a trava não tira TR de ninguém |
| libera vaga | **TR inteira baixada** | `'parcial'` existe na config, não é a escolhida |
| quem aprova | **coordenador** | vê só o próprio grupo; superadmin vê tudo |
| superadmin | **nunca trava** | verificado antes de tudo, sem depender de exceção |

**`limite_padrao` está NULL agora — nada trava até alguém digitar o número na tela.**
Isso é intencional: o Richard quis ver a tela funcionando antes de ligar.

### Três coisas que não são óbvias no código

1. **`null` é sem limite; `0` é bloqueio total.** Não são a mesma coisa em lugar nenhum.
   Confundir os dois libera ou trava a equipe inteira — há teste para cada.

2. **A aprovação AUTORIZA A TR, não soma +1.** Mudei isso no meio do teste: a Grazielly tem
   54 TRs num limite de 5 — aprovada, iria para 6 e continuaria travada, o que tornava o
   pedido inútil justamente para quem precisa. Quem aprova vê quantas TRs a pessoa já tem.
   A autorização vira `'usada'` ao ser gasta.

3. **A trava vive no `PATCH /prestacoes_contas/:codigo_pc`**, não na tela. É o único caminho
   por onde uma TR muda de dono. A tela só pergunta antes, por conveniência — e `limiteChecar`
   devolve "pode" quando a rede falha, porque quem decide é o servidor na hora de gravar.
   Como o front manda **um PATCH por PC**, há o caminho "a TR já é dele": sem ele, a segunda
   PC de uma TR sendo assumida seria barrada e o analista ficaria com metade da TR.

### Rotas

`GET /limite_tr/situacao` · `GET|PATCH /config_limite_tr` ·
`GET|PATCH|DELETE /limite_tr_excecao` · `GET|POST /solicitacao_vaga` ·
`PATCH /solicitacao_vaga/:id`

`PATCH /config_limite_tr` usa um par `(informou, valor)` em vez de COALESCE, porque
`limite_padrao = null` é um valor válido e COALESCE o descartaria como "não informado".

### Banco (já rodado pelo Richard em 10/08)

`config_limite_tr` (1 linha, `limite_padrao` NULL) · `limite_tr_excecao` (0 linhas) ·
`solicitacao_vaga` (0 linhas). SQL em `trava_trs.sql`, idempotente, com bloco de reverter.

### Testado contra o banco de produção, e revertido

Limite 5 barrou a Grazielly (54 TRs), deixou o Eduardo (1 TR) passar, superadmin isento;
pedido duplicado recusado, negar sem motivo recusado, aprovar duas vezes recusado;
autorização aprovada liberou a TR e virou `usada`.
**Revertido:** 2 PCs de volta ao estoque, solicitações apagadas, config de volta a NULL.

`teste_limite_tr.js` — 22 testes com dublê de banco, inclusive tabela ausente (tem de se
comportar como "sem limite", nunca derrubar a tela). Suítes: 39+39+50+22.

### O que falta

- [ ] **Definir o limite na tela** (Configurações → Limite de TRs). Nada trava até lá.
- [ ] Abas 2 e 3 de Configurações — a barra já monta a partir de `CFG_ABAS`, é só somar.
- [ ] Notificar o analista quando o pedido for decidido (hoje ele só descobre tentando de novo).

---

## CONCLUÍDO EM 08/08 — link do SGPe vem pronto no GET

O link deixou de ser carregado progressivamente pela tela. As **três** rotas que alimentam
os números de processo passam a devolver um mapa `links` ao lado de `data`:

| rota | campos |
|---|---|
| `GET /prestacoes_contas` | `processo_pc` + `processo_mae` |
| `GET /prestacoes_contas/resumo_tr` | `processo_mae` |
| `GET /prestacoes_contas/alertas_prazo` | `processo_pc` do `top10` |

**A chave do mapa é o VALOR CRU** (`links["SCC2146/2020"]`), não a forma canônica. É o que
permite ao front fazer `links[p.processo_pc]` sem regex — e é o que vai matar a REGRA CRÍTICA
abaixo quando a Fase 6 (front) entrar.

Nenhuma das três consulta o SGPe: só leem o cache. Quem consulta é `job_sgpe_links.js`.

- **Negativa gravada** — `origem = 'NAO_ENCONTRADO'` com `nu_processo` NULL. Processo que o
  SGPe não tem para de ser reconsultado a cada sessão. Precedência entre estados:
  `CONFERIDO` > `SGPE` > `NAO_ENCONTRADO` > `ERRO` (provisório, volta com recuo).
- **`ERRO`** é falha de rede: volta para a fila em 15 min / 1 h / 6 h / 24 h e desiste na 5ª.
- **`POST /sgpe/links` continua no ar**, agora ciente da negativa — é a rede de segurança
  até o front trocar.

### PARADO DE PROPÓSITO (combinado com o Richard em 08/08)

- **Fase 6 — front (`sigpc-gt/index.html`)**: não começou.
- **Job de carga (~1h15)**: não rodou. Fila em 7.317, para rodar acompanhado.

---

## A REGRA CRÍTICA ACABOU — 08/08

Era esta: *"a regex do `index.html` e a de `lib/sgpe-link.js` são a mesma regra em dois
lugares; mexeu numa, mexa na outra"*. **Não vale mais** — o front não tem mais regex.

A API passou a devolver o link pronto num mapa `links`, indexado pelo **valor cru**, e a tela
virou um `Map.get`. `SGPE_PADRAO`, `sgpeChave`, o resolvedor e o observador saíram do
`index.html` em 08/08 (sigpc-gt `main`), junto com o `sgpe-link-standalone.js`.

**A regra agora tem um dono só: `lib/sgpe-link.js`.** O teste de paridade foi aposentado — não
há mais o que comparar. No lugar dele, `sigpc-gt/teste_front_links.js` falha se a
normalização voltar a aparecer na tela.

Continua valendo o aviso do topo de `lib/sgpe-link.js`: **não existe fórmula** para o
`nuProcesso` interno. Medido em 08/08 sobre 7.699 pares reais, o deslocamento vai de 0 a 171,
sem regra. Errar não dá erro — abre outro processo em silêncio.

---

## CONCLUÍDO EM 06/08

- **Tabela de 183 `cdOrgaosetor`** extraída do SGPe e no ar
  (`9938571`, `feature/baixa-por-parcial`)
- **Regex da sigla aceita região** (ADR20, SDR13) com separador
- **Trava de ambiguidade corrigida** para avaliar dígitos crus antes da remoção de zeros
  (`1cf8a0f`) — 39 testes passando
- **22 ADRs validadas** contra o SGPe por `sgOrgaosetor`
- **UPDATE do grupo A no banco:** 76 valores, 1.641 linhas
- **Paridade front/servidor restaurada** (sigpc-gt `61e0d62`, `main`) — 8.159/8.159,
  0 divergências

### ⚠️ Correção ao registro do UPDATE

A tabela `prestacoes_contas_bkp_processo_pc` **não existe**. Conferido em 06/08 com
`to_regclass`: as únicas tabelas de backup no banco são `_backup_baixada_20260805` e
`_backup_parcial_num_20260805`, ambas de outra frente.

O UPDATE do grupo A foi aplicado **sem esse backup** — ou ele foi removido depois. O dado
está correto (a transformação foi validada valor a valor antes de rodar, e o
`ainda_colados` zerou), e o rollback continua trivial: basta remover o espaço inserido
entre região e número. Mas a rede de segurança prevista no plano não está lá.

---

## PENDENTE

- **Skill `sgpe-link` (SKILL.md)** — a fazer hoje à noite
- **22 valores dos grupos B e C** (ano grudado / ambíguos) em `adr_sdr_sem_link.csv`,
  neste repositório — conferência manual. Atingem 345 PCs.
  Composição: 18 com ano grudado, 1 com barra extra, 1 com ponto no ano, 2 sem região.
- ~~Merge da feature na main do sigpc-api~~ — **feito em 08/08** (`0285939`, fast-forward).
  ⚠️ Produção continua rodando da **`feature/baixa-por-parcial`**, não da `main` — confirmado
  no painel do Railway, e o cron do job também aponta para ela. Não há registro dessa
  configuração no código. Quem for mexer: publicar na main **não** publica em produção.
- **Sondar `cdOrgaosetor` das 9 regionais** agora testáveis: ADR01, 18, 21, 22, 24, 26,
  28, 29, 32. A ADR22 (`13580`) nunca foi verificada — foi ela que originou a frente.

---

## O QUE ESTÁ NO AR

| Peça | Onde | Commit |
|---|---|---|
| `POST /sgpe/links` | Railway, roda da `feature/baixa-por-parcial` | `1cf8a0f` |
| Mapa de 183 órgãos | `lib/sgpe-link.js` | `9938571` |
| Cache de links | tabela `sgpe_processo_ref` | criada no boot |
| Mapa `links` nas 3 rotas | `server.js` + `lib/sgpe-lote.js` | 08/08 |
| Colunas de negativa | `tentativas`, `ultima_tentativa`, `motivo`; `nu_processo` passou a aceitar NULL | ALTER aplicado à mão em 08/08 e no boot |
| Job | `job_sgpe_links.js` + cron de hora em hora no Railway (`--limite=200`) | 08/08 |
| Front sem regex | `sigpc-gt/index.html` — `procHtml` virou `Map.get` | sigpc-gt `94bae1a` |

`main` e `feature/baixa-por-parcial` estão **iguais** em `0285939` (merge de 08/08).
Produção roda da **feature** — ver a observação em PENDENTE.

### Cache em 08/08

388 resolvidos · **7.317 na fila** · 7.700 processos linkáveis no acervo.
Fora de alcance para sempre: 72 que não casam a regex + 4 de sigla desconhecida
(`ADR`, `SCCSCC`, `AR19`) — esses nem chegam a consultar o SGPe.

### O job

```bash
node job_sgpe_links.js --dry-run          # mostra a fila, não toca em nada
node job_sgpe_links.js --limite=200       # o que o cron vai rodar
node job_sgpe_links.js --somente-novos    # fim de carga
node job_sgpe_links.js --retentar-erros   # força os que falharam por rede
```

Ritmo medido: **0,59 s por processo** (mediana), p90 0,79 s. A fila cheia leva **~1h15**.
Ctrl+C encerra depois do processo corrente, sem escrita pela metade.

**FALTA CRIAR:** serviço separado no Railway para o cron (de hora em hora,
`--limite=200`). Não há `railway.json` no repositório — é configuração de painel.

---

## ARMADILHAS DESTA FRENTE

1. **Não existe fórmula** para o `nuProcesso` interno do SGPe. Só consulta. Errar não dá
   erro: abre outro processo, em silêncio.
2. **Região colada ao número é ambígua** e a trava devolve `null` de propósito.
   `ADR223151/2017` pode ser região 22 nº 3151 ou região 2 nº 23151. Não adivinhar.
3. **A trava sai do mapa, não de sigla chumbada.** Entrou chave nova, a proteção passa a
   valer sozinha.
4. **`SIGLAS_AMBIGUAS` conflita com o mapa novo:** `DC`, `SAN`, `SAP` e `SAS` estão nas
   duas listas. `siglaConhecida` devolve `true` e `orgaoDaSigla` lança `SiglaAmbigua`;
   a rota captura e joga em `naoEncontrados`. Não quebra, mas é incoerente. Mantido
   intacto por decisão expressa de 06/08.
5. **O deploy do Railway não é imediato.** Em 05/08 levou ~10 minutos de 404 antes de
   publicar. Não há `railway.json`, `nixpacks.toml` nem qualquer config no repositório.

---

## COMO TESTAR

```bash
npm run teste               # 39 + 33 testes, sem rede e sem banco
node --check server.js lib/*.js job_sgpe_links.js
```

Produção:

```bash
curl -s -X POST https://sigpc-api-production.up.railway.app/sgpe/links \
  -H "Content-Type: application/json" \
  -d '{"processos":["ADR20 1225/2017","SCC2146/2020"]}'
```
