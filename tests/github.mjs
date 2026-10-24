import "./local-only.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

const url = process.env.RIGEL_URL || "http://localhost:4321/rigel/";
const blueprint = await (await fetch(new URL("/rigel/manifest.json", url))).json();
const settingsType = blueprint.schema.documents.find(type => type.name === "settings");
assert.ok(settingsType, "The playground supplies a real settings schema");
const settingsDoc = structuredClone(blueprint.documents.find(doc => doc.id === "settings:site") ?? {
  id: "settings:site", type: "settings", slug: "site",
  data: Object.fromEntries(settingsType.fields.map(field => [field.key, field.initialValue ?? `Fixture ${field.key}`])),
});
settingsDoc.data.siteName = "Remote draft fixture";
const filePath = `${settingsType.folder}/site.json`;
let stored = JSON.stringify(settingsDoc.data, null, 2) + "\n";
let sha = "a".repeat(40);
let installed = false;
let writable = true;
let writes = 0;
let conflict = false;
let writeStatus = 0;
let fixtureUser = "fixture-user";
let readbackFailures = 0;
const requests = [];
const errors = [];
const gateway = createServer((request, response) => {
  const target = new URL(request.url, "http://localhost");
  if (target.pathname !== "/authorize") { response.writeHead(404).end(); return; }
  const origin = target.searchParams.get("origin");
  const nonce = target.searchParams.get("nonce");
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(`<!doctype html><title>Fixture gateway</title><button onclick='window.opener.postMessage(${JSON.stringify({ type: "rigel:auth", provider: "github", nonce, access_token: "ghu_fixture_user_token", expires_in: 3600 })},${JSON.stringify(origin)}); window.close()'>Authorize fixture</button><script>document.querySelector('button').click()</script>`);
});
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const authOrigin = `http://localhost:${gateway.address().port}`;
const manifest = {
  ...blueprint, backend: "github", pages: [], collections: [], menus: undefined, sidebar: undefined,
  schema: { ...blueprint.schema, objects: [], documents: [settingsType] }, documents: [settingsDoc],
  github: { repo: "fixture-owner/fixture-site", branch: "drafts", publishBranch: "main", repoRoot: "", authOrigin, appSlug: "rigel-cms", copyDir: "src/content/copy", collections: [] },
};
function api(path, method, body) {
  requests.push({ path, method });
  if (method === "OPTIONS") return [204, null];
  if (path === "/user") return [200, { login: fixtureUser, avatar_url: "https://avatars.githubusercontent.com/u/1", html_url: `https://github.com/${fixtureUser}` }];
  const installation = { id: 7, app_slug: "rigel-cms", account: { login: "fixture-owner", type: "User" }, permissions: { contents: "write" }, suspended_at: null, html_url: "https://github.com/settings/installations/7" };
  if (path.startsWith("/user/installations?")) return [200, { total_count: installed && fixtureUser === "fixture-user" ? 1 : 0, installations: installed && fixtureUser === "fixture-user" ? [installation] : [] }];
  const repository = { id: 42, full_name: manifest.github.repo, name: "fixture-site", default_branch: "main", owner: { login: "fixture-owner" }, permissions: { push: writable, pull: true }, archived: false, disabled: false };
  if (path.startsWith("/user/installations/7/repositories?")) return [200, { total_count: 1, repositories: [repository] }];
  const prefix = `/repos/${manifest.github.repo}`;
  if (path === prefix) return [200, repository];
  if (path.startsWith(`${prefix}/git/ref/heads/`) || path.startsWith(`${prefix}/branches/`)) return [200, { ref: "refs/heads/drafts", object: { sha: "b".repeat(40), type: "commit" }, commit: { sha: "b".repeat(40) } }];
  if (path.startsWith(`${prefix}/git/trees/`)) return [200, { truncated: false, tree: [{ path: filePath, type: "blob", mode: "100644", sha }] }];
  if (path.startsWith(`${prefix}/git/commits/`)) return [200, { tree: { sha: "b".repeat(40) } }];
  if (path.startsWith(`${prefix}/git/blobs/`)) return [200, { sha, encoding: "base64", content: Buffer.from(stored).toString("base64") }];
  if (path.split("?")[0] === `${prefix}/contents/${filePath}`) {
    if (method === "GET") {
      if (readbackFailures) { readbackFailures--; return [503, { message: "Fixture verification outage" }]; }
      return [200, { type: "file", path: filePath, sha, encoding: "base64", content: Buffer.from(stored).toString("base64") }];
    }
    if (method === "PUT") {
      if (writeStatus) return [writeStatus, { message: "Fixture access revoked" }];
      assert.equal(body.branch, "drafts");
      assert.equal(body.sha, sha, "Save uses the loaded blob, not the newest SHA");
      if (conflict) return [409, { message: "Fixture conflict" }];
      stored = Buffer.from(body.content, "base64").toString("utf8");
      sha = String(++writes).padStart(40, "0");
      return [200, { content: { sha } }];
    }
  }
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
}
await mkdir("_temp", { recursive: true });
const profile = await mkdtemp(`${process.cwd()}/_temp/github-browser-`);
const chrome = spawn(process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 10000);
    chrome.once("error", reject);
    chrome.stderr.on("data", chunk => { const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data), request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    result.error ? request.reject(new Error(result.error.message)) : request.resolve(result.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.sessionId !== sessionId) return;
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
    if (event.method === "Fetch.requestPaused") void (async () => {
      const { requestId, request } = event.params;
      const target = new URL(request.url);
      if (target.pathname === "/rigel/manifest.json") {
        await cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(manifest)).toString("base64") });
      } else if (target.hostname === "api.github.com") {
        const [status, result] = api(target.pathname + target.search, request.method, request.postData ? JSON.parse(request.postData) : undefined);
        await cdp("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [
          { name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Access-Control-Allow-Headers", value: "Authorization,Content-Type,Accept,X-GitHub-Api-Version" }, { name: "Access-Control-Allow-Methods", value: "GET,POST,PUT,DELETE,OPTIONS" },
        ], body: Buffer.from(result === null ? "" : JSON.stringify(result)).toString("base64") });
      } else if (target.pathname.startsWith("/rigel/api/local/")) {
        throw new Error("GitHub mode called a local persistence API");
      } else await cdp("Fetch.continueRequest", { requestId });
    })().catch(error => { errors.push(error.message); void cdp("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "Failed" }); });
  });
  await cdp("Page.enable"); await cdp("Runtime.enable");
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*://api.github.com/*" }, { urlPattern: "*/rigel/manifest.json" }, { urlPattern: "*/rigel/api/local/*" }] });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${expression}\n${JSON.stringify(errors)}\n${await evaluate("document.body.innerText.slice(0,2000)")}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await cdp("Page.navigate", { url });
  await waitFor("!!document.querySelector('#github-connection')");
  assert.equal(await evaluate("!!document.querySelector('#rigel-sidebar')"), false, "Identity-only login must not expose editors");
  assert.equal(requests.length, 0);
  await click("#github-sign-in");
  await waitFor("!!document.querySelector('#github-install')");
  await waitFor("document.querySelector('#github-check-access')?.disabled === false");
  assert.equal(await evaluate("document.querySelector('#github-install').href"), "https://github.com/apps/rigel-cms/installations/new");
  assert.equal(await evaluate("document.querySelector('#github-connection').textContent.includes('Only select repositories')"), true);
  assert.equal(requests.some(request => !["GET", "OPTIONS"].includes(request.method)), false);
  for (const theme of ["light", "dark"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
    await evaluate("Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))");
    for (const width of [1280, 390, 320]) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${theme} ${width}: no overflow`);
      assert.equal(await evaluate("[...document.querySelectorAll('#github-connection button, #github-connection a')].every(el => el.getBoundingClientRect().height >= 44)"), true);
      const contrast = await evaluate(`(() => {
        const rgb = color => color.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const luminance = color => rgb(color).map(value => { value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return [...document.querySelectorAll('#github-connection h1, #github-connection p, #github-connection button, #github-connection a')].map(element => {
          let parent = element, background;
          do { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; } while (parent && (background === 'transparent' || background === 'rgba(0, 0, 0, 0)'));
          const colors = [luminance(getComputedStyle(element).color), luminance(background)].sort((a, b) => b - a);
          return (colors[0] + 0.05) / (colors[1] + 0.05);
        });
      })()`);
      assert.ok(contrast.every(ratio => ratio >= 4.5), `${theme} ${width}: AA text and controls ${JSON.stringify(contrast)}`);
      await writeFile(`_temp/github-${theme}-${width}.png`, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  await evaluate("document.querySelector('#github-install').focus()");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.id"), "github-check-access");
  assert.ok(await evaluate("parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2"));
  installed = true; writable = false;
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor("document.querySelector('#github-connection').textContent.includes('write access')");
  assert.equal(await evaluate("!!document.querySelector('#rigel-sidebar')"), false);
  writable = true;
  await click("#github-check-access");
  await waitFor("!!document.querySelector('#rigel-sidebar')");
  await click('[data-document="settings:site"]');
  await waitFor("!!document.querySelector('.document-form input[type=text]')");
  assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), "Remote draft fixture");
  await evaluate("(() => { const input = document.querySelector('.document-form input[type=text]'); input.value = 'Saved Unicode 星'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  assert.equal(writes, 0, "Edits stay unsaved");
  await click(".save-button");
  await waitFor("document.querySelector('.save-status').textContent.trim() === 'Saved'");
  assert.equal(JSON.parse(stored).siteName, "Saved Unicode 星");
  assert.equal(writes, 1);
  conflict = true;
  await evaluate("(() => { const input = document.querySelector('.document-form input[type=text]'); input.value = 'Keep this dirty draft'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  await click(".save-button");
  await waitFor("!!document.querySelector('.save-toast')");
  assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), "Keep this dirty draft");
  assert.equal(JSON.parse(stored).siteName, "Saved Unicode 星");
  conflict = false;
  await evaluate("(() => { const now = Date.now; Date.now = () => now() + 3660000; })()");
  await click(".save-button");
  await waitFor("!!document.querySelector('.github-session button')");
  assert.equal(writes, 1, "Expired credentials cannot write");
  await click(".github-session button");
  await waitFor("!document.querySelector('.github-session')");
  assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), "Keep this dirty draft", "Reauthentication keeps the dirty draft");
  await click(".save-button");
  await waitFor("document.querySelector('.save-status').textContent.trim() === 'Saved'");
  assert.equal(JSON.parse(stored).siteName, "Keep this dirty draft");
  assert.equal(writes, 2);
  for (const status of [401, 403]) {
    const marker = `Recover access ${status}`;
    await evaluate(`(() => { const input = document.querySelector('.document-form input[type=text]'); input.value = ${JSON.stringify(marker)}; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    writeStatus = status;
    await click(".save-button");
    await waitFor("!!document.querySelector('.save-toast .github-reconnect')");
    fixtureUser = "wrong-account";
    await click(".save-toast .github-reconnect");
    await waitFor("document.querySelector('.uname')?.textContent === 'wrong-account'");
    await waitFor("!!document.querySelector('.github-session button:not(:disabled)')");
    assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), marker);
    const before = writes;
    await click(".save-button");
    await waitFor("document.querySelector('.save-toast p')?.textContent.includes('verify repository access')");
    assert.equal(writes, before, "Wrong-account reauthentication cannot save");
    fixtureUser = "fixture-user";
    writeStatus = 0;
    await click(".github-session button");
    await waitFor("!document.querySelector('.github-session')");
    assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), marker);
    await click(".save-button");
    await waitFor("document.querySelector('.save-status').textContent.trim() === 'Saved'");
    assert.equal(JSON.parse(stored).siteName, marker);
  }
  const beforeReadback = writes;
  readbackFailures = 1;
  await evaluate("(() => { const input = document.querySelector('.document-form input[type=text]'); input.value = 'Recover confirmed write'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  await click(".save-button");
  await waitFor("!!document.querySelector('.save-toast')");
  assert.equal(writes, beforeReadback + 1, "The write succeeded before readback failed");
  assert.equal(JSON.parse(stored).siteName, "Recover confirmed write");
  await click(".save-toast .outlined");
  await waitFor("document.querySelector('.save-status').textContent.trim() === 'Saved'");
  assert.equal(writes, beforeReadback + 1, "Retry verifies the completed write without issuing another PUT");
  await evaluate("(() => { const input = document.querySelector('.document-form input[type=text]'); input.value = 'Sign-out guard draft'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  await click(".user-btn");
  await click("#github-sign-out");
  await waitFor("!!document.querySelector('.unsaved-dialog[open]')");
  await evaluate("[...document.querySelectorAll('.unsaved-dialog button')].find(button => button.textContent.trim() === 'Keep editing').click()");
  assert.equal(await evaluate("document.querySelector('.document-form input[type=text]').value"), "Sign-out guard draft");
  await click(".user-btn"); await click("#github-sign-out");
  await evaluate("[...document.querySelectorAll('.unsaved-dialog button')].find(button => button.textContent.trim() === 'Discard changes').click()");
  await waitFor("!!document.querySelector('#github-sign-in')");
  assert.equal(await evaluate("JSON.stringify({...localStorage,...sessionStorage}).includes('ghu_fixture_user_token')"), false);
  assert.deepEqual(errors, []);
  console.log("PASS: real CMS popup, installation/write gates, draft load/Unicode Save, no local writes, conflicts, expiry and revoked 401/403 recovery with wrong-account rejection, readback retry without duplicate PUT, guarded sign-out, no token storage, AA/keyboard/light/dark 1280/390/320px (external transport is fixture-only)");
} finally {
  socket?.close(); chrome.kill("SIGKILL");
  await new Promise(resolve => gateway.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
