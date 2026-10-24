import "./local-only.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";

const url = process.env.RIGEL_URL || "http://127.0.0.1:4321/rigel/";
const file = "src/content/news/launch-week.json";
const original = await readFile(file);
await mkdir("_temp", { recursive: true });
const profile = await mkdtemp(`${process.cwd()}/_temp/media-insert-`);
const chrome = spawn(process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--window-size=1440,1000", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
    chrome.once("error", reject);
    chrome.stderr.on("data", chunk => { const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint); await once(socket, "open");
  let id = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data), request = pending.get(result.id);
    if (request) { pending.delete(result.id); result.error ? request.reject(new Error(result.error.message)) : request.resolve(result.result); }
    if (result.method === "Runtime.exceptionThrown") errors.push(result.params.exceptionDetails.exception?.description ?? result.params.exceptionDetails.text);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(requestId, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp("Runtime.enable"); await cdp("Page.enable");
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed");
    return result.result.value;
  };
  const waitFor = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}\nErrors: ${errors.join("\n")}`); };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = async (selector, value) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const navigate = async target => { await cdp("Page.navigate", { url: target }); await waitFor("document.readyState === 'complete'"); };
  const open = async (collection, slug) => {
    await waitFor(`!!document.querySelector('[data-collection=${collection}]')`);
    await click(`[data-collection=${collection}]`);
    await waitFor("!!document.querySelector('tbody .table-link')");
    await evaluate(`[...document.querySelectorAll('tbody tr')].find(row => row.cells[1].textContent.trim() === ${JSON.stringify(slug)}).querySelector('.table-link').click()`);
  };
  const embedSrc = () => evaluate("[...document.querySelectorAll('.block-content figure.media-embed iframe')].map(frame => frame.src)");

  await navigate(url);
  await open("news", "launch-week");
  await waitFor("!!document.querySelector('.block-content')");

  await click('.body-toolbar [aria-label="Insert media"]');
  await waitFor("!!document.querySelector('.media-menu:popover-open')");
  await evaluate("[...document.querySelectorAll('.media-menu:popover-open [role=menuitem]')].find(item => item.textContent.includes('YouTube')).click()");
  await waitFor("!!document.querySelector('dialog.media-insert[open]')");
  await type('dialog.media-insert input[type="text"]', "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await evaluate("[...document.querySelectorAll('dialog.media-insert button')].find(button => button.textContent.trim() === 'Insert').click()");
  await waitFor("!!document.querySelector('.block-content figure.media-embed iframe')");
  const src = (await embedSrc())[0];
  assert.equal(src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", `Privacy-enhanced YouTube embed expected, got ${src}`);
  assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed iframe').title"), "YouTube video", "Embed needs an accessible title");

  await click(".save-button");
  await waitFor("document.querySelector('.save-status')?.textContent.trim() === 'Saved'");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const node = saved.body.root.children.find(child => child.type === "embed");
  assert.deepEqual(node, { provider: "youtube", id: "dQw4w9WgXcQ", privacy: true, type: "embed", version: 1 }, "Saved embed keeps provider, id and privacy");

  await navigate(url);
  await open("news", "launch-week");
  await waitFor("!!document.querySelector('.block-content figure.media-embed iframe')");
  assert.equal((await embedSrc())[0], "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", "Reload restores the privacy-enhanced embed");
  await click('.markdown-modes button');
  await waitFor("!!document.querySelector('.block-markdown')");
  assert.ok((await evaluate("document.querySelector('.block-markdown').textContent")).includes("[YouTube video](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>)"), "Markdown view links the original video");

  assert.deepEqual(errors, [], errors.join("\n"));
  console.log("PASS: insert media menu adds a privacy-enhanced YouTube embed, saves, reloads and projects Markdown");
} finally {
  socket?.close();
  await (await import("node:fs/promises")).writeFile(file, original);
  chrome.kill();
  await once(chrome, "exit").catch(() => {});
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(profile, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
}
