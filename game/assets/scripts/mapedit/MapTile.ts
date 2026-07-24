import { _decorator, Component, Sprite, Enum } from 'cc';
import { EDITOR } from 'cc/env';

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

/**
 * 맵 편집 씬의 타일 1칸 — 이미지는 지정하지 않는다(구역의 통짜 바닥 이미지가 대체).
 * 게임 로직에 필요한 **속성(attr)·존(zone)만** 편집한다 (Inspector 다중 선택 가능).
 * 바닥 그림은 통짜 이미지가 담당하므로 타일 자체 스프라이트는 표시하지 않는다(데이터만 보유).
 * 칠한 속성/존의 시각 확인은 MapEditRoot의 데이터 프리뷰(_데이터프리뷰)가 담당.
 */
@ccclass('MapTile')
@executeInEditMode
export class MapTile extends Component {
    /** 구버전 데이터 호환용 — 더 이상 편집하지 않음(항상 0). 통짜 바닥 이미지가 대체. */
    img = 0;

    @property({ type: 속성, tooltip: '타일 속성 — 이동불가(벽)/대기열(손님 줄)/퇴장(손님 나감)' })
    attr: 속성 = 속성.없음;

    @property({ type: 존타입, tooltip: '구역 타입 — 마을(안전·회복) / 던전(스폰) / 통로(몬스터 불가침)' })
    zone: 존타입 = 존타입.없음;

    private done = false;

    update() {
        if (!EDITOR || this.done) return;
        this.forceRefresh();
    }

    /** 타일 스프라이트는 항상 숨김 — 통짜 바닥 이미지가 바닥을 담당 */
    forceRefresh() {
        const base = this.getComponent(Sprite);
        if (base) base.enabled = false;
        this.done = true;
    }
}
