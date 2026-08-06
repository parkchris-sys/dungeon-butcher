/**
 * 플레이어 8방향 처리 (BIBLE §6-a, 결정 2026-08-07 — **주인공만 8방향**, 몬스터는 좌우 2방향 유지).
 *
 * 방향 토큰은 규약대로 `n·ne·e·se·s·sw·w·nw` (파일명 `player_walk_ne_1.png`).
 * **화면 기준**이다 — N=화면 위, E=화면 오른쪽. 아이소 2:1에서 월드 방위는 화면상 26.57°/90°처럼
 * 비스듬히 떨어지지만, 아트가 그리는 그림과 조이스틱 입력이 모두 화면 기준이라 이쪽이 어긋남이 없다.
 * W·NW·SW는 E·NE·SE를 뒤집어 쓴다 (실제 제작 5방향) — 반전 짝은 DIR8_MIRROR.
 */

/** 화면 기준 8방향 — 클립 키·파일명에 그대로 쓰인다 */
export type Dir8 = 'e' | 'ne' | 'n' | 'nw' | 'w' | 'sw' | 's' | 'se';

/** 0°(E)부터 반시계로 45°씩 — 각도 → 방향 변환의 기준 */
export const DIR8: readonly Dir8[] = ['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se'];

const R2 = Math.SQRT1_2; // 대각 성분 (0.7071)

/** 방향별 단위 벡터 (화면 좌표, +y = 위) — 공격 방향 판정용 */
export const DIR8_VEC: Record<Dir8, [number, number]> = {
    e: [1, 0], ne: [R2, R2], n: [0, 1], nw: [-R2, R2],
    w: [-1, 0], sw: [-R2, -R2], s: [0, -1], se: [R2, -R2],
};

/**
 * 화면 입력 벡터 → 8방향 (균등 8등분, 경계 ±22.5° — 임의).
 * 입력이 없으면 null → 호출부가 현재 방향을 유지한다.
 */
export function dirFromScreen(sx: number, sy: number): Dir8 | null {
    if (sx === 0 && sy === 0) return null;
    let deg = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return DIR8[Math.round(deg / 45) % 8];
}

/**
 * 좌우 반전으로 서로를 대체할 수 있는 짝 (BIBLE §6-a "실제로 그릴 방향은 5개").
 * n·s는 좌우 대칭이라 짝이 없다 — 그 방향은 반드시 그려야 한다.
 */
export const DIR8_MIRROR: Partial<Record<Dir8, Dir8>> = {
    w: 'e', e: 'w', nw: 'ne', ne: 'nw', sw: 'se', se: 'sw',
};

/** 그 방향의 좌우 성분 (n·s는 없음 → null) */
export function sideOf(dir: Dir8): 'e' | 'w' | null {
    if (dir === 'n' || dir === 's') return null;
    return dir.endsWith('w') ? 'w' : 'e';
}
