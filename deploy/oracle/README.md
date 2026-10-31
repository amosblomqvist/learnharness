# LearnHarness na nuvem (Oracle Always Free)

Este kit coloca o LearnHarness numa máquina gratuita da Oracle, sempre ligada,
para você estudar do **tablet, celular, laptop ou PC** com o mesmo progresso.

```
 tablet / celular / PC ──(Tailscale, HTTPS privado)──▶ máquina Oracle A1 (Ubuntu ARM)
                                                       ├─ LearnHarness (serviço systemd, só 127.0.0.1)
                                                       ├─ Claude Code (logado na sua conta)
                                                       └─ ~/learnharness-data ──(a cada 15 min)──▶ repo privado no GitHub
```

- **O app é o mesmo** do desktop: o LearnHarness é um app web, e o Electron só
  abria uma janela para ele. No navegador funciona igual.
- **O Claude Code roda na máquina**, não no aparelho. O tablet só precisa de navegador.
- **Seus dados ficam numa pasta só** (`~/learnharness-data`), que também é um
  clone de um repositório **privado** no GitHub. Ela é salva a cada 15 minutos e
  sempre que o serviço para.
- **Só os seus aparelhos acessam.** O app escuta apenas dentro da máquina, e o
  Tailscale o publica com HTTPS somente na sua rede privada. Isso é obrigatório:
  no modo navegador o LearnHarness **não tem login**, e qualquer pessoa que
  alcançasse a porta usaria suas chaves e sua conta do Claude.

> ⚠️ Nunca abra a porta 3000 na Oracle nem use `tailscale funnel` com este app.

---

## 0. O que você precisa

- Conta no **GitHub** (você já tem).
- Conta na **Oracle Cloud**. Pede cartão só para verificar identidade; a conta
  gratuita não cobra.
- Conta no **Tailscale** (grátis para uso pessoal). Dá para entrar com a conta
  Google ou GitHub.
- Assinatura do Claude (Pro/Max) para o Claude Code, como você já usa hoje.

## 1. Criar o repositório privado de dados

No GitHub: **New repository** → nome `learnharness-data` → **Private** →
**não** marque README, .gitignore nem licença (ele precisa nascer vazio) → **Create**.

Guarde o endereço SSH dele: `git@github.com:GabrielSartoriMosquer/learnharness-data.git`.

## 2. Criar a conta Oracle e a máquina

1. Cadastre-se em <https://www.oracle.com/cloud/free/>. A **região inicial
   (home region) é permanente** e é a única onde as máquinas gratuitas podem ser
   criadas. São Paulo costuma ficar sem capacidade para a máquina ARM; se for
   viável, considere outra região próxima.
2. No console: **Compute → Instances → Create instance**.
   - **Name:** `learnharness`. O endereço final vai ser
     `https://learnharness.<sua-rede>.ts.net`.
   - **Image:** *Canonical Ubuntu 24.04* (a versão aarch64 é escolhida
     automaticamente com a forma Ampere).
   - **Shape:** *Ampere* → `VM.Standard.A1.Flex` → **2 OCPUs, 12 GB de memória**.
     Confira o selo *Always Free-eligible*: em junho de 2026 a Oracle reduziu o
     limite gratuito de 4 OCPU/24 GB para 2 OCPU/12 GB, e o console mostra o
     valor atual.
   - **Networking:** mantenha *Assign a public IPv4 address* (só para o primeiro
     acesso por SSH).
   - **SSH keys:** *Generate a key pair for me* → **baixe a chave privada**. Ou
     cole a chave pública do seu PC (`~/.ssh/id_ed25519.pub`).
   - **Boot volume:** 50 GB (o gratuito cobre até 200 GB no total).
3. **"Out of capacity"?** É comum. Tente outro *Availability Domain* na mesma
   tela, ou tente de novo em outros horários (madrugada costuma funcionar). Não
   tem jeito oficial de furar a fila.
4. Quando a máquina estiver *Running*, anote o **IP público**.

Do seu PC, teste o acesso:

```bash
chmod 600 ~/Downloads/ssh-key-*.key            # se a Oracle gerou a chave
ssh -i ~/Downloads/ssh-key-*.key ubuntu@IP_PUBLICO
```

## 3. Levar seus dados do PC para a máquina (migração)

1. **Feche o app desktop do LearnHarness no PC** (para nada mudar durante a cópia).
2. No PC, copie os dados e as chaves:

