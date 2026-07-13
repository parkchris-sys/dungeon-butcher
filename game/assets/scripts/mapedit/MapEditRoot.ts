import {
    _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Color, Layers,
    Graphics, RenderRoot2D, CCInteger, CCBoolean, CCString,
} from 'cc';
import { EDITOR } from 'cc/env';
import { MapTile } from './MapTile';
import { TileRegion } from './TileRegion';
import { parseMapRoot } from '../ingame/SceneMapLoader';
import { TILE_STYLE } from '../ingame/TileView';

const { ccclass, property, executeInEditMode } = _decorator;

declare const Editor: any; // 에디터 컨텍스트 전역 (EDITOR 가드로 빌드 미포함)

const B = 32;               // 청사진 1타일 px
const REGION_MAX = 32;      // 편집 구역 한 변 최대 타일 수 (에디터 보호 — 32×32=1024노드)

/**
 * 맵 편집 씬 루트 툴 (에디터 전용) — MapRoot 노드에 붙인다.
 *
 * 전체 타일을 노드로 만들지 않는다:
 *  - 배경: Graphics로 그린 페이크 격자 (mapTiles 크기 반영)
 *  - 실제 타일 노드: regions 그룹의 구역 중 editTiles가 체크된 것의 범위만큼만 생성
 *  - 타일 속성 원본: 이 컴포넌트에 저장(tileOverrides — 존 기본값 대비 변경분만).
 *    노드는 편집용 뷰라서 구역을 옮겨 다녀도 데이터가 유지된다.
 *
 * Inspector:
 *  - mapTiles: 맵 한 변 타일 수(홀수) — 격자·내보내기 크기. 바꾸면 격자 즉시 갱신
 *  - addRegion ✅: 편집 구역 추가 (regions 그룹에 8×8 사각형)
 *  - exportJson ✅: resources/maps/mapdata.json 내보내기 (게임이 읽는 데이터)
 *  - clearOverrides ✅: 손으로 바꾼 타일 전부 초기화 (존 기본값으로)
 */
@ccclass('MapEditRoot')
@executeInEditMode
export class MapEditRoot extends Component {
    @property({ type: CCInteger, tooltip: '맵 한 변 타일 수 (홀수 권장)' })
    mapTiles = 49;

    @property({ type: CCBoolean, tooltip: '체크 = 타일 편집 구역 추가 (8×8)' })
    addRegion = false;

    @property({ type: CCBoolean, tooltip: '체크 = resources/maps/mapdata.json 내보내기' })
    exportJson = false;

    @property({ type: CCBoolean, tooltip: '체크 = 타일 수정분 전체 초기화 (존 기본값으로)' })
    clearOverrides = false;

    /** 타일 변경분 저장소 — "gx,gy": [img, attr] (존 기본값과 다른 것만) */
    @property({ type: CCString, visible: false })
    tileOverridesJson = '{}';

    private activeRegion: Node | null = null;
    private tileNodes: Node[] = [];
    private lastGridKey = '';

    update() {
        if (!EDITOR) return;
        this.ensureIsoView();
        this.ensureGrid();
        this.cleanupLegacy();
        this.snapRegions();
        this.syncActiveRegion();

        if (this.addRegion) { this.addRegion = false; this.createRegion(); }
        if (this.clearOverrides) { this.clearOverrides = false; this.tileOverridesJson = '{}'; this.refreshTileNodes(); }
        if (this.exportJson) { this.exportJson = false; this.doExport(); }
    }

    /**
     * 아이소 뷰 — 게임과 똑같이 보이게 45° 회전 + 세로 50% 압축.
     * 데이터는 전부 MapRoot 로컬(정사각 격자) 좌표 그대로 — 보기(부모 변환)만 기울인다.
     * 구조: _isoview(scaleY 0.5, RenderRoot2D) └─ MapRoot(angle 45°)
     */
    private ensureIsoView() {
        // 예전 방식 잔재 제거 (MapRoot에 직접 붙였던 RenderRoot2D)
        const selfRoot = this.node.getComponent(RenderRoot2D);
        if (selfRoot) selfRoot.destroy();

        let parent = this.node.parent;
        if (parent && parent.name !== '_isoview') {
            const wrap = new Node('_isoview');
            wrap.layer = Layers.Enum.UI_2D;
            parent.addChild(wrap);
            wrap.addComponent(RenderRoot2D);
            this.node.parent = wrap;
            parent = wrap;
        }
        if (parent) {
            if (parent.scale.y !== 0.5) parent.setScale(1, 0.5, 1);
            if (!parent.getComponent(RenderRoot2D)) parent.addComponent(RenderRoot2D);
        }
        if (Math.abs(this.node.angle - 45) > 0.01) this.node.angle = 45;
    }

