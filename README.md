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

## License

[Apache-2.0](LICENSE). Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)).
