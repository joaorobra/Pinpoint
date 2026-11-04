# Auditoria de UX/UI — PINPOINT v0.6.4 (nov/2026)

Auditoria feita sobre a v0.6.4 (`0558834`). Os achados vêm de duas fontes:

1. **Teste no app renderizado.** Build web servido pelo Vite, aberto num vault de teste criado para isso (OPFS, com páginas, pastas aninhadas, um banco de dados no formato antigo, tarefas recorrentes e vencidas, tabela, código e títulos longos com acentos). Testado em 1366×800, 1000×700, 900×700 e 375×812, nos temas escuro e claro.
2. **Revisão do código-fonte** focada em teclado, foco, ARIA, textos e casos de borda. Cada item foi conferido no código antes de entrar aqui.

Severidade: **Crítico** (perda de dados ou recurso quebrado), **Alto** (atrapalha uma tarefa comum ou exclui usuários de teclado/leitor de tela), **Médio** (atrito visível) e **Baixo** (acabamento).

Status: ✅ corrigido nesta versão · ➖ não corrigido (motivo ao lado).

---

## Críticos

| # | Achado | Onde | Status |
|---|--------|------|--------|
| C1 | **Banco de dados no formato antigo não abria.** O schema com `fields: [{ key, type, options: ["a","b"] }]` (o mesmo do `sample-vault`) quebrava com `TypeError: Cannot read properties of undefined (reading 'some')`, e o erro cru aparecia na tela. | `DatabaseView.tsx`, `DbPageProperties.tsx` | ✅ O schema agora é normalizado na API (`normalizeDbSchema`), que converte `fields` em `columns` e opções de texto em `{id,label,color}`, para as linhas existentes continuarem batendo. |
| C2 | **Edições externas na página aberta nunca recarregavam, e o próximo autosave as sobrescrevia.** O timer do autosave não era zerado depois de disparar, e o watcher do vault ignora recargas enquanto há um save pendente. Afeta sync (Drive/Dropbox) e o modo Agent do chat. | `App.tsx` (`onEditorChange`) | ✅ O timer é zerado ao disparar. |
| C3 | **Enter em "Cancel" confirmava o diálogo, inclusive "Excluir permanentemente".** O backdrop capturava Enter e chamava `accept()` mesmo com o foco no Cancel. Em diálogos `choose`, Enter fechava sem resolver a ação. | `Dialogs.tsx` | ✅ Enter só confirma quando o foco não está num botão. `choose` e `password` tratam o próprio Enter. |
| C4 | **Delete/Backspace mandava a página aberta para a Lixeira através de um modal.** Bastava um modal aberto (Configurações, atalhos, menu) com foco num botão. | `App.tsx` (atalhos globais) | ✅ Atalhos de tecla única não disparam com overlay aberto nem com foco em controle. `?` também respeita isso. |

## Altos

