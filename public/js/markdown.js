/* =================== markdown =================== */
function renderMarkdown(src) {
  const raw = String(src || "");
  // Escape first, then apply light markdown on the escaped text.
  let text = esc(raw);
  const blocks = [];
  // fenced code
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    const i = blocks.length;
    blocks.push("<pre><code>" + code.replace(/^\n/, "") + "</code></pre>");
    return "\u0000B" + i + "\u0000";
  });
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let listType = null; // ul | ol
  function closeList() {
    if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; }
  }
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\u0000B(\d+)\u0000$/);
    if (fence) {
      closeList();
      out.push(blocks[Number(fence[1])]);
      i++;
      continue;
    }
    if (/^### /.test(line)) { closeList(); out.push("<h3>" + inlineMd(line.slice(4)) + "</h3>"); i++; continue; }
    if (/^## /.test(line)) { closeList(); out.push("<h2>" + inlineMd(line.slice(3)) + "</h2>"); i++; continue; }
    if (/^# /.test(line)) { closeList(); out.push("<h1>" + inlineMd(line.slice(2)) + "</h1>"); i++; continue; }
    const ul = line.match(/^[-*] (.+)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push("<li>" + inlineMd(ul[1]) + "</li>");
      i++; continue;
    }
    const ol = line.match(/^\d+\. (.+)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push("<li>" + inlineMd(ol[1]) + "</li>");
      i++; continue;
    }
    // table rows (optional)
    if (/^\|/.test(line) && line.endsWith("|")) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (!/^[-:| ]+$/.test(cells.join(""))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        let html = "<table style='border-collapse:collapse;width:100%;font-size:12.5px;margin:10px 0'>";
        rows.forEach((cells, ri) => {
          const tag = ri === 0 ? "th" : "td";
          html += "<tr>" + cells.map((c) => "<" + tag + " style='border:1px solid var(--border-subtle);padding:4px 8px;text-align:left'>" + inlineMd(c) + "</" + tag + ">").join("") + "</tr>";
        });
        html += "</table>";
        out.push(html);
      }
      continue;
    }
    if (line.trim() === "") { closeList(); out.push(""); i++; continue; }
    closeList();
    out.push("<p>" + inlineMd(line) + "</p>");
    i++;
  }
  closeList();
  return out.join("\n");
}
function isSafeMdHref(href) {
  // href may still contain HTML entities from esc(); decode the common ones for scheme checks.
  const u = String(href || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"');
  // Refuse any scheme that is not http/https (blocks javascript:, data:, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:/i.test(u)) return false;
  return true;
}
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => {
      if (!isSafeMdHref(u)) return t; // plain text when scheme is unsafe
      return '<a class="tlink" href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
}
