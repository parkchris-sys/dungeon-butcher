import { Node, Sprite, SpriteFrame, UITransform, Color, Layers, view } from 'cc';
import { TILE_W, TILE_H, isoX, isoY } from './Projection';
import { TileDef } from './MapData';
import { TILE_COLORS } from './TilePalette';

/**
 * 가상화 타일 렌더러 — 재사용 스크롤 뷰 방식.
 * 화면(+여유분)에 보이는 타일만 노드로 만들고, 화면 밖으로 나가면 풀에 반납해
 * 새로 들어오는 타일에 재사용한다. 노드 수 = 화면에 그려지는 만큼으로 고정(맵 크기 무관).
 * 모든 타일이 같은 마름모 프레임을 공유(틴트만 다름) → 드로우콜 1 유지.
 */

/** 타일 이미지 ID → 틴트 2색(체커 명암) — 아트 확정 시 이미지 프레임 테이블로 교체 (임의) */
export const TILE_STYLE: Record<number, [string, string]> = {
    0: ['#232330', '#1E1E29'], // 기본(존 밖)
    1: ['#4E3827', '#453122'], // 마을 — 목재 톤
    2: ['#3C3159', '#352B4F'], // 던전 — 석재 톤
};

const MARGIN = 2; // 화면 가장자리 여유 타일 수

export class TileView {
    /** 풀에 남겨두는 여유 노드 수 — 초과분은 파괴 */
    private static readonly POOL_SPARE = 64;

    private container: Node;
    private frame: SpriteFrame;
    private groundR: number;
    private tileAt: (gx: number, gy: number) => TileDef | null;

    private active = new Map<string, Node>(); // "gx,gy" → 노드
    private pool: Node[] = [];
    private lastKey = '';
    private colorCache = new Map<string, Color>();

    /** img ID → 타일 이미지 프레임 (resources/maps/tiles/tile_<id>.png — 없으면 틴트 폴백) */
    private frames: Map<number, SpriteFrame>;

    constructor(parent: Node, diamondFrame: SpriteFrame, groundR: number,
        tileAt: (gx: number, gy: number) => TileDef | null,
        frames?: Map<number, SpriteFrame>) {
        this.container = new Node('Tiles');
        this.container.layer = Layers.Enum.UI_2D;
        parent.addChild(this.container);
        this.frame = diamondFrame;
        this.groundR = groundR;
        this.tileAt = tileAt;
        this.frames = frames ?? new Map();
    }

    /** 카메라 중심(그리드 좌표)과 줌으로 갱신 — 중심 타일이 바뀔 때만 재계산 */
    update(centerGx: number, centerGy: number, zoom: number) {
        const key = `${Math.round(centerGx)},${Math.round(centerGy)},${zoom}`;
        if (key === this.lastKey) return;
        this.lastKey = key;
        this.refresh(centerGx, centerGy, zoom);
    }

    private refresh(centerGx: number, centerGy: number, zoom: number) {
        // 뷰포트(월드 px) 반크기 + 여유
        const vs = view.getVisibleSize();
        const halfW = vs.width / 2 / zoom + TILE_W * MARGIN;
        const halfH = vs.height / 2 / zoom + TILE_H * (MARGIN + 2); // 캐릭터 높이 여유
        const cx = isoX(centerGx, centerGy);
        const cy = isoY(centerGx, centerGy);

        // 화면 사각형 네 모서리 → 그리드 좌표 (sx=(gx-gy)·64, sy=(gx+gy)·32 의 역변환)
        const toGx = (sx: number, sy: number) => sx / TILE_W + sy / TILE_H;
        const toGy = (sx: number, sy: number) => sy / TILE_H - sx / TILE_W;
        const corners: [number, number][] = [
            [cx - halfW, cy - halfH], [cx + halfW, cy - halfH],
            [cx - halfW, cy + halfH], [cx + halfW, cy + halfH],
        ];
        const R = this.groundR;
        const gxs = corners.map(([sx, sy]) => toGx(sx, sy));
        const gys = corners.map(([sx, sy]) => toGy(sx, sy));
        const minGx = Math.max(-R, Math.floor(Math.min(...gxs)));
        const maxGx = Math.min(R, Math.ceil(Math.max(...gxs)));
        const minGy = Math.max(-R, Math.floor(Math.min(...gys)));
        const maxGy = Math.min(R, Math.ceil(Math.max(...gys)));

        // 필요한 타일 집합 — 그리드 박스가 아니라 "화면 사각형 안"인 타일만 (박스는 실제의 2~3배라 낭비)
        const needed = new Set<string>();
        for (let gy = minGy; gy <= maxGy; gy++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                const sx = isoX(gx, gy), sy = isoY(gx, gy);
                if (Math.abs(sx - cx) > halfW || Math.abs(sy - cy) > halfH) continue;
                if (this.tileAt(gx, gy)) needed.add(`${gx},${gy}`);
            }
        }

        // 화면 밖으로 나간 노드 → 풀로 반납
        for (const [k, node] of this.active) {
            if (!needed.has(k)) {
                node.active = false;
                this.pool.push(node);
                this.active.delete(k);
            }
        }

        // 풀 상한 — 여유분만 남기고 파괴 (하이어라키에 죽은 노드가 쌓이는 것 방지)
        while (this.pool.length > TileView.POOL_SPARE) {
            this.pool.pop()!.destroy();
        }

        // 새로 들어온 타일 → 풀에서 재사용(없으면 생성)
        for (const k of needed) {
            if (this.active.has(k)) continue;
            const [gx, gy] = k.split(',').map(Number);
            const tile = this.tileAt(gx, gy)!;
            const node = this.pool.pop() ?? this.createNode();
            node.active = true;
            node.setPosition(isoX(gx, gy), isoY(gx, gy), 0);
            const sp = node.getComponent(Sprite)!;
            const parityDark = ((gx + gy) % 2 + 2) % 2 === 1;
            const imgFrame = this.frames.get(tile.img);
            if (imgFrame) {
                // 실제 타일 이미지 — 체커 가독성은 밝기 틴트로
                sp.spriteFrame = imgFrame;
                sp.color = this.cachedColor(parityDark ? '#DFDFDF' : '#FFFFFF');
            } else if (TILE_COLORS[tile.img - 1]) {
                sp.spriteFrame = this.frame;
                sp.color = this.cachedColor(TILE_COLORS[tile.img - 1]);
            } else {
                sp.spriteFrame = this.frame;
                const style = TILE_STYLE[tile.img] ?? TILE_STYLE[0];
                sp.color = this.cachedColor(style[parityDark ? 1 : 0]);
            }
            this.active.set(k, node);
        }
    }

    private createNode(): Node {
        const n = new Node('t');
        n.layer = Layers.Enum.UI_2D;
        this.container.addChild(n);
        n.addComponent(UITransform).setContentSize(TILE_W, TILE_H);
        const s = n.addComponent(Sprite);
        s.sizeMode = Sprite.SizeMode.CUSTOM;
        s.spriteFrame = this.frame;
        return n;
    }

    private cachedColor(hex: string): Color {
        let c = this.colorCache.get(hex);
        if (!c) {
            c = new Color();
            Color.fromHEX(c, hex);
            this.colorCache.set(hex, c);
        }
        return c;
    }

    /** 현재 활성/풀 노드 수 (디버그용) */
    stats() {
        return { active: this.active.size, pooled: this.pool.length };
    }
}
