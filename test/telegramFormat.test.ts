import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTelegramMarkdown,
  renderTelegramMarkdown,
  splitTelegramHtml,
} from "../src/telegramFormat.ts";

test("renders the supported Markdown subset as Telegram HTML", () => {
  const result = renderTelegramMarkdown(
    "# Status\n\n**Done** with *care* and ~~noise~~.\n\n" +
      "- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n" +
      "[Open](https://example.com?q=1&x=2) and `a < b`.\n\n" +
      "```ts\nconst x = 1 < 2;\n```",
  );

  assert.match(result, /^<b>Status<\/b>/);
  assert.match(result, /<b>Done<\/b> with <i>care<\/i> and <s>noise<\/s>/);
  assert.match(result, /• one\n• two/);
  assert.match(result, /1\. first\n2\. second/);
  assert.match(result, /<blockquote>quoted\n?<\/blockquote>/);
  assert.match(result, /<a href="https:\/\/example\.com\?q=1&amp;x=2">Open<\/a>/);
  assert.match(result, /<code>a &lt; b<\/code>/);
  assert.match(
    result,
    /<pre><code class="language-ts">const x = 1 &lt; 2;\n<\/code><\/pre>/,
  );
});

test("escapes raw HTML instead of accepting agent-supplied tags", () => {
  assert.equal(
    renderTelegramMarkdown("<b>unsafe</b> & ordinary"),
    "&lt;b&gt;unsafe&lt;/b&gt; &amp; ordinary",
  );
});

test("splits by parsed UTF-16 length and keeps formatting valid", () => {
  const chunks = splitTelegramHtml("<b>ab😀cd</b>", 4);
  assert.deepEqual(chunks, ["<b>ab😀</b>", "<b>cd</b>"]);
});

test("does not split HTML entities", () => {
  assert.deepEqual(splitTelegramHtml("a&lt;b", 2), ["a&lt;", "b"]);
});

test("formats long Markdown into independently valid chunks", () => {
  const chunks = formatTelegramMarkdown(`**${"x".repeat(25)}**`, 10);
  assert.deepEqual(chunks, [
    "<b>xxxxxxxxxx</b>",
    "<b>xxxxxxxxxx</b>",
    "<b>xxxxx</b>",
  ]);
});