| # | Achado | Onde | Status |
|---|--------|------|--------|
| A1 | **Clicar numa pasta já aberta a recolhia.** Abrir uma pasta ou banco escondia as páginas que o usuário estava vendo. | `FileTree.tsx` | ✅ Clicar abre a pasta e a expande. Ela só recolhe com um segundo clique na pasta já ativa, e a seta (caret) alterna sozinha. |
| A2 | **O destaque da árvore não acompanhava o documento aberto.** Pastas e bancos nunca ficavam destacados, e ao abrir por aba, voltar/avançar ou pela paleta o destaque continuava na página anterior. | `FileTree.tsx`, `App.tsx` | ✅ As pastas ganharam o estado `active`, e a seleção acompanha o documento ativo (sem desfazer uma seleção múltipla). |
| A3 | **O painel direito mostrava o sumário da página anterior** quando uma pasta ou um banco estava aberto. O chip "saved" também aparecia para pastas. | `App.tsx` | ✅ Corrigido. |
| A4 | **Janela estreita quebrava o layout.** Em 900–1000px o editor ficava com ~300px, as abas sumiam e o cabeçalho transbordava com rolagem horizontal. | `App.tsx` (grid) | ✅ A coluna do editor usa `minmax(0,1fr)`. O painel direito se recolhe sozinho quando o editor ficaria com menos de 520px, sem mudar a preferência salva: ao alargar a janela ele volta, e o botão ainda força a exibição. |
| A5 | **Abas transbordavam sem indicação.** A aba ativa ficava cortada ("E…"), sem barra de rolagem e sem rolagem pela roda do mouse. | `App.tsx`, `styles.css` | ✅ As abas encolhem com reticências (mínimo de 116px), a aba ativa rola para a vista e a roda vertical rola a faixa. |
| A6 | **Tooltips vazavam e deslocavam a sidebar.** Os balões ficavam sempre no DOM e passavam da borda da sidebar, que tem `overflow:hidden`. Eles saíam cortados ("Hide sidebar") e, ao focar um botão, a sidebar rolava ~17px para o lado. | `Tooltip.tsx` | ✅ O balão agora é renderizado em portal com posição fixa, só enquanto está aberto, e fica limitado à viewport. |
| A7 | **Tabelas e listas no editor com espaçamento inflado.** O TipTap envolve cada célula e item num `<p>` com margem de 1em, o que deixava as linhas da tabela 3× mais altas (74px contra 42px). | `styles.css` | ✅ A margem foi zerada dentro de `td`, `th` e `li`. |
| A8 | **Contraste insuficiente no tema claro.** O texto na cor de destaque (links, tags, item ativo) ficava em 4,35:1, e o wikilink em 3,27:1. | `styles.css` | ✅ Novos tokens `--accent-text` e `--page-link`, escurecidos no tema claro: wikilink em 6,4:1 e texto de destaque em ~7:1. O tema escuro não mudou. |
| A9 | **Árvore de arquivos inacessível por teclado.** As linhas eram `div`s sem `tabIndex`, `role` nem teclas. | `FileTree.tsx` | ✅ Padrão WAI-ARIA *tree*: tabindex itinerante, ↑/↓/Home/End, → expande ou entra, ← recolhe ou sobe, Enter/Espaço abre e Shift+F10/Menu abre o menu de contexto. |
| A10 | **Abas de documento inacessíveis por teclado.** Abas inativas tinham `tabIndex=-1` e nenhuma tecla. | `App.tsx` | ✅ ←/→ entre abas, Enter/Espaço ativa e Delete fecha. |
| A11 | **O menu de contexto do editor editava o documento por trás.** O ProseMirror recebia Enter e as setas antes do menu. | `ContextMenu.tsx` | ✅ O menu escuta em fase de captura e interrompe a propagação. Ganhou `role="menu"` e `menuitem`. |
| A12 | **Escape num dropdown ou seletor de cor fechava as Configurações inteiras.** | `Select.tsx`, `ColorPicker.tsx`, `SettingsPanel.tsx` | ✅ O popover trata o próprio Escape, e Configurações ignora eventos já tratados. |
| A13 | **Enter em qualquer botão do diálogo "Criar" criava o item**, inclusive no Cancel e nas linhas de pasta. As subpastas só abriam com o mouse. | `CreateDialog.tsx` | ✅ Enter só cria a partir do campo de nome. → e ← expandem e recolhem pastas. |
| A14 | **Modais sem trap ou retorno de foco**: atalhos, criar, ícones e paleta. Nos diálogos com `autoFocus`, o foco caía no `<body>` ao fechar. | `useFocusTrap.ts` e modais | ✅ O hook foi aplicado aos modais que faltavam e descobre o gatilho real mesmo com `autoFocus`. |
| A15 | **Falha ao salvar era silenciosa, e os últimos ~600ms de digitação se perdiam ao fechar ou trocar de vault.** | `App.tsx` | ✅ A falha mostra um toast de erro e mantém o estado "unsaved". O save pendente é gravado em `pagehide`, `beforeunload` e na troca de vault. |
| A16 | **Ações reveladas só no hover ficavam invisíveis ao teclado e ao toque**: Lixeira, linhas do banco, "+" das colunas do quadro e do calendário, e "copiar" nos blocos de código do chat. No toque, as ações da linha do banco continuavam com `display:none`. | `styles.css` | ✅ `:focus-visible`/`:focus-within` e o bloco `(hover:none)` foram corrigidos. |
| A17 | **Botões aninhados (`<button>` dentro de `<button>`)** nos cards da visão de pasta: HTML inválido com cliques imprevisíveis. React avisava no console. | `FolderView.tsx` | ✅ O card virou `div role="button"` com teclado. |

