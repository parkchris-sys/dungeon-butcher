import { _decorator, Component, Node, Sprite, UITransform, Color, Layers, CCInteger } from 'cc';
import { EDITOR } from 'cc/env';
import { TILE_STYLE } from '../ingame/TileView';
import { TILE_COLORS } from '../ingame/TilePalette';
import { tileFrame, ensureTileFrames } from './TileFrameCache';

const { ccclass, property, executeInEditMode } = _decorator;

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

    @property({ type: CCInteger, tooltip: '속성 번호 — 0=없음, 1=이동불가(벽 대체). 이후 기획 표에 따라 확장' })
    attr = 0;

    @property({ type: CCInteger, tooltip: '구역 타입 — 0=없음 / 1=마을(안전·회복) / 2=던전(스폰) / 3=통로(몬스터 불가침)' })
    zone = 0;

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
            view.active = true;
            base.color = new Color(0, 0, 0, 0); // 밑판 숨김
        } else {
            if (this.imgNode) this.imgNode.active = false;
            const hex = this.attr === 1 ? '#B03A30'
                : (TILE_COLORS[this.img - 1] ?? (TILE_STYLE[this.img] ?? TILE_STYLE[0])[0]);
            const c = new Color();
            Color.fromHEX(c, hex);
            base.color = c;
        }
    }

    /** attr 상태를 이미지 틴트로 표현 (이동불가 = 붉은 물) */
    private tintColor(hex: string): Color {
        const c = new Color();
        Color.fromHEX(c, this.attr === 1 ? '#FF7A6E' : hex);
        return c;
    }

    /** 역보정 이미지 노드: 부모 체인의 R(45)·S(1,0.5)를 R(-45)·S(1,2)로 상쇄 */
    private ensureImgNode(): Node {
        if (this.imgNode && this.imgNode.isValid) return this.imgNode;
        const n = new Node('_img');
        n.layer = Layers.Enum.UI_2D;
        this.node.addChild(n);
        n.angle = -45;
        n.setScale(1, 2, 1);
        // 셀 마름모의 화면 크기 = 32√2 × 16√2
        n.addComponent(UITransform).setContentSize(32 * Math.SQRT2, 16 * Math.SQRT2);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        this.imgNode = n;
        return n;
    }
}
