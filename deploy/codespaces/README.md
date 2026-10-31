# LearnHarness no GitHub Codespaces

Este kit roda o LearnHarness num **Codespace** (um computador na nuvem do
GitHub) para você estudar do **tablet, celular, laptop ou PC** com o mesmo
progresso. É grátis dentro da cota da sua conta GitHub e não precisa de cartão.

```
 tablet / celular / PC ──(navegador, logado no GitHub)──▶ Codespace (Ubuntu, 2 núcleos)
                                                          ├─ LearnHarness (só 127.0.0.1:3000, porta PRIVADA)
                                                          ├─ Claude Code (login guardado em /workspaces)
                                                          └─ /workspaces/learnharness-data ──(a cada 15 min)──▶ repo privado
```

- **O app é o mesmo** do desktop: o LearnHarness é um app web, e o Electron só
  abria uma janela para ele.
- **O Claude Code roda no Codespace**, com a sua assinatura. O tablet só precisa
  de navegador.
- **Seus dados ficam num repositório privado** (`learnharness-data`), salvo a
  cada 15 minutos. Se o Codespace for apagado, um novo Codespace clona tudo de volta.
- **Só você acessa.** A porta 3000 é **privada**: o endereço só abre logado na
  sua conta do GitHub.

> ⚠️ Nunca mude a porta 3000 para *Public*. No modo navegador o LearnHarness
> **não tem login**: qualquer pessoa com o link usaria suas chaves e sua conta
> do Claude.

**Como é o dia a dia:** você abre o Codespace (30–60 s para ligar) e depois o
endereço do app. Ao terminar, você para o Codespace.

---

## 0. Cota grátis

A conta GitHub Free inclui por mês **120 core-horas** e **15 GB-mês** de
armazenamento. Este kit usa uma máquina de **2 núcleos**, então dá cerca de
**60 horas ligadas por mês** (umas 2 horas por dia). O tempo só conta enquanto o
Codespace está ligado; parado, ele só ocupa armazenamento (alguns GB).

Por padrão, contas pessoais têm limite de gastos de US$ 0 para Codespaces:
quando a cota acaba, ele simplesmente não liga até o mês virar, sem cobrança.
Confira em <https://github.com/settings/billing>.

## 1. Criar o repositório privado de dados

No GitHub: **New repository** → nome `learnharness-data` → **Private** →
**não** marque README, .gitignore nem licença (ele precisa nascer vazio) → **Create**.

## 2. Levar seus dados do PC (migração, uma vez)

1. **Feche o app desktop do LearnHarness.**
2. No PC, num terminal:

```bash
git clone https://github.com/GabrielSartoriMosquer/learnharness.git ~/learnharness-kit
cd ~/learnharness-kit
git checkout claude/harness-multi-device-sync-dlx85s   # até o kit entrar na main
bash deploy/codespaces/migrate-from-pc.sh git@github.com:GabrielSartoriMosquer/learnharness-data.git
```

(Se você usa HTTPS no git em vez de SSH, troque o endereço por
`https://github.com/GabrielSartoriMosquer/learnharness-data.git`.)

O script copia `~/.config/LearnHarness/data` para uma pasta temporária e envia
de lá. A pasta original fica **intocada**, como cópia de segurança. No fim ele
**lista os nomes** das chaves do seu `auth.json` (sem os valores), para o próximo passo.

Daqui em diante você estuda pelo navegador, inclusive no PC.

## 3. Cadastrar suas chaves como segredos

Em <https://github.com/settings/codespaces> → **Secrets → New secret**, para
cada nome que o script listou (por exemplo `DEEPGRAM_API_KEY`, do ditado):

- **Name:** o nome exatamente como listado.
- **Value:** o valor da chave (está no `~/.config/LearnHarness/auth.json` do PC).
- **Repository access:** `GabrielSartoriMosquer/learnharness`.

O app lê esses segredos como variáveis de ambiente. Eles sobrevivem mesmo se o
Codespace for apagado e nunca entram em arquivo nem no backup.

> ⚠️ **Não** cadastre `ANTHROPIC_API_KEY`: com ela, o Claude Code passaria a
> cobrar pela API em vez de usar a sua assinatura.

## 4. Ajustar o Codespaces na sua conta

Ainda em <https://github.com/settings/codespaces>:

- **Default idle timeout:** `60` minutos (veja o teste de inatividade abaixo).
- **Default retention period:** `30` dias (o máximo). Um Codespace parado é
  apagado depois disso sem uso; seus dados estão no backup de qualquer forma.

## 5. Criar o Codespace

1. Na página do seu fork: **Code → Codespaces → ⋯ → New with options**.
2. **Branch:** `claude/harness-multi-device-sync-dlx85s` (ou `main`, depois que o
   kit entrar nela). **Machine type:** 2-core.
3. O GitHub mostra que o Codespace pede **acesso de escrita a
   `learnharness-data`** → **Authorize and continue**. É assim que o backup
   funciona, sem chave extra.
4. A primeira criação demora alguns minutos: ela instala Claude Code e Chromium,
   clona seus dados e faz o build. Acompanhe pelo terminal (*Creation log*).

## 6. Login do Claude Code

No terminal do Codespace:

```bash
claude
```

Escolha entrar com a sua conta Claude (assinatura). Abra o link, autorize, cole
o código de volta e saia com `/exit`. O login fica em `/workspaces/.lh/claude`:
sobrevive a paradas e recriações do contêiner, e só se perde se o Codespace for
apagado (aí você repete este passo).

## 7. Abrir o app

1. No VS Code do Codespace, aba **Ports** → linha **LearnHarness (3000)** →
   ícone de globo, ou copie o endereço. Ele tem a forma
   `https://<nome-do-codespace>-3000.app.github.dev`.
