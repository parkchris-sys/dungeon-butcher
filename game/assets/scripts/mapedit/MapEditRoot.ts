import {
    _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Color, Layers,
    Graphics, RenderRoot2D, CCInteger, CCBoolean, CCString, CCObject,
    JsonAsset, assetManager,
} from 'cc';
import { EDITOR } from 'cc/env';
import { MapTile } from './MapTile';
import { TileRegion } from './TileRegion';
import { parseMapRoot } from '../ingame/SceneMapLoader';
import { parseMapDataJson, synthZoneDef, ZoneType } from '../ingame/MapData';
import { TILE_COLORS } from '../ingame/TilePalette';
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

    @property({ type: CCBoolean, tooltip: '체크 = mapdata.json을 에디터로 불러오기 ⚠️타일·스폰·배치물을 파일 내용으로 덮어씀 (구역 마커는 유지)' })
    importJson = false;

    @property({ type: CCBoolean, tooltip: '체크 = 타일 수정분 전체 초기화 (존 기본값으로)' })
    clearOverrides = false;

    /** 타일 변경분 저장소 — "gx,gy": [img, attr] (존 기본값과 다른 것만) */
    @property({ type: CCString, visible: false })
    tileOverridesJson = '{}';

    private activeRegion: Node | null = null;
    private tileNodes: Node[] = [];
    private lastGridKey = '';
    private lastRegionKey = ''; // 활성 구역의 위치·크기 — 바뀔 때만 재배치 (매 틱 덮어쓰기 방지)
    private lastW = 0; // 직전 배치의 구역 크기(타일) — 이동/리사이즈 구분용
    private lastH = 0;
    private lastMapTiles = 0; // 맵 크기 변경 감지 — 아래 모서리 고정 성장용
    private lastPreviewKey = ''; // 데이터 프리뷰 갱신 감지
    private lastImportDungeonIds = new Map<string, number>(); // 임포트한 타일별 던전 ID (구역 재생성용)

    update() {
        if (!EDITOR) return;
        this.ensureIsoView();
        this.ensureGrid();
        this.ensureDataPreview();
        this.cleanupLegacy();
        this.snapRegions();
        this.syncActiveRegion();

        if (this.addRegion) { this.addRegion = false; this.createRegion(); }
        if (this.clearOverrides) { this.clearOverrides = false; this.tileOverridesJson = '{}'; this.refreshTileNodes(); }
        if (this.exportJson) { this.exportJson = false; this.doExport(); }
        if (this.importJson) { this.importJson = false; this.doImport(); }
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

        // 맵 크기 변경 → 아래 모서리 고정 성장: 데이터 전체를 이동시켜
        // 기존 콘텐츠(마을 등)가 아래 모서리에 그대로 붙어 있게 한다
        if (this.lastMapTiles > 0 && N !== this.lastMapTiles) {
            this.shiftForResize((N - this.lastMapTiles) / 2);
        }
        this.lastMapTiles = N;

        const key = `${N}`;
        let grid = this.node.getChildByName('_격자');
        if (!grid) {
            grid = new Node('_격자');
            grid.hideFlags = CCObject.Flags.DontSave; // 매 세션 다시 그림 — 씬에 저장 금지
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

    /**
     * 전체 맵 데이터 프리뷰 — 칠해진 모든 타일을 구역(뷰포트) 없이도 항상 표시.
     * Graphics 노드 1개에 셀 사각형으로 그림 — 데이터가 바뀔 때만 다시 그림.
     * 색: img 팔레트 / attr=1 은 붉게. 활성 구역의 실제 타일이 이 위에 얹힘.
     */
    private ensureDataPreview() {
        let node = this.node.getChildByName('_데이터프리뷰');
        if (!node) {
            node = new Node('_데이터프리뷰');
            node.hideFlags = CCObject.Flags.DontSave;
            node.layer = Layers.Enum.UI_2D;
            this.node.addChild(node);
            node.setSiblingIndex(2); // 격자 위, 구역·타일 아래
            node.addComponent(Graphics);
            this.lastPreviewKey = '';
        }
        if (this.tileOverridesJson === this.lastPreviewKey) return;
        this.lastPreviewKey = this.tileOverridesJson;

        const g = node.getComponent(Graphics)!;
        g.clear();
        const ov = this.overrides();
        // 색깔별로 모아 그리기 (fill 호출 최소화)
        const byColor = new Map<string, string[]>();
        for (const key of Object.keys(ov)) {
            const [img, attr] = [ov[key][0] ?? 0, ov[key][1] ?? 0];
            const hex = attr === 1 ? '#B03A30'
                : (TILE_COLORS[img - 1] ?? (TILE_STYLE[img] ?? TILE_STYLE[0])[0]);
            let list = byColor.get(hex);
            if (!list) byColor.set(hex, list = []);
            list.push(key);
        }
        for (const [hex, keys] of byColor) {
            const c = new Color();
            Color.fromHEX(c, hex);
            g.fillColor = c;
            for (const key of keys) {
                const [gx, gy] = key.split(',').map(Number);
                g.rect(gx * B - B / 2 + 1, gy * B - B / 2 + 1, B - 2, B - 2);
            }
            g.fill();
        }
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
            // 반 타일(16px) 스냅 — 짝수 폭 구역도 셀 경계에 딱 맞출 수 있게
            const H = B / 2;
            const sx = Math.round(p.x / H) * H;
            const sy = Math.round(p.y / H) * H;
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
            // 같은 구역 유지 — 위치/크기가 실제로 바뀐 경우에만 재배치
            // (매 틱 재배치하면 사용자가 Inspector에서 고친 타일 값을 계속 덮어씀!)
            if (next) {
                const key = this.regionKey(next);
                if (key !== this.lastRegionKey) {
                    const ut = next.getComponent(UITransform);
                    const w = Math.round((ut?.contentSize.width ?? 0) / B);
                    const h = Math.round((ut?.contentSize.height ?? 0) / B);
                    if (w === this.lastW && h === this.lastH && this.tileNodes.length === w * h) {
                        // 순수 이동 — ★ 타일 데이터도 함께 이동 (구역 = 지역 그 자체)
                        const overrides = this.overrides();
                        for (const n of this.tileNodes) {
                            const m = n.name.match(/^t_(-?\d+)_(-?\d+)$/);
                            if (m) delete overrides[`${m[1]},${m[2]}`]; // 옛 좌표 비우기
                        }
                        this.tileOverridesJson = JSON.stringify(overrides);
                        this.layoutTiles(next, true); // 값 유지한 채 새 좌표로 개명/재배치
                        this.commitTiles(next);       // 새 좌표에 기록
                    } else {
                        // 리사이즈 — 기존 방식: 저장 후 좌표 기준으로 다시 로드
                        this.commitTiles(next);
                        this.layoutTiles(next);
                    }
                    this.lastRegionKey = this.regionKey(next); // autofit 반영된 최종 키
                }
            }
            return;
        }
        if (this.activeRegion) {
            this.commitTiles(this.activeRegion); // 데이터 반영 후 전환
            this.setRegionEditAlpha(this.activeRegion, false);
        }
        this.activeRegion = next;
        this.lastRegionKey = next ? this.regionKey(next) : '';
        if (next) {
            this.setRegionEditAlpha(next, true);
            this.layoutTiles(next);
        } else {
            this.destroyTiles();
        }
    }

    /**
     * 구역 스프라이트 알파 토글 — Sprite 색상 알파는 자식에게 상속되므로,
     * 편집 중(타일이 자식으로 들어옴)에는 FF로 올려야 타일이 제 밝기로 보인다.
     */
    private setRegionEditAlpha(region: Node, editing: boolean) {
        const sp = region.getComponent(Sprite);
        if (!sp) return;
        const c = sp.color.clone();
        c.a = editing ? 255 : 30;
        sp.color = c;
    }

    private regionKey(n: Node): string {
        const ut = n.getComponent(UITransform);
        return `${n.position.x},${n.position.y},${ut?.contentSize.width},${ut?.contentSize.height}`;
    }

    /**
     * 구역 범위에 맞춰 타일 노드 배치 — 재사용, 남으면 제거, 모자라면 생성.
     * preserveValues=true면 노드가 든 값(img/attr/zone)을 유지한 채 좌표만 갱신 (구역 이동용).
     */
    private layoutTiles(region: Node, preserveValues = false) {
        const ut = region.getComponent(UITransform);
        if (!ut) return;
        const w = Math.round(ut.contentSize.width / B);
        const h = Math.round(ut.contentSize.height / B);
        // 구역이 덮는 첫 셀 — floor로 안정적 타이브레이크 (셀 중심은 정수×32)
        const gx0 = Math.floor(region.position.x / B - w / 2 + 0.5);
        const gy0 = Math.floor(region.position.y / B - h / 2 + 0.5);

        // ★ autofit: 구역 사각형을 덮는 셀들에 딱 맞게 정렬 — 사각형과 타일이 항상 일치
        const fitX = (gx0 - 0.5 + w / 2) * B;
        const fitY = (gy0 - 0.5 + h / 2) * B;
        if (region.position.x !== fitX || region.position.y !== fitY) {
            region.setPosition(fitX, fitY, 0);
        }

        const needed = w * h;
        // 이전 세션에서 씬에 저장돼 남은 타일 잔재 제거 (우리 배열 밖의 t_* 노드)
        const mine = new Set(this.tileNodes);
        for (const child of [...region.children]) {
            if (/^t_/.test(child.name) && !mine.has(child)) child.destroy();
        }
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
                // 타일은 항상 실제 데이터 좌표(g×32)에 표시 — 에디터에서 보이는 위치 = 게임 위치
                n.setPosition((gx0 + tx) * B - region.position.x, (gy0 + ty) * B - region.position.y, 0);
                n.name = `t_${gx}_${gy}`;
                const tile = n.getComponent(MapTile)!;
                if (!preserveValues) {
                    const ov = overrides[`${gx},${gy}`];
                    tile.img = ov ? ov[0] : 0;
                    tile.attr = ov ? (ov[1] ?? 0) : 0;
                    tile.zone = ov ? (ov[2] ?? 0) : 0;
                }
                tile.forceRefresh();
            }
        }
        this.lastW = w;
        this.lastH = h;
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
        this.lastW = 0;
        this.lastH = 0;
    }

    private createTileNode(): Node {
        const n = new Node('t');
        n.hideFlags = CCObject.Flags.DontSave; // 편집용 일회성 — 씬에 저장 금지 (잔재 누적 방지)
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

    /**
     * 맵 크기 변경 시 데이터 이동 — 아래 모서리 고정 성장.
     * 커질 때(dR>0): 모든 콘텐츠를 (-dR,-dR) 이동 → 새 아래 모서리에 그대로 붙음, 위쪽으로만 넓어짐.
     * 줄일 때: 반대 방향 이동, 새 범위 밖 타일은 제거(경고 로그).
     */
    private shiftForResize(dR: number) {
        const s = -dR; // 콘텐츠 이동량 (타일)
        const R = (this.mapTiles - 1) / 2;

        // 타일 데이터
        const ov = this.overrides();
        const moved: Record<string, number[]> = {};
        let dropped = 0;
        for (const key of Object.keys(ov)) {
            const [gx, gy] = key.split(',').map(Number);
            const nx = gx + s, ny = gy + s;
            if (nx < -R || nx > R || ny < -R || ny > R) { dropped++; continue; }
            moved[`${nx},${ny}`] = ov[key];
        }
        this.tileOverridesJson = JSON.stringify(moved);

        // 스폰·전역 배치물·구역(구역 자식 배치물은 함께 이동)
        const px = s * B;
        const shiftChildren = (group: Node | null) => {
            for (const n of group?.children ?? []) {
                n.setPosition(n.position.x + px, n.position.y + px, 0);
            }
        };
        shiftChildren(this.node.getChildByName('spawn'));
        shiftChildren(this.node.getChildByName('props'));
        shiftChildren(this.node.getChildByName('regions'));

        // 활성 구역 화면 재로드 (이동 감지 로직이 이중 이동시키지 않게 키 갱신)
        if (this.activeRegion) {
            this.layoutTiles(this.activeRegion);
            this.lastRegionKey = this.regionKey(this.activeRegion);
        }
        console.log(`[MapEditRoot] 맵 크기 ${this.lastMapTiles}→${this.mapTiles}: 콘텐츠 ${s > 0 ? '+' : ''}${s}타일 이동 (아래 모서리 고정)${dropped ? `, 범위 밖 타일 ${dropped}개 제거` : ''}`);
    }

    // ── 불러오기 (mapdata.json → 에디터) — 내보내기의 역방향 ──
    private doImport() {
        // 덮어쓰기 사고 방지 — 현재 편집 상태를 백업으로 먼저 내보냄
        this.doExport('db://assets/mapedit/mapdata_backup.json'); // 에디터 폴더 — 빌드 미포함
        Editor.Message.request('asset-db', 'query-asset-info', 'db://assets/resources/maps/mapdata.json')
            .then((info: { uuid?: string } | null) => {
                if (!info?.uuid) {
                    console.warn('[MapEditRoot] 불러오기 실패 — mapdata.json이 없습니다');
                    return;
                }
                assetManager.loadAny({ uuid: info.uuid }, (err: Error | null, asset: JsonAsset) => {
                    if (err || !asset) {
                        console.warn('[MapEditRoot] mapdata.json 로드 실패', err);
                        return;
                    }
                    this.applyImport(asset.json);
                });
            })
            .catch((e: unknown) => console.warn('[MapEditRoot] mapdata.json 조회 실패', e));
    }

    private applyImport(json: unknown) {
        const map = parseMapDataJson(json);
        if (!map) {
            console.warn('[MapEditRoot] 불러오기 실패 — mapdata.json 형식이 올바르지 않습니다');
            return;
        }
        const R = map.groundRadius;
        this.mapTiles = R * 2 + 1;
        // ⚠️ 크기 변경 감지 기준점도 같이 갱신 — 안 하면 다음 틱에 shiftForResize가
        // 임포트로 바뀐 mapTiles를 사용자 리사이즈로 오해해 콘텐츠를 잘못 이동시킴
        this.lastMapTiles = this.mapTiles;
        this.lastGridKey = ''; // 격자 재생성

        // 타일 그리드 → 변경분 저장소 (0이 아닌 타일만)
        const ov: Record<string, number[]> = {};
        this.lastImportDungeonIds.clear();
        const grid = map.tiles ?? [];
        for (let iy = 0; iy < grid.length; iy++) {
            const row = grid[iy] ?? [];
            for (let ix = 0; ix < row.length; ix++) {
                const t = row[ix];
                const key = `${ix - R},${iy - R}`;
                if (t.img !== 0 || t.attr !== 0 || t.zone !== 0) {
                    ov[key] = [t.img, t.attr, t.zone];
                }
                if ((t.dungeon ?? 0) > 0) this.lastImportDungeonIds.set(key, t.dungeon!);
            }
        }
        this.tileOverridesJson = JSON.stringify(ov);

        // 스폰 마커
        const spawnGroup = this.ensureGroup('spawn');
        let spawnNode = spawnGroup.children.find(n => !n.name.startsWith('_'));
        if (!spawnNode) {
            spawnNode = this.createMarker(spawnGroup, '플레이어시작', 24, 24, '#FFFFFF');
        }
        spawnNode.setPosition(map.playerSpawn.gx * B, map.playerSpawn.gy * B, 0);

        // 배치물 — 기존 전부 비우고(전역+구역) 전역 그룹에 재생성
        const globalProps = this.ensureGroup('props');
        for (const c of [...globalProps.children]) c.destroy();
        for (const region of this.regionsGroup().children) {
            const rp = region.getChildByName('props');
            if (rp) for (const c of [...rp.children]) c.destroy();
        }
        const kindCount: Record<string, number> = {};
        for (const p of map.props) {
            kindCount[p.kind] = (kindCount[p.kind] || 0) + 1;
            const name = kindCount[p.kind] === 1 ? p.kind : `${p.kind}${kindCount[p.kind]}`;
            const n = this.createMarker(globalProps, name, Math.max(p.w / 4, 8), Math.max(p.h / 4, 8), p.tint);
            n.setPosition(p.gx * B, p.gy * B, 0);
        }

        // 칠해진 데이터에서 편집 구역 자동 생성 (같은 존 값의 연결 덩어리마다 1개)
        this.rebuildRegionsFromData();
        console.log(`[MapEditRoot] 불러오기 완료 — ${this.mapTiles}×${this.mapTiles}, 데이터 타일 ${Object.keys(ov).length}개, 배치물 ${map.props.length}개`);
    }

    /** 타일 데이터의 존 덩어리(연결 요소)마다 편집 구역 마커 생성 — 기존 구역은 교체 */
    private rebuildRegionsFromData() {
        this.destroyTiles();
        this.activeRegion = null;
        this.lastRegionKey = '';
        const group = this.regionsGroup();
        for (const c of [...group.children]) c.destroy();

        const ov = this.overrides();
        const zoneOf = new Map<string, number>();
        for (const k of Object.keys(ov)) {
            const z = ov[k][2] ?? 0;
            if (z > 0) zoneOf.set(k, z);
        }

        const visited = new Set<string>();
        const counts: Record<number, number> = {};
        let made = 0;
        // 행 우선(gy→gx) 정렬 — 게임의 던전 인스턴스 ID(buildDungeonIdGrid) 부여 순서와 일치
        const starts = [...zoneOf.keys()].sort((a, b) => {
            const [ax, ay] = a.split(',').map(Number);
            const [bx, by] = b.split(',').map(Number);
            return ay - by || ax - bx;
        });
        for (const start of starts) {
            if (visited.has(start)) continue;
            const z = zoneOf.get(start)!;
            // BFS로 같은 존 값 연결 덩어리 수집 (4방향)
            const queue = [start];
            visited.add(start);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            while (queue.length) {
                const k = queue.pop()!;
                const [gx, gy] = k.split(',').map(Number);
                if (gx < minX) minX = gx;
                if (gx > maxX) maxX = gx;
                if (gy < minY) minY = gy;
                if (gy > maxY) maxY = gy;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nk = `${gx + dx},${gy + dy}`;
                    if (!visited.has(nk) && zoneOf.get(nk) === z) {
                        visited.add(nk);
                        queue.push(nk);
                    }
                }
            }
            const w = Math.min(REGION_MAX, maxX - minX + 1);
            const h = Math.min(REGION_MAX, maxY - minY + 1);
            counts[z] = (counts[z] || 0) + 1;
            // 네이밍 규칙: 던전은 d{던전ID} — ID는 데이터(tiles.dungeon)에 기록된 명시값 우선, 없으면 순번
            const explicitId = z === ZoneType.Dungeon ? (this.lastImportDungeonIds.get(start) ?? 0) : 0;
            const dungeonId = explicitId > 0 ? explicitId : counts[z];
            const name = z === ZoneType.Dungeon
                ? `d${dungeonId}`
                : `${synthZoneDef(z).name}${counts[z]}`;
            const n = this.createMarker(group, name, w * B, h * B, '#FFFFFF');
            const sp = n.getComponent(Sprite)!;
            const c = sp.color.clone();
            c.a = 30;
            sp.color = c;
            n.setPosition((minX - 0.5 + w / 2) * B, (minY - 0.5 + h / 2) * B, 0);
            const tr = n.addComponent(TileRegion);
            if (z === ZoneType.Dungeon) tr.regionId = dungeonId;
            this.ensurePropsGroup(n);
            made++;
            if (maxX - minX + 1 > REGION_MAX || maxY - minY + 1 > REGION_MAX) {
                console.warn(`[MapEditRoot] 구역 '${name}' 덩어리가 최대 크기(${REGION_MAX})보다 큼 — 일부만 덮음`);
            }
        }
        console.log(`[MapEditRoot] 편집 구역 자동 생성: ${made}개`);
    }

    private ensureGroup(name: string): Node {
        let g = this.node.getChildByName(name);
        if (!g) {
            g = new Node(name);
            g.layer = Layers.Enum.UI_2D;
            this.node.addChild(g);
        }
        return g;
    }

    private createMarker(parent: Node, name: string, w: number, h: number, tint: string): Node {
        const n = new Node(name);
        n.layer = Layers.Enum.UI_2D;
        parent.addChild(n);
        n.addComponent(UITransform).setContentSize(w, h);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        const frame = this.findAnyFrame();
        if (frame) sp.spriteFrame = frame;
        const c = new Color();
        Color.fromHEX(c, tint);
        sp.color = c;
        return n;
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
    private doExport(url = 'db://assets/resources/maps/mapdata.json') {
        if (this.activeRegion) this.commitTiles(this.activeRegion); // 열려 있는 편집분 반영
        const map = parseMapRoot(this.node); // 벽·배치물·스폰
        if (!map) {
            console.warn('[MapEditRoot] 내보내기 실패 — MapRoot 구조가 올바르지 않습니다');
            return;
        }
        const N = this.mapTiles;
        const R = (N - 1) / 2;
        const overrides = this.overrides();
        // regionId가 지정된 구역 목록 (던전 ID 기록용)
        const idRegions: { gx0: number; gy0: number; w: number; h: number; id: number }[] = [];
        for (const n of this.regionsGroup().children) {
            const tr = n.getComponent(TileRegion);
            const ut = n.getComponent(UITransform);
            if (!tr || !ut || tr.regionId <= 0) continue;
            const w = Math.round(ut.contentSize.width / B);
            const h = Math.round(ut.contentSize.height / B);
            idRegions.push({
                gx0: Math.floor(n.position.x / B - w / 2 + 0.5),
                gy0: Math.floor(n.position.y / B - h / 2 + 0.5),
                w, h, id: tr.regionId,
            });
        }
        const dungeonIdOf = (gx: number, gy: number): number => {
            for (const r of idRegions) {
                if (gx >= r.gx0 && gx < r.gx0 + r.w && gy >= r.gy0 && gy < r.gy0 + r.h) return r.id;
            }
            return 0;
        };

        const img: number[] = [], zone: number[] = [], attr: number[] = [], dungeon: number[] = [];
        for (let gy = -R; gy <= R; gy++) {
            for (let gx = -R; gx <= R; gx++) {
                const ov = overrides[`${gx},${gy}`];
                const z = ov ? (ov[2] ?? 0) : 0;
                img.push(ov ? ov[0] : 0);
                attr.push(ov ? (ov[1] ?? 0) : 0);
                zone.push(z);
                dungeon.push(z === ZoneType.Dungeon ? dungeonIdOf(gx, gy) : 0);
            }
        }
        const payload = {
            version: 2, size: N,
            spawn: map.playerSpawn, props: map.props,
            tiles: { img, zone, attr, dungeon },
        };
        Editor.Message.request('asset-db', 'create-asset',
            url, JSON.stringify(payload), { overwrite: true })
            .then(() => console.log(`[MapEditRoot] 내보내기 완료 v2 → ${url} (${N}×${N}, 데이터 타일 ${Object.keys(overrides).length}개)`))
            .catch((e: unknown) => console.warn('[MapEditRoot] 내보내기 실패', e));
    }
}
