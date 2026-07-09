/**
 * 밸런스/설정 원본은 docs/BALANCE.md — 이 파일은 그 복사본이다.
 * 색상은 docs/BIBLE.md §6 마스터 팔레트.
 */
export const GameConfig = {
    // 허브 맵 크기 (px)
    map: { minX: -1200, maxX: 1200, minY: -800, maxY: 800 },

    player: {
        size: 48,       // 캐릭터 기준 크기
        moveSpeed: 280, // 초당 px — TBD(BALANCE)
    },

    camera: { smoothing: 8 },
};

/** 마스터 팔레트 (BIBLE §6) */
export const PALETTE = {
    lanternOrange: '#E8703A',
    warmAmber: '#F2A93B',
    rusticWood: '#8A5A3B',
    meatRed: '#C0503F',
    agedMeat: '#8C3A2E',
    gold: '#F0B429',
    dungeonViolet: '#6C4BB0',
    deepMagic: '#4A3A8C',
    arcaneCyan: '#4FB3C4',
    stoneGray: '#7C7686',
    goblinGreen: '#3B7A54',
    parchment: '#F7EFD8',
    ink: '#2A2230',
};