## Médios

| # | Achado | Status |
|---|--------|--------|
| M1 | **Estatísticas de Tarefas infladas pelas ocorrências recorrentes projetadas.** Um vault com 11 tarefas mostrava "27 Total · 4%", e o número mudava ao ligar "Show all recurring ahead". | ✅ As projeções não entram mais nos totais (agora "11 Total · 9%"). |
| M2 | **Nova página abria já rolada**, herdando a posição da página anterior. | ✅ A rolagem volta ao topo ao trocar de documento. |
| M3 | **Chip de status vazio** aparecia como uma pílula cinza no canto do cabeçalho em pastas e bancos. | ✅ |
| M4 | **Página vazia sem nenhuma indicação** de onde digitar nem do menu `/`. | ✅ Placeholder: "Start writing, or type / for blocks and commands…". |
| M5 | **Tela inicial com dois botões que fazem a mesma coisa** ("Open a vault folder" e "Connect a new folder"). | ✅ O link duplicado saiu (no Android, onde as ações são diferentes, ele continua). |
| M6 | **Conflito de CSS `.tb-btn`.** Os botões da barra de título e da barra de formatação do editor dividiam a classe, então a formatação herdava `width:46px` e `cursor: default`. | ✅ A barra de título passou a usar `.titlebar-btn`. |
| M7 | **Mensagens multilinha dos diálogos colapsavam numa linha só**: aviso de senha, listas de arquivos que falharam. | ✅ `white-space: pre-line`, com rolagem acima de 40vh. |
| M8 | **Senha errada fechava o diálogo de desbloqueio**, e era preciso achar "Unlock" de novo. | ✅ O diálogo pede de novo, com o erro visível (`role="alert"`). |
| M9 | **Excluir um tema personalizado era instantâneo**, sem confirmação. | ✅ Agora pede confirmação. |
| M10 | **Enter durante composição de IME** (japonês, chinês, coreano) enviava texto pela metade: chat, título, renomear, diálogos. | ✅ `isComposing` é verificado. |
| M11 | **Toast com "Undo" sumia em 5s sem pausa** e nem sempre era anunciado, porque a live region era montada junto com o toast. | ✅ Pausa no hover e no foco, 8s quando tem ação, e a live region fica sempre montada. O ícone de desfazer só aparece em "Undo". |
| M12 | **Lixeira mostrava "Trash is empty" quando a leitura falhava.** | ✅ Estado de erro com "Retry". |
| M13 | **Atalhos sempre como "Ctrl"/"Alt", também no macOS**, e Ctrl+W/Ctrl+N anunciados no navegador, que não deixa a página interceptá-los. | ✅ Helper `lib/keys.ts` (⌘/⌥ no Mac). No build web, os atalhos reservados pelo navegador saem da folha de atalhos e das dicas. A folha também ganhou os atalhos do editor. |
| M14 | **Paleta de comandos sem semântica de combobox**: o leitor de tela não anunciava o item selecionado. | ✅ `combobox`, `listbox`, `option` e `aria-activedescendant`. |
| M15 | **Partes do banco só funcionavam com o mouse**: abas de visão, "New row", renomear título, célula de moeda e card da galeria. | ✅ `role`, `tabIndex` e Enter/Espaço. |
| M16 | **"No matching rows" era um beco sem saída.** | ✅ Botões "Clear filters" e "New row". |
| M17 | **Linhas do sumário e da agenda** não eram focáveis, e clicar no texto da agenda abria a página duas vezes. | ✅ |

