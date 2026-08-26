import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

const projectRoot = new URL("../", import.meta.url);

test("AI 識圖大師歸屬製造二部且部門工具數同步", async () => {
  const page = await readFile(new URL("app/page.tsx", projectRoot), "utf8");

  assert.match(page, /id: "vision", name: "AI 識圖大師"[^\n]+department: "mfg2"/);
  assert.doesNotMatch(page, /id: "vision", name: "AI 識圖大師"[^\n]+department: "rd"/);
  assert.match(page, /id: "rd", name: "研發部"[^\n]+tools: 7/);
  assert.match(page, /id: "mfg2", name: "製造二部"[^\n]+tools: 6/);
});

test("AI 識圖使用一製程全圖並提供縮放與不遮擋的就近修正", async () => {
  const [page, css, image] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/globals.css", projectRoot), "utf8"),
    readFile(new URL("public/ai-vision-process1.png", projectRoot)),
  ]);

  assert.match(page, /5\.804LY0241001B0檢規\.pdf/);
  assert.match(page, /ai-vision-process1\.png/);
  assert.match(page, /aria-label="縮小工程圖"/);
  assert.match(page, /aria-label="放大工程圖"/);
  assert.match(page, /changeZoom\(\(\) => 100\)/);
  assert.match(page, /focusRequest/);
  assert.match(page, /setFocusRequest\(\(current\) => current \+ 1\)/);
  assert.match(page, /selectReviewField\(field\.id\)/);
  assert.match(page, /drawing-inline-editor/);
  assert.match(page, /圖旁直接修正/);
  assert.match(page, /activeHighlightRef/);
  assert.match(page, /getBoundingClientRect\(\)/);
  assert.match(page, /targetCenterX - canvas\.clientWidth \/ 2/);
  assert.match(page, /targetCenterY - canvas\.clientHeight \/ 2/);
  assert.match(page, /window\.requestAnimationFrame/);
  assert.match(page, /behavior: "auto"/);
  assert.match(page, /calc\(\$\{activeField\.highlight\.left\}% - 12px\)/);
  assert.match(page, /calc\(\$\{activeField\.highlight\.width\}% \+ 24px\)/);
  assert.match(page, /calc\(\$\{activeField\.highlight\.left\}% - 30px\)/);
  assert.match(css, /\.drawing-inline-editor[^}]*transform:translate\(-100%,-50%\)/);
  assert.match(css, /\.drawing-inline-editor::after/);
  assert.match(css, /\.real-source-highlight[^}]*border:0[^}]*outline:2px solid[^}]*outline-offset:5px[^}]*background:transparent/);
  assert.match(css, /\.vision-layout > \*[^}]*min-height:0/);
  assert.match(css, /\.drawing-workspace[^}]*min-height:0[^}]*height:100%[^}]*overflow:hidden/);
  assert.match(css, /\.drawing-canvas[^}]*min-height:0[^}]*overflow:scroll[^}]*touch-action:pan-x pan-y[^}]*scroll-behavior:auto/);
  assert.doesNotMatch(css, /\.real-report-sheet[^}]*transition:width/);
  assert.match(css, /\.review-card\.active[^}]*background:#eef0ff/);
  assert.match(css, /\.review-card\.active \.review-card-summary[^}]*background:#e7e9ff/);
  assert.doesNotMatch(page, /正在核對/);

  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(image.readUInt32BE(16), 1800);
  assert.equal(image.readUInt32BE(20), 1273);
});

test("人工核對區只顯示一欄目前結果並保留初始辨識值", async () => {
  const page = await readFile(new URL("app/page.tsx", projectRoot), "utf8");

  assert.match(page, /single-result-field/);
  assert.match(page, /目前辨識結果（可直接修改）/);
  assert.doesNotMatch(page, /原圖標註|AI →/);
  assert.doesNotMatch(page, /\{field\.original\}/);

  assert.match(page, /value: "42 ±0,7", original: "42 ±0,7"/);
  assert.match(page, /value: "28,4 ±0,5", original: "28,4 ±0,5"/);
});

