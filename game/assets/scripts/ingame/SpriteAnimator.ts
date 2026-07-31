import { Color, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { AnimClipDef, AnimData, AnimFrameDef } from './AnimData';

/**
 * 스프라이트(프레임) 애니메이터 — 코드 주도·풀 친화.
 *
 * 왜 cc.Animation이 아닌가: 몬스터·손님이 런타임 생성 + 풀 재사용 구조라서
 * 인스턴스마다 AnimationClip 컴포넌트를 붙이고 play/stop을 관리하는 방식과 궁합이 나쁘다.
 * 여기서는 **클립 정의(AnimClipDef)를 모든 인스턴스가 공유**하고, 프레임이 바뀔 때만
 * spriteFrame을 대입한다 (프레임 유지 중에는 아무 일도 하지 않음).
 *
 * 프레임별 기교(AnimFrameDef): hold(노출 시간 배수) · offX/offY(위치) · scaleX/scaleY(스쿼시)
 * · event(타격 타이밍 등 마커). 편집은 애니메이션 편집 씬(animedit)에서.
 */

/** 애니메이션 대상 1개 — 개체(몬스터/손님/플레이어)마다 하나 */
export class SpriteAnimator {
    private clip: AnimClipDef | null = null;
    private clipKey = '';
    private frameIdx = 0;
    private t = 0;          // 현재 프레임 경과 시간
    private baseX = 0;      // offset 적용 전 기준 위치 (스프라이트 노드 로컬)
    private baseY = 0;
    private baseW = 0;      // 기준 크기 — scale 기교는 이 값에 곱한다
    private baseH = 0;
    private finished = false;

    /**
     * @param node   프레임 이미지를 그릴 스프라이트 노드 (보통 캐릭터의 'Body')
     * @param sprite 그 노드의 Sprite
     * @param frames 클립 키 → (프레임 번호 → SpriteFrame) 조회 함수
     * @param onEvent 프레임 event 마커 콜백 (예: 'hit' → 데미지 판정)
     */
    constructor(
        private readonly node: Node,
        private readonly sprite: Sprite,
        private readonly frameOf: (clipKey: string, imgNo: number) => SpriteFrame | null,
        private readonly onEvent?: (name: string) => void,
    ) {
        this.baseX = node.position.x;
        this.baseY = node.position.y;
        const ut = node.getComponent(UITransform);
        this.baseW = ut ? ut.contentSize.width : 0;
        this.baseH = ut ? ut.contentSize.height : 0;
    }

    /** 기준 위치·크기 재설정 (외형 교체 등으로 스프라이트 크기가 바뀐 뒤 호출) */
    setBase(x: number, y: number, w: number, h: number) {
        this.baseX = x; this.baseY = y; this.baseW = w; this.baseH = h;
    }

    /**
     * 표시 높이 지정 — 클립이 바뀔 때 **첫 프레임의 원본 비율**로 크기를 맞추고 틴트를 흰색으로 되돌린다.
     * ⚠ 플레이스홀더(박스) 크기·틴트가 남아 있으면 실제 그림이 눌리거나 색이 덮인다.
     */
    private fitHeight = 0;
    private fitWhite: Color | null = null;
    setFitHeight(h: number, white: Color) {
        this.fitHeight = h;
        this.fitWhite = white;
    }

    private applyFit(firstImg: number) {
        if (this.fitHeight <= 0) return;
        const sf = this.frameOf(this.clipKey, firstImg);
        if (!sf) return;
        const h = this.fitHeight;
        const w = h * (sf.rect.width / Math.max(1, sf.rect.height));
        this.baseW = w; this.baseH = h;
        this.baseY = h / 2; // 발이 타일 중심에 닿게 (앵커 중앙)
        this.node.getComponent(UITransform)?.setContentSize(w, h);
        this.node.setPosition(this.baseX, this.baseY, 0);
        if (this.fitWhite) this.sprite.color = this.fitWhite;
    }

    /**
     * 좌우 반전 — 방향별 클립이 없을 때 한쪽 그림을 뒤집어 반대 방향으로 쓴다 (아트 물량 절반).
     * 스케일 기교는 contentSize로 처리하므로 노드 scale과 충돌하지 않는다.
     */
    private mirrored = false;
    setMirror(m: boolean) {
        if (this.mirrored === m) return;
        this.mirrored = m;
        this.node.setScale(m ? -1 : 1, 1, 1);
    }

    /** 현재 재생 중인 클립 키 ('' = 없음) */
    get current(): string { return this.clipKey; }
    /** 비반복 클립이 끝났는지 */
    get done(): boolean { return this.finished; }

    /**
     * 클립 재생. 같은 클립이면 아무 일도 하지 않는다(끊김 방지) — restart=true면 처음부터.
     * 클립이 없으면(아트 미반입) false를 돌려주고, 호출부는 정적 이미지를 유지하면 된다.
     */
    play(data: AnimData | null, key: string, restart = false): boolean {
        if (!data) return false;
        const clip = data.clips[key];
        if (!clip) return false;
        if (this.clipKey === key && !restart) return true;
        this.clip = clip;
        this.clipKey = key;
        this.frameIdx = 0;
        // 개체마다 시작 위상을 흩어 준다 — 22마리가 같은 프레임으로 움직이면 기계처럼 보임
        this.t = clip.loop ? Math.random() * this.frameDuration(clip, clip.frames[0]) : 0;
        this.finished = false;
        this.applyFrame(clip.frames[0], false);
        return true;
    }

    /** 재생 정지 — 기준 위치·크기로 되돌린다 */
    stop() {
        this.clip = null;
        this.clipKey = '';
        this.finished = false;
        this.node.setPosition(this.baseX, this.baseY, 0);
        this.node.getComponent(UITransform)?.setContentSize(this.baseW, this.baseH);
    }

    /** 프레임 1장의 노출 시간(초) = (1/fps) × hold */
    private frameDuration(clip: AnimClipDef, f: AnimFrameDef): number {
        return (1 / clip.fps) * (f.hold ?? 1);
    }

    update(dt: number, data: AnimData | null): string | null {
        const clip = this.clip;
        if (!clip || this.finished) return null;
        this.t += dt;
        let fired: string | null = null;
        // 여러 프레임을 건너뛸 수도 있으므로 while (저사양에서 프레임 드랍 대비)
        let guard = 0;
        while (this.t >= this.frameDuration(clip, clip.frames[this.frameIdx]) && guard++ < 16) {
            this.t -= this.frameDuration(clip, clip.frames[this.frameIdx]);
            const last = this.frameIdx >= clip.frames.length - 1;
            if (last && !clip.loop) {
                this.finished = true;
                // 종료 후 자동 전환 (예: player_attack → player_idle)
                if (clip.next && this.play(data, clip.next, true)) return fired;
                return fired;
            }
            this.frameIdx = last ? 0 : this.frameIdx + 1;
            const ev = this.applyFrame(clip.frames[this.frameIdx], true);
            if (ev) fired = ev;
        }
        return fired;
    }

    /** 프레임 적용 — 이미지 + offset/스케일 기교. 이벤트 마커가 있으면 이름을 돌려준다 */
    private applyFrame(f: AnimFrameDef, notify: boolean): string | null {
        const sf = this.frameOf(this.clipKey, f.img);
        if (sf) this.sprite.spriteFrame = sf;
        // 프레임별 offset — 통통 튀기·반동
        this.node.setPosition(this.baseX + (f.offX ?? 0), this.baseY + (f.offY ?? 0), 0);
        // 프레임별 스쿼시&스트레치
        const sx = f.scaleX ?? 1, sy = f.scaleY ?? 1;
        if (sx !== 1 || sy !== 1 || this.baseW > 0) {
            this.node.getComponent(UITransform)?.setContentSize(this.baseW * sx, this.baseH * sy);
        }
        if (f.event && notify) {
            this.onEvent?.(f.event);
            return f.event;
        }
        return null;
    }
}
