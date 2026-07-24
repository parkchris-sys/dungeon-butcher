import { _decorator, Component, Node, Sprite, UITransform, Color, Layers, CCInteger, Enum, CCObject } from 'cc';
import { EDITOR } from 'cc/env';
import { TILE_STYLE } from '../ingame/TileView';
import { TILE_COLORS } from '../ingame/TilePalette';
import { tileFrame, ensureTileFrames } from './TileFrameCache';

const { ccclass, property, executeInEditMode } = _decorator;

/** Inspector 드롭다운용 존 타입 — 값은 게임의 ZoneType(MapData.ts)과 동일 */
enum 존타입 {
    없음 = 0,
    마을 = 1,
    던전 = 2,
    통로 = 3,
}
Enum(존타입);

/** Inspector 드롭다운용 속성 — 값은 게임의 TILE_ATTR_*(MapData.ts)와 동일 */
enum 속성 {
    없음 = 0,
    이동불가 = 1, // 벽 대체
    대기열 = 2,   // 손님 NPC가 줄 서서 따라 이동
    퇴장 = 3,     // 손님 NPC가 나갈 때 따라 이동
}
Enum(속성);

/** 속성별 에디터 표시색 — 이미지가 있어도 이 틴트를 얹어 경로가 보이게 */
const ATTR_TINT: Record<number, string> = {
    1: '#B03A30', // 이동불가 — 붉은 벽
    2: '#3E86C0', // 대기열 — 파랑
    3: '#E0A93B', // 퇴장 — 노랑
};

/**
 * 맵 편집 씬의 타일 1칸 — Inspector에서 img/attr/zone을 편집한다 (다중 선택 편집 가능).
 * img = 타일 이미지 고유값({ID}_{이름}.png의 ID). 매칭되는 이미지가 있으면 실제 이미지로,
 * 없으면 팔레트 틴트로 표시. 게임 로직은 없음(에디터 전용 데이터).
 */
@ccclass('MapTile')
@executeInEditMode
export class MapTile extends Component {
    @property({ type: CCInteger, tooltip: '타일 이미지 고유값 — resources/maps/tiles의 {ID}_{이름}.png와 매칭 (0=없음)' })
    img = 0;

    @property({ type: 속성, tooltip: '타일 속성 — 이동불가(벽)/대기열(손님 줄)/퇴장(손님 나감)' })
    attr: 속성 = 속성.없음;

    @property({ type: 존타입, tooltip: '구역 타입 — 마을(안전·회복) / 던전(스폰) / 통로(몬스터 불가침)' })
    zone: 존타입 = 존타입.없음;

    private lastImg = -1;
    private lastAttr = -1;
    private lastHadFrame = false;
    private imgNode: Node | null = null;

    update() {
        if (!EDITOR) return;
        ensureTileFrames();
        const hasFrame = !!tileFrame(this.img);
        if (this.img !== this.lastImg || this.attr !== this.lastAttr || hasFrame !== this.lastHadFrame) {
            this.forceRefresh();
        }
    }

    /** 표시 갱신 (MapEditRoot가 값 재배정 후 호출) — 이동불가(attr=1)는 붉게 */
    forceRefresh() {
        this.lastImg = this.img;
        this.lastAttr = this.attr;
        const sf = EDITOR ? tileFrame(this.img) : null;
        this.lastHadFrame = !!sf;

        const base = this.getComponent(Sprite);
        if (!base) return;

        if (sf) {
            // 실제 타일 이미지 — 아이소 뷰 변환(45°+세로압축)을 역보정해 게임과 같은 모양으로
            const view = this.ensureImgNode();
            const sp = view.getComponent(Sprite)!;
            sp.spriteFrame = sf;
            sp.color = this.tintColor('#FFFFFF');
            sp.markForUpdateRenderData();
            view.active = true;
            // ⚠️ 밑판 숨김에 알파 0 금지 — Sprite 색상 알파는 자식에게 상속되어
            // _img까지 투명해진다. 컴포넌트 비활성화로 숨긴다 (자식 영향 없음).
            base.enabled = false;
        } else {
            if (this.imgNode) this.imgNode.active = false;
            base.enabled = true;
            const hex = ATTR_TINT[this.attr]
                ?? (TILE_COLORS[this.img - 1] ?? (TILE_STYLE[this.img] ?? TILE_STYLE[0])[0]);
            const c = new Color();
            Color.fromHEX(c, hex);
            base.color = c;
        }
    }

    /** attr 상태를 이미지 틴트로 표현 — 속성 있는 타일은 옅게 색을 얹어 경로가 보이게 */
    private tintColor(hex: string): Color {
        const c = new Color();
        Color.fromHEX(c, ATTR_TINT[this.attr] ?? hex);
        return c;
    }

    /** 역보정 이미지 노드: 부모 체인의 R(45)·S(1,0.5)를 R(-45)·S(1,2)로 상쇄 */
    private ensureImgNode(): Node {
        if (this.imgNode && this.imgNode.isValid) return this.imgNode;
        // 이전 세션에서 씬에 저장돼 남은 잔재 제거 — 런타임 프레임은 직렬화 불가라
        // 저장된 _img는 이미지 링크가 빈 스프라이트만 남는다 (누적 방지)
        for (const child of [...this.node.children]) {
            if (child.name === '_img') child.destroy();
        }
        const n = new Node('_img');
        n.hideFlags = CCObject.Flags.DontSave; // 씬에 저장 금지 (편집용 일회성 비주얼)
        n.layer = Layers.Enum.UI_2D;
        this.node.addChild(n);
        n.angle = -45;
        n.setScale(1, 2, 1);
        // 셀 마름모의 화면 크기 = 32√2 × 16√2
        n.addComponent(UITransform).setContentSize(32 * Math.SQRT2, 16 * Math.SQRT2);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false; // 마름모의 투명 모서리가 트리밍되면 비율이 왜곡됨
        this.imgNode = n;
        return n;
    }
}
