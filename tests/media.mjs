import "./local-only.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";

import { mediaFixtures } from "./media-fixtures.mjs";

const url = process.env.RIGEL_URL || "http://localhost:4321/rigel/";
const baseline = await (await fetch(new URL('/rigel/media.json', url))).json();
assert.equal(baseline.writable, true, 'Browser test requires live local backend');
const originalAssets = new Map(await Promise.all((baseline.assets ?? baseline.images).map(async image => [image.url, await readFile('public' + image.url)])));
const created = new Set();
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII=';
const uploadedURL = '/rigel-media/' + createHash('sha256').update(Buffer.from(pngBase64, 'base64')).digest('hex') + '.png';
if (!originalAssets.has(uploadedURL)) created.add(uploadedURL);
const sidecarPath = 'public/rigel-media/.rigel-media.json';
let originalSidecar = null;
try { originalSidecar = await readFile(sidecarPath, 'utf8'); } catch {}
const readSidecar = async () => JSON.parse(await readFile(sidecarPath, 'utf8'));
const slug = `richtext-check-${process.pid}`;
const copyFile = `src/content/copy/${slug}.ts`;
const originalCopy = `import { defineCopy } from "@rigel-cms/rigel/content";\nexport default defineCopy({slug: "${slug}", label: "${slug}", groups: [{id: "content", label: "Content", fields: [{key: "rich", label: "Rich copy", type: "markdown"}, {key: "items", label: "Items", type: "list", item: {fields: [{key: "rich", label: "Nested copy", type: "markdown"}]}}]}], values: {content: {rich: "Copy", items: [{rich: "*Nested*"}]}\n  },\n});`;
await mkdir('src/content/copy', { recursive: true });
await writeFile(copyFile, originalCopy, { flag: 'wx' });

