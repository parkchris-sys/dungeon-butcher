/**
 * 맵 데이터 계약 — 순수 데이터, cc import 없음.
 * 원천은 두 가지: ① 디자이너가 Tiled로 편집한 JSON (TiledLoader가 파싱)
 *                ② 코드 폴백 DEV_MAP (JSON이 없거나 깨졌을 때)
 * 좌표는 전부 그리드 좌표(gx, gy) — 화면 변환은 Projection.ts 담당.
 * 그리드 원점은 맵 중앙, 화면 하단 코너 = (-R, -R).
 */

export type ZoneKind = 'hub' | 'dungeon';

/** 구역 — 그리드 사각 영역(원점 = 최소 코너). 앞에 있는 존이 판정 우선. */
export interface ZoneDef {
    name: string;
    kind: ZoneKind;
    gx: number;   // 최소 코너 그리드 좌표
    gy: number;
    w: number;    // 그리드 폭(타일 수)
    h: number;
    tint: string; // 프로토타입 바닥 톤 (아트 오면 존별 패턴 텍스처로 교체)
}

/** 배치물 — 프로토타입은 실루엣 박스, 이후 프리팹 스폰으로 교체 */
export interface PropDef {
    kind: string; // 'shop' | 'counter' | 'gate' ... (임의)
    gx: number;
    gy: number;
    w: number;    // 화면 px
    h: number;
    tint: string;
}

/** 벽 — 이동을 막는 그리드 사각 영역(원점 = 최소 코너). 게이트 통로는 벽을 안 그린 틈으로 표현 */
export interface WallDef {
    gx: number;
    gy: number;
    w: number;
    h: number;
}

export interface MapData {
    name: string;
    groundRadius: number;             // 바닥 그리드 반경(타일 수)
    playerSpawn: { gx: number; gy: number };
    zones: ZoneDef[];                 // 판정: 앞 항목 우선 / 그리기: 뒤 항목부터(밑에 깔림)
    props: PropDef[];
    walls: WallDef[];
}

/**
 * 코드 폴백 맵 (전부 임의) — PHASE1 §1 레이아웃: 마을 = 맵 하단 코너, 위쪽이 사냥 지대.
 * Tiled JSON(resources/maps/ingame_map.json)이 있으면 그쪽이 우선한다.
 */
export const DEV_MAP: MapData = {
    name: 'dev(fallback)',
    groundRadius: 24,
    playerSpawn: { gx: -18, gy: -18 },
    zones: [
        // 마을이 먼저 — 사냥지대(전체)보다 판정 우선
        { name: '마을',     kind: 'hub',     gx: -24, gy: -24, w: 14, h: 14, tint: '#3A2E22' },
        { name: '사냥지대', kind: 'dungeon', gx: -24, gy: -24, w: 49, h: 49, tint: '#2A2240' },
    ],
    props: [
        { kind: 'shop',    gx: -20, gy: -14, w: 180, h: 200, tint: '#8A5A3B' }, // 정육점 건물
        { kind: 'counter', gx: -14, gy: -20, w: 140, h: 90,  tint: '#F2A93B' }, // 판매대
        { kind: 'gate',    gx: -11, gy: -11, w: 100, h: 150, tint: '#6C4BB0' }, // 사냥지대 경계 표시
    ],
    walls: [], // 폴백 맵은 벽 없음 — 벽은 Tiled 'walls' 레이어에서 저작
};
