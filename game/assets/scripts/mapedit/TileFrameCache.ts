import { SpriteFrame, Texture2D, assetManager } from 'cc';

/**
 * 에디터 전용 — 이미지 캐시 (타일·유닛·오브젝트 공용).
 * 폴더의 `{ID}_{이름}.png`를 조회해 ID → SpriteFrame으로 보관한다.
 * 이름 부분은 사람용 라벨일 뿐, 코드는 앞의 ID만 본다.
 * spriteFrame 서브에셋(@f9941)은 임포터 타입에 따라 없을 수 있으므로,
 * 항상 존재하는 texture 서브에셋(@6c48a)을 로드해 보충/폴백한다.
 */

declare const Editor: any;

class FrameCache {
    private cache = new Map<number, SpriteFrame>();
    private requested = false;

    constructor(private folder: string, private label: string) {}

    get(id: number): SpriteFrame | null {
        return this.cache.get(id) ?? null;
    }

    /** 이미지가 로드된 원본 크기 비율(h/w) — 외형 세로 크기 계산용 (미로드 시 1) */
    aspect(id: number): number {
        const sf = this.cache.get(id);
        const t = sf?.texture;
        return t && t.width > 0 ? t.height / t.width : 1;
    }

    ensure() {
        if (this.requested) return;
        this.requested = true;
        Editor.Message.request('asset-db', 'query-assets',
            { pattern: `db://assets/resources/maps/${this.folder}/**/*` })
            .then((assets: Array<{ name?: string; uuid?: string }>) => {
                let matched = 0;
                for (const a of assets ?? []) {
                    const m = String(a.name ?? '').match(/^(\d+)_/);
                    if (!m || !a.uuid || a.uuid.includes('@')) continue;
                    const id = +m[1];
                    matched++;
                    // 정식 spriteFrame 서브에셋(@f9941) 우선 — Inspector에 링크도 제대로 보임.
                    // 단, 에디터의 단일 로드는 텍스처 의존성이 빠질 수 있어 확인 후 보충한다
                    // (링크는 보이는데 픽셀이 안 그려지는 증상의 원인).
                    const loadTexInto = (sf: SpriteFrame | null) => {
                        assetManager.loadAny({ uuid: `${a.uuid}@6c48a` }, (err2: Error | null, tex: Texture2D) => {
                            if (err2 || !tex) {
                                console.warn(`[FrameCache:${this.label}] 텍스처 로드 실패: ${a.name}`, err2);
                                return;
                            }
                            const frame = sf ?? new SpriteFrame();
                            frame.texture = tex;
                            if (!sf) frame.packable = false;
                            this.cache.set(id, frame);
                        });
                    };
                    assetManager.loadAny({ uuid: `${a.uuid}@f9941` }, (err: Error | null, sf: SpriteFrame) => {
                        if (!err && sf) {
                            if (sf.texture) this.cache.set(id, sf);
                            else loadTexInto(sf); // 프레임은 있는데 텍스처가 비어 있음 — 보충
                        } else {
                            loadTexInto(null); // spriteFrame 서브에셋 없음 — 런타임 프레임 폴백
                        }
                    });
                }
                console.log(`[FrameCache:${this.label}] 이미지 ${matched}개 매칭 (에셋 ${assets?.length ?? 0}개 스캔)`);
                if (matched === 0) this.requested = false; // 폴더가 아직 임포트 전일 수 있음 — 재시도 허용
            })
            .catch((e: unknown) => {
                console.warn(`[FrameCache:${this.label}] 에셋 조회 실패`, e);
                this.requested = false;
            });
    }
}

const tiles = new FrameCache('tiles', '타일');
const units = new FrameCache('units', '유닛');
const objs = new FrameCache('objs', '오브젝트');

export function tileFrame(id: number): SpriteFrame | null { return tiles.get(id); }
export function ensureTileFrames() { tiles.ensure(); }

export function unitFrame(id: number): SpriteFrame | null { return units.get(id); }
export function unitAspect(id: number): number { return units.aspect(id); }
export function ensureUnitFrames() { units.ensure(); }

export function objFrame(id: number): SpriteFrame | null { return objs.get(id); }
export function objAspect(id: number): number { return objs.aspect(id); }
export function ensureObjFrames() { objs.ensure(); }