    // ── 페이크 격자 (Graphics — 노드 1개) ──
    private ensureGrid() {
        const N = this.mapTiles % 2 === 0 ? this.mapTiles + 1 : this.mapTiles;
        this.mapTiles = N;
        const key = `${N}`;
        let grid = this.node.getChildByName('_격자');
        if (!grid) {
            grid = new Node('_격자');
            grid.layer = Layers.Enum.UI_2D;
            this.node.addChild(grid);
            grid.setSiblingIndex(1); // 바닥가이드 위
            grid.addComponent(Graphics);
            this.lastGridKey = '';
        }
        if (this.lastGridKey === key) return;
        this.lastGridKey = key;

        const g = grid.getComponent(Graphics)!;
        g.clear();
        g.lineWidth = 1;
        g.strokeColor = new Color(255, 255, 255, 26);
        const half = (N * B) / 2;
        for (let i = 0; i <= N; i++) {
            const p = -half + i * B;
            g.moveTo(p, -half); g.lineTo(p, half);
            g.moveTo(-half, p); g.lineTo(half, p);
        }
        g.stroke();

        this.node.getComponent(UITransform)?.setContentSize(N * B, N * B);
        this.node.getChildByName('_바닥가이드')?.getComponent(UITransform)?.setContentSize(N * B, N * B);
    }

    /** 구버전 전체 타일 그룹 잔재 제거 (에디터 프리즈 원인) */
    private cleanupLegacy() {
        const legacy = this.node.getChildByName('tiles');
        if (legacy) legacy.destroy();
    }

    // ── 편집 구역 ──
    private regionsGroup(): Node {
        let g = this.node.getChildByName('regions');
        if (!g) {
            g = new Node('regions');
            g.layer = Layers.Enum.UI_2D;
            this.node.addChild(g);
        }
        return g;
    }

    private createRegion() {
        const g = this.regionsGroup();
        const n = new Node(`구역${g.children.length + 1}`);
        n.layer = Layers.Enum.UI_2D;
        g.addChild(n);
        n.addComponent(UITransform).setContentSize(8 * B, 8 * B);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        const frame = this.findAnyFrame();
        if (frame) sp.spriteFrame = frame;
        sp.color = new Color(255, 255, 255, 30); // 반투명 — 밑의 타일이 보이게
        n.addComponent(TileRegion);
        this.ensurePropsGroup(n);
        console.log('[MapEditRoot] 편집 구역 추가 — 옮기고 크기 잡은 뒤 editTiles 체크');
    }

    /** 구역마다 props 하위 그룹 — 배치물은 구역 자식이라 구역과 함께 움직임 */
    private ensurePropsGroup(region: Node): Node {
        let p = region.getChildByName('props');
        if (!p) {
            p = new Node('props');
            p.layer = Layers.Enum.UI_2D;
            region.addChild(p);
        }
        p.setSiblingIndex(region.children.length - 1); // 타일 위에 보이게 항상 마지막
        return p;
    }

    /** 구역 이동/크기 32px 스냅 + 최대 크기 제한 + props 그룹 보장 */
    private snapRegions() {
        for (const n of this.regionsGroup().children) {
            this.ensurePropsGroup(n);
            const p = n.position;
            const sx = Math.round(p.x / B) * B;
            const sy = Math.round(p.y / B) * B;
            if (sx !== p.x || sy !== p.y) n.setPosition(sx, sy, 0);
            const ut = n.getComponent(UITransform);
            if (ut) {
                const w = Math.min(REGION_MAX, Math.max(1, Math.round(ut.contentSize.width / B))) * B;
                const h = Math.min(REGION_MAX, Math.max(1, Math.round(ut.contentSize.height / B))) * B;
                if (w !== ut.contentSize.width || h !== ut.contentSize.height) ut.setContentSize(w, h);
            }
        }
    }

    // ── 활성 구역 전환 + 타일 노드 재사용 ──
    private syncActiveRegion() {
        // editTiles가 체크된 구역 찾기 (여러 개면 첫 번째만 유지)
        let next: Node | null = null;
        for (const n of this.regionsGroup().children) {
            const r = n.getComponent(TileRegion);
            if (!r || !r.editTiles) continue;
            if (!next) next = n;
            else r.editTiles = false;
        }
        if (next === this.activeRegion) {
            if (next) this.layoutTiles(next); // 활성 구역이 움직였을 수 있음 — 위치 동기화
            return;
        }
        if (this.activeRegion) this.commitTiles(this.activeRegion); // 데이터 반영 후 전환
        this.activeRegion = next;
        if (next) this.layoutTiles(next);
        else this.destroyTiles();
    }