```bash
CHAVE=~/Downloads/ssh-key-*.key                  # ou omita -i se usou sua própria chave
ssh -i $CHAVE ubuntu@IP_PUBLICO 'mkdir -p ~/lh-import'
scp -i $CHAVE -r ~/.config/LearnHarness/data ubuntu@IP_PUBLICO:~/lh-import/
scp -i $CHAVE ~/.config/LearnHarness/auth.json ubuntu@IP_PUBLICO:~/lh-import/
```

O `auth.json` (suas chaves de API, por exemplo a do Deepgram para ditado) vai
direto do PC para a máquina e **nunca** entra no backup do GitHub.

A pasta `~/.config/LearnHarness` do PC fica **intocada**, como cópia de segurança.
Daqui em diante, também no PC você estuda pelo navegador.

## 4. Instalar tudo na máquina

Na máquina (pelo SSH):

```bash
git clone https://github.com/GabrielSartoriMosquer/learnharness.git ~/learnharness
LH_DATA_REPO=git@github.com:GabrielSartoriMosquer/learnharness-data.git \
  bash ~/learnharness/deploy/oracle/install.sh
```

O script instala Node 26, Claude Code, Chromium e Tailscale, faz o build e
cria os serviços. Ele para em três momentos para pedir algo a você:

1. **Login no Tailscale:** aparece um link. Abra em qualquer aparelho e entre na
   sua conta.
2. **Deploy key:** aparece uma linha começando com `ssh-ed25519`. No GitHub,
   abra `learnharness-data` → **Settings → Deploy keys → Add deploy key**, cole
   a linha, **marque *Allow write access*** e salve. Volte e aperte Enter.
   Essa chave só dá acesso a esse repositório.
3. **HTTPS do Tailscale:** se ainda não estiver ativo na sua rede, o
   `tailscale serve` mostra um link para ativar. Também dá para ativar em
   <https://login.tailscale.com/admin/dns> → *HTTPS Certificates* → *Enable*.

O build demora alguns minutos. No fim aparece o endereço, algo como
`https://learnharness.tail1234.ts.net`.

O script pode ser rodado de novo sem problema: ele pula o que já está feito.

## 5. Login do Claude Code na máquina

```bash
claude
```

Escolha entrar com a sua conta Claude (assinatura). Ele mostra um link: abra no
PC ou no tablet, autorize e cole o código de volta no terminal. Depois saia com
`/exit`. O login fica guardado na máquina (`~/.claude`).

No app, **Configurações** mostra o status do Claude Code.

## 6. Usar nos seus aparelhos

1. Instale o app **Tailscale** no tablet, celular, laptop e PC e entre na mesma conta.
2. Com o Tailscale ligado, abra `https://learnharness.<sua-rede>.ts.net`.
3. Dica: no tablet, use *Adicionar à tela inicial* para abrir como um app.

O ditado funciona porque o endereço é HTTPS (o navegador só libera o microfone
assim).

## 7. Fechar o SSH público (recomendado)

O install ligou o **Tailscale SSH**, então você não precisa mais da porta 22
aberta na internet.

1. Do PC (com Tailscale ligado), teste: `ssh ubuntu@learnharness`.
2. Funcionou? No console da Oracle: **Networking → Virtual cloud networks →**
   a VCN da máquina **→ Security Lists → Default Security List → Ingress Rules**
   → apague a regra da porta **22** (origem `0.0.0.0/0`).

Daí em diante a máquina não tem nenhuma porta aberta para a internet.

---

## Atualizar o LearnHarness

Você decide quando atualizar. A máquina segue **o seu fork**, e o fork só muda
quando você quer.

1. **Trazer novidades do autor original para o seu fork** (opcional): no GitHub,
   na página do seu fork, **Sync fork → Update branch**. Antes, dá para ver o que
   mudou em **Sync fork → Compare**.
2. **Atualizar a máquina:**

```bash
bash ~/learnharness/deploy/oracle/update.sh
```

O script baixa o seu fork, faz o build **sem derrubar o app atual**, roda um
teste de fumaça e só então troca a versão (fica fora do ar por alguns
segundos). Se a versão nova não responder, **a anterior volta sozinha**.

Para voltar manualmente para a versão anterior:

```bash
sudo systemctl stop learnharness
mv ~/learnharness-server ~/learnharness-server.failed
mv ~/learnharness-server.prev ~/learnharness-server
sudo systemctl start learnharness
```

> Sobre o seu fork: se o autor apagar o repositório original ou torná-lo
> privado, o seu fork **continua existindo**, com todos os arquivos e todo o
> histórico. E a máquina e o seu PC têm cópias completas do repositório.

## Backup e restauração

**O que vai para o backup:** tudo em `~/learnharness-data`, ou seja chats,
grafo, sessões de prática, configurações e overrides de prompt. **Não vão:**
`auth.json` (chaves), o login do Claude Code, arquivos temporários e
gravações de depuração.

