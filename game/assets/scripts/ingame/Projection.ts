/**
 * 아이소메트릭 투영 (2:1 마름모). 순수 함수 — cc import 없음(엔진 교체·테스트 대비).
 * 그리드 좌표(gx, gy) → 화면 좌표. h는 높이(고기 스택/점프)로 화면상 위로 올림.
 */
export const TILE_W = 128; // 타일 폭(px) — 2026-07-10 확정 (2:1, POT)
export const TILE_H = 64;  // 타일 높이(px) — 2026-07-10 확정

export function isoX(gx: number, gy: number): number {
    return (gx - gy) * (TILE_W / 2);
}

export function isoY(gx: number, gy: number, h: number = 0): number {
    return (gx + gy) * (TILE_H / 2) + h;
}

/** 깊이 정렬 키 — 클수록 화면 앞(아래). Entities siblingIndex 정렬에 사용. */
export function isoSort(gx: number, gy: number): number {
    return gx + gy;
}

/** 화면 이동 벡터(vsx, vsy) → 그리드 이동량. 화면 기준 이동을 아이소 그리드로 역투영. */
export function screenToGrid(vsx: number, vsy: number): { gx: number; gy: number } {
    return {
        gx: vsx / TILE_W + vsy / TILE_H,
        gy: -vsx / TILE_W + vsy / TILE_H,
    };
}
