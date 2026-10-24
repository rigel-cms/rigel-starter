import "./local-only.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mediaFixtures } from './media-fixtures.mjs';

const url = process.env.RIGEL_URL || "http://127.0.0.1:4321/rigel/";
const file = "src/content/news/launch-week.json";
const original = await readFile(file);
await mkdir("_temp", { recursive: true });
await writeFile('_temp/media-edit.mp4', mediaFixtures.find(asset => asset.type === 'video/mp4').bytes);
const videoUrl = `/@fs/${process.cwd()}/_temp/media-edit.mp4`;
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
  const checkEmbed = async () => {
    await waitFor("!!document.querySelector('.block-content figure[data-rigel-embed=youtube] img')");
    assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed iframe')"), null, 'Editor never loads an embedded player');
    assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed img').src"), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed strong').textContent"), 'YouTube Video');
    assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed [data-rigel-edit-video]').hidden"), false);
    assert.equal(await evaluate("!!document.querySelector('[data-play],.video-toolbar')"), false);
    assert.equal(await evaluate("document.querySelector('.block-content figure.media-embed figcaption').textContent"), 'YouTube · Rick Astley - Never Gonna Give You Up (Rickroll)');
  };
  const mouseClick = async (doc, selector) => {
      const point = await evaluate(`(() => {const el=${doc}.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const rect=el.getBoundingClientRect(),frame=${doc}.defaultView.frameElement,box=frame?.getBoundingClientRect(),scale=frame ? box.width/frame.clientWidth : 1;return {x:(box?.left??0)+(rect.left+rect.width/2)*scale,y:(box?.top??0)+(rect.top+rect.height/2)*scale};})()`);
      await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
      await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  const editVideo = async (doc, selector, expectedUrl, expectedTitle) => {
    const disk = await readFile(file, 'utf8');
    const mediaClick = selector => mouseClick(doc, selector);
    const mediaType = (selector, value) => evaluate(`(() => {const field=${doc}.querySelector(${JSON.stringify(selector)});field.focus();field.value=${JSON.stringify(value)};field.dispatchEvent(new field.ownerDocument.defaultView.Event('input',{bubbles:true}));})()`);
    await evaluate(`${doc}.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    assert.equal(await evaluate(`(() => {const figure=${doc}.querySelector(${JSON.stringify(selector)}),card=figure.querySelector('[data-rigel-edit-video]').parentElement,box=figure.getBoundingClientRect(),rect=card.getBoundingClientRect();return rect.left>=box.left && rect.right<=box.right && rect.right<=${doc}.documentElement.clientWidth && card.scrollWidth<=card.clientWidth;})()`), true, 'Video overlay fits its container and viewport');
    await writeFile(`_temp/video-edit-${doc === 'document' ? 'sidebar' : 'inline'}-${selector.includes('youtube') ? 'youtube' : selector.includes('vimeo') ? 'vimeo' : 'file'}.png`, Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    await mediaClick(`${selector} [data-rigel-edit-video]`);
    try { await waitFor(`!!${doc}.querySelector('dialog.media-insert[open][aria-label="Edit video"]')`); }
    catch (error) { throw new Error(`${error.message}\n${await evaluate(`JSON.stringify({editing:!!${doc}.querySelector('.block-content'),buttons:[...${doc}.querySelectorAll('[data-rigel-edit-video]')].map(button=>({hidden:button.hidden,key:button.closest('figure')?.dataset.blockKey})),dialogs:[...${doc}.querySelectorAll('dialog')].map(dialog=>({open:dialog.open,label:dialog.ariaLabel})),active:${doc}.activeElement?.outerHTML.slice(0,100)})`)}`); }
    const fields = await evaluate(`[...${doc}.querySelectorAll('dialog.media-insert input[type=text]')].map(input=>input.value)`);
    assert.deepEqual(fields, [expectedUrl, expectedTitle], 'Editing starts with the selected video values');
    const titleInput = `dialog.media-insert label:nth-of-type(${selector.includes('media-video') ? 3 : 2}) input`;
    await mediaType(titleInput, 'Cancelled edit');
    await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitFor(`!${doc}.querySelector('dialog.media-insert[open]')`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await evaluate(`${doc}.querySelector(${JSON.stringify(selector + ' [data-rigel-edit-video]')}).focus()`);
    assert.equal(await evaluate(`${doc}.activeElement?.matches('[data-rigel-edit-video]')`), true, 'Overlay edit button can receive keyboard focus');
    await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(`!!${doc}.querySelector('dialog.media-insert[open]')`);
    assert.equal(await evaluate(`${doc}.querySelector(${JSON.stringify(titleInput)}).value`), expectedTitle, 'Escape discards modal edits');
    const editedUrl = expectedUrl.includes('youtube.com') ? 'https://www.youtube.com/watch?v=jNQXAC9IVRw' : expectedUrl.includes('vimeo.com') ? 'https://vimeo.com/76979871' : expectedUrl;
    const urlInput = 'dialog.media-insert input[type=text]';
    await mediaType(urlInput, editedUrl);
    await mediaType(titleInput, expectedTitle + ' edited');
    await mediaClick('dialog.media-insert .primary');
    assert.equal(await evaluate(`!!${doc}.querySelector('dialog[open]')`), false, await evaluate(`JSON.stringify([...${doc}.querySelectorAll('dialog[open]')].map(dialog=>({text:dialog.textContent,style:${doc}.defaultView.getComputedStyle(dialog).pointerEvents,button:dialog.querySelector('.primary')?.getBoundingClientRect().toJSON()})))`));
    await waitFor(`${doc}.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(expectedTitle + ' edited')})`);
    await mediaClick(`${selector} [data-rigel-edit-video]`);
    await waitFor(`!!${doc}.querySelector('dialog.media-insert[open]')`);
    assert.equal(await evaluate(`${doc}.querySelector(${JSON.stringify(urlInput)}).value`), editedUrl, 'Edited video URL is retained');
    await mediaType(urlInput, expectedUrl);
    await mediaType(titleInput, expectedTitle);
    await mediaClick('dialog.media-insert .primary');
    await waitFor(`!${doc}.querySelector('dialog[open]') && ${doc}.querySelector(${JSON.stringify(selector)}).textContent.endsWith(${JSON.stringify(expectedTitle)})`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal(await evaluate(`${doc}.querySelectorAll(${JSON.stringify(selector)}).length`), 1, 'Editing replaces the selected video instead of duplicating it');
    assert.equal(await readFile(file, 'utf8'), disk, 'Editing does not autosave');
  };
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
  await checkEmbed();

  await click('.body-toolbar [aria-label="Insert media"]');
  await waitFor("!!document.querySelector('.media-menu:popover-open')");
  await evaluate("[...document.querySelectorAll('.media-menu:popover-open [role=menuitem]')].find(item => item.textContent.includes('Vimeo')).click()");
  await waitFor("!!document.querySelector('dialog.media-insert[open]')");
  await evaluate("[...document.querySelectorAll('dialog.media-insert button')].find(button=>button.textContent.trim()==='Insert').click()");
  await waitFor("!!document.querySelector('.block-content figure[data-rigel-embed=vimeo]')");
  assert.equal(await evaluate("document.querySelector('.block-content figure[data-rigel-embed=vimeo] figcaption').textContent"), 'Vimeo · The Rolling Stones - Angry');
  assert.equal(await evaluate("document.querySelector('.block-content figure[data-rigel-embed=vimeo] strong').textContent"), 'Vimeo Video');
  await editVideo('document', '.block-content figure[data-rigel-embed=youtube]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Rick Astley - Never Gonna Give You Up (Rickroll)');
  await editVideo('document', '.block-content figure[data-rigel-embed=vimeo]', 'https://vimeo.com/861680818', 'The Rolling Stones - Angry');
  await click('.body-toolbar [data-media-trigger]');
  await waitFor("!!document.querySelector('.media-menu:popover-open')");
  await evaluate("[...document.querySelectorAll('.media-menu:popover-open [role=menuitem]')].find(item => item.textContent.trim()==='Video').click()");
  await waitFor("!!document.querySelector('dialog.media-insert[open]')");
  await type('dialog.media-insert input[type=text]', videoUrl);
  await type('dialog.media-insert label:nth-of-type(3) input', 'Fixture video');
  await click('dialog.media-insert .primary');
  await waitFor("!!document.querySelector('.block-content figure.media-video')");
  await editVideo('document', '.block-content figure.media-video', videoUrl, 'Fixture video');

  await click(".save-button");
  await waitFor("document.querySelector('.save-status')?.textContent.trim() === 'Saved'");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const node = saved.body.root.children.find(child => child.type === "embed");
  assert.equal(saved.body.root.children[0].type, 'embed', 'Slash insertion replaces the command paragraph in place');
  assert.equal(JSON.stringify(saved.body).includes('/youtube'), false, 'Slash command text is not saved');
  assert.deepEqual(node, { provider: "youtube", id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Rickroll)", privacy: true, type: "embed", version: 1 }, "Saved embed keeps provider, id, title and privacy");
  const publicUrl = new URL(`/news/${saved.frontmatter.slug || 'launch-week'}/`, url).href;
  await waitFor(`(async () => (await (await fetch(${JSON.stringify(publicUrl)})).text()).includes('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0'))()`);
  await waitFor(`(async () => (await (await fetch(${JSON.stringify(publicUrl)})).text()).includes('https://player.vimeo.com/video/861680818?dnt=1'))()`);

  await navigate(url);
  await open("news", "launch-week");
  await checkEmbed();
  await waitFor("!!document.querySelector('.visual-editor iframe').contentDocument?.querySelector('figure[data-rigel-embed=youtube] img')");
  await waitFor("!!document.querySelector('.visual-editor iframe').contentDocument?.querySelector('figure[data-rigel-embed=vimeo]')");
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
  assert.equal(await evaluate(`${frameDoc}.querySelector('figure[data-rigel-embed=youtube] [data-rigel-edit-video]').hidden`), false, 'Reloaded preview offers editing before entering the block editor');
  await evaluate(`${frameDoc}.querySelector('figure[data-rigel-embed=youtube]').scrollIntoView({block:'center'})`);
  await waitFor(`${frameDoc}.querySelector('figure[data-rigel-embed=youtube] img').complete`);
  await writeFile('_temp/embed-preview.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await editVideo(frameDoc, 'figure[data-rigel-embed=youtube]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Rick Astley - Never Gonna Give You Up (Rickroll)');
  await editVideo(frameDoc, '.block-content figure[data-rigel-embed=vimeo]', 'https://vimeo.com/861680818', 'The Rolling Stones - Angry');
  await editVideo(frameDoc, '.block-content figure.media-video', videoUrl, 'Fixture video');
  await evaluate(`${frameDoc}.querySelector('.block-content p').click()`);
  for (const choice of ['image', 'video', 'youtube', 'vimeo']) {
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await mouseClick(frameDoc, '.block-content p');
    await evaluate(`(() => {const doc=${frameDoc},root=doc.querySelector('.block-content'),node=root.querySelector('p');root.focus();const range=doc.createRange();range.selectNodeContents(node);const selection=doc.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    for (const character of `/${choice}`) await cdp('Input.insertText', { text: character });
    try { await waitFor(`!![...${frameDoc}.querySelectorAll('.block-slash [role=option]')].find(option=>option.textContent.toLowerCase()===${JSON.stringify(choice)})`); }
    catch (error) { throw new Error(`${error.message}\n${await evaluate(`JSON.stringify({text:${frameDoc}.querySelector('.block-content')?.textContent,active:${frameDoc}.activeElement?.outerHTML.slice(0,200),menu:${frameDoc}.querySelector('.block-slash')?.outerHTML,selection:${frameDoc}.defaultView.getSelection()?.anchorNode?.parentElement?.outerHTML.slice(0,200)})`)}`); }
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`!!${frameDoc}.querySelector('dialog[open]')`);
    assert.equal(await evaluate(`${frameDoc}.querySelector('dialog[open] h2').textContent`), choice === 'image' ? 'Choose image' : choice === 'video' ? 'Add video' : `Add ${choice === 'youtube' ? 'YouTube' : 'Vimeo'} video`);
    await evaluate(`${frameDoc}.querySelector('dialog[open] .close').click()`);
    await waitFor(`!${frameDoc}.querySelector('dialog[open]')`);
  }
  assert.ok((await readFile(file)).equals(Buffer.from(JSON.stringify(saved, null, 2)+'\n')), 'Inline slash commands never autosave');

  const unsavedBody = await evaluate(`${frameDoc}.querySelector('.block-content').textContent`);
  await click('.user-btn');
  await evaluate("[...document.querySelectorAll('.user-menu button')].find(button=>button.textContent.includes('Settings')).click()");
  await waitFor("!!document.querySelector('.settings-modal')");
  assert.equal(await evaluate("!!document.querySelector('.unsaved-dialog')"), false, 'Settings opens without a navigation guard');
  await evaluate("[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent.trim()==='Media').click()");
  await waitFor("!!document.querySelector('.settings-pane input')");
  await type('.settings-pane input', 'test-only-api-key');
  await waitFor("JSON.parse(localStorage.getItem('rigelcms.settings')).apiKeys.pexels==='test-only-api-key'");
  await click('.settings-head .close');
  assert.equal(await evaluate(`${frameDoc}.querySelector('.block-content').textContent`), unsavedBody, 'API-key settings preserve the unsaved article');
  assert.equal(await evaluate("document.querySelector('.save-button').disabled"), false);
  assert.ok((await readFile(file)).equals(Buffer.from(JSON.stringify(saved, null, 2)+'\n')), 'Settings never saves content');
  await click('.user-btn');
  await evaluate("[...document.querySelectorAll('.user-menu button')].find(button=>button.textContent.includes('Keyboard Shortcuts')).click()");
  await waitFor("!!document.querySelector('[aria-label=\"Keyboard shortcuts\"]')");
  assert.equal(await evaluate("!!document.querySelector('.unsaved-dialog')"), false, 'Shortcuts also opens over unsaved edits');
  await click('.rigel-modal-backdrop');
  await click('.brand');
  await waitFor("!!document.querySelector('.unsaved-dialog[open]')");
  await evaluate("[...document.querySelectorAll('.unsaved-dialog button')].find(button=>button.textContent.trim()==='Keep editing').click()");
  assert.equal(await evaluate(`${frameDoc}.querySelector('.block-content').textContent`), unsavedBody, 'Leaving content still guards the unsaved draft');

  assert.deepEqual(errors, [], errors.join("\n"));
  console.log("PASS: media insert/save/reload; direct overlay editing by real mouse and keyboard; cancel, update-in-place and no autosave in sidebar/inline");
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
