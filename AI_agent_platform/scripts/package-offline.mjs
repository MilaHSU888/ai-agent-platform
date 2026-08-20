import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(projectRoot, "offline-dist");
const exportDir = path.join(projectRoot, "exports");
const outputPath = path.join(exportDir, "昇達AI工具平台_離線展示.html");

const assetMimeTypes = {
  "ai-balloon-s01.png": "image/png",
  "ai-balloon-s02.png": "image/png",
  "ai-balloon-s03.png": "image/png",
  "ai-balloon-s04.png": "image/png",
  "ai-vision-export-template.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function resolveBuildAsset(reference) {
  const cleanReference = reference.replace(/^\.\//, "");
  return path.join(buildDir, cleanReference);
}

let html = await readFile(path.join(buildDir, "offline.html"), "utf8");

html = await replaceAsync(
  html,
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/gi,
  async (_match, href) => {
    const css = await readFile(resolveBuildAsset(href), "utf8");
    return `<style>${css}</style>`;
  },
);

html = await replaceAsync(
  html,
  /<script\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*><\/script>/gi,
  async (_match, source) => {
    const javascript = await readFile(resolveBuildAsset(source), "utf8");
    return `<script type="module">${javascript.replaceAll("</script>", "<\\/script>")}</script>`;
  },
);

for (const [assetName, mimeType] of Object.entries(assetMimeTypes)) {
  const asset = await readFile(path.join(projectRoot, "public", assetName));
  const dataUrl = `data:${mimeType};base64,${asset.toString("base64")}`;
  html = html.replaceAll(`/${assetName}`, dataUrl).replaceAll(`./${assetName}`, dataUrl);
}

html = html
  .replace(/<link\b[^>]*\brel=["'](?:icon|modulepreload)["'][^>]*>/gi, "")
  .replace("</head>", "<meta name=\"offline-build\" content=\"single-file\" /></head>");

await mkdir(exportDir, { recursive: true });
await writeFile(outputPath, html);

const unresolvedDependencies = [
  /<script\b[^>]*\bsrc=/i,
  /<link\b[^>]*\brel=["']stylesheet["']/i,
  /(?:src|href)=["']\/(?!\/)/i,
];

if (unresolvedDependencies.some((pattern) => pattern.test(html))) {
  throw new Error("離線 HTML 仍包含未內嵌的相依資源");
}

console.log(outputPath);

async function replaceAsync(source, expression, replacer) {
  const matches = [...source.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let result = source;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    result = `${result.slice(0, match.index)}${replacements[index]}${result.slice(match.index + match[0].length)}`;
  }
  return result;
}
