// The encrypted image folder on the laptop's internal disk. One file per image:
//   <dir>/<first two characters of the id>/<id>.sqm
// The id is random, so nothing about the picture (name, owner, date) is visible in the file name.
//
// put / get / remove / exists work on plaintext images. readRaw / writeRaw move the encrypted bytes as they
// are, which is what the S3 replica stores and what healing a missing file writes back.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const AppError = require('../../core/AppError');
const { ID_PATTERN } = require('../../core/sql');
const { encrypt, decrypt } = require('./media.crypto');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const unreadable = () => new AppError('This photo could not be read. The server may be using a different key than the one that saved it.', 500, 'MEDIA_UNREADABLE');
const missing = () => new AppError('This photo’s file is missing from the server.', 404, 'MEDIA_FILE_MISSING');

function createLocalStore({ dir, key }) {
  const root = path.resolve(dir);
  const safeId = (id) => {
    // Ids come from our own database, but a path is built from this one, so check anyway.
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid media id');
    return id.toLowerCase();
  };
  const fileFor = (id) => path.join(root, id.slice(0, 2), `${id}.sqm`);

  // Temp file in the same folder, fsync, then rename: a crash leaves the old state or the whole new file.
  function writeRaw(id, bytes) {
    const target = fileFor(safeId(id));
    const folder = path.dirname(target);
    fs.mkdirSync(folder, { recursive: true, mode: DIR_MODE });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(temp, 'wx', FILE_MODE);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    try { // make the rename itself durable; not every platform allows opening a directory
      const dfd = fs.openSync(folder, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* best effort */ }
  }

  function readRaw(id) {
    try {
      return fs.readFileSync(fileFor(safeId(id)));
    } catch (err) {
      if (err.code === 'ENOENT') throw missing();
      throw err;
    }
  }

  function decode(id, userId, bytes) {
    try {
      return decrypt(key, userId, id, bytes);
    } catch {
      throw unreadable(); // wrong key, other owner, damaged or tampered: never serve anything
    }
  }

  return {
    dir: root,
    put(id, userId, plaintext) { writeRaw(id, encrypt(key, userId, safeId(id), plaintext)); },
    get(id, userId) { return decode(id, userId, readRaw(id)); },
    // Checks that bytes fetched from elsewhere (the replica) really are this image before they are trusted.
    decode,
    readRaw,
    writeRaw,
    exists(id) { return fs.existsSync(fileFor(safeId(id))); },
    // Idempotent: a file that is already gone is fine.
    remove(id) { fs.rmSync(fileFor(safeId(id)), { force: true }); },
    // Files that look like ours, for the orphan sweep. Anything else in the folder is left alone.
    *list() {
      let folders;
      try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const folder of folders) {
        if (!folder.isDirectory() || !/^[a-f0-9]{2}$/i.test(folder.name)) continue;
        for (const entry of fs.readdirSync(path.join(root, folder.name), { withFileTypes: true })) {
          const match = /^([a-f0-9]{24})\.sqm(\.[a-f0-9]{12}\.tmp)?$/i.exec(entry.name);
          if (!entry.isFile() || !match || match[1].slice(0, 2).toLowerCase() !== folder.name.toLowerCase()) continue;
          const file = path.join(root, folder.name, entry.name);
          try { yield { id: match[1].toLowerCase(), file, temp: Boolean(match[2]), mtimeMs: fs.statSync(file).mtimeMs }; } catch { /* vanished */ }
        }
      }
    },
    removeFile(file) { fs.rmSync(file, { force: true }); },
  };
}

module.exports = { createLocalStore };
