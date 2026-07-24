import { _decorator, Component, Sprite, Color, Enum } from 'cc';
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

/** 속성별 표시색 — 속성이 우선 (경로가 잘 보이게) */
const ATTR_TINT: Record<number, string> = {
    1: '#B03A30', // 이동불가 — 붉은 벽
    2: '#3E86C0', // 대기열 — 파랑
    3: '#E0A93B', // 퇴장 — 노랑
};

/** 존별 베이스 색 — 속성이 없을 때 존을 구분해 보여줌 */
const ZONE_TINT: Record<number, string> = {
    0: '#2A2A34', // 없음
    1: '#4E3827', // 마을
    2: '#3C3159', // 던전
    3: '#3A3A44', // 통로
};

/**
 * 맵 편집 씬의 타일 1칸 — 이제 이미지는 지정하지 않는다(구역의 통짜 바닥 이미지가 대체).
 * 여기서는 게임 로직에 필요한 **속성(attr)·존(zone)만** 편집한다 (다중 선택 편집 가능).
 * 표시는 속성/존 색으로만 — 실제 바닥 그림은 TileRegion.floorImg가 담당.
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

    private lastKey = '';

    update() {
        if (!EDITOR) return;
        const key = `${this.attr},${this.zone}`;
        if (key !== this.lastKey) this.forceRefresh();
    }

    /** 표시 갱신 (MapEditRoot가 값 재배정 후 호출) — 속성색 우선, 없으면 존색 */
    forceRefresh() {
        this.lastKey = `${this.attr},${this.zone}`;
        const base = this.getComponent(Sprite);
        if (!base) return;
        base.enabled = true;
        const hex = ATTR_TINT[this.attr] ?? ZONE_TINT[this.zone] ?? ZONE_TINT[0];
        const c = new Color();
        Color.fromHEX(c, hex);
        base.color = c;
    }
}
