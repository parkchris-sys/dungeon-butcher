import { _decorator, Component, Node, Sprite, UITransform, Color, Layers, CCInteger, CCString, CCBoolean, CCObject } from 'cc';
import { EDITOR } from 'cc/env';
import { objFrame, objAspect, ensureObjFrames } from './TileFrameCache';

const { ccclass, property, executeInEditMode } = _decorator;

const B = 32;           // 청사진 1타일 px
const OBJ_MAX = 16;     // 오브젝트 한 변 최대 타일 수

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

    private lastKey = '';
    private imgNode: Node | null = null;

    update() {
        if (!EDITOR) return;
        ensureObjFrames();

        this.tileW = Math.min(OBJ_MAX, Math.max(1, Math.round(this.tileW)));
        this.tileH = Math.min(OBJ_MAX, Math.max(1, Math.round(this.tileH)));
        const w = this.tileW, h = this.tileH;

        // 밑판 = 차지 영역 (타일 단위) — 격자 셀에 딱 맞게 스냅 (구역과 같은 방식)
        this.node.getComponent(UITransform)?.setContentSize(w * B, h * B);
        const p = this.node.position;
        const gx0 = Math.floor(p.x / B - w / 2 + 0.5);
        const gy0 = Math.floor(p.y / B - h / 2 + 0.5);
        const fitX = (gx0 - 0.5 + w / 2) * B;
        const fitY = (gy0 - 0.5 + h / 2) * B;
        if (p.x !== fitX || p.y !== fitY) this.node.setPosition(fitX, fitY, 0);

        const sf = objFrame(this.img);
        const key = `${this.img},${!!sf},${w},${h}`;
        if (key === this.lastKey) return;
        this.lastKey = key;

        const base = this.getComponent(Sprite);

        if (sf) {
            // 외형 이미지 — 역보정으로 업라이트 표시, 폭 = 발자국 마름모의 화면 폭,
            // 하단 = 발자국 마름모의 아래 꼭짓점 (오브젝트가 타일 위에 "서 있는" 모양)
            const view = this.ensureImgNode();
            const sp = view.getComponent(Sprite)!;
            sp.spriteFrame = sf;
            sp.markForUpdateRenderData();
            const isoW = (w + h) * B / Math.SQRT2;
            view.getComponent(UITransform)!.setContentSize(isoW, isoW * objAspect(this.img));
            // 마름모 아래 꼭짓점의 로컬 좌표 = (-(w+h)B/4, -(w+h)B/4) — 화면상 수평 중앙·최하단
            const corner = -(w + h) * B / 4;
            view.setPosition(corner, corner, 0);
            view.active = true;
            if (base) {
                // 발자국은 반투명으로 유지하고 싶지만 알파가 자식에 상속되므로 enabled로 숨김
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