    /** 구역 범위에 맞춰 타일 노드 배치 — 재사용, 남으면 제거, 모자라면 생성 */
    private layoutTiles(region: Node) {
        const ut = region.getComponent(UITransform);
        if (!ut) return;
        const w = Math.round(ut.contentSize.width / B);
        const h = Math.round(ut.contentSize.height / B);
        const gx0 = Math.round(region.position.x / B - w / 2);
        const gy0 = Math.round(region.position.y / B - h / 2);

        const needed = w * h;
        // 부족분 생성 / 초과분 제거
        while (this.tileNodes.length < needed) this.tileNodes.push(this.createTileNode());
        while (this.tileNodes.length > needed) this.tileNodes.pop()!.destroy();

        const overrides = this.overrides();
        let i = 0;
        for (let ty = 0; ty < h; ty++) {
            for (let tx = 0; tx < w; tx++) {
                const gx = gx0 + tx, gy = gy0 + ty;
                const n = this.tileNodes[i++];
                if (n.parent !== region) n.parent = region;
                // 구역 로컬 좌표 (구역과 함께 움직이도록 자식으로)
                n.setPosition((tx - w / 2 + 0.5) * B, (ty - h / 2 + 0.5) * B, 0);
                n.name = `t_${gx}_${gy}`;
                const tile = n.getComponent(MapTile)!;
                const ov = overrides[`${gx},${gy}`];
                tile.img = ov ? ov[0] : 0;
                tile.attr = ov ? (ov[1] ?? 0) : 0;
                tile.zone = ov ? (ov[2] ?? 0) : 0;
                tile.forceRefresh();
            }
        }
    }

    /** 현재 타일 노드들의 값을 저장소에 반영 (전부 0이면 저장 안 함) */
    private commitTiles(region: Node) {
        const overrides = this.overrides();
        for (const n of this.tileNodes) {
            const m = n.name.match(/^t_(-?\d+)_(-?\d+)$/);
            const tile = n.getComponent(MapTile);
            if (!m || !tile) continue;
            const gx = +m[1], gy = +m[2];
            if (tile.img !== 0 || tile.attr !== 0 || tile.zone !== 0) {
                overrides[`${gx},${gy}`] = [tile.img, tile.attr, tile.zone];
            } else {
                delete overrides[`${gx},${gy}`];
            }
        }
        this.tileOverridesJson = JSON.stringify(overrides);
    }

    private refreshTileNodes() {
        if (this.activeRegion) this.layoutTiles(this.activeRegion);
    }

    private destroyTiles() {
        for (const n of this.tileNodes) n.destroy();
        this.tileNodes = [];
    }

    private createTileNode(): Node {
        const n = new Node('t');
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(B - 2, B - 2);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        const frame = this.findAnyFrame();
        if (frame) sp.spriteFrame = frame;
        n.addComponent(MapTile);
        return n;
    }

    /** 변경분 저장소 — "gx,gy": [img, attr, zone] (구버전 [img, attr]도 허용) */
    private overrides(): Record<string, number[]> {
        try { return JSON.parse(this.tileOverridesJson || '{}'); } catch { return {}; }
    }

    private findAnyFrame(): SpriteFrame | null {
        const guide = this.node.getChildByName('_바닥가이드')?.getComponent(Sprite);
        if (guide?.spriteFrame) return guide.spriteFrame;
        for (const child of this.node.children) {
            const sp = child.getComponentInChildren(Sprite);
            if (sp?.spriteFrame) return sp.spriteFrame;
        }
        return null;
    }

    // ── 내보내기 (v2 — 존 사각형 없음, 타일 zone값이 존의 원본) ──
    private doExport() {
        if (this.activeRegion) this.commitTiles(this.activeRegion); // 열려 있는 편집분 반영
        const map = parseMapRoot(this.node); // 벽·배치물·스폰
        if (!map) {
            console.warn('[MapEditRoot] 내보내기 실패 — MapRoot 구조가 올바르지 않습니다');
            return;
        }
        const N = this.mapTiles;
        const R = (N - 1) / 2;
        const overrides = this.overrides();
        const img: number[] = [], zone: number[] = [], attr: number[] = [];
        for (let gy = -R; gy <= R; gy++) {
            for (let gx = -R; gx <= R; gx++) {
                const ov = overrides[`${gx},${gy}`];
                img.push(ov ? ov[0] : 0);
                attr.push(ov ? (ov[1] ?? 0) : 0);
                zone.push(ov ? (ov[2] ?? 0) : 0);
            }
        }
        const payload = {
            version: 2, size: N,
            spawn: map.playerSpawn, walls: map.walls, props: map.props,
            tiles: { img, zone, attr },
        };
        Editor.Message.request('asset-db', 'create-asset',
            'db://assets/resources/maps/mapdata.json', JSON.stringify(payload), { overwrite: true })
            .then(() => console.log(`[MapEditRoot] 내보내기 완료 v2 (${N}×${N}, 데이터 타일 ${Object.keys(overrides).length}개)`))
            .catch((e: unknown) => console.warn('[MapEditRoot] 내보내기 실패', e));
    }
}
