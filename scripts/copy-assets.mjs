import { copyFile, cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../index.html", import.meta.url),
  new URL("../public/index.html", import.meta.url)
);
await copyFile(
  new URL("../civics-data.js", import.meta.url),
  new URL("../public/civics-data.js", import.meta.url)
);
await copyFile(
  new URL("../_headers", import.meta.url),
  new URL("../public/_headers", import.meta.url)
);
await cp(
  new URL("../law-data/", import.meta.url),
  new URL("../public/law-data/", import.meta.url),
  { recursive: true, force: true }
);
