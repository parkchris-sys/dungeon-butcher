import { MapData, ZoneDef, PropDef, WallDef, ZoneKind } from './MapData';
import { TILE_H } from './Projection';

/**
 * Tiled(아이소메트릭) JSON → MapData 파서. 순수 로직 — cc import 없음.
 *
 * 디자이너 규약 (resources/maps/README.md 참고):
 *  - 맵: orientation=isometric, tile 128×64, 정사각(width=height, 홀수 권장)
 *  - 오브젝트 레이어 "zones": 사각형 오브젝트. class(hub|dungeon), 커스텀 속성 tint(선택)
 *  - 오브젝트 레이어 "props": 포인트 오브젝트. 커스텀 속성 kind/w/h/tint(선택)
 *  - 오브젝트 레이어 "spawn": 포인트 오브젝트 1개 = 플레이어 시작 위치
 *
 * 좌표 변환: Tiled 아이소 오브젝트 좌표는 x,y 모두 tileheight(64) 단위의
 * "그리드 픽셀" 공간이다 → 타일 좌표 = px/64.
 * Tiled는 (0,0)이 위 코너·y아래방향, 우리는 맵 중앙 원점·y위방향이므로
 *   우리 gx = K - tiledGy,  우리 gy = K - tiledGx   (K = (W-1)/2)
 * 로 축을 스왑+반전하면 Tiled 에디터에서 보이는 그대로 게임 화면에 나온다.
 */

interface TiledProperty { name: string; value: unknown }
interface TiledObject {
    name?: string; class?: string; type?: string;
    x: number; y: number; width?: number; height?: number;
    point?: boolean; properties?: TiledProperty[];
}
interface TiledLayer { type: string; name: string; objects?: TiledObject[] }
interface TiledMapJson {
    orientation?: string; width?: number; height?: number;
    tilewidth?: number; tileheight?: number; layers?: TiledLayer[];
}

function props(obj: TiledObject): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of obj.properties ?? []) out[p.name] = p.value;
    return out;
}

function klass(obj: TiledObject): string {
    return (obj.class ?? obj.type ?? '') as string; // Tiled 1.9+는 class, 이전엔 type
}

/** 파싱 실패 시 null — 호출부가 DEV_MAP으로 폴백 */
export function parseTiledMap(json: unknown): MapData | null {
    const m = json as TiledMapJson;
    if (!m || m.orientation !== 'isometric' || !m.layers || !m.width || !m.height) return null;

    const K = (m.width - 1) / 2;
    const unit = m.tileheight || TILE_H; // Tiled 아이소 오브젝트 좌표 단위
    const toGx = (tx: number, ty: number) => K - ty / unit;
    const toGy = (tx: number, ty: number) => K - tx / unit;

    const zones: ZoneDef[] = [];
    const propList: PropDef[] = [];
    const walls: WallDef[] = [];
    let spawn = { gx: 0, gy: 0 };

    // Tiled 사각 오브젝트 → 우리 그리드 사각 (축 스왑+반전)
    const rectFromTiled = (o: TiledObject) => {
        const wT = (o.width ?? 0) / unit;
        const hT = (o.height ?? 0) / unit;
        return {
            gx: K - o.y / unit - hT,
            gy: K - o.x / unit - wT,
            w: hT,
            h: wT,
        };
    };

    for (const layer of m.layers) {
        if (layer.type !== 'objectgroup' || !layer.objects) continue;

        if (layer.name === 'zones') {
            for (const o of layer.objects) {
                const p = props(o);
                zones.push({
                    name: o.name || 'zone',
                    kind: (klass(o) === 'hub' ? 'hub' : 'dungeon') as ZoneKind,
                    ...rectFromTiled(o),
                    tint: (p.tint as string) || '#2A2240',
                });
            }
        } else if (layer.name === 'walls') {
            for (const o of layer.objects) {
                walls.push(rectFromTiled(o));
            }
        } else if (layer.name === 'props') {
            for (const o of layer.objects) {
                const p = props(o);
                propList.push({
                    kind: (p.kind as string) || o.name || 'prop',
                    gx: toGx(o.x, o.y),
                    gy: toGy(o.x, o.y),
                    w: (p.w as number) || 120,
                    h: (p.h as number) || 120,
                    tint: (p.tint as string) || '#7C7686',
                });
            }
        } else if (layer.name === 'spawn') {
            const o = layer.objects[0];
            if (o) spawn = { gx: toGx(o.x, o.y), gy: toGy(o.x, o.y) };
        }
    }

    if (zones.length === 0) return null;

    // 작은 존이 앞에 오게 정렬 — 겹칠 때 좁은 존(마을)이 넓은 존(사냥지대)보다 판정 우선
    zones.sort((a, b) => a.w * a.h - b.w * b.h);

    return {
        name: 'tiled',
        groundRadius: K,
        playerSpawn: spawn,
        zones,
        props: propList,
        walls,
    };
}
