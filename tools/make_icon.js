/**
 * 원본 PNG 1장에서 안드로이드 런처 아이콘 5종(mdpi~xxxhdpi)을 만든다.
 *   node tools/make_icon.js <원본.png> [출력 res 디렉터리]
 *
 * 왜 직접 만드나: 이 저장소엔 이미지 라이브러리(jimp)가 설치돼 있지 않고,
 * 아이콘은 **한 번 만들면 끝이 아니라** 아트가 바뀔 때마다 다시 뽑아야 해서 도구로 남긴다.
 *
 * 축소는 **면적 평균(box filter)**. 2048 → 48은 42배 축소라 최근접/이중선형으로 줄이면
 * 픽셀이 튀어 지저분해진다. 평균을 내야 축소본이 원본의 인상을 유지한다.
 * 알파는 **곱해서 평균 내고 다시 나눈다(premultiply)** — 안 그러면 투명한 가장자리의
 * 검은 RGB가 섞여 테두리에 어두운 띠가 생긴다.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// 안드로이드 런처 아이콘 규격 (dpi별 px)
const DENSITIES = [
    { dir: 'mipmap-mdpi', size: 48 },
    { dir: 'mipmap-hdpi', size: 72 },
    { dir: 'mipmap-xhdpi', size: 96 },
    { dir: 'mipmap-xxhdpi', size: 144 },
    { dir: 'mipmap-xxxhdpi', size: 192 },
];

function decodePng(buf) {
    let p = 8, w = 0, h = 0, depth = 0, color = 0;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        const data = buf.slice(p + 8, p + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            depth = data[8]; color = data[9];
            if (depth !== 8 || (color !== 6 && color !== 2)) {
                throw new Error(`RGBA8/RGB8만 지원 (depth=${depth} color=${color})`);
            }
            if (data[12] !== 0) throw new Error('인터레이스 PNG는 미지원');
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        p += 12 + len;
    }
    const ch = color === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)];
        const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
            let v = line[i];
            if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
            else if (ft === 4) {
                const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 0xFF;
        }
        for (let x = 0; x < w; x++) {
            out[(y * w + x) * 4] = cur[x * ch];
            out[(y * w + x) * 4 + 1] = cur[x * ch + 1];
            out[(y * w + x) * 4 + 2] = cur[x * ch + 2];
            out[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
        }
        prev = cur;
    }
    return { w, h, data: out };
}

const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
})();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const tb = Buffer.from(t);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, d])));
    return Buffer.concat([l, tb, d, cr]);
};
function encodePng(w, h, rgba) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ih = Buffer.alloc(13);
    ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
    const raw = Buffer.alloc(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
        raw[y * (1 + w * 4)] = 0;
        rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
    }
    return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 면적 평균 축소 — 원본 픽셀 하나가 여러 출력 픽셀에 걸치는 경우까지 비율대로 반영한다 */
function resizeBox(src, sw, sh, dw, dh) {
    const out = Buffer.alloc(dw * dh * 4);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
        const y0 = y * sy, y1 = (y + 1) * sy;
        for (let x = 0; x < dw; x++) {
            const x0 = x * sx, x1 = (x + 1) * sx;
            let r = 0, g = 0, b = 0, a = 0, wsum = 0;
            for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
                const fy = Math.min(y1, py + 1) - Math.max(y0, py);
                for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
                    const fx = Math.min(x1, px + 1) - Math.max(x0, px);
                    const wgt = fx * fy;
                    if (wgt <= 0) continue;
                    const i = (py * sw + px) * 4;
                    const al = src[i + 3] / 255;
                    // premultiply — 투명 픽셀의 RGB가 색을 오염시키지 않게
                    r += src[i] * al * wgt; g += src[i + 1] * al * wgt; b += src[i + 2] * al * wgt;
                    a += src[i + 3] * wgt;
                    wsum += wgt;
                }
            }
            const o = (y * dw + x) * 4;
            if (wsum <= 0) continue;
            const aa = a / wsum;
            const inv = aa > 0 ? 255 / aa : 0;
            out[o] = Math.min(255, Math.round(r / wsum * inv));
            out[o + 1] = Math.min(255, Math.round(g / wsum * inv));
            out[o + 2] = Math.min(255, Math.round(b / wsum * inv));
            out[o + 3] = Math.round(aa);
        }
    }
    return out;
}

const [srcPath, resDir = 'game/native/engine/android/res'] = process.argv.slice(2);
if (!srcPath) {
    console.error('사용: node tools/make_icon.js <원본.png> [res 디렉터리]');
    process.exit(1);
}
const im = decodePng(fs.readFileSync(srcPath));
if (im.w !== im.h) console.warn(`⚠ 원본이 정사각이 아님 (${im.w}x${im.h}) — 런처가 늘려 보일 수 있다`);
for (const d of DENSITIES) {
    const dst = path.join(resDir, d.dir, 'ic_launcher.png');
    if (!fs.existsSync(path.dirname(dst))) { console.warn(`건너뜀 (폴더 없음): ${dst}`); continue; }
    const px = resizeBox(im.data, im.w, im.h, d.size, d.size);
    fs.writeFileSync(dst, encodePng(d.size, d.size, px));
    console.log(`  ${d.dir.padEnd(14)} ${d.size}x${d.size}  ${dst}`);
}
console.log(`완료 — 원본 ${im.w}x${im.h}`);
