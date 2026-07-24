import { _decorator, Component, Node, Sprite, UITransform, Color, Layers, CCInteger, CCString, CCObject } from 'cc';
import { EDITOR } from 'cc/env';
import { unitFrame, unitAspect, ensureUnitFrames, retryUnitFrames } from './TileFrameCache';

const { ccclass, property, executeInEditMode } = _decorator;

const B = 32; // 청사진 1타일 px

/** 부모 루트 이름 → 마커 색 (종류별 루트: monsters/npcs/spawn) */
const ROOT_COLORS: Record<string, string> = {
    monsters: '#C0503F', // 몬스터 = 붉은색
    npcs: '#3BAF6E',     // NPC = 초록색
    spawn: '#FFFFFF',    // 플레이어 = 흰색
};

/**
 * 맵 편집 씬의 유닛 마커 — 몬스터(monsters 루트)/NPC(npcs 루트)/플레이어(spawn 루트) 공용.
 * 타일 1칸 점유, 위치는 타일 중심에 자동 스냅.
 *  - img:  외형 — resources/maps/units의 {ID}_{이름}.png (0=이미지 없음, 색 마커)
 *  - kind: 종류 — 몬스터는 스폰 종류 키(slime 등)로 게임에 그대로 전달, NPC는 자유 라벨
 * 노드 이름은 자유 (사람용 라벨 — 데이터에는 kind가 저장됨).
 */
@ccclass('MapUnit')
@executeInEditMode
export class MapUnit extends Component {
    @property({ type: CCInteger, tooltip: '외형 — resources/maps/units의 {ID}_{이름}.png와 매칭 (0=색 마커)' })
    img = 0;

    @property({ type: CCString, tooltip: '종류 — 몬스터: 스폰 종류 키(slime 등, CombatSystem과 매칭)\n'
        + 'NPC: customer(손님) = 대기열 따라 이동·판매 루프 대상 / 그 외 라벨 = 정적 표시\n'
        + '플레이어: player 고정' })
    kind = '';

    private lastKey = '';
    private imgNode: Node | null = null;
    private rescanTick = 0;

    update() {
        if (!EDITOR) return;
        ensureUnitFrames();
        // 이미지가 아직 안 잡혔으면 주기적으로 units 폴더 재스캔 — 새 이미지 추가 시 리로드 불필요
        if (this.img > 0 && !unitFrame(this.img) && (++this.rescanTick % 30 === 0)) retryUnitFrames();

        // 타일 중심(정수×32px)에 스냅
        const p = this.node.position;
        const sx = Math.round(p.x / B) * B;
        const sy = Math.round(p.y / B) * B;
        if (sx !== p.x || sy !== p.y) this.node.setPosition(sx, sy, 0);

        const sf = unitFrame(this.img);
        const key = `${this.img},${!!sf},${this.node.parent?.name}`;
        if (key === this.lastKey) return;
        this.lastKey = key;

        const base = this.getComponent(Sprite);
        this.node.getComponent(UITransform)?.setContentSize(B - 4, B - 4);

        if (sf) {
            // 실제 유닛 이미지 — 아이소 뷰 역보정(-45°, 세로 2배), 발이 타일 중심에 닿게
            const view = this.ensureImgNode();
            const sp = view.getComponent(Sprite)!;
            sp.spriteFrame = sf;
            sp.markForUpdateRenderData();
            const h = 32; // 캐릭터 기준 크기 = 1타일 폭 (게임 128px = 청사진 32px)
            view.getComponent(UITransform)!.setContentSize(h / unitAspect(this.img), h);
            view.active = true;
            // ⚠️ 밑판 숨김에 알파 0 금지 — Sprite 색상 알파는 자식에게 상속됨 (enabled로 숨김)
            if (base) base.enabled = false;
        } else {
            if (this.imgNode) this.imgNode.active = false;
            if (base) {
                base.enabled = true;
                const c = new Color();
                Color.fromHEX(c, ROOT_COLORS[this.node.parent?.name ?? ''] ?? '#B9A6F0');
                c.a = 200;
                base.color = c;
            }
        }
    }

    /** 역보정 이미지 노드 — anchorY 0: 이미지 하단 = 타일 중심 (서 있는 모양) */
    private ensureImgNode(): Node {
        if (this.imgNode && this.imgNode.isValid) return this.imgNode;
        for (const child of [...this.node.children]) {
            if (child.name === '_img') child.destroy(); // 씬에 저장된 잔재 제거 (링크 빈 스프라이트)
        }
        const n = new Node('_img');
        n.hideFlags = CCObject.Flags.DontSave;
        n.layer = Layers.Enum.UI_2D;
        this.node.addChild(n);
        n.angle = -45;
        n.setScale(1, 2, 1);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0); // 발 기준
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false;
        this.imgNode = n;
        return n;
    }
}
