// 픽셀아트 이미지 meta의 텍스처 필터를 **nearest**로 바꾼다 (BIBLE §5 픽셀아트).
//
// 왜: 임포터 기본이 linear라서 **에디터에서는 뭉개져 보이고 게임에서는 또렷**하다
// (런타임은 IngameBootstrap.pixelate가 nearest로 강제하므로). meta를 고치면 양쪽이 같아진다.
// 사용: node tools/set_nearest.js game/assets/resources/maps/objs game/assets/resources/chars ...
const fs = require('fs');
const path = require('path');

let changed = 0, seen = 0;
function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.png.meta')) continue;
        seen++;
        const raw = fs.readFileSync(p, 'utf8');
        let m;
        try { m = JSON.parse(raw); } catch { console.warn('파싱 실패:', p); continue; }
        let hit = false;
        for (const sub of Object.values(m.subMetas ?? {})) {
            const u = sub.userData;
            if (!u || u.minfilter === undefined) continue; // 텍스처 서브에셋만
            if (u.minfilter !== 'nearest' || u.magfilter !== 'nearest') {
                u.minfilter = 'nearest';
                u.magfilter = 'nearest';
                hit = true;
            }
        }
        if (!hit) continue;
        // 들여쓰기 2칸 — 에디터가 저장하는 형식과 동일하게 유지 (diff 노이즈 최소화)
        fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
        changed++;
    }
}
for (const dir of process.argv.slice(2)) walk(dir);
console.log(`meta ${seen}개 검사 → ${changed}개 nearest로 변경`);
