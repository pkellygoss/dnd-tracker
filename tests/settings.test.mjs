// Settings: validation, API key handling and backup exclusion.
import { blockedCalls } from "./no-network.mjs";
import "fake-indexeddb/auto";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../js/db.js";
import * as S from "../js/settings.js";
import { exportBackup, importBackup, readBackup } from "../js/backup.js";
import { handleApi } from "../js/api.js";
import { ActionError } from "../js/actions.js";

const KEY = "abcd1234efgh5678ijkl9012mnop3456";
let n = 0;
const freshDb = () => openDB(`settings-${++n}-${Math.random()}`);

after(() => assert.deepEqual(blockedCalls, [], "no test may make a real network call"));

test("defaults are returned until something is saved", async () => {
  const s = await S.getSettings(await freshDb());
  assert.equal(s.azure_deployment, "gpt-image-2.5-sunburst");
  assert.equal(s.azure_api_version, "2025-04-01-preview");
  assert.equal(s.has_api_key, false);
  assert.equal(s.api_key_hint, "");
});

test("saving validates, normalises the endpoint, and empty values reset to defaults", async () => {
  const db = await freshDb();
  const r = await S.saveSettings(db, {
    azure_endpoint: " https://other.cognitiveservices.azure.com/openai/deployments/x/images/generations?api-version=1 ",
    azure_deployment: "my-deploy_2", junk: "ignored",
  });
  assert.equal(r.settings.azure_endpoint, "https://other.cognitiveservices.azure.com");
  assert.equal(r.settings.azure_deployment, "my-deploy_2");
  assert.equal(r.settings.junk, undefined);

  await assert.rejects(S.saveSettings(db, { azure_endpoint: "http://insecure.example" }), /https/);
  await assert.rejects(S.saveSettings(db, { azure_endpoint: "not a url" }), ActionError);
  await assert.rejects(S.saveSettings(db, { azure_deployment: "has spaces/slash" }), /Deployment/);
  await assert.rejects(S.saveSettings(db, { azure_api_version: "yesterday" }), /API version/);
  assert.equal((await S.getSettings(db)).azure_deployment, "my-deploy_2", "a rejected save changes nothing");

  await S.saveSettings(db, { azure_endpoint: "", azure_deployment: "" });
  const s = await S.getSettings(db);
  assert.equal(s.azure_endpoint, S.DEFAULT_SETTINGS.azure_endpoint);
  assert.equal(s.azure_deployment, S.DEFAULT_SETTINGS.azure_deployment);
});

test("the API key is stored, only ever exposed as a 4-character hint, and can be removed", async () => {
  const db = await freshDb();
  await assert.rejects(S.setApiKey(db, "   "), /Paste a key/);
  await assert.rejects(S.setApiKey(db, "short"), /doesn't look like/);
  const r = await S.setApiKey(db, `  ${KEY}  `);
  assert.equal(r.settings.has_api_key, true);
  assert.equal(r.settings.api_key_hint, "…3456");
  assert.ok(!JSON.stringify(r).includes(KEY), "the key itself must never be returned to the page");
  assert.equal(await S.getApiKey(db), KEY);

  const viaApi = await handleApi(db, "GET", "/api/settings", null);
  assert.ok(!JSON.stringify(viaApi).includes(KEY), "nor through the local API");

  await S.clearApiKey(db);
  assert.equal((await S.getSettings(db)).has_api_key, false);
  assert.equal(await S.getApiKey(db), null);
});

test("backups never contain the API key, and importing one leaves this device's key in place", async () => {
  const db = await freshDb();
  await db.saveCharacter("c", { name: "Lawine", notes: "has a key" });
  await S.setApiKey(db, KEY);
  await S.saveSettings(db, { azure_deployment: "custom-deploy" });

  const { blob } = await exportBackup(db);
  const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  assert.ok(!raw.includes(KEY), "key must not appear anywhere in the zip bytes");
  const payload = await readBackup(blob);
  assert.ok(!JSON.stringify(payload).includes(KEY), "key must not appear in data.json");
  assert.ok(!JSON.stringify(payload).includes("secret:"), "no secret meta records at all");

  const other = await freshDb();
  await S.setApiKey(other, "zzzz9999yyyy8888xxxx7777wwww6666");
  await importBackup(other, blob);
  assert.equal(await S.getApiKey(other), "zzzz9999yyyy8888xxxx7777wwww6666", "import must not touch the device's key");
  assert.equal((await other.getCharacter("c")).name, "Lawine");
});

test("settings routes through the local API shim", async () => {
  const db = await freshDb();
  let r = await handleApi(db, "POST", "/api/settings/update", { azure_api_version: "2025-04-01-preview" });
  assert.equal(r.status, 200);
  r = await handleApi(db, "POST", "/api/settings/key", { key: "x" });
  assert.equal(r.status, 400);
  r = await handleApi(db, "POST", "/api/settings/key", { key: KEY });
  assert.equal(r.body.settings.has_api_key, true);
  r = await handleApi(db, "POST", "/api/settings/key/delete", null);
  assert.equal(r.body.settings.has_api_key, false);
});
