import "./local-only.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

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
  const checkActions = async () => {
    assert.equal(await evaluate("(() => {const dialog=document.querySelector('dialog.media-insert'),rect=dialog.getBoundingClientRect(),style=getComputedStyle(dialog);return rect.width===innerWidth && rect.height===innerHeight && style.borderTopWidth==='0px' && style.paddingTop==='16px';})()"), true, 'Native dialog uses the shared full-viewport reset');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('dialog.media-insert .media-button-actions')).borderTopWidth"), '1px', 'Footer uses the shared divider');
    const layout = await evaluate("(() => {const dialog=document.querySelector('dialog.media-insert'),actions=dialog.querySelector('.media-button-actions'),buttons=[...actions.querySelectorAll('button')],toggle=dialog.querySelector('label.inline');return {order:buttons.map(button=>button.textContent.trim()),gap:actions.getBoundingClientRect().top-toggle.getBoundingClientRect().bottom,left:buttons[0].getBoundingClientRect().left< buttons[1].getBoundingClientRect().left};})()");
    assert.deepEqual(layout.order, ['Cancel', 'Insert']);
    assert.equal(layout.left, true, 'Cancel is left of Insert');
    assert.equal(await evaluate("[...document.querySelectorAll('dialog.media-insert label:not(.inline)')].every(label=>{const caption=label.querySelector(':scope > span'),input=label.querySelector('input');return caption && getComputedStyle(caption).fontSize==='12px' && getComputedStyle(caption).fontWeight==='600' && input.getBoundingClientRect().top-caption.getBoundingClientRect().bottom>=6;})"), true, 'Field labels use shared styling and spacing');
    assert.equal(await evaluate("(() => {const actions=document.querySelector('dialog.media-insert .media-button-actions'),buttons=actions.querySelectorAll('button'),rect=actions.getBoundingClientRect();return Math.abs(buttons[0].getBoundingClientRect().left-rect.left)<1 && Math.abs(buttons[1].getBoundingClientRect().right-rect.right)<1;})()"), true, 'Actions sit at opposite edges');
    assert.equal(await evaluate("(() => {const label=document.querySelector('dialog.media-insert label.inline');return label.querySelector('input').getBoundingClientRect().right<=label.querySelector('span').getBoundingClientRect().left;})()"), true, 'Toggle is left of its label');
    assert.ok(layout.gap >= 16, `Actions need space below the toggle, got ${layout.gap}px`);
  };

  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('rigelcms.settings',JSON.stringify({userPref:{editorExperience:'sidebar'}}))" });
  await navigate(url);
  await open("news", "launch-week");
  await waitFor("!!document.querySelector('.block-content')");

  const slashMedia = async choice => {
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await evaluate("(() => {const root=document.querySelector('.block-content'),node=root.querySelector('p');root.focus();const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()");
    for (const character of `/${choice}`) await cdp('Input.insertText', { text: character });
    await waitFor(`document.querySelector('.block-content p')?.textContent===${JSON.stringify(`/${choice}`)}`);
    try { await waitFor(`!![...document.querySelectorAll('.block-slash [role=option]')].find(option=>option.textContent.toLowerCase()===${JSON.stringify(choice)})`); }
    catch (error) { throw new Error(`${error.message}\n${await evaluate("JSON.stringify({menu:document.querySelector('.block-slash')?.outerHTML,selection:getSelection()?.toString(),body:document.querySelector('.block-content')?.innerHTML})")}`); }
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  };
  for (const choice of ['image', 'video', 'youtube', 'vimeo']) {
    await slashMedia(choice);
    await waitFor(choice === 'image' ? "!!document.querySelector('dialog.image-dialog[open]')" : "!!document.querySelector('dialog.media-insert[open]')");
    assert.equal(await evaluate("document.querySelector('dialog[open] h2').textContent"), choice === 'image' ? 'Choose image' : choice === 'video' ? 'Add video' : `Add ${choice === 'youtube' ? 'YouTube' : 'Vimeo'} video`);
    assert.ok((await readFile(file)).equals(original), 'Slash commands never autosave');
    await click('dialog[open] .close');
    await waitFor("!document.querySelector('dialog[open]')");
    assert.equal(await evaluate("document.querySelector('.block-content p').textContent"), `/${choice}`, 'Cancel leaves the slash paragraph intact');
  }

  await click('.body-toolbar [aria-label="Insert media"]');
  await waitFor("!!document.querySelector('.media-menu:popover-open')");
  await evaluate("[...document.querySelectorAll('.media-menu:popover-open [role=menuitem]')].find(item => item.textContent.includes('Vimeo')).click()");
  await waitFor("!!document.querySelector('dialog.media-insert[open]')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('dialog.media-insert input[type=text]')].map(input=>input.value)"), ["https://vimeo.com/861680818", "The Rolling Stones - Angry"], "Vimeo opens with an editable example URL and title");
  await checkActions();
  await click('dialog.media-insert .close');

  await slashMedia('youtube');
  await waitFor("!!document.querySelector('dialog.media-insert[open]')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('dialog.media-insert input[type=text]')].map(input=>input.value)"), ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up (Rickroll)"], "YouTube opens with an editable example URL and title");
  await checkActions();
  await type('dialog.media-insert input[type="text"]', "https://youtu.be/dQw4w9WgXcQ?si=share");
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await checkActions();
    assert.equal(await evaluate("(() => {const modal=document.querySelector('dialog.media-insert .rigel-modal'),rect=modal.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight && modal.scrollWidth<=modal.clientWidth;})()"), true, 'Modal fits the viewport without horizontal overflow');
    await writeFile(`_temp/media-insert-${width}-${theme}.png`, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await evaluate("[...document.querySelectorAll('dialog.media-insert button')].find(button => button.textContent.trim() === 'Insert').click()");
  await waitFor("!!document.querySelector('.block-content figure.media-embed iframe')");
  const src = (await embedSrc())[0];
  assert.equal(src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", `Privacy-enhanced YouTube embed expected, got ${src}`);
  assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed iframe').title"), "Rick Astley - Never Gonna Give You Up (Rickroll)", "Embed keeps the example title");

  await click(".save-button");
  await waitFor("document.querySelector('.save-status')?.textContent.trim() === 'Saved'");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const node = saved.body.root.children.find(child => child.type === "embed");
  assert.equal(saved.body.root.children[0].type, 'embed', 'Slash insertion replaces the command paragraph in place');
  assert.equal(JSON.stringify(saved.body).includes('/youtube'), false, 'Slash command text is not saved');
  assert.deepEqual(node, { provider: "youtube", id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Rickroll)", privacy: true, type: "embed", version: 1 }, "Saved embed keeps provider, id, title and privacy");

  await navigate(url);
  await open("news", "launch-week");
  await waitFor("!!document.querySelector('.block-content figure.media-embed iframe')");
  assert.equal((await embedSrc())[0], "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", "Reload restores the privacy-enhanced embed");
  await click('.markdown-modes button');
  await waitFor("!!document.querySelector('.block-markdown')");
  assert.ok((await evaluate("document.querySelector('.block-markdown').textContent")).includes("[Rick Astley - Never Gonna Give You Up (Rickroll)](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>)"), "Markdown view links the original video with its title");

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('.user-btn');
  await evaluate("[...document.querySelectorAll('.user-menu button')].find(button=>button.textContent.includes('Settings')).click()");
  await waitFor("!!document.querySelector('.settings-nav')");
  await evaluate("[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent.trim()==='Editor').click()");
  await click('.settings-pane input[value=inline]');
  await click('.settings-head .close');
  await waitFor("document.querySelector('.canvas-stage')?.dataset.ready==='true'");
  const frameDoc = "document.querySelector('.visual-editor iframe').contentDocument";
  await evaluate(`${frameDoc}.querySelector('[data-rigel-richtext="$body"] p').click()`);
  await waitFor(`!!${frameDoc}.querySelector('.block-content')`);
  for (const choice of ['image', 'video', 'youtube', 'vimeo']) {
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await evaluate(`(() => {const doc=${frameDoc},root=doc.querySelector('.block-content'),node=root.querySelector('p');root.focus();const range=doc.createRange();range.selectNodeContents(node);const selection=doc.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
    for (const character of `/${choice}`) await cdp('Input.insertText', { text: character });
    await waitFor(`!![...${frameDoc}.querySelectorAll('.block-slash [role=option]')].find(option=>option.textContent.toLowerCase()===${JSON.stringify(choice)})`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`!!${frameDoc}.querySelector('dialog[open]')`);
    assert.equal(await evaluate(`${frameDoc}.querySelector('dialog[open] h2').textContent`), choice === 'image' ? 'Choose image' : choice === 'video' ? 'Add video' : `Add ${choice === 'youtube' ? 'YouTube' : 'Vimeo'} video`);
    await evaluate(`${frameDoc}.querySelector('dialog[open] .close').click()`);
    await waitFor(`!${frameDoc}.querySelector('dialog[open]')`);
  }
  assert.ok((await readFile(file)).equals(Buffer.from(JSON.stringify(saved, null, 2)+'\n')), 'Inline slash commands never autosave');

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
