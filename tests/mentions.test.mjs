// @-mention parsing/suggestion logic (pure functions; the DOM parts are covered by the browser smoke test).
import "./no-network.mjs"; // tests must never reach a real service
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentions, mentionedNames, findMentionQuery, suggest, insertMention, noteIndex } from "../js/mentions.js";

test("parseMentions splits text and mentions, including names with spaces and commas", () => {
  const t = "Met @[Heftklammer, Graf von Schreiberei] at @[Divan].\nThen left.";
  assert.deepEqual(parseMentions(t), [
    { type: "text", value: "Met " },
    { type: "mention", name: "Heftklammer, Graf von Schreiberei", raw: "@[Heftklammer, Graf von Schreiberei]" },
    { type: "text", value: " at " },
    { type: "mention", name: "Divan", raw: "@[Divan]" },
    { type: "text", value: ".\nThen left." },
  ]);
  assert.deepEqual(parseMentions(""), []);
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions("no mentions, just an email a@b.com and @plain"), [
    { type: "text", value: "no mentions, just an email a@b.com and @plain" }]);
  assert.deepEqual(parseMentions("@[]").map((t) => t.type), ["text"], "empty brackets are not a mention");
  assert.deepEqual(parseMentions("@[broken\nacross lines]").map((t) => t.type), ["text"]);
});

test("mentionedNames de-duplicates case-insensitively, keeping first spelling and order", () => {
  assert.deepEqual(mentionedNames("@[Divan] and @[divan] and @[Elspeth] and @[Divan]"), ["Divan", "Elspeth"]);
});

test("findMentionQuery: only triggers on a real @ being typed", () => {
  const at = (text) => findMentionQuery(text, text.length);
  assert.deepEqual(at("@"), { start: 0, query: "" });
  assert.deepEqual(at("We met @Div"), { start: 7, query: "Div" });
  assert.deepEqual(at("We met @Graf von S"), { start: 7, query: "Graf von S" }, "spaces allowed in the query");
  assert.deepEqual(at("(@El"), { start: 1, query: "El" });
  assert.deepEqual(at("typed @[Hef"), { start: 6, query: "Hef" }, "a manually typed bracket is ignored");
  assert.equal(at("mail me@home"), null, "an @ inside a word (emails) doesn't trigger");
  assert.equal(at("@[Divan] then"), null, "after a completed mention");
  assert.equal(at("@Div\nnext line"), null, "queries don't cross lines");
  assert.equal(at("no at sign here"), null);
  assert.equal(at("@" + "x".repeat(80)), null, "very long runs aren't treated as a query");
  assert.deepEqual(findMentionQuery("a @Div b", 6), { start: 2, query: "Div" }, "works with the caret mid-text");
});

test("suggest: prefix matches first, then substring; drops names that can't be mentioned", () => {
  const names = ["Divan", "Elspeth", "Cult of Ruhak Khan", "Ruhak", "Bad]Name", "Gem of Protection", "Divan"];
  assert.deepEqual(suggest(names, "ruh"), ["Ruhak", "Cult of Ruhak Khan"]);
  assert.deepEqual(suggest(names, "of"), ["Cult of Ruhak Khan", "Gem of Protection"]);
  assert.deepEqual(suggest(names, ""), ["Cult of Ruhak Khan", "Divan", "Elspeth", "Gem of Protection", "Ruhak"], "empty query lists everything (no duplicates)");
  assert.ok(!suggest(names, "bad").includes("Bad]Name"));
  assert.equal(suggest(Array.from({ length: 20 }, (_, i) => `N${i}`), "n").length, 8);
});

test("insertMention replaces the typed @query and puts the caret after it", () => {
  assert.deepEqual(insertMention("We met @Div at noon", 7, 11, "Divan"), { text: "We met @[Divan] at noon", caret: 15 },
    "no double space when whitespace already follows");
  assert.deepEqual(insertMention("We met @Div", 7, 11, "Divan"), { text: "We met @[Divan] ", caret: 16 });
  assert.deepEqual(insertMention("@[Hef", 0, 5, "Heftklammer, Graf von Schreiberei"),
    { text: "@[Heftklammer, Graf von Schreiberei] ", caret: 37 });
  assert.equal(insertMention("@[Hef]", 0, 5, "Heftklammer").text, "@[Heftklammer] ", "no doubled bracket");
});

test("noteIndex links names case-insensitively; first note wins on a duplicate name", () => {
  const idx = noteIndex([{ id: "a", name: "Divan" }, { id: "b", name: " divan " }, { id: "c", name: "" }, { id: "d" }]);
  assert.deepEqual(idx, { divan: "a" });
});
