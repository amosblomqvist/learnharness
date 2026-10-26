// Tool names as people read them: "pycharm__replace_text_in_file" → Edit · PyCharm.
// Shared by the window (tool rows) and the IDE agent (tool titles in the IDE's chat).
const IDE_NAMES: Record<string, string> = { pycharm: "PyCharm", webstorm: "WebStorm", idea: "IntelliJ", brave: "Brave" }

export function describeTool(name: string): { server: string; verb: string } {
  const n = name.replace(/^mcp__/, "")
  const [server, tool] = n.includes("__") ? n.split("__") : ["", n]
  const t = (tool ?? n).replace(/^brave_/, "")
  const verbs: Record<string, string> = {
    Read: "Read",
    Glob: "Find files",
    Grep: "Search",
    Edit: "Edit",
    MultiEdit: "Edit",
    Write: "Write",
    WebSearch: "Web search",
    WebFetch: "Fetch",
    read_file: "Read",
    get_file_text_by_path: "Read",
    list_files: "List",
    list_directory_tree: "List",
    search_text: "Search",
    search_in_files_by_text: "Search",
    search_in_files_by_regex: "Search",
    search_symbol: "Find symbol",
    get_symbol_info: "Symbol info",
    get_file_problems: "Check problems",
    get_all_open_file_paths: "Open editors",
    open_file_in_editor: "Open in editor",
    replace_text_in_file: "Edit",
    apply_patch: "Patch",
    create_new_file: "Create",
    reformat_file: "Reformat",
    rename_refactoring: "Rename",
    edit_file: "Edit",
    write_file: "Write",
    fetch_url: "Fetch",
    search_replace: "Edit",
    grep: "Search",
    glob: "Find files",
    list_dir: "List",
    web_fetch: "Fetch",
    web_search: "Web search",
    news_search: "News search",
    llm_context: "Web context",
    Agent: "Research",
    research: "Research",
    render_diagram: "Check diagram"
  }
  return { server: IDE_NAMES[server] ?? server, verb: verbs[t] ?? t.replace(/_/g, " ") }
}

