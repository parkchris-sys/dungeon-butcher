import { SpriteFrame, assetManager } from 'cc';

/**
 * 에디터 전용 — 타일 이미지 캐시.
 * resources/maps/tiles의 `{ID}_{이름}.png`를 조회해 ID → SpriteFrame으로 보관한다.
 * 이름 부분은 사람용 라벨일 뿐, 코드는 앞의 ID만 본다.
 */

declare const Editor: any;

const cache = new Map<number, SpriteFrame>();
let requested = false;

export function tileFrame(id: number): SpriteFrame | null {
    return cache.get(id) ?? null;
}

export function ensureTileFrames() {
    if (requested) return;
    requested = true;
    Editor.Message.request('asset-db', 'query-assets',
        { pattern: 'db://assets/resources/maps/tiles/*.png' })
        .then((assets: Array<{ name?: string; uuid?: string }>) => {
            for (const a of assets ?? []) {
                const m = String(a.name ?? '').match(/^(\d+)_/);
                if (!m || !a.uuid) continue;
                const id = +m[1];
                // 이미지 에셋의 spriteFrame 서브에셋 uuid 규칙: <uuid>@f9941
                assetManager.loadAny({ uuid: `${a.uuid}@f9941` }, (err: Error | null, sf: SpriteFrame) => {
                    if (!err && sf) cache.set(id, sf);
                });
            }
        })
        .catch(() => { requested = false; }); // 실패 시 다음 틱에 재시도 가능
}
