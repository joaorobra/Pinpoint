"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/markdown.ts
var markdown_exports = {};
__export(markdown_exports, {
  docToMarkdown: () => docToMarkdown,
  markdownToHtml: () => markdownToHtml
});
module.exports = __toCommonJS(markdown_exports);
function applyMarks(text, marks) {
  if (!marks) return text;
  let out = text;
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        out = `**${out}**`;
        break;
      case "italic":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link":
        out = `[${out}](${m.attrs?.href ?? ""})`;
        break;
    }
  }
  return out;
}
function inline(nodes) {
  if (!nodes) return "";
  return nodes.map((n) => {
    if (n.type === "text") return applyMarks(n.text ?? "", n.marks);
    if (n.type === "hardBreak") return "\n";
    if (n.type === "image") return `![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})`;
    if (n.type === "wikiLink") return `[[${n.attrs?.name ?? ""}]]`;
    return inline(n.content);
  }).join("");
}
function listToMd(node, ordered, depth) {
  const indent = "  ".repeat(depth);
  const lines = [];
  (node.content ?? []).forEach((item, i) => {
    const checked = item.attrs?.checked;
    const marker = ordered ? `${i + 1}.` : "-";
    const box = item.type === "taskItem" ? checked ? "[x] " : "[ ] " : "";
    const para = item.content?.[0];
    const firstLine = inline(para?.content);
    lines.push(`${indent}${marker} ${box}${firstLine}`);
    (item.content ?? []).slice(1).forEach((child) => {
      if (child.type === "bulletList") lines.push(listToMd(child, false, depth + 1));
      else if (child.type === "orderedList") lines.push(listToMd(child, true, depth + 1));
      else if (child.type === "taskList") lines.push(listToMd(child, false, depth + 1));
      else if (child.type === "paragraph") lines.push(`${indent}  ${inline(child.content)}`);
    });
  });
  return lines.join("\n");
}
function tableToMd(node) {
  const rows = node.content ?? [];
  const lines = [];
  rows.forEach((row, ri) => {
    const cells = (row.content ?? []).map((c) => inline(c.content?.[0]?.content).trim());
    lines.push(`| ${cells.join(" | ")} |`);
    if (ri === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  });
  return lines.join("\n");
}
function docToMarkdown(doc) {
  const blocks = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "heading":
        blocks.push(`${"#".repeat(node.attrs?.level ?? 1)} ${inline(node.content)}`);
        break;
      case "paragraph":
        blocks.push(inline(node.content));
        break;
      case "bulletList":
        blocks.push(listToMd(node, false, 0));
        break;
      case "orderedList":
        blocks.push(listToMd(node, true, 0));
        break;
      case "taskList":
        blocks.push(listToMd(node, false, 0));
        break;
      case "blockquote":
        blocks.push(
          (node.content ?? []).map((c) => `> ${inline(c.content)}`).join("\n")
        );
        break;
      case "codeBlock":
        blocks.push("```" + (node.attrs?.language ?? "") + "\n" + (node.content?.[0]?.text ?? "") + "\n```");
        break;
      case "queryBlock":
        blocks.push("```query\n" + (node.attrs?.dsl ?? "") + "\n```");
        break;
      case "horizontalRule":
        blocks.push("---");
        break;
      case "table":
        blocks.push(tableToMd(node));
        break;
      default:
        blocks.push(inline(node.content));
    }
  }
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, name) => {
    const n = String(name).trim();
    return `<span data-page-link="${n.replace(/"/g, "&quot;")}">${n}</span>`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s;
}
function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  const LIST_RE = /^(\s*)(?:([-*])|(\d+)\.)\s(\[[ xX]\]\s?)?(.*)$/;
  const parseListLine = (line) => {
    const m = line.match(LIST_RE);
    if (!m) return null;
    const [, indentStr, bullet, , box, rest] = m;
    const task = !!box;
    return {
      indent: indentStr.replace(/\t/g, "  ").length,
      ordered: !bullet,
      // numbered when there was no `-`/`*` marker
      task,
      checked: task ? /\[x\]/i.test(box) : false,
      text: rest
    };
  };
  const renderList = (block) => {
    const out = [];
    let k = 0;
    while (k < block.length) {
      const baseIndent = block[k].indent;
      const task = block[k].task;
      const ordered = block[k].ordered;
      const tag = task ? `<ul data-type="taskList">` : ordered ? "<ol>" : "<ul>";
      out.push(tag);
      while (k < block.length && block[k].indent === baseIndent && block[k].task === task && block[k].ordered === ordered) {
        const it = block[k++];
        const children = [];
        while (k < block.length && block[k].indent > baseIndent) children.push(block[k++]);
        const childHtml = children.length ? renderList(children) : "";
        if (task) {
          out.push(
            `<li data-type="taskItem" data-checked="${it.checked}"><label><input type="checkbox"${it.checked ? " checked" : ""}><span></span></label><div><p>${inlineMd(it.text)}</p>${childHtml}</div></li>`
          );
        } else {
          out.push(`<li><p>${inlineMd(it.text)}</p>${childHtml}</li>`);
        }
      }
      out.push(task ? "</ul>" : ordered ? "</ol>" : "</ul>");
    }
    return out.join("\n");
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      html.push(`<h${level}>${inlineMd(line.replace(/^#+\s/, ""))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      if (lang.toLowerCase() === "query") {
        const dsl = code.join(" ").trim();
        html.push(`<div data-query="${dsl.replace(/"/g, "&quot;")}"></div>`);
      } else {
        html.push(
          `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`
        );
      }
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote><p>${inlineMd(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
      const parseRow = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /^\|/.test(lines[i])) bodyRows.push(parseRow(lines[i++]));
      html.push("<table><tbody>");
      html.push("<tr>" + header.map((h) => `<th><p>${inlineMd(h)}</p></th>`).join("") + "</tr>");
      for (const r of bodyRows)
        html.push("<tr>" + r.map((c) => `<td><p>${inlineMd(c)}</p></td>`).join("") + "</tr>");
      html.push("</tbody></table>");
      continue;
    }
    if (parseListLine(line)) {
      const block = [];
      let parsed;
      while (i < lines.length && (parsed = parseListLine(lines[i]))) {
        block.push(parsed);
        i++;
      }
      html.push(renderList(block));
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inlineMd(para.join(" "))}</p>`);
  }
  return html.join("\n");
}
