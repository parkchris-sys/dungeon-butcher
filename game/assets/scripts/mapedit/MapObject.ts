import { _decorator, Component, Node, Sprite, UITransform, Color, Layers, CCInteger, CCFloat, CCString, CCBoolean, CCObject } from 'cc';
import { EDITOR } from 'cc/env';
import { objFrame, ensureObjFrames, retryObjFrames } from './TileFrameCache';
import { TileRegion } from './TileRegion';
import { TILE_W, TILE_H } from '../ingame/Projection';

const { ccclass, property, executeInEditMode } = _decorator;

const B = 32;           // 청사진 1타일 px
const OBJ_MAX = 16;     // 오브젝트 한 변 최대 타일 수
const ISO_K = 1 / (2 * Math.SQRT2); // 게임 px → 에디터 _img 크기 (타일 _img와 동일 기준)

/**
 * 맵 편집 씬의 오브젝트 마커 — objects 루트 아래. 타일 위에 올라가며 크기는 타일 단위.
 *  - img:   외형 — resources/maps/objs의 {ID}_{이름}.png (0=이미지 없음, 갈색 실루엣)
 *  - kind:  종류 라벨 (자유 — 예: crate, tree, meat_rack)
 *  - tileW/tileH: 차지하는 타일 수 — 밑판(발자국)이 이 크기로 그려지고 격자에 스냅됨
 */
@ccclass('MapObject')
@executeInEditMode
export class MapObject extends Component {
    @property({ type: CCString, tooltip: '트리거가 연결할 때 사용하는 오브젝트 고유 ID' })
    objectId = '';

    @property({ type: CCInteger, tooltip: '외형 — resources/maps/objs의 {ID}_{이름}.png와 매칭 (0=실루엣)' })
    img = 0;

    @property({ type: CCString, tooltip: '종류 라벨 (자유 — 예: crate, tree, meat_rack)' })
    kind = 'obj';

    @property({ type: CCInteger, tooltip: '차지하는 타일 수 (가로)' })
    tileW = 1;

    @property({ type: CCInteger, tooltip: '차지하는 타일 수 (세로)' })
    tileH = 1;

    @property({ type: CCBoolean, tooltip: '체크하면 플레이어가 오브젝트 점유 타일로 이동할 수 있습니다.' })
    walkable = false;

    @property({ type: CCBoolean, tooltip: '체크하면 바닥에 깔린 것으로 취급 — 항상 캐릭터보다 먼저(뒤에) 그려져 바닥에 붙은 효과 (카펫·자국 등)' })
    floorDecal = false;

    @property({ type: CCInteger, tooltip: '종속 리전 ID — 값을 넣으면 이 오브젝트가 해당 리전의 objects 자식으로 편입되어\n'
        + '리전과 함께 움직입니다 (0=전역, 어느 리전에도 종속되지 않음)' })
    regionId = 0;

    @property({ type: CCFloat, tooltip: '외형 이미지 배율 (기본 1) — 타일 크기(tileW/H)와 무관하게 이미지 크기를 조절' })
    imgScale = 1;

    @property({ type: CCInteger, tooltip: '외형 이미지 X offset(px) — 발자국 하단 꼭짓점 기준' })
    imgOffX = 0;

    @property({ type: CCInteger, tooltip: '외형 이미지 Y offset(px)' })
    imgOffY = 0;

    private lastKey = '';
    private imgNode: Node | null = null;
    private rescanTick = 0;

