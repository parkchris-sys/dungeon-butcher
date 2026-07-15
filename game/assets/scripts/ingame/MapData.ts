/**
 * 맵 데이터 계약 — 순수 데이터, cc import 없음.
 * 원천은 두 가지: ① 디자이너가 Tiled로 편집한 JSON (TiledLoader가 파싱)
 *                ② 코드 폴백 DEV_MAP (JSON이 없거나 깨졌을 때)
 * 좌표는 전부 그리드 좌표(gx, gy) — 화면 변환은 Projection.ts 담당.
 * 그리드 원점은 맵 중앙, 화면 하단 코너 = (-R, -R).
 */

/** 타일 zone 값의 정식 정의 — 에디터·게임·문서 공용 */
export enum ZoneType {
    None = 0,     // 존 없음 (미개방 지대)
    Town = 1,     // 마을 — 안전·회복, 몬스터 불가침
    Dungeon = 2,  // 던전 — 웨이브 스폰
    Corridor = 3, // 통로 — 몬스터 불가침·회복 없음·스폰 없음 (임의 — 기획 확정 대상)
}

export type ZoneKind = 'hub' | 'dungeon' | 'corridor';

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

/** 타일 1칸의 데이터 — 렌더링(img)과 게임 로직(zone/attr)의 단위 */
export interface TileDef {
    img: number;      // 타일 이미지 ID (0=기본 바닥 — {ID}_{이름}.png와 매칭)
    zone: number;     // 구역 타입 (ZoneType: 0없음/1마을/2던전/3통로)
    attr: number;     // 속성 번호 (아래 TILE_ATTR 참고)
    dungeon?: number; // 던전 인스턴스 ID — 에디터 TileRegion.regionId에서 기록 (0/없음=자동 부여)
}

/** 편집 구역 정보 — 이름·던전ID·기하. 에디터 왕복 보존 + 게임의 던전 이름 표시용 */
export interface MapRegionInfo {
    name: string; // 지역 이름 (규칙: 던전 = d{ID})
    id: number;   // 던전 인스턴스 ID (0 = 던전 아님/미지정)
    gx: number;   // 최소 코너 그리드 좌표
    gy: number;
    w: number;    // 타일 수
    h: number;
}

/** 타일 속성 번호 — 기획 확정 시 표로 이관 (임의) */
export const TILE_ATTR_NONE = 0;
export const TILE_ATTR_BLOCKED = 1; // 이동불가 — 벽을 대체

export interface MapData {
    name: string;
    groundRadius: number;             // 바닥 그리드 반경(타일 수)
    playerSpawn: { gx: number; gy: number };
    zones: ZoneDef[];                 // 존 정의 목록 — 판정의 원본은 타일 zone값
    props: PropDef[];
    tiles?: TileDef[][];              // [gy+R][gx+R] — 없으면 buildTileGrid로 존에서 파생
    regions?: MapRegionInfo[];        // 편집 구역 (이름·던전ID·기하) — 에디터 왕복 + 던전 이름 표시
}

/** 존 목록에서 (gx,gy)가 속한 존 번호(1부터)를 찾음 — 0=없음. zones는 면적 오름차순 전제 */
export function zoneIndexAt(zones: ZoneDef[], gx: number, gy: number): number {
    for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        // 반개구간 — 폭 w 사각형은 타일 w개 (gx0 .. gx0+w-1). <= 쓰면 한 줄 더 먹는 off-by-one
        if (gx >= z.gx && gx < z.gx + z.w && gy >= z.gy && gy < z.gy + z.h) return zi + 1;
    }
    return 0;
}

/** 존 번호(ZoneType) → 합성 존 정의. 1=마을(hub), 2=던전(dungeon), 3=통로(corridor) */
export function synthZoneDef(zi: number): ZoneDef {
    switch (zi) {
        case ZoneType.Town:
            return { name: '마을', kind: 'hub', gx: 0, gy: 0, w: 0, h: 0, tint: '#3A2E22' };
        case ZoneType.Corridor:
            return { name: '통로', kind: 'corridor', gx: 0, gy: 0, w: 0, h: 0, tint: '#3A3A44' };
        case ZoneType.Dungeon:
        default: // 4 이상은 일단 던전 취급 (임의)
            return { name: '던전', kind: 'dungeon', gx: 0, gy: 0, w: 0, h: 0, tint: '#2A2240' };
    }
}

