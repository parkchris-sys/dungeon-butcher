/**
 * 맵 데이터 계약 — 순수 데이터, cc import 없음.
 * 지금은 코드가 채우지만(DEV_MAP), 이후 디자이너가 Tiled로 찍은 JSON을
 * 같은 형태로 파싱해 꽂는다 (렌더링/스폰 코드는 불변).
 * 좌표는 전부 그리드 좌표(gx, gy) — 화면 변환은 Projection.ts 담당.
 */

export type ZoneKind = 'hub' | 'dungeon';

/** 구역 — 그리드 정사각 영역. 경계 트리거·바닥 톤·(이후) 웨이브 규칙이 여기 물린다. */
export interface ZoneDef {
    name: string;
    kind: ZoneKind;
    gx: number;   // 중심 그리드 좌표
    gy: number;
    span: number; // 한 변 길이(타일 수)
    tint: string; // 프로토타입 바닥 톤 (아트 오면 존별 패턴 텍스처로 교체)
}

/** 배치물 — 프로토타입은 실루엣 박스, 이후 프리팹 스폰으로 교체 */
export interface PropDef {
    kind: string; // 'shop' | 'counter' | 'pillar' ... (임의)
    gx: number;
    gy: number;
    w: number;    // 화면 px (임의 — 아트 규격 확정 전)
    h: number;
    tint: string;
}

export interface MapData {
    name: string;
    groundRadius: number;             // 바닥 그리드 반경(타일 수)
    playerSpawn: { gx: number; gy: number };
    zones: ZoneDef[];
    props: PropDef[];
}

/** Phase 1 개발용 맵 (전부 임의) — 허브 존 + 던전 존 + 최소 배치물 */
export const DEV_MAP: MapData = {
    name: 'dev',
    groundRadius: 24,
    playerSpawn: { gx: 0, gy: 0 },
    zones: [
        { name: '허브',   kind: 'hub',     gx: 0,  gy: 0,  span: 12, tint: '#3A2E22' },
        { name: '던전',   kind: 'dungeon', gx: 14, gy: 14, span: 16, tint: '#2A2240' },
    ],
    props: [
        { kind: 'shop',    gx: -3, gy: 3,  w: 180, h: 200, tint: '#8A5A3B' }, // 정육점 건물
        { kind: 'counter', gx: 3,  gy: 3,  w: 140, h: 90,  tint: '#F2A93B' }, // 판매대
        { kind: 'gate',    gx: 6,  gy: 6,  w: 100, h: 150, tint: '#6C4BB0' }, // 던전 방향 표시
    ],
};
