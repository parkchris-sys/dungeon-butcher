import {
    _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Color, Layers,
    Graphics, RenderRoot2D, CCInteger, CCBoolean, CCString, CCObject,
    JsonAsset, assetManager,
} from 'cc';
import { EDITOR } from 'cc/env';
import { MapTile } from './MapTile';
import { TileRegion } from './TileRegion';
import { MapUnit } from './MapUnit';
import { MapObject } from './MapObject';
import { MapTrigger, MapTriggerKind, triggerKindOf, triggerTypeOf } from './MapTrigger';
import { ensureFloorFrames, floorFrame, retryFloorFrames } from './TileFrameCache';
import { parseMapRoot } from '../ingame/SceneMapLoader';
import {
    parseMapDataJson, synthZoneDef, ZoneType, MapRegionInfo, MapObjectDef, MapUnitDef, MapTriggerDef,
} from '../ingame/MapData';
import { TILE_W, TILE_H } from '../ingame/Projection';

/** 아이소 카운터 트랜스폼 배율 — 게임 px → 에디터 _img 크기 (타일 _img와 동일 기준) */
const ISO_K = 1 / (2 * Math.SQRT2);

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

    @property({ type: CCBoolean, tooltip: '체크 = 오브젝트 추가 (objects 루트) — img 외형·kind 종류·tileW/H 타일 단위 크기' })
    addObject = false;

    @property({ type: CCBoolean, tooltip: '체크 = 트리거 추가 (triggers 루트) — 타입·크기·연결 ID 설정' })
    addTrigger = false;

    @property({ type: CCBoolean, tooltip: '체크 = 몬스터 추가 (monsters 루트) — kind가 그 던전의 스폰 종류가 됨 (예: slime)' })
    addMonster = false;

    @property({ type: CCBoolean, tooltip: '체크 = NPC 추가 (npcs 루트) — img 외형·kind 자유 라벨' })
    addNpc = false;

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
        this.syncPlacements();
        this.ensureFloorPreviews();
        this.raiseOverlays();

        if (this.addRegion) { this.addRegion = false; this.createRegion(); }
        if (this.addObject) { this.addObject = false; this.createObject(); }
        if (this.addTrigger) { this.addTrigger = false; this.createTrigger(); }
        if (this.addMonster) { this.addMonster = false; this.createUnit('monsters', '몬스터', 'slime'); }
        if (this.addNpc) { this.addNpc = false; this.createUnit('npcs', 'NPC', 'customer'); }
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
        const attrTint: Record<number, string> = { 1: '#B03A30', 2: '#3E86C0', 3: '#E0A93B' };
        const zoneTint: Record<number, string> = { 0: '#2A2A34', 1: '#4E3827', 2: '#3C3159', 3: '#3A3A44' };
        for (const key of Object.keys(ov)) {
            const attr = ov[key][1] ?? 0;
            const zone = ov[key][2] ?? 0;
            // 속성이 우선(경로 강조), 없으면 존 색 — 실제 바닥 그림은 구역 통짜 이미지가 담당
            const hex = attrTint[attr] ?? zoneTint[zone] ?? zoneTint[0];
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

    /**
     * 구역별 통짜 바닥 이미지 프리뷰 — 게임과 같은 모양으로 (아이소 카운터 트랜스폼).
     * 타일별 이미지 대신 구역 하나에 큰 바닥 그림 1장. 값이 바뀔 때만 다시 만든다.
     * 별도 그룹(_바닥이미지)에 둬서 구역 마커의 반투명 알파가 상속되지 않게 한다.
     */
    private lastFloorKey = '';
    private floorRescanTick = 0;
    private ensureFloorPreviews() {
        ensureFloorFrames();
        let group = this.node.getChildByName('_바닥이미지');
        if (!group) {
            group = new Node('_바닥이미지');
            group.hideFlags = CCObject.Flags.DontSave; // 런타임 프레임 — 씬 저장 금지
            group.layer = Layers.Enum.UI_2D;
            this.node.addChild(group);
            group.setSiblingIndex(3); // 데이터프리뷰 위, 구역 마커 아래
            this.lastFloorKey = '';
        }

        // 서명 — 구역 위치·크기 + 바닥 파라미터 + 로드된 프레임 크기. 바뀔 때만 재생성
        let sig = '';
        let anyMissing = false;
        for (const n of this.regionsGroup().children) {
            const tr = n.getComponent(TileRegion);
            if (!tr || !tr.floorImg) continue;
            const f = floorFrame(tr.floorImg);
            if (!f) anyMissing = true;
            const ut = n.getComponent(UITransform);
            sig += `${n.position.x},${n.position.y},${ut?.contentSize.width}x${ut?.contentSize.height},`
                + `${tr.floorImg},${tr.floorScale},${tr.floorOffX},${tr.floorOffY},`
                + `${f ? f.rect.width : 0}x${f ? f.rect.height : 0};`;
        }
        // 이미지가 아직 안 잡힌 구역이 있으면 주기적으로 폴더 재스캔 (새 이미지 추가 시 리로드 불필요)
        if (anyMissing && (++this.floorRescanTick % 30 === 0)) retryFloorFrames();

        if (sig === this.lastFloorKey) return;
        this.lastFloorKey = sig;

        for (const c of [...group.children]) c.destroy();
        for (const n of this.regionsGroup().children) {
            const tr = n.getComponent(TileRegion);
            if (!tr || !tr.floorImg) continue;
            const f = floorFrame(tr.floorImg);
            const scale = tr.floorScale || 1;
            // 화면 px offset → 타일 offset(screenToGrid) → 청사진 로컬 (게임 isoX/isoY와 일치)
            const offGx = tr.floorOffX / TILE_W + tr.floorOffY / TILE_H;
            const offGy = -tr.floorOffX / TILE_W + tr.floorOffY / TILE_H;
            const node = new Node('_floor');
            node.hideFlags = CCObject.Flags.DontSave;
            node.layer = Layers.Enum.UI_2D;
            group.addChild(node);
            node.setPosition(n.position.x + offGx * B, n.position.y + offGy * B, 0);
            node.angle = -45;               // MapRoot의 +45 상쇄 → 업라이트
            node.setScale(1, 2, 1);         // _isoview scaleY 0.5 상쇄
            // ⚠️ UITransform 먼저 — Sprite 추가 시 UITransform이 자동 부착되므로 순서 뒤바뀌면 중복 오류
            const ut = node.addComponent(UITransform);
            const sp = node.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            if (f) {
                ut.setContentSize(f.rect.width * scale * ISO_K, f.rect.height * scale * ISO_K);
                sp.spriteFrame = f;
            } else {
                // 이미지 없음 — 구역 크기의 마젠타 플레이스홀더 (floorImg 지정됐지만 파일 못 찾음)
                const rut = n.getComponent(UITransform);
                const w = Math.round((rut?.contentSize.width ?? B) / B);
                const h = Math.round((rut?.contentSize.height ?? B) / B);
                ut.setContentSize((w + h) * TILE_W / 2 * ISO_K, (w + h) * TILE_H / 2 * ISO_K);
                sp.spriteFrame = this.findAnyFrame();
                sp.color = new Color(220, 70, 200, 150);
            }
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

    /** 사용 중이지 않은 다음 지역 ID */
    private nextRegionId(): number {
        let max = 0;
        for (const n of this.regionsGroup().children) {
            const tr = n.getComponent(TileRegion);
            if (tr && tr.regionId > max) max = tr.regionId;
        }
        return max + 1;
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
        const tr = n.addComponent(TileRegion);
        tr.regionId = this.nextRegionId(); // 모든 지역은 고유 ID
        this.ensurePropsGroup(n);
        console.log(`[MapEditRoot] 편집 구역 추가 (ID ${tr.regionId}) — 이름은 자유롭게, 위치 잡고 editTiles 체크`);
    }

    /**
     * 오브젝트·배치물을 최상위로 — EditTiles로 생긴 타일 노드보다 뒤(위)에 그려지게.
     * Cocos 2D는 시빌링 인덱스가 클수록 위에 렌더되므로 매 틱 마지막으로 밀어 준다.
     * 리전 안: props → objects 순으로 올려 objects가 맨 위. 전역 objects도 MapRoot 맨 뒤로.
     */
    private raiseOverlays() {
        for (const region of this.regionsGroup().children) {
            const props = region.getChildByName('props');
            const objs = region.getChildByName('objects');
            if (props) props.setSiblingIndex(region.children.length - 1);
            if (objs) objs.setSiblingIndex(region.children.length - 1);
        }
        const globalObjects = this.node.getChildByName('objects');
        if (globalObjects) globalObjects.setSiblingIndex(this.node.children.length - 1);
    }

    /** 구역마다 objects 하위 그룹 — 종속 오브젝트가 구역 자식이라 구역과 함께 움직임 */
    private ensureObjectsGroup(region: Node): Node {
        let g = region.getChildByName('objects');
        if (!g) {
            g = new Node('objects');
            g.layer = Layers.Enum.UI_2D;
            region.addChild(g);
        }
        return g;
    }

    /** 전역 objects + 모든 리전 objects 그룹의 오브젝트 노드 목록 ('_' 제외) */
    private allObjectNodes(): Node[] {
        const out: Node[] = [];
        for (const n of this.ensureGroup('objects').children) {
            if (!n.name.startsWith('_')) out.push(n);
        }
        for (const r of this.regionsGroup().children) {
            const g = r.getChildByName('objects');
            if (g) for (const n of g.children) if (!n.name.startsWith('_')) out.push(n);
        }
        return out;
    }

    /**
     * 오브젝트를 종속 리전으로 편입 — MapObject.regionId가 가리키는 리전의 objects 자식으로 이동.
     * 절대 위치(청사진)는 보존한다. regionId=0 이거나 해당 리전이 없으면 전역 objects 그룹으로.
     */
    private syncObjectRegions() {
        const globalObjects = this.ensureGroup('objects');
        const regions = this.regionsGroup().children;
        const regionById = (id: number) =>
            regions.find(r => r.getComponent(TileRegion)?.regionId === id) ?? null;

        for (const node of this.allObjectNodes()) {
            const o = node.getComponent(MapObject);
            if (!o) continue;
            const targetRegion = o.regionId > 0 ? regionById(o.regionId) : null;
            const targetParent = targetRegion ? this.ensureObjectsGroup(targetRegion) : globalObjects;
            if (node.parent === targetParent) continue;

            // 절대 청사진 좌표 = 현재 로컬 + 현재 소속 리전 offset
            const curParent = node.parent;
            const curRegion = curParent && curParent.name === 'objects' ? curParent.parent : null;
            const curOff = curRegion?.getComponent(TileRegion) ? curRegion.position : null;
            const absX = node.position.x + (curOff?.x ?? 0);
            const absY = node.position.y + (curOff?.y ?? 0);
            const newOff = targetRegion ? targetRegion.position : null;
            node.parent = targetParent;
            node.setPosition(absX - (newOff?.x ?? 0), absY - (newOff?.y ?? 0), 0);
        }
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

    // ── 배치물 (종류별 루트: objects / monsters / npcs / spawn) ──
    /**
     * 종류별 루트 보장 + 자식 노드에 편집 컴포넌트 자동 부착.
     * 디자이너가 노드를 복제/신규 생성해도 컴포넌트가 저절로 붙어 바로 편집 가능.
     */
    private syncPlacements() {
        // 오브젝트 노드는 전역 objects 그룹 + 각 리전의 objects 그룹 모두에 있을 수 있음
        for (const n of this.allObjectNodes()) {
            if (!n.getComponent(MapObject)) n.addComponent(MapObject);
        }
        this.syncObjectRegions();
        const triggers = this.ensureGroup('triggers');
        for (const n of triggers.children) {
            if (n.name.startsWith('_')) continue;
            if (!n.getComponent(MapTrigger)) n.addComponent(MapTrigger);
        }
        for (const rootName of ['monsters', 'npcs', 'spawn']) {
            const root = this.ensureGroup(rootName);
            for (const n of root.children) {
                if (n.name.startsWith('_')) continue;
                if (!n.getComponent(MapUnit)) {
                    const u = n.addComponent(MapUnit);
                    u.kind = rootName === 'spawn' ? 'player'
                        : rootName === 'monsters' ? 'slime' : 'npc';
                }
            }
        }
    }

    private createObject() {
        const root = this.ensureGroup('objects');
        const n = this.createMarker(root, `오브젝트${root.children.length + 1}`, B, B, '#8A6A4A');
        const o = n.addComponent(MapObject);
        let index = 1;
        const used = new Set(root.children.map(child => child.getComponent(MapObject)?.objectId));
        while (used.has(`object-${index}`)) index++;
        o.objectId = `object-${index}`;
        o.kind = 'obj';
        console.log('[MapEditRoot] 오브젝트 추가 — Inspector에서 img(외형)·kind(종류)·tileW/H(타일 크기) 설정');
    }

    private createTrigger() {
        const root = this.ensureGroup('triggers');
        let index = 1;
        const used = new Set(root.children.map(child => child.getComponent(MapTrigger)?.triggerId));
        while (used.has(`trigger-${index}`)) index++;
        const n = this.createMarker(root, `트리거${index}`, B, B, '#D96C4A');
        const trigger = n.addComponent(MapTrigger);
        trigger.triggerId = `trigger-${index}`;
        trigger.triggerType = MapTriggerKind.IngredientDropoff;
        console.log('[MapEditRoot] 트리거 추가 — triggerId·triggerType·tileW/H·연결 ID를 설정하세요');
    }

    private createUnit(rootName: string, label: string, kind: string) {
        const root = this.ensureGroup(rootName);
        const n = this.createMarker(root, `${label}${root.children.length + 1}`, B - 4, B - 4, '#FFFFFF');
        const u = n.addComponent(MapUnit);
        u.kind = kind;
        console.log(`[MapEditRoot] ${label} 추가 — Inspector에서 img(외형)·kind(종류) 설정`);
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
     * 편집 중이면 구역 마커 Sprite를 끈다 — 통짜 바닥 이미지 위를 반투명 마커가 덮지 않게.
     * 편집 아닐 땐 반투명 마커(alpha 30)로 구역 위치·크기를 보여준다.
     */
    private setRegionEditAlpha(region: Node, editing: boolean) {
        const sp = region.getComponent(Sprite);
        if (!sp) return;
        sp.enabled = !editing;
        if (!editing) {
            const c = sp.color.clone();
            c.a = 30;
            sp.color = c;
        }
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
        shiftChildren(this.node.getChildByName('objects'));
        shiftChildren(this.node.getChildByName('triggers'));
        shiftChildren(this.node.getChildByName('monsters'));
        shiftChildren(this.node.getChildByName('npcs'));

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
        const spawnUnit = spawnNode.getComponent(MapUnit) ?? spawnNode.addComponent(MapUnit);
        spawnUnit.kind = 'player';
        spawnUnit.img = map.playerImg ?? 0;

        // 오브젝트·몬스터·NPC — 루트 비우고 데이터로 재생성
        const objRoot = this.ensureGroup('objects');
        for (const c of [...objRoot.children]) c.destroy();
        for (const o of map.objects ?? []) {
            const n = this.createMarker(objRoot, o.kind, o.w * B, o.h * B, '#8A6A4A');
            n.setPosition((o.gx - 0.5 + o.w / 2) * B, (o.gy - 0.5 + o.h / 2) * B, 0);
            const comp = n.addComponent(MapObject);
            comp.objectId = o.id ?? '';
            comp.kind = o.kind;
            comp.img = o.img;
            comp.tileW = o.w;
            comp.tileH = o.h;
            comp.walkable = o.walkable ?? false;
            comp.regionId = o.regionId ?? 0; // syncObjectRegions가 다음 틱에 리전으로 편입
            comp.imgScale = o.imgScale ?? 1;
            comp.imgOffX = o.imgOffX ?? 0;
            comp.imgOffY = o.imgOffY ?? 0;
        }
        const triggerRoot = this.ensureGroup('triggers');
        for (const c of [...triggerRoot.children]) c.destroy();
        for (const t of map.triggers ?? []) {
            const n = this.createMarker(triggerRoot, t.id, t.w * B, t.h * B, '#D96C4A');
            n.setPosition((t.gx - 0.5 + t.w / 2) * B, (t.gy - 0.5 + t.h / 2) * B, 0);
            const comp = n.addComponent(MapTrigger);
            comp.triggerId = t.id;
            comp.triggerType = triggerKindOf(t.type);
            comp.tileW = t.w;
            comp.tileH = t.h;
            comp.triggerLink1 = t.triggerLinks[0] ?? '';
            comp.objectLink1 = t.objectLinks[0] ?? '';
            comp.npcImg = t.npcImg ?? 0;
        }
        const restoreUnits = (rootName: string, list: MapUnitDef[] | undefined) => {
            const root = this.ensureGroup(rootName);
            for (const c of [...root.children]) c.destroy();
            for (const u of list ?? []) {
                const n = this.createMarker(root, u.kind, B - 4, B - 4, '#FFFFFF');
                n.setPosition(u.gx * B, u.gy * B, 0);
                const comp = n.addComponent(MapUnit);
                comp.kind = u.kind;
                comp.img = u.img;
            }
        };
        restoreUnits('monsters', map.monsters);
        restoreUnits('npcs', map.npcs);

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

        // 구역 복원: 데이터에 저장된 구역(이름·ID·기하) 우선, 없으면 클러스터 파생(레거시)
        if (map.regions && map.regions.length > 0) this.restoreRegionsFromList(map.regions);
        else this.rebuildRegionsFromData();
        console.log(`[MapEditRoot] 불러오기 완료 — ${this.mapTiles}×${this.mapTiles}, 데이터 타일 ${Object.keys(ov).length}개, `
            + `오브젝트 ${map.objects?.length ?? 0}·몬스터 ${map.monsters?.length ?? 0}·NPC ${map.npcs?.length ?? 0}`);
    }

    /** 데이터에 저장된 구역 목록으로 편집 구역 복원 — 이름·던전ID·기하 그대로 */
    private restoreRegionsFromList(list: MapRegionInfo[]) {
        this.destroyTiles();
        this.activeRegion = null;
        this.lastRegionKey = '';
        const group = this.regionsGroup();
        for (const c of [...group.children]) c.destroy();
        for (const r of list) {
            const n = this.createMarker(group, r.name, r.w * B, r.h * B, '#FFFFFF');
            const sp = n.getComponent(Sprite)!;
            const c = sp.color.clone();
            c.a = 30;
            sp.color = c;
            n.setPosition((r.gx - 0.5 + r.w / 2) * B, (r.gy - 0.5 + r.h / 2) * B, 0);
            const tr = n.addComponent(TileRegion);
            tr.regionId = r.id;
            tr.floorImg = r.floorImg ?? 0;
            tr.floorScale = r.floorScale ?? 1;
            tr.floorOffX = r.floorOffX ?? 0;
            tr.floorOffY = r.floorOffY ?? 0;
            this.ensurePropsGroup(n);
        }
        console.log(`[MapEditRoot] 구역 복원: ${list.length}개 (데이터 저장분)`);
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
            // 이름은 자유 라벨 — 기본값만 타입+번호로. ID는 데이터 명시값 우선, 없으면 새 고유 번호
            const explicitId = z === ZoneType.Dungeon ? (this.lastImportDungeonIds.get(start) ?? 0) : 0;
            const name = `${synthZoneDef(z).name}${counts[z]}`;
            const n = this.createMarker(group, name, w * B, h * B, '#FFFFFF');
            const sp = n.getComponent(Sprite)!;
            const c = sp.color.clone();
            c.a = 30;
            sp.color = c;
            n.setPosition((minX - 0.5 + w / 2) * B, (minY - 0.5 + h / 2) * B, 0);
            const tr = n.addComponent(TileRegion);
            tr.regionId = explicitId > 0 ? explicitId : this.nextRegionId();
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
        // 모든 구역(이름·던전ID·기하) 수집 — 데이터에 저장해 에디터 왕복 보존 + 게임 이름 표시
        const regionList: MapRegionInfo[] = [];
        for (const n of this.regionsGroup().children) {
            const tr = n.getComponent(TileRegion);
            const ut = n.getComponent(UITransform);
            if (!tr || !ut) continue;
            const w = Math.round(ut.contentSize.width / B);
            const h = Math.round(ut.contentSize.height / B);
            regionList.push({
                name: n.name,
                id: tr.regionId,
                gx: Math.floor(n.position.x / B - w / 2 + 0.5),
                gy: Math.floor(n.position.y / B - h / 2 + 0.5),
                w, h,
                floorImg: tr.floorImg || undefined,
                floorScale: tr.floorImg ? tr.floorScale : undefined,
                floorOffX: tr.floorImg ? tr.floorOffX : undefined,
                floorOffY: tr.floorImg ? tr.floorOffY : undefined,
            });
        }
        // 지역 ID 검증 — 모든 지역은 고유 ID (중복·미지정은 경고)
        const seenIds = new Set<number>();
        for (const r of regionList) {
            if (r.id <= 0) console.warn(`[MapEditRoot] 지역 '${r.name}'의 ID가 미지정(0) — Inspector에서 지정하세요`);
            else if (seenIds.has(r.id)) console.warn(`[MapEditRoot] 지역 ID 중복: ${r.id} ('${r.name}') — 고유해야 합니다`);
            else seenIds.add(r.id);
        }

        const dungeonIdOf = (gx: number, gy: number): number => {
            for (const r of regionList) {
                if (r.id > 0 && gx >= r.gx && gx < r.gx + r.w && gy >= r.gy && gy < r.gy + r.h) return r.id;
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
        // 배치물 수집 — 오브젝트(전역 + 리전 종속, 절대 좌표로 변환)·몬스터·NPC·플레이어 외형
        const objectList: MapObjectDef[] = [];
        const collectObjects = (group: Node | null, baseX: number, baseY: number) => {
            for (const n of group?.children ?? []) {
                if (n.name.startsWith('_')) continue;
                const o = n.getComponent(MapObject);
                if (!o) continue;
                const ax = baseX + n.position.x, ay = baseY + n.position.y;
                objectList.push({
                    id: o.objectId || undefined,
                    kind: o.kind || 'obj', img: o.img,
                    gx: Math.floor(ax / B - o.tileW / 2 + 0.5),
                    gy: Math.floor(ay / B - o.tileH / 2 + 0.5),
                    w: o.tileW, h: o.tileH,
                    walkable: o.walkable,
                    regionId: o.regionId || undefined,
                    imgScale: o.imgScale !== 1 ? o.imgScale : undefined,
                    imgOffX: o.imgOffX || undefined,
                    imgOffY: o.imgOffY || undefined,
                });
            }
        };
        collectObjects(this.node.getChildByName('objects'), 0, 0); // 전역
        for (const region of this.regionsGroup().children) {
            collectObjects(region.getChildByName('objects'), region.position.x, region.position.y);
        }
        const triggerList: MapTriggerDef[] = [];
        const triggerIds = new Set<string>();
        const objectIds = new Set<string>();
        for (const object of objectList) {
            if (!object.id) continue;
            if (objectIds.has(object.id)) console.warn(`[MapEditRoot] 오브젝트 ID 중복: ${object.id}`);
            objectIds.add(object.id);
        }
        for (const n of this.node.getChildByName('triggers')?.children ?? []) {
            if (n.name.startsWith('_')) continue;
            const t = n.getComponent(MapTrigger);
            if (!t) continue;
            const id = t.triggerId.trim();
            if (!id) {
                console.warn(`[MapEditRoot] 트리거 '${n.name}'의 triggerId가 비어 있어 제외됩니다`);
                continue;
            }
            if (triggerIds.has(id)) console.warn(`[MapEditRoot] 트리거 ID 중복: ${id}`);
            triggerIds.add(id);
            triggerList.push({
                id,
                type: triggerTypeOf(t.triggerType),
                gx: Math.floor(n.position.x / B - t.tileW / 2 + 0.5),
                gy: Math.floor(n.position.y / B - t.tileH / 2 + 0.5),
                w: t.tileW,
                h: t.tileH,
                triggerLinks: t.triggerLink1.trim() ? [t.triggerLink1.trim()] : [],
                objectLinks: t.objectLink1.trim() ? [t.objectLink1.trim()] : [],
                npcImg: t.npcImg || undefined,
            });
        }
        for (const t of triggerList) {
            for (const link of t.triggerLinks) {
                if (!triggerIds.has(link)) console.warn(`[MapEditRoot] 트리거 '${t.id}'의 연결 대상 '${link}'을 찾을 수 없습니다`);
            }
            for (const link of t.objectLinks) {
                if (!objectIds.has(link)) console.warn(`[MapEditRoot] 트리거 '${t.id}'의 연결 오브젝트 '${link}'를 찾을 수 없습니다`);
            }
        }
        const collectUnits = (rootName: string): MapUnitDef[] => {
            const list: MapUnitDef[] = [];
            for (const n of this.node.getChildByName(rootName)?.children ?? []) {
                if (n.name.startsWith('_')) continue;
                const u = n.getComponent(MapUnit);
                if (!u) continue;
                list.push({
                    kind: u.kind || 'unknown', img: u.img,
                    gx: Math.round(n.position.x / B),
                    gy: Math.round(n.position.y / B),
                });
            }
            return list;
        };
        const monsterList = collectUnits('monsters');
        const npcList = collectUnits('npcs');
        for (const m of monsterList) {
            if (dungeonIdOf(m.gx, m.gy) === 0) {
                console.warn(`[MapEditRoot] 몬스터 '${m.kind}'(${m.gx},${m.gy})가 지역 밖에 있음 — 스폰 설정에서 제외될 수 있음`);
            }
        }
        // 플레이어 외형 — spawn 마커의 MapUnit.img
        const spawnUnit = this.node.getChildByName('spawn')
            ?.children.find(n => !n.name.startsWith('_'))?.getComponent(MapUnit);

        const payload = {
            version: 2, size: N,
            spawn: { ...map.playerSpawn, img: spawnUnit?.img ?? 0 },
            props: map.props,
            tiles: { img, zone, attr, dungeon },
            regions: regionList,
            objects: objectList,
            triggers: triggerList,
            monsters: monsterList,
            npcs: npcList,
        };
        Editor.Message.request('asset-db', 'create-asset',
            url, JSON.stringify(payload), { overwrite: true })
            .then(() => console.log(`[MapEditRoot] 내보내기 완료 v2 → ${url} (${N}×${N}, 데이터 타일 ${Object.keys(overrides).length}개)`))
            .catch((e: unknown) => console.warn('[MapEditRoot] 내보내기 실패', e));
    }
}
