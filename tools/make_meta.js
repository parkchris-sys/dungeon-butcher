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

function buildMeta(name, W, H, FILTER, TRIM) {
  const u = crypto.randomUUID();
  const tex = 'a' + Math.random().toString(16).slice(2, 6);
  const spr = 'b' + Math.random().toString(16).slice(2, 6);
  return {
    ver: "1.0.27", importer: "image", imported: true, uuid: u, files: [".json", ".png"],
    subMetas: {
      [tex]: {
        importer: "texture", uuid: `${u}@${tex}`, displayName: name, id: tex, name: "texture",
        userData: { wrapModeS: "clamp-to-edge", wrapModeT: "clamp-to-edge", imageUuidOrDatabaseUri: u, isUuid: true, visible: false, minfilter: FILTER, magfilter: FILTER, mipfilter: "none", anisotropy: 0 },
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
          isUuid: true, imageUuidOrDatabaseUri: `${u}@${tex}`, atlasUuid: "", trimType: TRIM
        },
        ver: "1.0.12", imported: true, files: [".json"], subMetas: {}
      }
    },
    userData: { type: "sprite-frame", fixAlphaTransparencyArtifacts: false, hasAlpha: true, redirect: `${u}@${tex}` }
  };
}

(async () => {
  // --nearest: 픽셀아트용. 확대할 때 뭉개지지 않게 point 필터로 (기본 linear는 픽셀을 흐리게 만든다)
  // --notrim: **여러 프레임짜리 애니메이션 클립에는 필수.**
  //   기본값 trimType=auto는 프레임마다 투명 여백을 잘라내는데, 잘린 폭은 프레임마다 다르다.
  //   그런데 노드 크기는 첫 프레임 비율로 한 번만 정해지므로(SpriteAnimator.applyFit),
  //   좁게 잘린 프레임이 그 크기에 맞춰 **가로로 늘어난다** → 걸을 때 몸이 뚱뚱해졌다 홀쭉해졌다 한다.
  const args = process.argv.slice(2);
  const NEAREST = args.includes('--nearest');
  const NOTRIM = args.includes('--notrim');
  for (const p of args.filter(a => !a.startsWith('--'))) {
    const im = await Jimp.read(p);
    const W = im.bitmap.width, H = im.bitmap.height;
    const name = path.basename(p, '.png');
    const mp = p + '.meta';
    if (fs.existsSync(mp)) {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      for (const k of Object.keys(m.subMetas || {})) {
        const sm = m.subMetas[k];
        if (NEAREST && sm.importer === 'texture') { sm.userData.minfilter = 'nearest'; sm.userData.magfilter = 'nearest'; }
        if (sm.importer !== 'sprite-frame') continue;
        Object.assign(sm.userData, { width: W, height: H, rawWidth: W, rawHeight: H });
        if (NOTRIM) Object.assign(sm.userData, {
          trimType: 'none', trimX: 0, trimY: 0, offsetX: 0, offsetY: 0,
        });
        sm.userData.vertices = spriteVertices(W, H);
      }
      fs.writeFileSync(mp, JSON.stringify(m, null, 2));
      console.log(`  갱신 ${name}  ${W}x${H} (uuid 유지)`);
    } else {
      fs.writeFileSync(mp, JSON.stringify(buildMeta(name, W, H, NEAREST ? 'nearest' : 'linear', NOTRIM ? 'none' : 'auto'), null, 2));
      console.log(`  신규 ${name}  ${W}x${H}`);
    }
  }
})();
