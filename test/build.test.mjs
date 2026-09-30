'use strict';

// Архив сборки: пути внутри — через «/», как требует формат ZIP, и содержимое
// совпадает с src. Compress-Archive из Windows PowerShell 5.1 писал «\»
// (dist/listening-glass-0.1.0.zip, 2026-09-30).
// Изоляция: архив пишется во временный каталог ОС, каталог удаляется в after.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildZip } = require('../build.js');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-build-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function srcFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? srcFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  ));
}

function readZip(file) {
  const zip = fs.readFileSync(file);
  const entries = new Map();
  let i = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (i !== -1 && zip.readUInt32LE(i) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(i + 28);
    const name = zip.subarray(i + 46, i + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(i + 42);
    const size = zip.readUInt32LE(i + 20);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.set(name, zlib.inflateRawSync(zip.subarray(dataStart, dataStart + size)));
    i += 46 + nameLength + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  return entries;
}

test('zip entry names use forward slashes and cover every file of src', () => {
  const entries = readZip(buildZip(SRC, path.join(tmp, 'out.zip')));
  const names = [...entries.keys()];
  assert.ok(names.every((name) => !name.includes('\\')), names.join(', '));
  assert.ok(names.includes('page/core.js'));
  assert.deepEqual(names.sort(), srcFiles(SRC).sort());
});

test('zip entries unpack to the bytes of src', () => {
  const entries = readZip(buildZip(SRC, path.join(tmp, 'bytes.zip')));
  for (const [name, data] of entries) {
    assert.ok(data.equals(fs.readFileSync(path.join(SRC, ...name.split('/')))), name);
  }
});
