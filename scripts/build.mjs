// dist/(拡張機能本体)を作る
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  target: "chrome120",
  charset: "utf8",
  legalComments: "none",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

const configs = [
  { ...common, entryPoints: [`${root}src/background/index.ts`], outfile: `${dist}/background.js`, format: "esm" },
  { ...common, entryPoints: [`${root}src/content/index.ts`], outfile: `${dist}/content.js`, format: "iife" },
  { ...common, entryPoints: [`${root}src/popup/main.ts`], outfile: `${dist}/popup.js`, format: "iife" },
  { ...common, entryPoints: [`${root}src/options/index.ts`], outfile: `${dist}/options.js`, format: "iife" },
];

/**
 * 既知の広告枠を「判定が終わるまで」ぼかす CSS を、検出に使うのと同じセレクタ一覧から作る。
 * manifest の css は DOM の組み立て前に適用されるので、広告が一瞬見えることがない。
 * 状態属性(判定結果・判定しない枠)が付いたら外れる。html の属性で全体の ON/OFF を切り替える。
 */
async function contentCss() {
  const base = await readFile(`${root}static/content.css`, "utf8");
  const sel = JSON.parse(await readFile(`${root}src/content/selectors.json`, "utf8"));
  const list = [...sel.adSelectors, ...sel.widgetSelectors].join(",\n  ");
  return `${base}
/* 判定前ぼかし(scripts/build.mjs が src/content/selectors.json から生成) */
html[data-ks-preblur] :is(
  ${list}
):not([data-ks-state]) {
  filter: blur(3px) saturate(0.4) !important;
  opacity: 0.6 !important;
}
`;
}

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await cp(`${root}static`, dist, { recursive: true });
  await writeFile(`${dist}/content.css`, await contentCss());
}

await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  fsWatch(`${root}static`, { recursive: true }, () => {
    copyStatic().then(() => console.log("static copied"), console.error);
  });
  fsWatch(`${root}src/content/selectors.json`, () => {
    copyStatic().then(() => console.log("static copied"), console.error);
  });
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
