import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

export async function checkSeo({ cdp, evaluate, waitFor }) {
  const manifest = await evaluate("fetch('/rigel/manifest.json').then(response => response.json())");
  const pages = manifest.documents.filter(doc => !manifest.schema.documents.find(type => type.name === doc.type).shared);
  const fixtures = [
    { slug: 'home', file: 'src/content/pages/home.json', route: '/' },
    { slug: 'about', file: 'src/content/pages/about.json', route: '/about/' },
    { collection: 'blog', slug: 'first-post', file: 'src/content/blog/first-post.json', route: '/blog/first-post/' },
    { collection: 'news', slug: 'launch-week', file: 'src/content/news/launch-week.json', route: '/news/launch-week/' },
  ];
  const originals = await Promise.all(fixtures.map(item => readFile(item.file, 'utf8')));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const open = async item => {
    await click(item.collection ? `[data-collection="${item.collection}"]` : '#nav-pages');
    await waitFor("!!document.querySelector('tbody .table-link')");
    if (item.drafted) assert.equal(await evaluate(`!![...document.querySelectorAll('tbody tr')].find(row => row.cells[1].textContent.trim() === ${JSON.stringify(item.slug)}).querySelector('.badge')`), true, 'Saved drafts are marked in page lists');
    await evaluate(`[...document.querySelectorAll('tbody tr')].find(row => row.cells[1].textContent.trim() === ${JSON.stringify(item.slug)}).querySelector('.table-link').click()`);
    await waitFor("document.querySelector('.canvas-stage')?.dataset.ready === 'true'");
  };
  const input = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const image = '/demo/landscape.jpg';
  const absoluteImage = new URL(image, process.env.RIGEL_URL || 'http://localhost:4321/rigel/').href;
  const chooseImage = async attr => {
    await click(`[${attr}=ogImage] .image-field button`);
    await waitFor("!!document.querySelector('.image-dialog[open]')");
    await evaluate("[...document.querySelectorAll('.image-dialog .tabs button')].find(button => button.textContent.trim() === 'url').click()");
    await input('.image-dialog input[type=url]', image);
    await evaluate("[...document.querySelectorAll('.image-dialog button')].find(button => button.textContent.trim() === 'Use this URL').click()");
    await waitFor("!!document.querySelector('.image-dialog .media-selection')");
    await click('.image-dialog .media-actions .primary');
    await waitFor("!document.querySelector('.image-dialog[open]')");
  };
  try {
    for (const page of pages) {
      await open(page);
      assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Edit name\"]')"), false);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.page-properties-header h3, #properties-content > section > h3')].map(heading => heading.textContent)"), ['Page properties', 'Structure']);
      await evaluate("window.pageNameControl = document.querySelector('.document-properties [data-schema-path=title] input'); window.draftControl = document.querySelector('.document-properties [data-schema-path=draft] input[role=switch]')");
      assert.equal(await evaluate("!!window.pageNameControl && !!window.draftControl"), true);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.panel-tabs [role=tab]')].map(tab => tab.textContent)"), ['Content', 'SEO']);
      await click('#properties-tab-seo');
      assert.equal(await evaluate("!!document.querySelector('#properties-seo [data-schema-path=ogImage] .image-field')"), true, 'Every website page has a social image picker in SEO');
      assert.equal(await evaluate("!document.querySelector('#properties-seo').hidden && document.querySelector('#properties-content').hidden && !!document.querySelector('[data-schema-path=metaTitle] input') && !!document.querySelector('[data-schema-path=description] textarea')"), true);
      await evaluate("document.querySelector('.visual-editor iframe').contentDocument.querySelector('h1').click()");
      await waitFor("document.querySelector('#properties-tab-content').getAttribute('aria-selected') === 'true' && !!document.activeElement?.closest('.section-properties')");
      assert.equal(await evaluate("window.pageNameControl === document.querySelector('.document-properties [data-schema-path=title] input') && window.draftControl === document.querySelector('.document-properties [data-schema-path=draft] input[role=switch]')"), true, 'Page properties remain mounted when selecting sections');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.page-properties-header h3, #properties-content > section > h3')].map(heading => heading.textContent)"), ['Page properties', 'Structure', 'Section properties']);
      await evaluate("document.querySelector('.structure-row').click()");
      assert.equal(await evaluate("window.pageNameControl === document.querySelector('.document-properties [data-schema-path=title] input')"), true);
      assert.equal(await evaluate("(() => { const panel = document.querySelector('.schema-panel').getBoundingClientRect(), name = window.pageNameControl.getBoundingClientRect(), draft = window.draftControl.getBoundingClientRect(); return name.top >= panel.top && draft.bottom <= panel.bottom; })()"), true, 'Page name and Draft stay visible while section properties are focused');
      if (page.slug === 'home') await writeFile('_temp/page-properties.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    for (const item of fixtures) {
      await open(item);
      const frame = "document.querySelector('.visual-editor iframe')";
      const heading = await evaluate(`${frame}.contentDocument.querySelector('h1').textContent`);
      const originalSeo = await evaluate("document.querySelector('.seo-fields input').value");
      const name = `Renamed ${item.collection ?? 'page'} ${item.slug}`;
      const attr = item.collection ? 'data-collection-field' : 'data-schema-path';
      await input(`[${attr}=title] input`, name);
      if (!item.collection) await click('[data-schema-path=draft] input[role=switch]');
      assert.equal(await evaluate("document.querySelector('.titlebar h2').textContent"), name);
      assert.equal(await evaluate("document.querySelector('.seo-fields input').value"), originalSeo, 'Renaming content does not overwrite SEO title');
      assert.equal(await readFile(item.file, 'utf8'), originals[fixtures.indexOf(item)], 'Page properties do not autosave or change the URL');
      await evaluate("document.querySelector('#properties-tab-content').focus()");
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
      await waitFor("document.activeElement?.id === 'properties-tab-seo' && !document.querySelector('#properties-seo').hidden");
      const title = `SEO title ${item.collection ?? 'page'} ${item.slug}`;
      const description = `Saved SEO description for ${item.route}`;
      for (const [key, cases] of [
        ['metaTitle', [['', 'empty'], ['Tiny', 'danger'], ['T'.repeat(40), 'warning'], ['T'.repeat(50), 'success'], ['T'.repeat(60), 'success'], ['T'.repeat(61), 'danger'], ['🌟', 'danger']]],
        ['description', [['', 'empty'], ['Short', 'danger'], ['D'.repeat(100), 'warning'], ['D'.repeat(120), 'success'], ['D'.repeat(160), 'success'], ['D'.repeat(161), 'danger']]],
      ]) {
        for (const [value, tone] of cases) {
          await input(`[${attr}=${key}] ${key === 'metaTitle' ? 'input' : 'textarea'}`, value);
          assert.equal(await evaluate(`document.querySelector('[data-seo-length=${key}]').dataset.tone`), tone);
          assert.equal(await evaluate(`document.querySelector('[data-seo-length=${key}]').firstElementChild.getAttribute('role')`), 'meter', 'Length bar sits before the recommendation and counter');
          assert.equal(await evaluate(`Number(document.querySelector('[data-seo-length=${key}] [role=meter]').getAttribute('aria-valuenow'))`), [...value].length);
          assert.equal(await evaluate(`document.querySelector('[data-seo-length=${key}] .seo-length-count').textContent`), `${[...value].length}/${key === 'metaTitle' ? 60 : 160}`);
        }
      }
      await input(`[${attr}=metaTitle] input`, title);
      await input(`[${attr}=description] textarea`, description);
      await chooseImage(attr);
      assert.equal(await evaluate(`document.querySelector('[${attr}=ogImage] .image-field img').getAttribute('src')`), image);
      assert.equal(await evaluate(`(() => { const field=document.querySelector('[${attr}=ogImage] .image-field'), bounds=field.getBoundingClientRect(); return [...field.children].every(child => child.getBoundingClientRect().right <= bounds.right); })()`), true, 'Social image controls fit the properties panel');
      assert.equal(await evaluate(`(() => { const field=document.querySelector('[${attr}=ogImage] .image-field'), preview=field.querySelector('.preview'), rect=preview.getBoundingClientRect(), button=field.querySelector('button').getBoundingClientRect(), style=getComputedStyle(preview); return rect.width <= 400 && Math.abs(rect.width-field.getBoundingClientRect().width)<1 && Math.abs(rect.width/rect.height-1200/628)<0.02 && style.objectFit==='cover' && style.objectPosition==='50% 50%' && button.top>=rect.bottom; })()`), true, 'Social image fills the sidebar up to 400px with a centered 1200:628 crop and controls below');
      assert.equal(await evaluate(`document.querySelector('[${attr}=ogImage]').textContent.includes('1200 × 628 px')`), true);
      assert.equal(await readFile(item.file, 'utf8'), originals[fixtures.indexOf(item)], 'SEO edits stay unsaved');
      assert.equal(await evaluate(`${frame}.contentDocument.querySelector('h1').textContent`), item.collection ? name : heading, 'SEO title is independent of the content heading');
      await click('#properties-tab-content');
      await click('#properties-tab-seo');
      assert.equal(await evaluate(`document.querySelector('[${attr}=metaTitle] input').value`), title);
      if (item.slug === 'home') await writeFile('_temp/page-seo.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await click('.save-button');
      await waitFor("document.querySelector('.save-status')?.textContent.trim() === 'Saved'");
      const saved = await readFile(item.file, 'utf8');
      assert(saved.includes(title) && saved.includes(description), 'Explicit Save persists text metadata');
      const savedData = JSON.parse(saved);
      assert.equal((item.collection ? savedData.frontmatter : savedData).ogImage, image, 'Explicit Save persists the social image');
      assert(saved.includes(name), 'Explicit Save persists the independently edited CMS name');
      if (!item.collection) assert.equal(JSON.parse(saved).draft, true);
      for (let attempt = 0; attempt < 100; attempt++) {
        const head = await evaluate(`fetch(${JSON.stringify(item.route)}).then(response => response.text()).then(html => { const doc = new DOMParser().parseFromString(html, 'text/html'); return { title: doc.title, description: doc.querySelector('meta[name=description]')?.content, ogImage: doc.querySelector('meta[property=\"og:image\"]')?.content, twitterImage: doc.querySelector('meta[name=\"twitter:image\"]')?.content }; })`);
        if (head.title === `${title} | Rigel` && head.description === description && head.ogImage === absoluteImage && head.twitterImage === absoluteImage) break;
        if (attempt === 99) assert.fail(`Actual public metadata did not update for ${item.route}: ${JSON.stringify(head)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await cdp('Page.reload');
      await waitFor("!!document.querySelector('[data-doctype=author]')");
      await open({ ...item, drafted: !item.collection });
      if (!item.collection) assert.equal(await evaluate("document.querySelector('[data-schema-path=draft] input[role=switch]').checked"), true, 'Draft state survives Save and reload');
      await click('#properties-tab-seo');
      assert.equal(await evaluate(`document.querySelector('[${attr}=metaTitle] input').value`), title);
      assert.equal(await evaluate(`document.querySelector('[${attr}=description] textarea').value`), description);
      assert.equal(await evaluate(`document.querySelector('[${attr}=ogImage] .image-field img').getAttribute('src')`), image, 'Social image survives reload');
      await click(`[${attr}=ogImage] [aria-label="Remove image"]`);
      assert.equal(await readFile(item.file, 'utf8'), saved, 'Removing a social image does not autosave');
      await click('.save-button');
      await waitFor("document.querySelector('.save-status')?.textContent.trim() === 'Saved'");
      const cleared = JSON.parse(await readFile(item.file, 'utf8'));
      assert.equal((item.collection ? cleared.frontmatter : cleared).ogImage, '');
      await waitFor(`fetch(${JSON.stringify(item.route)}).then(response => response.text()).then(html => { const head=new DOMParser().parseFromString(html,'text/html'); return !head.querySelector('meta[property="og:image"], meta[name="twitter:image"]'); })`);
    }
    console.log('PASS: Content/SEO tabs on all website pages and articles, keyboard navigation, canvas selection returns to Content, independent SEO values, explicit Save/file/public head/reload and exact fixture restoration');
  } finally {
    await Promise.all(fixtures.map((item, index) => writeFile(item.file, originals[index])));
    await cdp('Page.reload');
    await waitFor("!!document.querySelector('[data-doctype=author]')");
  }
}
