import { defineConfig } from "astro/config";

import { rigel } from "@rigel-cms/rigel";
import schema from "./src/content/schema";

const postFields = [
  { key: "title", label: "Article title", type: "string" },
  { key: "date", label: "Date", type: "date" },
  { key: "author", label: "Author", type: "reference", to: "author" },
  { key: "draft", label: "Draft", type: "boolean" },
];

export default defineConfig({
  vite: { server: { watch: { ignored: ["**/_temp/**"] } } },
  integrations: [
    rigel({
      copyDir: "src/content/copy",
      backend: process.env.RIGEL_GITHUB_REPO ? "github" : "local",
      repo: process.env.RIGEL_GITHUB_REPO,
      repoRoot: "",
      demo: process.env.RIGEL_DEMO !== "false",
      schema,
      sidebar: [
        { kind: "heading", label: "Website" },
        { kind: "link", target: { kind: "pages" } },
        { kind: "link", target: { kind: "collection", name: "blog" }, label: "Blog" },
        { kind: "link", target: { kind: "collection", name: "news" }, icon: "megaphone" },
        { kind: "heading", label: "Shared content" },
        { kind: "link", target: { kind: "documents", type: "author" }, icon: "users" },
        { kind: "link", target: { kind: "documents", type: "logoSet" }, icon: "images" },
        { kind: "link", target: { kind: "documents", type: "callout" }, icon: "megaphone" },
        { kind: "link", target: { kind: "menus" } },
        { kind: "heading", label: "Assets" },
        { kind: "link", target: { kind: "media" } },
        { kind: "separator" },
        { kind: "link", target: { kind: "document", type: "settings", id: "settings:site" }, label: "Site settings", icon: "gear" },
        { kind: "link", target: { kind: "document", type: "demo", id: "demo:fields" }, label: "Demo", icon: "squares-four" },
      ],
      preview: {
        documents: {
          page: { url: "/{slug}/", index: "/" },
        },
        collections: {
          blog: { url: "/blog/{slug}/", new: "/preview/blog/" },
          news: { url: "/news/{slug}/", new: "/preview/news/" },
        },
      },
      menus: { folder: "src/content/menus", maxDepth: 3 },
      collections: [
        {
          name: "blog",
          label: "Blogs",
          folder: "src/content/blog",
          fields: [...postFields, { key: "tags", label: "Tags", type: "tags" }],
          columns: ["title", "date", "author", "tags"],
        },
        {
          name: "news",
          label: "News",
          folder: "src/content/news",
          fields: postFields.map(field => field.key === "author" ? { ...field, label: "Authors", multiple: true } : field),
          columns: ["title", "date", "author"],
        },
      ],
    }),
  ],
});
