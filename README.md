# Rigel starter

[![Rigel CMS](https://img.shields.io/npm/v/@rigel-cms/rigel?label=Rigel%20CMS)](https://www.npmjs.com/package/@rigel-cms/rigel)
[![Astro 7](https://img.shields.io/badge/Astro-7-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

An Astro website with Rigel CMS configured for pages, blog posts, news and footer menus. Your content stays in the repository.

## Get started

Use Node.js 24 and pnpm 11:

```sh
pnpm install
pnpm dev
```

Open the local URL printed in your terminal. Visit `/rigel/` to edit content. Local mode writes files when you press Save; it does not create Git commits.

- `astro.config.mjs`: Rigel configuration and preview mappings.
- `src/content/schema.ts`: editable page and shared-content fields.
- `src/content/`: sample content to replace with your own.

Run `pnpm build` to build the website. GitHub editing requires a separate [authentication setup](https://rigelcms.dev/docs/github-publishing/).

[Documentation](https://rigelcms.dev/docs/) · [Rigel CMS source](https://github.com/rigel-cms/rigel)

## Optional English and French content

The default starter uses one content language. Enable the separate English and French example before starting or building:

```sh
RIGEL_CONTENT_MULTILANG=true pnpm dev
RIGEL_CONTENT_MULTILANG=true pnpm build
```

Visit `/en/studio/` and `/fr/studio/`, or `/en/articles/publishing/` and `/fr/articles/publishing/`. The example lives in `src/content/multilang/`; it leaves the original pages and articles in place. Each language has its own page type, section layout and article collection. Authors, logos and media are shared. Draft pages and articles stay out of production website routes.

In the editor, **Content language** filters annotated page types and collections. Unannotated content remains available in both languages. Settings > Interface changes the editor interface language; it does not translate content or choose its language. Settings > Content controls whether global search covers all content languages or only the current one. The website example reuses the existing navigation and footer rather than translating that shared chrome.

Run `RIGEL_CONTENT_MULTILANG=true pnpm test` for production route and content checks. With the opt-in development server already running, run `RIGEL_CONTENT_MULTILANG=true RIGEL_URL=http://localhost:4321/rigel/ pnpm test:browser multilang` for the browser regression. Run the same browser command without `RIGEL_CONTENT_MULTILANG` against a default server to check that the selector and example stay disabled. Browser checks use an isolated Chrome profile and restore edited fixture bytes; run them sequentially.

## Page templates

Core pages remain uncategorized. Legal is a native `DocumentDef.category` template, not an editable category field. Visit `/legal/example/`; its copy is a layout specimen, not a ready-to-use legal policy.

Appearance is a per-page property, not a category or route prefix. The native **Dark theme** switch in page properties changes the layout's color tokens; pages without it remain light. `/perspective/` is an ordinary Core page with this property enabled.

With multilingual content enabled, Legal examples are available under `/en/legal/example/` and `/fr/legal/example/`. Each template declares its own allowed sections and creation defaults. Newly saved Legal pages use the legal route prefix; Core pages keep ordinary routes regardless of theme. Editor and website mappings are in `astro.config.mjs`. Restart the local development server after schema changes so its manifest and write routes use the new definitions.

Rigel CMS 1.4.0 provides the Pages Core/Legal/All filter, live page and article search, and the page-template creation dialog. Save a newly created schema page before opening its visual preview. Inline editing starts with Properties closed; use the panel toggle to open page fields or SEO settings.

## License

[Apache-2.0](LICENSE). Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)).
