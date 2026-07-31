import { _decorator, Component, CCInteger } from 'cc';

const { ccclass, property } = _decorator;

/**
 * 애니메이션 프레임 1장 (편집용) — 클립 노드의 자식으로 하나씩 둔다.
 * **자식 순서 = 재생 순서** (하이어라키에서 드래그로 순서 변경).
 *
 * 프레임별 "기교"를 여기서 준다:
 *  - hold: 노출 시간 배수 (짧게 스치거나 길게 머무르게)
 *  - offX/offY: 위치 흔들림 (통통 튀기·반동)
 *  - scaleX/scaleY: 스쿼시 & 스트레치 (착지·타격 임팩트)
 *  - event: 이 프레임에서 게임 로직에 알림 (예: hit = 데미지가 들어가는 순간)
 */
@ccclass('AnimFrame')
export class AnimFrame extends Component {
    @property({ type: CCInteger, tooltip: '프레임 번호 — 파일명의 `_n` (chars/{종류}_{상태}_{n}.png).\n0이면 자식 순서를 번호로 사용' })
    img = 0;

    @property({ tooltip: '노출 시간 배수 (1=기본 1/fps, 0.5=짧게 스침, 2=두 배 길게)' })
    hold = 1;

    @property({ type: CCInteger, tooltip: '화면 X offset(px) — 반동·흔들림' })
    offX = 0;

    @property({ type: CCInteger, tooltip: '화면 Y offset(px) — 통통 튀기' })
    offY = 0;

    @property({ tooltip: '가로 스케일 (1=원본) — 스쿼시&스트레치' })
    scaleX = 1;

    @property({ tooltip: '세로 스케일 (1=원본)' })
    scaleY = 1;

    @property({ tooltip: '이벤트 마커 (비우면 없음). `hit` = 이 프레임에 데미지가 들어감' })
    event = '';
}