test("右側核對資料依球標編號由小到大排列", async () => {
  const page = await readFile(new URL("app/page.tsx", projectRoot), "utf8");

  assert.match(page, /orderedReviewFields = useMemo\(\(\) => \[\.\.\.fields\]\.sort\(\(left, right\) => left\.marker - right\.marker\)/);
  assert.match(page, /orderedReviewFields\.map\(\(field\)/);
  assert.doesNotMatch(page, /review-pinned-final|orderedReviewFields\.at\(-1\)/);
  assert.match(page, /一製程 13 筆辨識資料已全部展開/);
  assert.match(page, /className="ready"/);

  const css = await readFile(new URL("app/globals.css", projectRoot), "utf8");
  assert.match(css, /\.vision-app[^}]*height:100vh[^}]*overflow:hidden/);
  assert.match(css, /\.vision-layout[^}]*height:calc\(100vh - 136px\)/);
  assert.match(css, /\.review-panel[^}]*height:calc\(100vh - 136px\)[^}]*grid-template-rows:auto auto minmax\(0,1fr\) auto/);
  assert.match(css, /\.review-list[^}]*overflow-y:auto/);
  assert.match(css, /\.review-footer[^}]*position:relative/);

  const markers = [...page.matchAll(/id: "balloon-(\d+)", marker: (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(markers, Array.from({ length: 13 }, (_, index) => index + 1));
});

test("Excel 匯出保留客戶版型、僅製程 001，量測欄留白且判定為待檢", async () => {
  const [page, template] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("public/ai-vision-export-template.xlsx", projectRoot)),
  ]);
  const files = unzipSync(template);
  const mainSheetXml = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const mainSheetRels = strFromU8(files["xl/worksheets/_rels/sheet1.xml.rels"]);
  const sharedStringsXml = strFromU8(files["xl/sharedStrings.xml"]);
  const sharedStrings = [...sharedStringsXml.matchAll(/<x:si>([\s\S]*?)<\/x:si>/g)].map((match) =>
    [...match[1].matchAll(/<x:t[^>]*>([\s\S]*?)<\/x:t>/g)].map((text) => text[1]).join(""),
  );
  const getCellXml = (reference) => {
    const start = mainSheetXml.indexOf(`<x:c r="${reference}"`);
    if (start === -1) return "";
    const openingEnd = mainSheetXml.indexOf(">", start);
    const opening = mainSheetXml.slice(start, openingEnd + 1);
    if (opening.endsWith("/>")) return opening;
    const closingEnd = mainSheetXml.indexOf("</x:c>", openingEnd);
    return mainSheetXml.slice(start, closingEnd + "</x:c>".length);
  };
  const getCellValue = (reference) => {
    const cell = getCellXml(reference);
    const rawValue = cell.match(/<x:v>([\s\S]*?)<\/x:v>/)?.[1] ?? "";
    if (/t="s"/.test(cell) && rawValue !== "") {
      return sharedStrings[Number(rawValue)] ?? "";
    }
    return rawValue;
  };
  const workbookXml = Object.entries(files)
    .filter(([path]) => path.endsWith(".xml"))
    .map(([, data]) => strFromU8(data))
    .join("\n");

  assert.match(workbookXml, /品質檢驗紀錄/);
  assert.equal(getCellValue("K25"), "自動2.5D設備數據");
  assert.equal(getCellValue("M25"), "手動量測");
  assert.equal(getCellValue("N25"), "覆檢");
  assert.equal(getCellValue("O25"), "再覆檢");
  assert.equal(getCellValue("P25"), "判定");
  assert.match(workbookXml, /檢驗備註/);
  assert.match(workbookXml, /儀器/);
  assert.match(workbookXml, /單位/);
  assert.match(workbookXml, /公差/);
  assert.match(workbookXml, /804LY0241001B0/);
  assert.match(mainSheetXml, /<x:c r="E6"[^>]*>[\s\S]*?<x:v>13<\/x:v><\/x:c>/);
  assert.doesNotMatch(workbookXml, /\{\{EXPORTED_AT\}\}/);
  assert.doesNotMatch(mainSheetRels, /relationships\/drawing/);
  assert.doesNotMatch(workbookXml, /\{\{(?:VALUE|STATUS)_\d+\}\}/);
  for (let row = 26; row <= 43; row += 1) {
    assert.equal(getCellValue(`B${row}`), "001");
    for (const column of ["K", "M", "N", "O"]) {
      assert.equal(getCellValue(`${column}${row}`), "");
    }
    assert.equal(getCellValue(`P${row}`), "待檢");
  }
  for (let row = 44; row <= 80; row += 1) {
    for (const column of "BCDEFGHIJKLMNOPQRST") {
      assert.equal(getCellValue(`${column}${row}`), "");
    }
  }
  assert.match(page, /804LY0241001B0_品質檢驗紀錄\.xlsx/);
});