    update() {
        if (!EDITOR) return;
        ensureObjFrames();
        // 이미지가 아직 안 잡혔으면 주기적으로 objs 폴더 재스캔 — 새 이미지 추가 시 리로드 불필요
        if (this.img > 0 && !objFrame(this.img) && (++this.rescanTick % 30 === 0)) retryObjFrames();

        this.tileW = Math.min(OBJ_MAX, Math.max(1, Math.round(this.tileW)));
        this.tileH = Math.min(OBJ_MAX, Math.max(1, Math.round(this.tileH)));
        const w = this.tileW, h = this.tileH;

        // 밑판 = 차지 영역 (타일 단위) — 절대 청사진 좌표 기준으로 격자 셀에 스냅.
        // 리전에 종속되면 부모(리전)가 반타일 오프셋일 수 있어, 로컬이 아닌 절대 좌표로 스냅해야 정렬됨.
        this.node.getComponent(UITransform)?.setContentSize(w * B, h * B);
        const grp = this.node.parent;
        const region = grp && grp.name === 'objects' && grp.parent?.getComponent(TileRegion) ? grp.parent : null;
        const ox = region ? region.position.x : 0;
        const oy = region ? region.position.y : 0;
        const p = this.node.position;
        const ax = p.x + ox, ay = p.y + oy;
        const gx0 = Math.floor(ax / B - w / 2 + 0.5);
        const gy0 = Math.floor(ay / B - h / 2 + 0.5);
        const fitX = (gx0 - 0.5 + w / 2) * B - ox;
        const fitY = (gy0 - 0.5 + h / 2) * B - oy;
        if (p.x !== fitX || p.y !== fitY) this.node.setPosition(fitX, fitY, 0);

        const sf = objFrame(this.img);
        const scale = this.imgScale || 1;
        const key = `${this.img},${!!sf},${w},${h},${scale},${this.imgOffX},${this.imgOffY}`;
        if (key === this.lastKey) return;
        this.lastKey = key;

        const base = this.getComponent(Sprite);

        if (sf) {
            // 외형 이미지 — 역보정으로 업라이트 표시. 크기는 타일 크기와 무관(원본×배율),
            // 하단 = 발자국 마름모의 아래 꼭짓점(앵커 유지) + 화면 offset
            const view = this.ensureImgNode();
            const sp = view.getComponent(Sprite)!;
            sp.spriteFrame = sf;
            sp.markForUpdateRenderData();
            view.getComponent(UITransform)!.setContentSize(
                sf.rect.width * scale * ISO_K, sf.rect.height * scale * ISO_K);
            // 마름모 아래 꼭짓점의 로컬 좌표 = (-(w+h)B/4, -(w+h)B/4) — 화면상 수평 중앙·최하단
            const corner = -(w + h) * B / 4;
            // 화면 px offset → 타일 offset(screenToGrid) → 청사진 로컬 (게임과 동일 정렬)
            const offGx = this.imgOffX / TILE_W + this.imgOffY / TILE_H;
            const offGy = -this.imgOffX / TILE_W + this.imgOffY / TILE_H;
            view.setPosition(corner + offGx * B, corner + offGy * B, 0);
            view.active = true;
            if (base) {
                // ⚠️ Sprite 색 알파는 자식(_img)에 상속됨 — 알파 255로 올려 이미지가 흐려지지 않게 한 뒤
                // 밑판 자체는 enabled=false로 숨긴다
                const c = base.color.clone();
                c.a = 255;
                base.color = c;
                base.enabled = false;
            }
        } else {
            if (this.imgNode) this.imgNode.active = false;
            if (base) {
                base.enabled = true;
                const c = new Color();
                Color.fromHEX(c, '#8A6A4A'); // 오브젝트 실루엣 = 갈색
                c.a = 170;
                base.color = c;
            }
        }
    }

    /** 역보정 이미지 노드 — anchorY 0: 하단 기준 */
    private ensureImgNode(): Node {
        if (this.imgNode && this.imgNode.isValid) return this.imgNode;
        for (const child of [...this.node.children]) {
            if (child.name === '_img') child.destroy(); // 씬에 저장된 잔재 제거
        }
        const n = new Node('_img');
        n.hideFlags = CCObject.Flags.DontSave;
        n.layer = Layers.Enum.UI_2D;
        this.node.addChild(n);
        n.angle = -45;
        n.setScale(1, 2, 1);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false;
        this.imgNode = n;
        return n;
    }
}
