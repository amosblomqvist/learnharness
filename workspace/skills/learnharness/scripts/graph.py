#!/usr/bin/env python3
"""Read LearnHarness propositions and recorded reasoning chains, without writes.

These records describe what sources articulated, not mastery or guaranteed truth.
Source file paths are labels only: this script never opens the imported originals.
"""

import sys

sys.dont_write_bytecode = True

import argparse
import json
import re

from _data import DataError, add_common_arguments, data_root, print_json, read_chat, read_json, safe_path


def warn(message):
    print(f"warning: {message}", file=sys.stderr)


def strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def valid_record(value, chain=False):
    if not isinstance(value, dict):
        return False
    fields = ("id", "createdAt", "conclusion") if chain else ("id", "createdAt", "name", "statement")
    if not all(isinstance(value.get(field), str) for field in fields):
        return False
    points = value.get("provenance")
    if not isinstance(points, list) or not all(
        isinstance(point, dict)
        and isinstance(point.get("chatId"), str)
        and isinstance(point.get("messageId"), str)
        for point in points
    ):
        return False
    items = value.get("premises" if chain else "aliases")
    return strings(items) and (not chain or len(items) > 0)


def reject_constant(value):
    raise ValueError(f"Non-JSON numeric constant: {value}")


def read_ledger(root, relative, chain=False):
    path = safe_path(root, relative)
    try:
        with path.open(encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line, parse_constant=reject_constant)
                except ValueError:
                    warn(f"{relative}:{number}: malformed JSON; skipped (results may be incomplete)")
                    continue
                if not valid_record(value, chain):
                    warn(f"{relative}:{number}: invalid record shape; skipped (results may be incomplete)")
                    continue
                yield value
    except FileNotFoundError:
        return
    except (OSError, UnicodeError) as exc:
        raise DataError(f"Cannot read {relative}: {exc}") from exc


def union_points(target, points):
    seen = {(point["chatId"], point["messageId"]) for point in target}
    for point in points:
        key = (point["chatId"], point["messageId"])
        if key not in seen:
            target.append(point)
            seen.add(key)


def load_graph(root):
    """Merge ledger lines using getGraph's first-identity/union semantics."""
    stamp = read_json(root, "graph/format.json", missing=None)
    if stamp is not None:
        version = stamp.get("version") if isinstance(stamp, dict) else None
        if isinstance(version, bool) or not isinstance(version, (int, float)) or version % 1:
            raise DataError("graph/format.json: invalid graph format version")
        if version > 1:
            raise DataError(f"Graph format version {version} is newer than supported version 1; upgrade this skill")
    nodes = {}
    for line in read_ledger(root, "graph/nodes.jsonl"):
        existing = nodes.get(line["id"])
        if existing is None:
            nodes[line["id"]] = {**line, "aliases": list(line["aliases"]), "provenance": list(line["provenance"])}
            continue
        for phrasing in [line["statement"], *line["aliases"]]:
            if phrasing and phrasing not in existing["aliases"]:
                existing["aliases"].append(phrasing)
        union_points(existing["provenance"], line["provenance"])
    chains = {}
    for line in read_ledger(root, "graph/chains.jsonl", chain=True):
        key = "+".join(sorted(line["premises"])) + ">" + line["conclusion"]
        existing = chains.get(key)
        if existing is None:
            chains[key] = {**line, "premises": list(line["premises"]), "provenance": list(line["provenance"])}
        else:
            union_points(existing["provenance"], line["provenance"])
    return {"nodes": list(nodes.values()), "chains": list(chains.values())}


def birth_session(node):
    return node["provenance"][0]["chatId"] if node["provenance"] else None


def load_metadata(root):
    """Read only stored metadata, never the filePath references in sources."""
    sources = read_json(root, "graph/sources.json", missing={})
    if not isinstance(sources, dict):
        raise DataError("graph/sources.json: expected an object keyed by source id")
    metadata = {}
    for source in sources.values():
        if not isinstance(source, dict) or not all(isinstance(source.get(key), str) for key in ("id", "filePath", "importedAt")):
            warn("graph/sources.json: invalid source metadata; skipped (labels may be incomplete)")
            continue
        metadata[source["id"]] = {
            "id": source["id"], "name": source["filePath"], "kind": "file",
            "createdAt": source["importedAt"], "updatedAt": source["importedAt"],
        }
    chats = safe_path(root, "chats")
    if chats.exists():
        for path in sorted(chats.glob("*.json")):
            try:
                chat = read_chat(root, path.stem)
            except DataError as exc:
                warn(f"chats/{path.name}: {exc}; skipped (labels may be incomplete)")
                continue
            metadata[chat["id"]] = {
                "id": chat["id"], "name": chat["title"], "kind": "chat",
                "createdAt": chat["createdAt"], "updatedAt": chat["updatedAt"],
            }
    return metadata