## Baixos

| # | Achado | Status |
|---|--------|--------|
| B1 | Botões só com ícone sem nome acessível: mês anterior/próximo do calendário, adicionar/remover opção (o "✕" era lido como "multiplicação"), campos de opção e busca de ícones. | ✅ |
| B2 | Texto inconsistente: "Delete forever" × "Delete permanently", "Couldn't" × "Couldn’t", "Delete" num diálogo que move para a Lixeira, "+ add filter" em minúsculas. | ✅ |
| B3 | Branco fixo sobre a cor de destaque (switch, checkbox do banco, dia selecionado/hoje, botão "New") ficava ilegível com um accent claro. | ✅ Usa `--accent-contrast`. |
| B4 | Animações do Framer Motion fora dos helpers ignoravam "reduzir movimento" do sistema. | ✅ `MotionConfig reducedMotion="user"` na raiz. |
| B5 | Construtor de consulta: o rótulo "Where" ficava sozinho numa linha e os filtros desalinhados 8px das outras linhas. A rolagem também deslocava o layout ao aparecer a barra. | ✅ Grid alinhado e `scrollbar-gutter: stable`. |
| B6 | Paleta sem "Go to Tags", e as ações "Go to…" tinham a dica genérica "Command". | ✅ |
| B7 | Checkbox de tarefa sempre com o rótulo "Toggle done", sem dizer qual tarefa. | ✅ "Mark done: <tarefa>". |
| B8 | Alvo pequeno: o "×" das abas tinha 18px. | ✅ 20px. |

## Não corrigido nesta versão

| Achado | Motivo e recomendação |
|--------|------------------------|
| O texto da tarefa abre a página só com clique, e as ações da tarefa só pelo botão direito (`TaskList.tsx`, `TasksView.tsx`). | Precisa de um botão "abrir" e de um menu acessível por teclado em cada linha, o que muda o layout da lista. **Recomendação:** um botão "⋯" visível no foco e no hover, abrindo o mesmo menu. |
| Clicar numa linha da árvore não move o foco para ela (fica no `<body>`), então quem alterna mouse e teclado precisa clicar de novo ou usar Tab. | O campo de renomear fica dentro da linha e não pode perder o foco. Dá para resolver com cuidado. Fica como próximo passo. |
| Abrir uma página leva ~0,6s até o conteúdo aparecer no modo dev, com a área em branco durante a transição. | Medido só no dev server, não no build de produção. **Recomendação:** medir no instalador. Se continuar, mostrar um esqueleto em vez de branco. |
| O chunk `icon-registry` tem ~6MB (1,2MB gzip). | Já é carregado sob demanda, só ao abrir o seletor de ícones. Fica como nota de desempenho. |
| Os rótulos da interface estão em inglês. | Decisão de produto (i18n). Fora do escopo. |

## Como foi validado

- `tsc --noEmit` sem erros e `vite build` de produção OK.
- No app, com o vault de teste:
  - O banco antigo abre, com select colorido e linhas preservadas.
  - Linhas da tabela do editor medidas: 74px → 42px.
  - Contraste medido no tema claro.
  - Placeholder da página vazia.
  - Estatísticas de Tarefas (11 / 9%).
  - Painel direito se recolhendo em 1000px.
  - Tooltip sem deslocar a sidebar (`scrollWidth` = `clientWidth`).
  - Pasta permanece aberta ao ser aberta.
  - Teclado na árvore: setas, Home, ←/→, Enter.
  - Diálogo de exclusão: Tab circula dentro do diálogo e Enter em "Cancel" cancela (com teclas reais).
- **Não validado aqui:** o app desktop Tauri (não houve mudanças em Rust), leitores de tela reais e o build Android.
