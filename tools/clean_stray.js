// 오브젝트 PNG에서 **떨어진 조각(슬라이스 잔재)** 제거 — 가장 큰 연결 덩어리만 남긴다.
//
// 왜 필요한가: 시트에서 낱개로 자를 때 옆 오브젝트의 일부가 캔버스 구석에 섞여 들어오면,
// 게임에서는 그 조각이 **바닥에 떠 있는 정체불명의 물건**으로 렌더된다(실제로 32번에서 발생).
// 사용: node tools/clean_stray.js <png...>   (--dry 를 붙이면 검사만)
const zlib = require('zlib');
const fs = require('fs');

function decodePng(buf) {
    let p = 8, w = 0, h = 0; const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        const data = buf.slice(p + 8, p + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            if (data[8] !== 8 || data[9] !== 6) throw new Error('RGBA8만 지원');
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(w * h * 4), stride = w * 4;
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)];
        const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
            let v = line[i];
            if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
            else if (ft === 4) {
                const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 0xFF;
        }
        cur.copy(out, y * stride); prev = cur;
    }
    return { w, h, data: out };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tb = Buffer.from(t); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, d]))); return Buffer.concat([l, tb, d, cr]); };
function encodePng(w, h, rgba) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
    const raw = Buffer.alloc(h * (1 + w * 4));
    for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4); }
    return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dry = process.argv.includes('--dry');
for (const file of process.argv.slice(2).filter(a => a !== '--dry')) {
    const im = decodePng(fs.readFileSync(file));
    const lab = new Int32Array(im.w * im.h).fill(-1);
    const comps = [];
    for (let i = 0; i < im.w * im.h; i++) {
        if (im.data[i * 4 + 3] <= 16 || lab[i] >= 0) continue;
        const stack = [i]; lab[i] = comps.length; const px = [];
        while (stack.length) {
            const c = stack.pop(); px.push(c);
            const cx = c % im.w, cy = (c / im.w) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h) continue;
                const ni = ny * im.w + nx;
                if (im.data[ni * 4 + 3] > 16 && lab[ni] < 0) { lab[ni] = comps.length; stack.push(ni); }
            }
        }
        comps.push(px);
    }
    if (comps.length <= 1) { console.log(`${file}: 조각 1개 — 그대로`); continue; }
    comps.sort((a, b) => b.length - a.length);
    const keep = comps[0].length;
    const removed = comps.slice(1).reduce((a, c) => a + c.length, 0);
    console.log(`${file}: 조각 ${comps.length}개 → 주 덩어리 ${keep}px 유지, ${removed}px 제거`);
    if (dry) continue;
    const out = Buffer.from(im.data);
    for (const c of comps.slice(1)) for (const p of c) out[p * 4 + 3] = 0; // 알파만 0으로
    fs.writeFileSync(file, encodePng(im.w, im.h, out));
}
