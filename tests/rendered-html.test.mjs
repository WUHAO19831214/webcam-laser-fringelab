import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished FringeLab experiment bench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>FringeLab｜激光干涉衍射分析实验台<\/title>/i);
  assert.match(html, /FRINGELAB/);
  assert.match(html, /把光屏上的条纹/);
  assert.match(html, /相对光强剖面/);
  assert.match(html, /计算自动结果/);
  assert.match(html, /打开计算器/);
  assert.doesNotMatch(html, /参考值偏差|class="stage-footer"/);
  assert.match(html, /峰值≤98%/);
  assert.match(html, /理想模型拟合/);
  assert.match(html, /拖动四角方块调整长宽/);
  assert.match(html, /标尺套合/);
  assert.match(html, /RULER FIT/);
  assert.match(html, /自动识别刻度尺/);
  assert.match(html, /框选实物尺/);
  assert.match(html, /两点实际距离/);
  assert.match(html, /双缝干涉/);
  assert.match(html, /单缝衍射/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships science documentation and no disposable starter preview", async () => {
  const [packageJson, basis, protocol, calibration, validation] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("docs/SCIENTIFIC_BASIS.md", root), "utf8"),
    readFile(new URL("docs/MEASUREMENT_PROTOCOL.md", root), "utf8"),
    readFile(new URL("docs/CALIBRATION.md", root), "utf8"),
    readFile(new URL("docs/VALIDATION.md", root), "utf8"),
  ]);

  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(basis, /相对光强（相机响应）/);
  assert.match(protocol, /激光安全/);
  assert.match(calibration, /空间标定/);
  assert.match(validation, /仿真/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
  await assert.rejects(access(new URL("app/_sites-preview/preview.css", root)));
});
