/**
 * PNG에 Cocos용 .meta(sprite-frame)를 만들거나 크기만 갱신한다.
 *   node tools/make_meta.js <png경로> [<png경로> ...]
 *
 * - .meta가 이미 있으면 **uuid를 유지하고 크기만** 고친다 (기존 참조가 안 깨짐)
 * - 없으면 새로 만든다. type=sprite-frame이 아니면 게임에서 로드에 실패한다
 */
const Jimp = require('jimp');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function spriteVertices(W, H) {
  const hw = W / 2, hh = H / 2;
  return {
    rawPosition: [-hw, -hh, 0, hw, -hh, 0, -hw, hh, 0, hw, hh, 0],
    indexes: [0, 1, 2, 2, 1, 3],
    uv: [0, H, W, H, 0, 0, W, 0], nuv: [0, 0, 1, 0, 0, 1, 1, 1],
    minPos: [-hw, -hh, 0], maxPos: [hw, hh, 0],
  };
}

function buildMeta(name, W, H) {
  const u = crypto.randomUUID();
  const tex = 'a' + Math.random().toString(16).slice(2, 6);
  const spr = 'b' + Math.random().toString(16).slice(2, 6);
  return {
    ver: "1.0.27", importer: "image", imported: true, uuid: u, files: [".json", ".png"],
    subMetas: {
      [tex]: {
        importer: "texture", uuid: `${u}@${tex}`, displayName: name, id: tex, name: "texture",
        userData: { wrapModeS: "clamp-to-edge", wrapModeT: "clamp-to-edge", imageUuidOrDatabaseUri: u, isUuid: true, visible: false, minfilter: "linear", magfilter: "linear", mipfilter: "none", anisotropy: 0 },
        ver: "1.0.22", imported: true, files: [".json"], subMetas: {}
      },
      [spr]: {
        importer: "sprite-frame", uuid: `${u}@${spr}`, displayName: name, id: spr, name: "spriteFrame",
        userData: {
          trimThreshold: 1, rotated: false, offsetX: 0, offsetY: 0, trimX: 0, trimY: 0,
          width: W, height: H, rawWidth: W, rawHeight: H,
          borderTop: 0, borderBottom: 0, borderLeft: 0, borderRight: 0,
          packable: true, pixelsToUnit: 100, pivotX: 0.5, pivotY: 0.5, meshType: 0,
          vertices: spriteVertices(W, H),
          isUuid: true, imageUuidOrDatabaseUri: `${u}@${tex}`, atlasUuid: "", trimType: "auto"
        },
        ver: "1.0.12", imported: true, files: [".json"], subMetas: {}
      }
    },
    userData: { type: "sprite-frame", fixAlphaTransparencyArtifacts: false, hasAlpha: true, redirect: `${u}@${tex}` }
  };
}

(async () => {
  for (const p of process.argv.slice(2)) {
    const im = await Jimp.read(p);
    const W = im.bitmap.width, H = im.bitmap.height;
    const name = path.basename(p, '.png');
    const mp = p + '.meta';
    if (fs.existsSync(mp)) {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      for (const k of Object.keys(m.subMetas || {})) {
        const sm = m.subMetas[k];
        if (sm.importer !== 'sprite-frame') continue;
        Object.assign(sm.userData, { width: W, height: H, rawWidth: W, rawHeight: H });
        sm.userData.vertices = spriteVertices(W, H);
      }
      fs.writeFileSync(mp, JSON.stringify(m, null, 2));
      console.log(`  갱신 ${name}  ${W}x${H} (uuid 유지)`);
    } else {
      fs.writeFileSync(mp, JSON.stringify(buildMeta(name, W, H), null, 2));
      console.log(`  신규 ${name}  ${W}x${H}`);
    }
  }
})();
