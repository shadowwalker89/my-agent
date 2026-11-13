// Phase 3-A: Telegram's HTML parse mode. Escape everything first, then
// apply the small markdown subset we emit (fenced/inline code, bold,
// strikethrough). Anything else stays literal, so a model answer can
// never inject tags.
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Only these tags are allowed through untouched. Everything else is
// escaped, so a model answer can never inject arbitrary HTML.
const SAFE_TAG_RE = /<\/?(?:b|strong|i|em|u|s|code|pre|blockquote)>|<a\s+href="[^"]*"\s*>|<\/a>/gi;

function splitTableCells(line) {
  return String(line ?? "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function cleanTableHeader(cell) {
  return String(cell ?? "").replace(/\*\*/g, "").replace(/~~/g, "").replace(/`/g, "").trim();
}

// Mobile-friendly cards instead of broken ASCII pipes: every data row
// becomes one "▫️ header: value • header: value" bullet.
function renderMarkdownTables(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const block = [];
    let j = i;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    const sepIdx = block.findIndex((line, idx) => idx > 0 && splitTableCells(line).every((cell) => /^:?-{2,}:?$/.test(cell)));
    if (sepIdx < 1) {
      out.push(...block);
      i = j - 1;
      continue;
    }
    const header = splitTableCells(block[sepIdx - 1]);
    const rows = block.slice(sepIdx + 1);
    if (!rows.length) {
      out.push(...block.filter((_, idx) => idx !== sepIdx));
      i = j - 1;
      continue;
    }
    for (const row of rows) {
      const cells = splitTableCells(row);
      const parts = [];
      for (let k = 0; k < Math.max(header.length, cells.length); k++) {
        const label = cleanTableHeader(header[k]);
        const value = cells[k] ?? "";
        if (!label && !value) continue;
        parts.push(label ? `<b>${label}:</b> ${value}` : value);
      }
      if (parts.length) out.push(`▫️ ${parts.join("  •  ")}`);
    }
    i = j - 1;
  }
  return out.join("\n");
}

// Plain-text fallback: Telegram rejected our HTML (e.g. a malformed
// entity), so drop markup symbols instead of showing them literally.
export function stripTelegramMarkup(text) {
  return String(text ?? "")
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,4}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:---|___|\*\*\*)[ \t]*$/gm, "───────────────")
    .replace(/^[ \t]*[-*]\s+/gm, "• ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

export function formatTelegramHtml(text) {
  const src = String(text ?? "");
  const blocks = [];
  const tags = [];
  let s = src.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, info, code) => {
    const body = escapeHtml(code.replace(/\n$/, ""));
    // A language-tagged fence keeps the historical <pre> shape; a bare
    // fence gets the richer <pre><code> wrapper.
    const rendered = String(info).trim() ? `<pre>${body}</pre>` : `<pre><code>${body}</code></pre>`;
    const i = blocks.push(rendered) - 1;
    return `\u0000B${i}\u0000`;
  });
  // Stash already-safe HTML before escaping so <b>...</b> stays bold
  // instead of printing literally (and is never double-escaped).
  s = s.replace(SAFE_TAG_RE, (tag) => {
    const i = tags.push(tag) - 1;
    return `\u0000T${i}\u0000`;
  });
  s = escapeHtml(s);
  s = renderMarkdownTables(s);
  s = s.replace(/^#{1,4}[ \t]+(.+)$/gm, "\n📌 <b>$1</b>");
  s = s.replace(/^[ \t]*(?:---|___|\*\*\*)[ \t]*$/gm, "───────────────");
  s = s.replace(/^[ \t]*[-*]\s+(.+)$/gm, "• $1");
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/\u0000T(\d+)\u0000/g, (_, i) => tags[Number(i)] ?? "");
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? "");
  return s;
}

// Phase 1-e Pillar 1: zero-drop progress feedback. Telegram caps a
// message at 4096 chars. Phase 2-d: chunks split on newline or space
// boundaries whenever possible within maxLen, so a multi-chunk answer
// never cuts a Persian word in half; only a single contiguous token
// longer than maxLen is hard-sliced at maxLen.
export function splitTelegramText(text, maxLen = 4096) {
  const s = String(text ?? "");
  const limit = Math.max(1, Math.floor(maxLen) || 4096);
  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a newline break (drop the newline itself); else the last
    // space in the window (drop one space); else a hard slice.
    const nl = window.lastIndexOf("\n");
    if (nl > 0) {
      chunks.push(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      continue;
    }
    const sp = window.lastIndexOf(" ");
    if (sp > 0) {
      chunks.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
      continue;
    }
    chunks.push(window);
    rest = rest.slice(limit);
  }
  chunks.push(rest);
  return chunks.length ? chunks : [""];
}

export function normalizeReply(input) {
  const { text, buttons = [], files = [], edit_message_id = null } = typeof input === "string" ? { text: input } : (input ?? {});
  return {
    text: String(text ?? ""),
    buttons: Array.isArray(buttons) ? buttons : [],
    files: Array.isArray(files) ? files : [],
    edit_message_id: edit_message_id ?? null,
  };
}
