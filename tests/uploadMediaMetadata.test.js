const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filenameSuggestsImage,
  filenameSuggestsVideo,
  normalizeUploadFileDescriptor,
} = require("../dist-bot/uploadMediaMetadata.js");

test("normalizeUploadFileDescriptor rewrites mismatched jpg name to png when buffer is PNG", () => {
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  assert.deepEqual(
    normalizeUploadFileDescriptor("photo_1775180887_155.jpg", pngBuffer),
    {
      filename: "photo_1775180887_155.png",
      contentType: "image/png",
    },
  );
});

test("normalizeUploadFileDescriptor keeps jpeg filename when buffer is JPEG", () => {
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

  assert.deepEqual(
    normalizeUploadFileDescriptor("photo_1775180887_155.jpg", jpegBuffer),
    {
      filename: "photo_1775180887_155.jpg",
      contentType: "image/jpeg",
    },
  );
});

test("filenameSuggestsImage uses filename extension when mimeType is missing", () => {
  assert.equal(filenameSuggestsImage("photo_1775180887_155.jpg"), true);
  assert.equal(filenameSuggestsImage("screen.PNG"), true);
  assert.equal(filenameSuggestsImage("report.pdf"), false);
});

test("filenameSuggestsVideo uses filename extension when mimeType is missing", () => {
  assert.equal(filenameSuggestsVideo("clip.mp4"), true);
  assert.equal(filenameSuggestsVideo("clip.webm"), true);
  assert.equal(filenameSuggestsVideo("image.jpg"), false);
});