Para conferir: o histórico do repositório `learnharness-data` no GitHub mostra
um commit `backup: <data>` sempre que algo mudou. Na máquina:

```bash
systemctl list-timers learnharness-backup.timer     # próximo backup
journalctl -u learnharness-backup -n 20             # últimos backups
sudo systemctl start learnharness-backup            # backup agora
```

### Restaurar numa máquina nova

Se a máquina sumir (ver o risco abaixo), crie outra (passo 2) e:

1. Copie de novo o `auth.json` do PC para `~/lh-import/auth.json` (passo 3, só
   a segunda linha do `scp`), ou cadastre as chaves de novo no app depois.
2. Rode o mesmo comando do passo 4. Como o `learnharness-data` já tem dados,
   o install **só clona** e não importa nada. Ele gera uma deploy key nova:
   adicione-a no GitHub e apague a antiga.
3. Refaça o login do Claude Code (passo 5).
4. No painel do Tailscale (<https://login.tailscale.com/admin/machines>), apague
   a máquina antiga, para a nova poder usar o nome `learnharness`.

Você volta exatamente do último backup, perdendo no máximo 15 minutos.

## ⚠️ Risco da conta gratuita: máquina ociosa

Na conta gratuita, a Oracle pode **recuperar** (desligar e apagar) máquinas
consideradas ociosas: quando, ao longo de 7 dias, CPU, rede e memória ficam
abaixo de 20%. Um app de estudo pessoal fica parado a maior parte do tempo,
então isso pode acontecer.

Você escolheu continuar na conta gratuita. O plano para esse caso é o backup:
se a máquina sumir, siga *Restaurar numa máquina nova*. Não use scripts que
simulam uso para enganar a regra.

Se um dia isso incomodar, a saída oficial é passar a conta para *Pay As You
Go*, o que remove a regra de ociosidade (os recursos Always Free continuam
gratuitos). Nesse caso crie um alerta de orçamento (*Billing → Budgets*) para
saber de qualquer cobrança.

## Limitações conhecidas

- **Endpoint customizado e logins por assinatura não funcionam pelo endereço
  `ts.net`.** Isso vale para Configurações → endpoint customizado e para os
  logins do ChatGPT, Copilot e Grok. Por segurança, o app recusa essas ações
  quando chega por um proxy HTTPS (o `tailscale serve`). Claude Code, chaves de
  API, chat, grafo, prática e configurações funcionam normalmente.
- **Um servidor por vez.** Não volte a usar o app desktop do PC com os mesmos
  dados: as duas cópias divergiriam.
- **Chromium em vez de Chrome:** o Google Chrome não tem versão Linux ARM. O
  install baixa o Chromium do Playwright e aponta o app para ele (`CHROME_PATH`).
- **ARM não é testado pelo projeto original.** As bibliotecas nativas do app
  têm versão `linux-arm64`, e o `update.sh` roda o teste de fumaça do servidor
  antes de trocar a versão, mas algum detalhe pode aparecer só na máquina real.

## Comandos úteis

```bash
systemctl status learnharness              # o app está rodando?
journalctl -u learnharness -f              # logs do app ao vivo
sudo systemctl restart learnharness        # reiniciar
tailscale serve status                     # endereço publicado
nano ~/.config/learnharness/learnharness.env   # porta, caminhos, CHROME_PATH
```

## Onde fica cada coisa na máquina

| Caminho | O que é |
|---|---|
| `~/learnharness` | clone do seu fork (onde o build acontece) |
| `~/learnharness-server` | a versão em uso (`.prev` = a anterior) |
| `~/learnharness-data` | **seus dados** (clone do repo privado de backup) |
| `~/.config/learnharness/auth.json` | chaves de API (0600, fora do backup) |
| `~/.config/learnharness/learnharness.env` | variáveis do serviço |
| `~/.ssh/learnharness-data` | deploy key do backup |

## Arquivos deste kit

| Arquivo | Função |
|---|---|
| `install.sh` | prepara a máquina (pode rodar de novo) |
| `update.sh` | atualiza a partir do fork, com troca segura e volta automática |
| `backup.sh` | commit + push dos dados (só quando algo mudou) |
| `learnharness.service` | serviço do app (só em 127.0.0.1) |
| `learnharness-backup.service` / `.timer` | backup a cada 15 min |
| `learnharness.env.example` | modelo das variáveis do serviço |
| `data.gitignore` | `.gitignore` do repositório de dados |

Fontes sobre a Oracle (consultadas em outubro de 2026):
[documentação Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[InfoQ sobre a redução de junho de 2026](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/).
