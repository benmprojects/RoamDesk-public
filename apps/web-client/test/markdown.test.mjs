import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, inline, plain } from "../js/markdown.js";

const kinds = (blocks) => blocks.map((b) => b.t);

test("headings, paragraphs, rules and code blocks", () => {
  const b = parse("# Title\n\nSome **bold** text.\n\n---\n\n```powershell\nGet-Item x\n  indented\n```\nAfter");
  assert.deepEqual(kinds(b), ["h", "p", "hr", "code", "p"]);
  assert.equal(b[0].level, 1);
  assert.equal(b[3].lang, "powershell");
  assert.equal(b[3].text, "Get-Item x\n  indented");
});

test("an unclosed code block runs to the end instead of swallowing nothing", () => {
  const b = parse("```\nline 1\nline 2");
  assert.deepEqual(kinds(b), ["code"]);
  assert.equal(b[0].text, "line 1\nline 2");
});

test("bullet and numbered lists, including nested items and lazy continuation", () => {
  const b = parse("Steps:\n1. First\n2. Second\n   - nested a\n   - nested b\n3. Third\ncontinues\n\n- other");
  assert.deepEqual(kinds(b), ["p", "list", "list"]);
  const ol = b[1];
  assert.equal(ol.ordered, true);
  assert.equal(ol.items.length, 3);
  assert.deepEqual(kinds(ol.items[1]), ["p", "list"]);
  assert.equal(ol.items[1][1].items.length, 2);
  assert.equal(plain(ol.items[2][0].inl), "Third\ncontinues");
  assert.equal(b[2].ordered, false);
});

test("a numbered list can start anywhere", () => {
  assert.equal(parse("3. three\n4. four")[0].start, 3);
});

test("tables with alignment and pipes inside code", () => {
  const b = parse("| Tool | What |\n|:--|--:|\n| `a|b` | x |\n| c | **y** |");
  assert.deepEqual(kinds(b), ["table"]);
  assert.deepEqual(b[0].align, ["left", "right"]);
  assert.equal(b[0].rows.length, 2);
  assert.equal(b[0].rows[0][0][0].t, "code");
  assert.equal(b[0].rows[0][0][0].v, "a|b");
});

test("quotes contain blocks", () => {
  const b = parse("> quoted **text**\n> - item");
  assert.deepEqual(kinds(b), ["quote"]);
  assert.deepEqual(kinds(b[0].blocks), ["p", "list"]);
});

test("inline: code, bold, italic, strike, links and line breaks", () => {
  const n = inline("Run `npm test` then **check** the *result* and ~~old~~ [docs](https://example.com/a).\nNext line");
  assert.deepEqual(n.map((x) => x.t), ["text", "code", "text", "b", "text", "i", "text", "s", "text", "a", "text", "br", "text"]);
  assert.equal(n[9].href, "https://example.com/a");
});

test("snake_case names aren't italicised", () => {
  const n = inline("call send_file and ask_user now");
  assert.deepEqual(n.map((x) => x.t), ["text"]);
});

test("unsafe link targets become plain text", () => {
  const n = inline("[click](javascript:alert(1)) and [x](data:text/html,hi)");
  assert.ok(n.every((x) => x.t !== "a"));
  assert.equal(plain(n), "click) and x");
});

test("bare addresses become links without trailing punctuation", () => {
  const n = inline("See https://example.com/path. Or (https://example.com/x).");
  const links = n.filter((x) => x.t === "a").map((x) => x.href);
  assert.deepEqual(links, ["https://example.com/path", "https://example.com/x"]);
});

test("escapes and unmatched markers stay as text", () => {
  assert.equal(plain(inline("2 \\* 3 * 4 and a lone ` tick")), "2 * 3 * 4 and a lone ` tick");
});

test("never loops forever on odd input", () => {
  for (const s of ["|", "| a |\n", "-", "1.", "```", "> ", "[", "**", "* ", "~~", "a\n\n\n", "|---|", "- \n  "]) parse(s);
});
