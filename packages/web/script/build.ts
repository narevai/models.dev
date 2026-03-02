#!/usr/bin/env bun

import { Rendered, Providers } from "../src/render";
import fs from "fs/promises";
import path from "path";
import { $ } from "bun";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "browser",
  external: [
    "/src/index.css",
    "/logos/*",
  ],
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

let html = await Bun.file("./dist/index.html").text();
html = html.replace("<!--static-->", Rendered);
await Bun.write("./dist/_index.html", html);
await Bun.write("./dist/_api.json", JSON.stringify(Providers));

await fs.unlink("./dist/index.html");
