// Render a small Markdown subset as DOM nodes. Raw HTML and external content stay text.
function appendInline(parent, text) {
  const pieces = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(pieces)) {
    parent.append(text.slice(offset, match.index));
    const part = match[0];
    if (part.startsWith("[")) {
      // Display the destination as text to avoid leaking the local origin.
      const split = part.lastIndexOf("](");
      parent.append(part.slice(1, split) + " (" + part.slice(split + 2));
    } else {
      const tag = part.startsWith("`") ? "code" : part.startsWith("**") ? "strong" : "em";
      const width = tag === "strong" ? 2 : 1;
      const node = document.createElement(tag);
      node.textContent = part.slice(width, -width);
      parent.append(node);
    }
    offset = match.index + part.length;
  }
  parent.append(text.slice(offset));
}

export function markdown(text) {
  const container = document.createElement("div");
  container.className = "markdown";
  const lines = String(text).replaceAll("\r\n", "\n").split("\n");
  let paragraph = [], code = null, list = null;
  const flush = () => {
    if (!paragraph.length) return;
    const block = document.createElement("p");
    appendInline(block, paragraph.join("\n"));
    container.append(block);
    paragraph = [];
  };
  const emitCode = () => {
    const pre = document.createElement("pre"), value = document.createElement("code");
    value.textContent = code.join("\n");
    pre.append(value);
    container.append(pre);
    code = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^\s*```\s*$/.test(line)) emitCode();
      else code.push(line);
      continue;
    }
    const heading = /^(#{1,6}) +(.+)$/.exec(line);
    const bullet = /^(?:[-*+] |(\d+)\. )(.+)$/.exec(line);
    if (!bullet) list = null;
    if (/^\s*```/.test(line)) {
      flush();
      code = [];
    } else if (heading) {
      flush();
      const node = document.createElement("h" + Math.min(6, heading[1].length + 2));
      appendInline(node, heading[2]);
      container.append(node);
    } else if (bullet) {
      flush();
      const tag = bullet[1] ? "OL" : "UL";
      if (list?.tagName !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement("li");
      appendInline(item, bullet[2]);
      list.append(item);
    } else if (line.trim()) {
      paragraph.push(line);
    } else flush();
  }
  if (code !== null) emitCode();
  flush();
  return container;
}
