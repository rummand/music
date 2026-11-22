// Shared song library on disk: DATA_DIR/songs/<id>/{song.json, photo.jpg, thumb.jpg}.
// No login: every visitor sees every song. On Railway DATA_DIR is a mounted volume (/data).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const ID_RE = /^[a-z0-9]{10,32}$/;

export function createSongStore(dataDir) {
  const root = path.join(dataDir, 'songs');
  let ready = fs.mkdir(root, { recursive: true });

  const dirOf = (id) => {
    if (!ID_RE.test(String(id))) return null;
    return path.join(root, id);
  };

  async function writeJson(file, obj) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, file);
  }

  async function get(id) {
    const dir = dirOf(id);
    if (!dir) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'song.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    root,

    async create({ title, abc, warnings = [], photo }) {
      await ready;
      const id = crypto.randomBytes(8).toString('hex');
      const dir = path.join(root, id);
      await fs.mkdir(dir, { recursive: true });
      const now = new Date().toISOString();
      if (photo) {
        await fs.writeFile(path.join(dir, 'photo.jpg'), photo);
        try {
          const thumb = await sharp(photo).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
          await fs.writeFile(path.join(dir, 'thumb.jpg'), thumb);
        } catch { /* thumbnail is optional */ }
      }
      const song = { id, title: title || 'Uden titel', abc, warnings, created_at: now, updated_at: now, has_photo: !!photo };
      await writeJson(path.join(dir, 'song.json'), song);
      return song;
    },

    get,

    async list() {
      await ready;
      let ids = [];
      try { ids = await fs.readdir(root); } catch { return []; }
      const songs = await Promise.all(ids.filter((i) => ID_RE.test(i)).map(get));
      return songs
        .filter(Boolean)
        .map(({ id, title, created_at, updated_at, has_photo }) => ({ id, title, created_at, updated_at, has_photo }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    async update(id, patch) {
      const song = await get(id);
      if (!song) return null;
      if (typeof patch.abc === 'string') song.abc = patch.abc;
      if (typeof patch.title === 'string' && patch.title.trim()) song.title = patch.title.trim().slice(0, 200);
      song.updated_at = new Date().toISOString();
      await writeJson(path.join(dirOf(id), 'song.json'), song);
      return song;
    },

    async remove(id) {
      const dir = dirOf(id);
      if (!dir || !(await get(id))) return false;
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    },

    filePath(id, name) {
      const dir = dirOf(id);
      if (!dir || !['photo.jpg', 'thumb.jpg'].includes(name)) return null;
      return path.join(dir, name);
    },
  };
}
