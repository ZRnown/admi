import test from "node:test";
import assert from "node:assert/strict";

import Jimp from "jimp";
import {
  applyWatermarkCoverToImageBuffer,
  buildWatermarkCoverDrawboxFilter,
  resolveWatermarkCoverConfig,
} from "../src/watermarkCover.ts";

test("applyWatermarkCoverToImageBuffer covers configured image region", async () => {
  const image = await new Jimp(20, 20, 0xffffffff);
  const input = await image.getBufferAsync(Jimp.MIME_PNG);

  const output = await applyWatermarkCoverToImageBuffer(input, {
    enabled: true,
    applyToImages: true,
    regions: [{ x: 0, y: 0, width: 0.5, height: 0.5, color: "#000000", opacity: 100 }],
  });

  const result = await Jimp.read(output);
  const covered = Jimp.intToRGBA(result.getPixelColor(2, 2));
  const untouched = Jimp.intToRGBA(result.getPixelColor(18, 18));

  assert.equal(covered.r, 0);
  assert.equal(covered.g, 0);
  assert.equal(covered.b, 0);
  assert.equal(untouched.r, 255);
});

test("buildWatermarkCoverDrawboxFilter emits ffmpeg drawbox filters", () => {
  const filter = buildWatermarkCoverDrawboxFilter({
    enabled: true,
    applyToVideos: true,
    regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, color: "#112233", opacity: 80 }],
  });

  assert.match(filter || "", /drawbox=x=iw\*0\.100000/);
  assert.match(filter || "", /color=0x112233@0\.80/);
});

test("resolveWatermarkCoverConfig lets rule override global and disable cover", () => {
  const globalConfig = {
    enabled: true,
    applyToImages: true,
    applyToVideos: false,
    regions: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
  };

  assert.deepEqual(resolveWatermarkCoverConfig(globalConfig, { enabled: true, applyToVideos: true }), {
    enabled: true,
    applyToImages: true,
    applyToVideos: true,
    regions: globalConfig.regions,
  });
  assert.equal(resolveWatermarkCoverConfig(globalConfig, { enabled: false }), undefined);
});