/** 에디터가 내보낸 mapdata.json(v1: 존 사각형 포함 / v2: 타일 zone값만) → MapData */
export function parseMapDataJson(j: unknown): MapData | null {
    const d = j as {
        version?: number; size?: number;
        spawn?: { gx: number; gy: number };
        zones?: ZoneDef[]; props?: PropDef[];
        tiles?: { img: number[]; zone: number[]; attr: number[]; dungeon?: number[] };
        regions?: MapRegionInfo[];
    };
    if (!d || (d.version !== 1 && d.version !== 2) || !d.size) return null;
    if ((!d.zones || d.zones.length === 0) && !d.tiles) return null; // 존도 타일도 없으면 무효
    const size = d.size;
    const R = Math.floor((size - 1) / 2);

    let tiles: TileDef[][] | undefined;
    if (d.tiles && d.tiles.img?.length === size * size) {
        tiles = [];
        for (let iy = 0; iy < size; iy++) {
            const row: TileDef[] = [];
            for (let ix = 0; ix < size; ix++) {
                const i = iy * size + ix;
                row.push({
                    img: d.tiles.img[i] ?? 0,
                    zone: d.tiles.zone?.[i] ?? 0,
                    attr: d.tiles.attr?.[i] ?? 0,
                    dungeon: d.tiles.dungeon?.[i] ?? 0,
                });
            }
            tiles.push(row);
        }
    }

    // 존 목록: v1은 명시된 사각형, v2는 타일 zone값에서 합성 (안정된 객체 정체성을 위해 여기서 1회 생성)
    let zones: ZoneDef[];
    if (d.zones && d.zones.length > 0) {
        zones = [...d.zones].sort((a, b) => a.w * a.h - b.w * b.h);
    } else {
        let maxZone = 0;
        for (const z of d.tiles!.zone ?? []) if (z > maxZone) maxZone = z;
        zones = [];
        for (let zi = 1; zi <= maxZone; zi++) zones.push(synthZoneDef(zi));
    }

    return {
        name: 'data',
        groundRadius: R,
        playerSpawn: d.spawn ?? { gx: 0, gy: 0 },
        zones,
        props: d.props ?? [],
        tiles,
        regions: d.regions,
    };
}

/**
 * 던전 인스턴스 ID 그리드 — 몬스터 소속·어그로·던전별 스폰 설정의 기준.
 * ① 명시 ID 우선: 에디터에서 TileRegion.regionId로 지정해 타일에 기록된 값 (안정적 — 권장)
 * ② 자동 보충: 명시 ID가 없는 던전 타일은 연결 덩어리별 자동 부여
 *    (명시 ID가 하나라도 있으면 1000+부터 — 설정 충돌 방지 / 전혀 없으면 1부터, 레거시 호환)
 */
export function buildDungeonIdGrid(tiles: TileDef[][], R: number): number[][] {
    const size = R * 2 + 1;
    const ids: number[][] = [];
    for (let i = 0; i < size; i++) ids.push(new Array(size).fill(0));
    const isDungeon = (ix: number, iy: number) =>
        ix >= 0 && iy >= 0 && ix < size && iy < size &&
        (tiles[iy]?.[ix]?.zone ?? 0) === ZoneType.Dungeon;

    // ① 명시 ID 반영
    let hasExplicit = false;
    for (let iy = 0; iy < size; iy++) {
        for (let ix = 0; ix < size; ix++) {
            const d = tiles[iy]?.[ix]?.dungeon ?? 0;
            if (d > 0 && isDungeon(ix, iy)) {
                ids[iy][ix] = d;
                hasExplicit = true;
            }
        }
    }

    // ② 자동 보충 (연결 요소)
    let next = hasExplicit ? 1001 : 1;
    for (let iy = 0; iy < size; iy++) {
        for (let ix = 0; ix < size; ix++) {
            if (ids[iy][ix] !== 0 || !isDungeon(ix, iy)) continue;
            const queue: [number, number][] = [[ix, iy]];
            ids[iy][ix] = next;
            while (queue.length) {
                const [x, y] = queue.pop()!;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (isDungeon(nx, ny) && ids[ny][nx] === 0) {
                        ids[ny][nx] = next;
                        queue.push([nx, ny]);
                    }
                }
            }
            next++;
        }
    }
    return ids;
}

/**
 * 존 데이터 → 타일 그리드 파생 (타일 단위 저작이 들어오기 전까지의 기본 생성).
 * img 매핑: hub=1, dungeon=2, 존 밖=0 (임의 — 타일 이미지 테이블 확정 시 갱신)
 */
export function buildTileGrid(map: MapData): TileDef[][] {
    const R = map.groundRadius;
    const size = R * 2 + 1;
    const grid: TileDef[][] = [];
    for (let iy = 0; iy < size; iy++) {
        const row: TileDef[] = [];
        const gy = iy - R;
        for (let ix = 0; ix < size; ix++) {
            const gx = ix - R;
            let img = 0, zone = 0;
            for (let zi = 0; zi < map.zones.length; zi++) {
                const z = map.zones[zi];
                if (gx >= z.gx && gx < z.gx + z.w && gy >= z.gy && gy < z.gy + z.h) {
                    img = z.kind === 'hub' ? 1 : 2;
                    zone = zi + 1;
                    break; // 좁은 존 우선 (zones는 면적 오름차순)
                }
            }
            row.push({ img, zone, attr: 0 });
        }
        grid.push(row);
    }
    return grid;
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
};
