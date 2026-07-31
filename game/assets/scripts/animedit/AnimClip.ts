import { _decorator, Component, CCInteger } from 'cc';

const { ccclass, property } = _decorator;

/**
 * 애니메이션 클립 1개 (편집용) — clips 그룹 아래 노드 하나 = 클립 하나.
 * **클립 키는 `{종류}_{상태}`** 로, 프레임 파일명 규칙과 동일하게 맞춘다
 * (예: `chicken_walk` → chars/chicken_walk_1.png …). 게임은 이 키로 클립을 찾는다.
 *
 * 프레임은 이 노드의 **자식 순서대로** 재생된다 (AnimFrame 컴포넌트).
 */
@ccclass('AnimClip')
export class AnimClip extends Component {
    @property({ tooltip: '클립 키 — `{종류}_{상태}` (예: player_walk, chicken_walk, player_attack).\n'
        + '프레임 이미지는 chars/{키}_{n}.png 로 매칭됩니다' })
    clipKey = '';

    @property({ type: CCInteger, tooltip: '기본 프레임 속도(fps) — 픽셀아트는 8~12가 잘 읽힙니다.\n프레임별 hold로 개별 조절' })
    fps = 10;

    @property({ tooltip: '반복 재생 (공격처럼 1회성이면 끄고 next에 복귀 클립을 지정)' })
    loop = true;

    @property({ tooltip: '비반복 클립이 끝난 뒤 자동 전환할 클립 키 (예: player_attack → player_idle)' })
    next = '';

    @property({ tooltip: '체크 = 이 클립을 편집 씬에서 미리보기 재생 (한 번에 하나만)' })
    preview = false;
}