2. Confira que a coluna *Visibility* diz **Private**.
3. **Salve esse endereço** nos favoritos do tablet e do PC (no tablet, *Adicionar
   à tela inicial*). Ele não muda enquanto o Codespace existir.

O ditado funciona porque o endereço é HTTPS.

---

## Dia a dia

1. **Ligar:** <https://github.com/codespaces> → toque no seu Codespace. Ele abre
   o VS Code no navegador e o LearnHarness sobe sozinho.
2. **Estudar:** abra o favorito do app.
3. **Parar ao terminar:** <https://github.com/codespaces> → **⋯** ao lado do
   Codespace → **Stop codespace**. Parar economiza a cota; nada se perde.

## Teste de inatividade (faça uma vez)

O Codespace desliga depois de um tempo sem atividade. A documentação do GitHub
cita o editor e o terminal como atividade, mas **não diz se usar o app pela
porta conta**. Para descobrir:

1. Com o timeout em **60 min**, ligue o Codespace, abra o app e **feche a aba do
   VS Code**.
2. Estude só pelo app por uns **70 minutos**.
3. **Não caiu?** Usar o app conta como atividade: mantenha 60 min (ou até menos,
   para economizar quando esquecer de parar).
4. **Caiu?** Suba o timeout para **240 min** (o máximo) e lembre de parar o
   Codespace ao terminar. Esquecer custa até 4 h × 2 núcleos = 8 core-horas.

## Atualizar o LearnHarness

Você decide quando atualizar. O Codespace segue **o seu fork**.

1. **Trazer novidades do autor original** (opcional): na página do fork,
   **Sync fork → Update branch** (antes, **Compare** mostra o que mudou).
2. **No terminal do Codespace:**

```bash
bash deploy/codespaces/update.sh
```

O script puxa o fork e faz o build **sem derrubar o app atual**. Depois roda um
teste de fumaça e só então troca a versão. Se a nova não responder, **a
anterior volta sozinha**.

## Backup e restauração

**Vai para o backup:** tudo em `/workspaces/learnharness-data`, ou seja chats,
grafo, sessões de prática, configurações e overrides de prompt. **Não vão:**
chaves, o login do Claude Code, temporários e gravações de depuração.

- O histórico do repositório `learnharness-data` no GitHub mostra um commit
  `backup: <data>` sempre que algo mudou.
- Log: `/workspaces/.lh/logs/backup.log`. Backup na hora:
  `bash deploy/oracle/backup.sh`.
- Ao ligar, o Codespace já envia o que tiver ficado pendente da última sessão.
  O Codespace parado guarda o disco, então parar nunca perde dados.

**Se o Codespace for apagado** (30 dias sem uso, ou por você): crie outro
(passo 5). Ele clona o `learnharness-data` sozinho e você volta exatamente do
último backup. Refaça o login do Claude (passo 6) e salve o novo endereço do
app. Os segredos continuam lá.

## Limitações conhecidas

- **Endpoint customizado e logins por assinatura não funcionam pelo endereço
  `app.github.dev`.** Isso vale para Configurações → endpoint customizado e para
  os logins do ChatGPT, Copilot e Grok. Por segurança, o app recusa essas ações
  quando chega por um proxy HTTPS. Claude Code, chaves de API, chat, grafo,
  prática e configurações funcionam normalmente. Se precisar dessas ações, uma
  possibilidade (não testada) é abrir o Codespace no **VS Code desktop**, que
  encaminha a porta para `localhost:3000` no seu PC.
- **Um servidor por vez.** Não volte a usar o app desktop do PC com os mesmos
  dados: as duas cópias divergiriam.
- **Ligar leva 30–60 s**, e a primeira criação leva alguns minutos (build).

## Comandos úteis (terminal do Codespace)

```bash
tail -f /workspaces/.lh/logs/server.log      # logs do app
bash deploy/codespaces/start.sh              # sobe o app se não estiver no ar
kill "$(cat /workspaces/.lh/server.pid)"     # para o app (o start.sh sobe de novo)
```

## Onde fica cada coisa

| Caminho | O que é |
|---|---|
| `/workspaces/learnharness` | o seu fork (onde o build acontece) |
| `/workspaces/learnharness-data` | **seus dados** (clone do repo privado) |
| `/workspaces/.lh/server` | a versão em uso (`.prev` = a anterior) |
| `/workspaces/.lh/claude` | login e configuração do Claude Code |
| `/workspaces/.lh/auth.json` | chaves cadastradas pelo app (0600, fora do backup) |
| `/workspaces/.lh/logs/` | logs do app e do backup |

Tudo em `/workspaces` sobrevive a paradas e recriações do contêiner.

## Arquivos deste kit

| Arquivo | Função |
|---|---|
| `.devcontainer/devcontainer.json` | máquina, variáveis e permissão para o repo de dados |
| `deploy/codespaces/setup.sh` | instala Claude Code e Chromium, clona os dados e faz o build (na criação) |
| `deploy/codespaces/start.sh` | sobe o app e o backup automático (a cada início) |
| `deploy/codespaces/update.sh` | atualiza a partir do fork, com troca segura e volta automática |
| `deploy/codespaces/migrate-from-pc.sh` | migração única, roda no PC |
| `deploy/oracle/backup.sh` | o backup em si (compartilhado com o kit da Oracle) |

Fontes:
[cotas do Codespaces](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces),
[tempo de inatividade](https://github.com/github/docs/blob/main/content/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces.md),
[o que conta como atividade](https://docs.github.com/en/codespaces/about-codespaces/deep-dive).
