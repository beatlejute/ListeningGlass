'use strict';

// Проверка материалов карточки Chrome Web Store: размеры PNG в store/images
// сверяются с требованиями магазина, записанными в store/listing.md, и с
// таблицей store/images/README.md. Тикет IMPL-010.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(ROOT, 'store', 'images');
const MANIFEST_FILE = path.join(IMAGES_DIR, 'README.md');
const LISTING_FILE = path.join(ROOT, 'store', 'listing.md');

const PROMO_FILE = 'promo-440x280.png';
const SCREENSHOT_PATTERN = /^screenshot-\d+\.png$/;
const MAX_SCREENSHOTS = 5;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Размер PNG из заголовка IHDR: ширина — байты 16..19, высота — 20..23. */
function readPngSize(file) {
  const bytes = fs.readFileSync(path.join(IMAGES_DIR, file));
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} — не PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Требуемые размеры из текста listing: «small promo tile 440×280, screenshots 1280×800». */
function readRequiredSizes() {
  const listing = fs.readFileSync(LISTING_FILE, 'utf8');
  const match = listing.match(
    /small promo tile (\d+)×(\d+), screenshots (\d+)×(\d+)/,
  );
  assert.ok(match, `${LISTING_FILE} не содержит строки с требуемыми размерами`);
  const [, promoWidth, promoHeight, shotWidth, shotHeight] = match.map(Number);
  return {
    promo: { width: promoWidth, height: promoHeight },
    screenshot: { width: shotWidth, height: shotHeight },
  };
}

/** Строки таблицы манифеста: файл, требуемый размер, измеренный размер. */
function readManifestRows() {
  const manifest = fs.readFileSync(MANIFEST_FILE, 'utf8');
  const rows = [];
  for (const line of manifest.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim().replace(/`/g, ''));
    if (cells.length < 5 || !cells[1].endsWith('.png')) continue;
    rows.push({ file: cells[1], required: cells[2], measured: cells[3] });
  }
  assert.ok(rows.length > 0, `${MANIFEST_FILE} не содержит таблицы файлов`);
  return rows;
}

function listingFiles() {
  return fs
    .readdirSync(IMAGES_DIR)
    .filter((name) => name === PROMO_FILE || SCREENSHOT_PATTERN.test(name))
    .sort();
}

describe('материалы карточки магазина', () => {
  const required = readRequiredSizes();

  test('промо-плитка имеет требуемый размер', () => {
    assert.deepEqual(readPngSize(PROMO_FILE), required.promo);
  });

  test('скриншоты имеют требуемый размер, их от 1 до 5', () => {
    const screenshots = listingFiles().filter((name) => SCREENSHOT_PATTERN.test(name));
    assert.ok(screenshots.length >= 1 && screenshots.length <= MAX_SCREENSHOTS,
      `скриншотов ${screenshots.length}, допустимо от 1 до ${MAX_SCREENSHOTS}`);
    for (const file of screenshots) {
      assert.deepEqual(readPngSize(file), required.screenshot, `${file} — размер не по требованию`);
    }
  });

  test('скриншоты различаются между собой', () => {
    const screenshots = listingFiles().filter((name) => SCREENSHOT_PATTERN.test(name));
    const digests = new Set(
      screenshots.map((file) => fs.readFileSync(path.join(IMAGES_DIR, file)).toString('base64')),
    );
    assert.equal(digests.size, screenshots.length, 'среди скриншотов есть побайтовые копии');
  });

  test('таблица README описывает все материалы карточки', () => {
    const documented = readManifestRows().map((row) => row.file).sort();
    for (const file of listingFiles()) {
      assert.ok(documented.includes(file), `${file} не описан в ${MANIFEST_FILE}`);
    }
  });

  test('размеры в таблице README совпадают с файлами', () => {
    for (const row of readManifestRows()) {
      const { width, height } = readPngSize(row.file);
      assert.equal(row.measured, `${width}×${height}`,
        `${row.file}: в README записано ${row.measured}, в файле ${width}×${height}`);
    }
  });
});