def session_index(graph, metadata):
    counts = {}
    for node in graph["nodes"]:
        session = birth_session(node)
        if session is not None:
            counts[session] = counts.get(session, 0) + 1
    entries = []
    for session, count in counts.items():
        entry = metadata.get(session, {"id": session, "name": session, "kind": "file", "createdAt": None, "updatedAt": None})
        entries.append({**entry, "propositions": count})
    # Stable sorts preserve ascending ids when both descending timestamps tie.
    entries.sort(key=lambda item: item["id"])
    entries.sort(key=lambda item: item["createdAt"] or "", reverse=True)
    entries.sort(key=lambda item: item["updatedAt"] or "", reverse=True)
    return entries


def search_case(text):
    """Match the app's non-Unicode JS /i casing, not Python's broader /i.

    JS uppercases one UTF-16 unit, but keeps multi-character expansions and
    non-ASCII-to-ASCII mappings unchanged (e.g. ſ must not match s).
    """
    def canonical(char):
        upper = char.upper()
        if ord(char) > 0xFFFF or len(upper) != 1 or (ord(char) >= 128 and ord(upper) < 128):
            return char
        return upper
    return "".join(canonical(char) for char in text)


def select_nodes(graph, session=None, query=None):
    nodes = graph["nodes"]
    if session is not None:
        nodes = [node for node in nodes if birth_session(node) == session]
    if query is not None:
        # The app's find tool treats only '*' specially; all other punctuation
        # is literal. Without a star, matching is a case-insensitive substring.
        pattern = search_case(query if "*" in query else f"*{query}*")
        matcher = re.compile(".*".join(re.escape(part) for part in pattern.split("*")), re.DOTALL)
        return [node for node in nodes if any(
            matcher.fullmatch(search_case(text)) for text in [node["name"], node["statement"], *node["aliases"]]
        )]
    return sorted(nodes, key=lambda node: node["id"])


def provenance_markdown(points, metadata):
    if not points:
        print("- Provenance: none recorded (no birth session)")
        return
    print("- Provenance (first point is birth):")
    for point in points:
        session = point["chatId"]
        meta = metadata.get(session)
        label = f" — {meta['name']} ({meta['kind']})" if meta else ""
        message = point["messageId"] or "(session-level)"
        print(f"  - {session}{label}; message: {message}")


def node_markdown(node, metadata, heading="###"):
    print(f"{heading} {node['name']} (`{node['id']}`)\n")
    print(node["statement"])
    print(f"\n- Created: {node['createdAt']}")
    print("- Aliases:" if node["aliases"] else "- Aliases: none")
    for alias in node["aliases"]:
        print(f"  - {alias}")
    provenance_markdown(node["provenance"], metadata)
    print()


def print_markdown(command, result, graph, metadata, root):
    print(f"# {command.capitalize()}\n")
    print(f"Data directory: {root}\n")
    print("Recorded propositions and reasoning, not mastery or guaranteed truth.\n")
    if not result:
        print("No matching records.")
    elif command == "sessions":
        for session in result:
            print(f"## {session['name']} (`{session['id']}`)\n")
            print(f"- Kind: {session['kind']}\n- Birth propositions: {session['propositions']}")
            print(f"- Created: {session['createdAt'] or 'unknown'}\n- Updated: {session['updatedAt'] or 'unknown'}\n")
    elif command == "chains":
        nodes = {node["id"]: node for node in graph["nodes"]}
        for chain in result:
            print(f"## Chain `{chain['id']}`\n")
            print(f"Premises: {', '.join(chain['premises'])} → Conclusion: {chain['conclusion']}\n")
            print(f"- Created: {chain['createdAt']}")
            provenance_markdown(chain["provenance"], metadata)
            print()
            for role, node_id in [("Premise", node_id) for node_id in chain["premises"]] + [("Conclusion", chain["conclusion"])]:
                if node_id in nodes:
                    print(f"### {role}\n")
                    node_markdown(nodes[node_id], metadata, heading="####")
                else:
                    print(f"### {role}: `{node_id}` (missing proposition)\n")
    else:
        for node in result:
            node_markdown(node, metadata)


def nonempty(value):
    if value == "":
        raise argparse.ArgumentTypeError("must not be empty")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    add_common_arguments(parser)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sessions", help="List birth sessions, most recently active first")
    propositions = commands.add_parser("propositions", help="Read full propositions; optionally filter by birth session")
    propositions.add_argument("--session", metavar="ID", type=nonempty)
    find = commands.add_parser("find", help="Case-insensitive search of names, statements and aliases; '*' is a wildcard")
    find.add_argument("query", metavar="QUERY", type=nonempty)
    chains = commands.add_parser("chains", help="Read recorded reasoning chains, optionally involving one node")
    chains.add_argument("--node", metavar="ID", type=nonempty)
    args = parser.parse_args(argv)
    try:
        root = data_root(args.data_dir)
        graph = load_graph(root)
        metadata = load_metadata(root) if args.command == "sessions" or args.format == "markdown" else {}
        if args.command == "sessions":
            result = session_index(graph, metadata)
        elif args.command in ("propositions", "find"):
            result = select_nodes(graph, getattr(args, "session", None), getattr(args, "query", None))
        else:
            result = [chain for chain in graph["chains"] if args.node is None or args.node == chain["conclusion"] or args.node in chain["premises"]]
        if args.format == "json":
            print_json({"data_dir": str(root), "records": result})
        else:
            print_markdown(args.command, result, graph, metadata, root)
        return 0
    except (DataError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