await mkdir("_temp", { recursive: true });
const profile = await mkdtemp(`${process.cwd()}/_temp/settings-browser-`);
const chrome = spawn(process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome did not start")), 10000);
    chrome.once("error", reject);
    chrome.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    if (result.error) request.reject(new Error(result.error.message));
    else request.resolve(result.result);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timed out: ${method} ${JSON.stringify(params)}`)); }, 15000);
      pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  const errors = [];
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
    if (event.method === "Page.javascriptDialogOpening" && event.params.type === "beforeunload") void cdp('Page.handleJavaScriptDialog', { accept: true });
  });
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  async function evaluate(expression) {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Browser evaluation failed");
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) {
        const rounded = await evaluate(`(() => {
          const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
          return [...document.querySelectorAll('.rigel, .rigel *')].flatMap(el => ['', '::before', '::after'].flatMap(pseudo => {
            const style = getComputedStyle(el, pseudo || null);
            if (pseudo && ['none', 'normal'].includes(style.content)) return [];
            const expected = !pseudo && el.classList.contains('avatar') ? '50%' : '0px';
            return corners.every(c => style[c] === expected) ? [] : [el.tagName + '.' + el.getAttribute('class') + pseudo];
          }));
        })()`);
        assert.deepEqual(rounded, [], 'Only avatars may have rounded corners');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out: ${expression}`);
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.alert = window.confirm = window.prompt = () => { throw new Error('Native dialogs are forbidden'); };
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => {
      if (window.failSave && args[1]?.method === 'POST') return new Response('Save failed for test', {status: 500});
      const response = await fetchOriginal(...args);
      if (args[0] !== '/rigel/manifest.json') return response;
      const manifest = await response.json();
      manifest.collections.find(c => c.name === 'blog').fields.push({key: 'summary', label: 'Rich summary', type: 'markdown'});
      return Response.json(manifest);
    };
  ` });
  for (let i = 0; i < 100; i++) {
    const manifest = await (await fetch(new URL('/rigel/manifest.json', url), { signal: AbortSignal.timeout(15000) })).json();
    if (manifest.pages.some(p => p.slug === slug) && manifest.collections.find(c => c.name === 'blog').posts.some(p => p.slug === slug)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const editor = label => `[contenteditable=true][aria-label="${label}"]`;
  const root = label => `document.querySelector(${JSON.stringify(editor(label))}).closest('.markdown-editor')`;
  const button = (label, text) => evaluate(`[...${root(label)}.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(text)}).click()`);
  const format = (label, value) => evaluate(`(() => { const el = ${root(label)}.querySelector('select[aria-label="Text style"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  const source = label => evaluate(`${root(label)}.querySelector('textarea').value`);
  const setSource = (label, text) => evaluate(`(() => {const el = ${root(label)}.querySelector('textarea'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true}));})()`);
  const selectText = label => evaluate(`(() => {const el = document.querySelector(${JSON.stringify(editor(label))}); el.focus(); const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);})()`);
  const type = async (label, text) => { await selectText(label); await cdp('Input.insertText', {text}); };
  const open = async nav => {
    await waitFor(`!!document.querySelector(${JSON.stringify(nav)})`);
    await click(nav);
    await waitFor(`!![...document.querySelectorAll('.table-link')].find(b => b.textContent.trim() === ${JSON.stringify(slug)})`);
    await evaluate(`[...document.querySelectorAll('.table-link')].find(b => b.textContent.trim() === ${JSON.stringify(slug)}).click()`);
  };
  const choice = text => evaluate(`[...document.querySelectorAll('.unsaved-dialog button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const savedFile = async (file, text) => {
    for (let i = 0; i < 100; i++) { if ((await readFile(file, 'utf8')).includes(text)) return; await new Promise(r => setTimeout(r, 100)); }
    assert.fail(`Save did not persist ${text}`);
  };
  await new Promise(r => setTimeout(r, 750));
  await cdp('Page.navigate', {url});
  await waitFor("!!document.querySelector('#nav-media')");
  assert.equal(await evaluate("document.querySelector('.rail-scroll > button').id"), 'nav-pages');
  await click('#nav-media');
  await waitFor("!!document.querySelector('.media-library .grid')");
  assert.equal(await evaluate("!!document.querySelector('.media-tools button[role=combobox][aria-label=\"Media type\"]')"), true, 'Custom media category filter');
  assert.equal(await evaluate("document.querySelector('.save-button') === null"), true);
  assert.equal(await evaluate("document.querySelector('.media-library .tabs, .media-library input[type=file]') === null"), true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.media-views button')].map(b => ({label: b.getAttribute('aria-label'), tooltip: b.dataset.tooltip, text: b.textContent.trim(), svg: !!b.querySelector('svg[aria-hidden="true"] path[d]')}))`), [
    {label: 'Grid view', tooltip: 'Grid view', text: '', svg: true},
    {label: 'List view', tooltip: 'List view', text: '', svg: true},
  ]);
  assert.ok(await evaluate(`(() => {
    const group = document.querySelector('.media-views');
    return group.nextElementSibling.getBoundingClientRect().left - group.getBoundingClientRect().right >= 24;
  })()`), 'View toggle is separated from filters by 1.5rem');
  assert.ok(await evaluate(`[...document.querySelectorAll('.media-tools .select-trigger')].every(select => {
    const icon = select.querySelector('svg'), style = getComputedStyle(select);
    return parseFloat(style.gap) >= 12 && icon.getAttribute('aria-hidden') === 'true' &&
      select.getBoundingClientRect().right - icon.getBoundingClientRect().right >= 12;
  })`), 'Custom dropdowns reserve text space and inset decorative carets');
  await evaluate("document.querySelector('[aria-label=\"Grid view\"]').focus()");
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'List view');
  assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineWidth"), '3px');
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await waitFor("document.querySelector('[aria-label=\"List view\"]').getAttribute('aria-pressed') === 'true'");
  await click('[aria-label="Grid view"]');
  await waitFor("document.querySelector('[aria-label=\"Grid view\"]').getAttribute('aria-pressed') === 'true'");
  const desktopWidth = await evaluate("document.querySelector('.media-library').getBoundingClientRect().width");
  assert.ok(desktopWidth > 720, `Library width ${desktopWidth}`);
  const desktopColumns = await evaluate("getComputedStyle(document.querySelector('.media-library .grid')).gridTemplateColumns.split(' ').length");
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  assert.ok(await evaluate("getComputedStyle(document.querySelector('.media-library .grid')).gridTemplateColumns.split(' ').length") < desktopColumns);
  await cdp('Emulation.clearDeviceMetricsOverride');
  const uploadButton = text => evaluate(`[...document.querySelector('[aria-label="Upload media"]').querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  await click('.titlebar .primary');
  await waitFor("!!document.querySelector('.image-dialog[open] input[type=file]')");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'Close');
  assert.match(await evaluate("document.querySelector('.image-dialog input[type=file]').parentElement.textContent"), /2 MB maximum/);
  await evaluate("{const input=document.querySelector('.image-dialog input[type=file]'),files=new DataTransfer();files.items.add(new File([new Uint8Array(2*1024*1024+1)],'oversized.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));}");
  await waitFor("document.querySelector('.image-dialog [role=alert]')?.textContent.includes('up to 2 MB')");
  assert.equal(await evaluate("!!document.querySelector('.image-dialog .media-selection')"), false, 'Oversized files never reach upload confirmation');
  const tooLarge = await fetch(new URL('/rigel/api/local/media',url), {method:'POST',headers:{Origin:new URL(url).origin,'Content-Type':'image/png','X-Rigel-Filename':'oversized.png'},body:new Uint8Array(2*1024*1024+1)});
  assert.equal(tooLarge.status,413,'Real API enforces the same configured limit');
  assert.match(await tooLarge.text(), /2 MB/);
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor("!document.querySelector('.image-dialog')");
  assert.equal(await evaluate("document.activeElement.textContent.trim()"), 'Upload');
  await click('.titlebar .primary');
  await waitFor("!!document.querySelector('.image-dialog[open] input[type=file]')");
  await evaluate(`(async () => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const input = document.querySelector('input[type=file]'); const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'fixture.png', {type:'image/png'})); input.files = dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor("!!document.querySelector('.media-selection')");
  await writeFile('_temp/media-upload-preview.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await uploadButton('Import image');
  await waitFor("!document.querySelector('.image-dialog') && !!document.querySelector('.media-library .thumb img')");
  await writeFile('_temp/media-library.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  console.log(`Media desktop width: ${desktopWidth}px; columns: ${desktopColumns}; mobile responsive and modal Escape verified`);
  const uploaded = uploadedURL;
  await waitFor(`!!document.querySelector('.media-library img[src="${uploaded}"]')`);
  assert.equal((await fetch(new URL(uploaded,url))).status, 200);
  const mediaBytes = await readFile('public' + uploaded);
  assert.equal(mediaBytes.toString('base64'), 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII=');
  const metadata = (await (await fetch(new URL('/rigel/media.json', url))).json()).images.find(a => a.url === uploaded);
  const actual = await stat('public' + uploaded);
  assert.equal(metadata.size, actual.size);
  assert.equal(metadata.modified, actual.mtime.toISOString());
  assert.equal(metadata.type, 'image/png');
  const mediaControl = (label, value, event = 'change') => evaluate(`{const el = document.querySelector('.media-tools ${event === 'change' ? 'select' : 'input'}[aria-label="${label}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('${event}', {bubbles:true}));}`);
  const mediaButton = text => evaluate(`[...document.querySelectorAll('.media-library .media-tools button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(text)}).click()`);
  await mediaControl('Media type', 'Images');
  await mediaControl('Modified month', metadata.modified.slice(0,7));
  await mediaControl('Search media', metadata.name, 'input');
  await waitFor("document.querySelectorAll('.media-library .thumb').length === 1");
  await mediaButton('List view');
  await waitFor("document.querySelectorAll('.media-table tbody tr').length === 1");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.media-table th')].map(x=>x.textContent)"), ['File','Type','Size','Modified (UTC)']);
  await click('.media-library .media-file');
  await waitFor("!!document.querySelector('.media-selection')");
  await uploadButton('Cancel');
  await mediaButton('Grid view');
  await waitFor("document.querySelector('.media-library .thumb')?.getAttribute('aria-pressed') === 'true'");
  await mediaButton('List view');
  await waitFor("document.querySelector('.media-library .media-file')?.getAttribute('aria-pressed') === 'true'");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Media type\"]').value"), 'Images');
  await mediaControl('Media type', 'Documents');
  await waitFor("document.querySelector('.media-library [role=status]')?.textContent === 'No media match these filters.'");
  await mediaButton('Reset filters');
  await waitFor("document.querySelectorAll('.media-table tbody tr').length > 0");
  await writeFile('_temp/media-list.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', {width,height:844,deviceScaleFactor:1,mobile:false});
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), 'No list/toolbar page overflow');
    assert.ok(await evaluate("[...document.querySelectorAll('.media-tools > *')].every(el => el.getBoundingClientRect().right <= innerWidth)"));
  }
  await writeFile('_temp/media-list-mobile.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await cdp('Emulation.clearDeviceMetricsOverride');
  await mediaButton('Grid view');
  console.log('PASS: filesystem metadata, combined format/month/search, no matches/reset, grid/list filters and selection, narrow list/toolbar');
  assert.deepEqual(await evaluate("[...document.querySelector('select[aria-label=\\\"Media type\\\"]').options].map(o=>o.text)"), ['All media items','Images','Audio','Video','Documents','Spreadsheets','Archives','Other']);
  const renamedAssets = new Map();
  for (const fixture of mediaFixtures) {
    const expectedURL = '/rigel-media/' + createHash('sha256').update(fixture.bytes).digest('hex') + '.' + fixture.name.split('.').pop();
    if (!originalAssets.has(expectedURL)) created.add(expectedURL);
    await click('.titlebar .primary');
    await waitFor("!!document.querySelector('.image-dialog input[type=file]')");
    await evaluate(`{ const input = document.querySelector('.image-dialog input[type=file]'), dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob('${fixture.bytes.toString('base64')}'), c=>c.charCodeAt(0))], '${fixture.name}', {type:'${fixture.type}'})); input.files = dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor("!!document.querySelector('.media-selection')");
    assert.equal(await evaluate("!!document.querySelector('.media-selection img, .media-selection iframe')"), false);
    await uploadButton('Upload file');
    await waitFor("!document.querySelector('.image-dialog')");
    const listing = await (await fetch(new URL('/rigel/media.json', url))).json();
    const item = listing.assets.find(a=>a.url===expectedURL);
    assert.ok(item); assert.equal(item.type, fixture.type);
    assert.equal(listing.images.some(a=>a.url===expectedURL), false);
    assert.deepEqual(await readFile('public'+expectedURL), fixture.bytes);
    const download = await fetch(new URL(expectedURL,url));
    assert.equal(download.headers.get('content-type'),fixture.type);
    assert.equal(download.headers.get('x-content-type-options'),'nosniff');
    assert.match(download.headers.get('content-disposition'), fixture.category === 'Video' ? /^inline;/ : /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),fixture.bytes);
    await mediaControl('Media type',fixture.category);
    await mediaControl('Modified month',item.modified.slice(0,7));
    await mediaControl('Search media',item.name,'input');
    await waitFor("document.querySelectorAll('.media-library .thumb').length === 1");
    assert.equal(await evaluate("document.querySelector('.media-library .thumb .media-extension').textContent"), fixture.name.split('.').pop().toUpperCase(), 'Extension badge uses the actual file');
    assert.equal(await evaluate("!!document.querySelector('.media-library .thumb img')"),false);
    assert.equal(await evaluate("document.querySelector('.media-search').previousElementSibling.textContent.trim()"),'Reset filters');
    assert.equal(await evaluate("document.querySelector('.media-search').previousElementSibling.previousElementSibling.textContent.trim()"),'Refresh');
    await mediaButton('List view');
    await waitFor("document.querySelectorAll('.media-table tbody tr').length === 1");
    await click('.media-file');
    await waitFor("!!document.querySelector('.media-selection a[download]')");
    assert.equal(await evaluate("document.querySelector('.media-selection a[download]').getAttribute('href')"),expectedURL);
    if (fixture.category === 'Video') {
      await waitFor("document.querySelector('.media-selection video')?.readyState>=2");
      assert.equal(await evaluate("document.querySelector('.media-selection video').controls"), true, 'Metadata editor has a playable video');
      await evaluate("document.querySelector('.media-selection video').play()");
      await waitFor("document.querySelector('.media-selection video').currentTime>0");
      await evaluate("document.querySelector('.media-selection video').pause()");
      const previousTheme = await evaluate("document.documentElement.dataset.theme || ''");
      for (const width of [1440,390]) for (const theme of ['light','dark']) {
        await cdp('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        assert.equal(await evaluate("(() => {const video=document.querySelector('.media-preview video').getBoundingClientRect(),panel=document.querySelector('.media-preview').getBoundingClientRect();return video.left>=panel.left && video.right<=panel.right+1 && document.documentElement.scrollWidth<=innerWidth;})()"), true, 'Video preview fits its container without assuming a ratio');
        await writeFile(`_temp/video-metadata-${width}-${theme}.png`, Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
      }
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(previousTheme)}`);
      await evaluate(`{const input=document.querySelector('[aria-label="Media display name"]');input.value='Fixture movie without extension';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
      await uploadButton('Save');
      await waitFor("[...document.querySelectorAll('.media-selection p')].some(p=>p.textContent.trim()==='Metadata saved.')");
      assert.equal((await readSidecar())[expectedURL].name, 'Fixture movie without extension');
      renamedAssets.set(expectedURL, 'Fixture movie without extension');
      assert.deepEqual(await readFile('public'+expectedURL),fixture.bytes, 'Renaming leaves the video bytes untouched');
    }
    await uploadButton('Cancel');
    if (fixture.category === 'Video') {
      await mediaControl('Search media', 'Fixture movie without extension', 'input');
      await waitFor("document.querySelectorAll('.media-table tbody tr').length===1");
      await mediaButton('Grid view');
      await waitFor("!!document.querySelector('.media-library .thumb[aria-label=\"Fixture movie without extension\"]')");
      assert.equal(await evaluate("document.querySelector('.media-library .thumb .media-extension').textContent"), 'MP4', 'Display-name rename cannot change extension badge');
      const badgeTheme = await evaluate("document.documentElement.dataset.theme || ''");
      for (const width of [1440,390]) for (const theme of ['light','dark']) {
        await cdp('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        assert.equal(await evaluate("[...document.querySelectorAll('.media-library .thumb')].every(button=>{const box=button.getBoundingClientRect(),badge=button.querySelector('.media-extension'),rect=badge.getBoundingClientRect();return rect.top>=box.top && rect.top<box.top+16 && rect.right<=box.right && rect.right>box.right-16 && badge.id===button.getAttribute('aria-describedby');})"), true, 'Badges stay top-right and provide accessible descriptions');
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.media-extension')).fontSize"), '10px', 'Extension badges remain compact');
        await writeFile(`_temp/media-badges-${width}-${theme}.png`, Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
      }
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(badgeTheme)}`);
      await waitFor("document.querySelector('.media-library .thumb video')?.getVideoPlaybackQuality().totalVideoFrames>0");
      assert.deepEqual(await evaluate("(() => {const video=document.querySelector('.media-library .thumb video');return [video.muted,video.controls,video.paused,video.videoWidth>0];})()"), [true,false,true,true], 'Renamed video stays in Video filter with a decoded, silent, nonplaying frame preview');
      await writeFile('_temp/video-library-frame.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    }
    await mediaButton('Reset filters');
    await mediaButton('Grid view');
    console.log(`PASS: ${fixture.category} UI upload -> disk -> category/date/search grid/list -> download exact bytes and safe headers`);
  }
  const repositoryAlt = 'A small repository image';
  await evaluate(`[...document.querySelectorAll('.media-library .thumb')].find(button => button.querySelector('img')?.getAttribute('src') === ${JSON.stringify(uploaded)}).click()`);
  await waitFor("!!document.querySelector('textarea[aria-label=\"Media alt text\"]')");
  await evaluate(`{ const control=document.querySelector('[aria-label="Media alt text"]'); control.value=${JSON.stringify(repositoryAlt)}; control.dispatchEvent(new Event('input',{bubbles:true})); }`);
  await click('.media-selection .media-actions .primary');
  await waitFor("document.querySelector('.media-meta [role=status]')?.textContent === 'Metadata saved.'");
  assert.equal((await readSidecar())[uploaded].alt, repositoryAlt);
  assert.equal((await (await fetch(new URL('/rigel/media.json', url))).json()).images.find(asset => asset.url === uploaded).alt, repositoryAlt);
  assert.deepEqual(await readFile('public' + uploaded), mediaBytes);
  assert.equal(await evaluate("(() => { const left=document.querySelector('.media-preview').getBoundingClientRect(), right=document.querySelector('.media-details').getBoundingClientRect(); return right.left>=left.right && Math.abs(left.width/right.width-1.5)<0.03; })()"), true, 'Metadata modal uses 60/40 desktop columns');
  assert.equal(await evaluate("(() => { const download=document.querySelector('.media-download').getBoundingClientRect(), path=document.querySelector('.media-path').getBoundingClientRect(), cancel=document.querySelector('.media-button-actions button').getBoundingClientRect(); return download.right<=path.left && path.right<=cancel.left && getComputedStyle(document.querySelector('.media-path')).overflowX==='auto'; })()"), true, 'Footer places Download, scrollable code path, then Cancel/Save');
  assert.equal(await evaluate("document.querySelector('.media-path code').textContent"), uploaded);
  await writeFile('_temp/media-alt-desktop.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate("(() => { const preview=document.querySelector('.media-preview').getBoundingClientRect(), fields=document.querySelector('.media-details').getBoundingClientRect(), modal=document.querySelector('.image-picker'); return fields.top>=preview.bottom && modal.scrollWidth<=modal.clientWidth; })()"), true, 'Metadata stacks without overflow on mobile');
  await writeFile('_temp/media-alt-mobile.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await cdp('Emulation.clearDeviceMetricsOverride');
  await click('.media-selection .media-actions button.outlined');
  await open('#nav-pages');
  await waitFor(`!!document.querySelector(${JSON.stringify(editor('Rich copy'))})`);
  await button('Rich copy', 'Insert image');
  await waitFor("!!document.querySelector('[aria-label=\"Choose image\"]')");
  const modalButton = text => evaluate(`[...document.querySelector('[aria-label="Choose image"]').querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  await waitFor("!!document.querySelector('.image-dialog .thumb')");
  assert.equal(await evaluate("[...document.querySelectorAll('.image-dialog .thumb')].every(b=>!!b.querySelector('img'))"), true);
  await modalButton('upload');
  await waitFor("!!document.querySelector('.image-dialog input[type=file]')");
  assert.equal(await evaluate("document.querySelector('.image-dialog input[type=file]').accept.includes('.pdf')"), false);
  await evaluate(`{ const input = document.querySelector('.image-dialog input[type=file]'), dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4'], 'not-an-image.pdf', {type:'application/pdf'})); input.files = dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); }`);
  await waitFor("!!document.querySelector('.image-dialog [role=alert]')");
  assert.equal(await evaluate("!!document.querySelector('.media-selection')"), false);
  await modalButton('url');
  await evaluate(`{ const input = document.querySelector('.image-dialog input[type=url]'); input.value='/rigel-media/document.pdf'; input.dispatchEvent(new Event('input',{bubbles:true})); }`);
  await modalButton('Use this URL');
  await waitFor("!!document.querySelector('.image-dialog [role=alert]')");
  assert.equal(await evaluate("!!document.querySelector('.media-selection')"), false);
  await evaluate("document.querySelector('[aria-label=\"Choose image\"] .media-head .close').click()");
  assert.equal(await readFile(copyFile,'utf8'), originalCopy);
  assert.equal(await evaluate("document.querySelector('.save-button').disabled"), true);
  await type('Rich copy', 'before after');
  await format('Rich copy', 'paragraph');
  await evaluate(`document.querySelector(${JSON.stringify(editor('Rich copy'))}).focus()`);
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  for (let i = 0; i < 5; i++) await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await evaluate('new Promise(r => setTimeout(r, 100))');
  await button('Rich copy','Insert image');
  await modalButton('url');
  const input = (selector, value) => evaluate(`(() => {const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await input('[aria-label="Choose image"] input[type=url]', 'javascript:alert(1)');
  await modalButton('Use this URL');
  await waitFor("!!document.querySelector('[aria-label=\"Choose image\"] [role=alert]')");
  await input('[aria-label="Choose image"] input[type=url]', uploaded);
  await modalButton('Use this URL');
  await input('.media-selection input:not([readonly])', 'Tiny fixture');
  assert.ok(await evaluate("document.querySelector('.media-selection .primary').getBoundingClientRect().width > 80"), 'Picker buttons must not inherit compact rich-text toolbar sizing');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.image-dialog .outlined')).borderTopStyle"), 'solid');
  await writeFile('_temp/media-richtext-picker.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await modalButton('Insert image');
  await waitFor(`!!${root('Rich copy')}.querySelector('.ProseMirror img')`);
  await button('Rich copy','Markdown');
  assert.equal(await source('Rich copy'), `before ![Tiny fixture](${uploaded})after`);
  assert.equal(await readFile(copyFile,'utf8'), originalCopy, 'Insertion is draft-only');
  await click('#nav-media');
  await waitFor("!!document.querySelector('.unsaved-dialog[open]')");
  await choice('Keep editing');
  await click('.save-button');
  await savedFile(copyFile, `![Tiny fixture](${uploaded})`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  await cdp('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 400));
  await waitFor("!!document.querySelector('#nav-media')");
  await click('#nav-media');
  await waitFor("!!document.querySelector('.media-library')");
  await mediaButton('List view');
  await waitFor("!!document.querySelector('.media-library .media-table')");
  await cdp('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 400));
  await waitFor("!!document.querySelector('#nav-media')");
  await click('#nav-media');
  await waitFor("!!document.querySelector('.media-library')");
  await waitFor("!!document.querySelector('.media-library .media-table tbody')");
  assert.equal(await evaluate("!!document.querySelector('.media-library .media-table tbody')"), true, 'Saved media view (list) survives reload');
  await mediaButton('Grid view');
  await waitFor("!!document.querySelector('.media-library .grid')");
  await open('#nav-pages');
  await waitFor(`!!document.querySelector(${JSON.stringify(editor('Rich copy'))})`);
  await button('Rich copy','Visual');
  await button('Rich copy','Insert image');
  await modalButton('library');
  await waitFor("!!document.querySelector('[aria-label=\"Choose image\"] .thumb')");
  await mediaControl('Image format', 'image/png');
  await mediaControl('Search media', metadata.name, 'input');
  await evaluate("[...document.querySelectorAll('.image-dialog .media-views button')].find(b => b.getAttribute('aria-label') === 'List view').click()");
  await waitFor("document.querySelectorAll('.image-dialog .media-file').length === 1");
  await click('.image-dialog .media-file');
  assert.equal(await evaluate("document.querySelector('.media-selection input:not([readonly])').value"), repositoryAlt, 'Fresh picker uses saved repository alt text');
  await modalButton('Back');
  await waitFor("document.querySelector('.image-dialog .media-file')?.getAttribute('aria-pressed') === 'true'");
  assert.equal(await evaluate("document.querySelector('.image-dialog select[aria-label=\\\"Image format\\\"]').value"), 'image/png');
    await evaluate("document.querySelector('.image-dialog .media-head .close').click()");
    assert.equal(await evaluate("document.querySelector('.save-button').disabled"), true);
  await evaluate(`localStorage.setItem('rigelcms.keys', JSON.stringify({unsplash:'synthetic-test-key'}));
    const real = window.fetch; window.tracked=0;
    window.fetch = async (url,...args) => {
      if (String(url).startsWith('https://api.unsplash.com/photos/test/download')) {window.tracked++; return Response.json({});}
      if (String(url).startsWith('https://api.unsplash.com/photos')) return Response.json([{id:'test',urls:{regular:'https://images.unsplash.com/test',small:'https://images.unsplash.com/test'},user:{name:'Fixture photographer'}}]);
      return real(url,...args);
    };`);
  await button('Rich copy','Insert image');
  await modalButton('library');
  await waitFor("!!document.querySelector('.image-dialog .media-file, .image-dialog .thumb')");
  await evaluate(`[...document.querySelectorAll('.image-dialog .media-file, .image-dialog .thumb')].find(button => button.querySelector('img')?.getAttribute('src') === ${JSON.stringify(uploaded)}).click()`);
  await modalButton('Insert image');
  await waitFor(`!!${root('Rich copy')}.querySelector('img[alt="${repositoryAlt}"]')`);
  assert.equal((await readFile(copyFile,'utf8')).includes(repositoryAlt), false, 'Default alt insertion stays unsaved');
  await button('Rich copy','Insert image');
  await modalButton('unsplash');
  await waitFor("!!document.querySelector('[aria-label=\"Choose image\"] .thumb')");
  await click('[aria-label="Choose image"] .thumb');
  await modalButton('Insert image');
  await waitFor('window.tracked === 1');
  await button('Rich copy','Markdown');
  assert.ok((await source('Rich copy')).includes('Fixture photographer'));
  assert.ok((await source('Rich copy')).includes('https://images.unsplash.com/test'));
  assert.ok(!(await readFile(copyFile,'utf8')).includes('Fixture photographer'));
  await click('#nav-media');
  await waitFor("!!document.querySelector('.unsaved-dialog[open]')");
  await choice('Discard changes');
  await waitFor("!!document.querySelector('.media-library')");
  await click('.titlebar .primary');
  await waitFor("!!document.querySelector('.image-dialog[open] .tabs')");
  await writeFile('_temp/media-sources.png', Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.image-dialog .tabs button')].map(b => b.textContent.trim())"), ['upload','url','picsum','pexels','pixabay']);
  await evaluate(`{ localStorage.setItem('rigelcms.keys', JSON.stringify({pexels:'synthetic',pixabay:'synthetic'}));
    const real = window.fetch;
    window.fetch = async (url,...args) => {
      const value = String(url);
      if (value.startsWith('https://api.pexels.com/')) return Response.json({photos:[{src:{large:'https://images.pexels.com/test.png',medium:'https://images.pexels.com/test.png'},photographer:'Fixture'}]});
      if (value.startsWith('https://pixabay.com/api/')) return Response.json({hits:[{largeImageURL:'https://cdn.pixabay.com/test.png',webformatURL:'https://cdn.pixabay.com/test.png',user:'Fixture'}]});
      if (['https://example.com/', 'https://picsum.photos/', 'https://images.pexels.com/', 'https://cdn.pixabay.com/'].some(prefix => value.startsWith(prefix))) {
        const bytes = Uint8Array.from(atob('${pngBase64}'), c => c.charCodeAt(0));
        return new Response(new Blob([bytes, value], {type:'image/png'}));
      }
      return real(url,...args);
    }; }`);
  for (const provider of ['url','picsum','pexels','pixabay']) {
    await uploadButton(provider);
    let remote;
    if (provider === 'url') {
      remote = 'https://example.com/photo.png';
      await input('.image-dialog input[type=url]', remote);
      await uploadButton('Use this URL');
    } else {
      await waitFor("!!document.querySelector('.image-dialog .thumb')");
      await click('.image-dialog .thumb');
      remote = await evaluate("document.querySelector('.media-selection input[readonly]').value");
    }
    const expected = Buffer.concat([Buffer.from(pngBase64, 'base64'), Buffer.from(remote)]);
    const local = '/rigel-media/' + createHash('sha256').update(expected).digest('hex') + '.png';
    if (!originalAssets.has(local)) created.add(local);
    await uploadButton('Import image');
    await waitFor("!document.querySelector('.image-dialog')");
    await waitFor(`!!document.querySelector('.media-library img[src="${local}"]')`);
    const response = await fetch(new URL(local, url));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    assert.deepEqual(await readFile('public' + local), expected);
    const listing = await (await fetch(new URL('/rigel/media.json',url))).json();
    assert.ok(listing.images.some(image => image.url === local));
    console.log(`PASS: ${provider} mocked download -> real POST -> disk/GET bytes and library ${local}`);
    if (provider !== 'pixabay') { await click('.titlebar .primary'); await waitFor("!!document.querySelector('.image-dialog input[type=file]')"); }
  }
  await evaluate('window.mediaReloadMarker = true');
  await cdp('Page.reload');
  await waitFor("!window.mediaReloadMarker && !!document.querySelector('#nav-media')");
  await click('#nav-media');
  for (const asset of [...originalAssets.keys(), ...created]) {
    const name = renamedAssets.get(asset) ?? (baseline.assets ?? baseline.images).find(item => item.url === asset)?.name ?? decodeURIComponent(asset.split("/").pop());
    await waitFor(`!![...document.querySelectorAll(".media-library .thumb, .media-library .media-file")].find(b => b.dataset.tooltip === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})`);
  }
  for (const [asset, bytes] of originalAssets) assert.deepEqual(await readFile('public' + asset), bytes);
  console.log('PASS: reload displays durable imports and all pre-existing user assets unchanged');
  // ── Metadata sidecar: author capture, display-name/title/description rename, safe validation ──
  const medOrigin = new URL(url).origin;
  const csvBytes = Buffer.from('author,value\nAda,1\n');
  const csvURL = '/rigel-media/' + createHash('sha256').update(csvBytes).digest('hex') + '.csv';
  if (!originalAssets.has(csvURL)) created.add(csvURL);
  assert.equal((await readSidecar())[uploadedURL].author, 'Local user', 'Client upload captured Local user author fallback');
  let res = await fetch(new URL('/rigel/api/local/media', url), { method: 'POST', headers: { Origin: medOrigin, 'Content-Type': 'text/csv', 'X-Rigel-Filename': 'meta.csv', 'X-Rigel-Author': 'Ada Lovelace' }, body: csvBytes });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, csvURL);
  assert.equal((await readSidecar())[csvURL].author, 'Ada Lovelace', 'Upload captured saved identity author');
  const metaName = 'Fixture banner', metaTitle = 'A test title', metaDesc = 'Longer description for the asset.';
  res = await fetch(new URL('/rigel/api/local/media', url), { method: 'PUT', headers: { Origin: medOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: csvURL, name: metaName, title: metaTitle, description: metaDesc }) });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.url, csvURL);
  assert.equal(updated.name, metaName);
  assert.equal(updated.title, metaTitle);
  assert.equal(updated.description, metaDesc);
  assert.equal(updated.author, 'Ada Lovelace');
  const meta = (await readSidecar())[csvURL];
  assert.equal(meta.name, metaName);
  assert.equal(meta.title, metaTitle);
  assert.equal(meta.description, metaDesc);
  assert.equal(meta.author, 'Ada Lovelace');
  assert.deepEqual(await readFile('public' + csvURL), csvBytes, 'rename must not touch the real hashed file');
  for (const bad of [
    { url: csvURL, name: '../evil' },
    { url: csvURL, name: 'x'.repeat(200) },
    { url: csvURL, name: 'a b/c' },
    { url: csvURL, author: 'Hacker' },
    { url: '/rigel-media/nope.csv', name: 'X' },
    { url: csvURL, title: 'no', bogus: true },
  ]) {
    const r = await fetch(new URL('/rigel/api/local/media', url), { method: 'PUT', headers: { Origin: medOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(bad) });
    assert.equal(r.status, 400, `expected reject ${JSON.stringify(bad)}`);
  }
  assert.equal((await readSidecar())[csvURL].name, metaName, 'rejected writes leave sidecar unchanged');
  assert.deepEqual(await readFile('public' + csvURL), csvBytes, 'rejected writes leave real file unchanged');
  await evaluate('window.mediaMetaMarker = true');
  await cdp('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 1100));
  await waitFor("!window.mediaMetaMarker && !!document.querySelector('#nav-media')");
  await new Promise(resolve => setTimeout(resolve, 300));
  await click('#nav-media');
  await waitFor("!!document.querySelector('.media-library')");
  await mediaButton('Grid view');
  await waitFor("!!document.querySelector('.media-library .grid')");
  assert.equal(await evaluate(`!![...document.querySelectorAll('.media-library figure')].find(f => f.querySelector('figcaption')?.textContent === ${JSON.stringify(metaName)})`), true, 'Grid shows display name');
  await mediaButton('List view');
  await waitFor(`[...document.querySelectorAll('.media-table .media-file')].some(b => b.textContent.includes(${JSON.stringify(metaName)}))`);
  await evaluate(`[...document.querySelectorAll('.media-table .media-file')].find(b => b.textContent.includes(${JSON.stringify(metaName)})).click()`);
  await waitFor("!!document.querySelector('.media-selection')");
  assert.equal(await evaluate("document.querySelector('.media-path code')?.textContent"), csvURL);
  assert.equal(await evaluate("document.querySelector('.media-selection input[aria-label=\"Media display name\"]')?.value"), metaName);
  assert.equal(await evaluate("document.querySelector('.media-selection input[aria-label=\"Media title\"]')?.value"), metaTitle);
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Media alt text\"]')"), false, 'Nonimages have no alt text field');
  assert.equal(await evaluate("document.querySelector('.media-selection textarea[aria-label=\"Media description\"]')?.value"), metaDesc);
  assert.ok(await evaluate("[...document.querySelectorAll('.media-selection p.hint')].some(p => p.textContent.includes('Author: Ada Lovelace'))"), 'Read-only author displayed');
  assert.equal(await evaluate("document.querySelector('.media-selection a[download]')?.getAttribute('href')"), csvURL);
  assert.ok(await evaluate("[...document.querySelectorAll('.media-selection .media-actions button')].some(b => b.textContent.trim() === 'Save' && b.classList.contains('primary'))"), 'Save button present');
  await click('.media-selection .media-actions .primary');
  await waitFor("[...document.querySelectorAll('.media-selection p')].some(p => p.textContent.trim() === 'Metadata saved.')");
  await click('.media-selection .media-actions button.outlined');
  await waitFor("!document.querySelector('.media-selection')");
  await mediaButton('Grid view');
  console.log('PASS: metadata sidecar author capture, rename/title/description, URL+file unchanged, safe validation, grid/list display name and preview metadata editor');
  await evaluate(`[...document.querySelectorAll('.media-library .thumb')].find(button => button.querySelector('img')?.getAttribute('src') === ${JSON.stringify(uploaded)}).click()`);
  await waitFor("!!document.querySelector('textarea[aria-label=\"Media alt text\"]')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Media alt text\"]').value"), repositoryAlt, 'Alt text survives reload');
  await evaluate("{ const control=document.querySelector('[aria-label=\"Media alt text\"]'); control.value=''; control.dispatchEvent(new Event('input',{bubbles:true})); }");
  await click('.media-selection .media-actions .primary');
  await waitFor("document.querySelector('.media-meta [role=status]')?.textContent === 'Metadata saved.'");
  assert.equal((await readSidecar())[uploaded].alt, '', 'Decorative alt can be cleared');
  await click('.media-selection .media-actions button.outlined');
  console.log('PASS: image-only alt metadata Save/disk/list/reload/clear/default insertion; 60/40 desktop and stacked mobile preview; source bytes preserved');
  assert.deepEqual(errors, []);
  console.log('PASS: Media navigation, Markdown copy-field image pickers, real upload/list/served bytes, cancellation, safe URL, alt text, preserved selection, draft-only insertion, explicit Save persistence, Media unsaved guard, library cancellation, mocked Unsplash tracking/credit');
} finally {
  for (const asset of created) await rm('public' + asset, {force:true});
  socket?.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(copyFile, {force: true});
  if (originalSidecar === null) await rm(sidecarPath, {force: true});
  else await writeFile(sidecarPath, originalSidecar);
}
