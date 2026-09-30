const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Архив собирается средствами Node. Compress-Archive из Windows PowerShell 5.1
// записывал пути через «\» (dist/listening-glass-0.1.0.zip: `page\core.js`,
// 2026-09-30), а формат ZIP требует «/»: распаковщик может сделать из такого
// пути имя файла, и расширение не найдёт свои скрипты.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = prefix + entry.name;
      return entry.isDirectory()
        ? listFiles(path.join(dir, entry.name), `${name}/`)
        : [name];
    });
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(srcDir, outFile) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of listFiles(srcDir)) {
    const file = path.join(srcDir, ...name.split('/'));
    const data = fs.readFileSync(file);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const { time, day } = dosDateTime(fs.statSync(file).mtime);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имя в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...locals, ...centrals, end]));
  return outFile;
}

module.exports = { buildZip };

if (require.main === module) {
  const manifest = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8'));
  const zipName = `listening-glass-${manifest.version}.zip`;
  buildZip('src', path.join('dist', zipName));
  console.log('dist/' + zipName);
}
