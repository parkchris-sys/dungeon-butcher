import { Node, UITransform, Sprite } from 'cc';
import { MapData, ZoneDef, PropDef, ZoneKind } from './MapData';

/**
 * 맵 편집 씬(MapRoot 노드 트리) → MapData 파서.
 * 에디터 툴(MapEditRoot)이 내보내기 시 사용한다 — 런타임은 내보내진
 * resources/maps/mapdata.json(parseMapDataJson)을 읽고, 편집 씬은 빌드에 포함되지 않는다.
 *
 * 규약: 청사진 1타일 = 32px, 원점 = 맵 중앙.
 * MapRoot 아래 zones/hub, zones/dungeon, props, spawn — 마커의 위치·크기·색이 곧 데이터.
 * '_'로 시작하는 노드는 무시.
 */

const B = 32; // 청사진 1타일 px
const PROP_SCALE = 4; // 청사진 px → 게임 px

function rectOf(n: Node): { gx: number; gy: number; w: number; h: number } | null {
    const ut = n.getComponent(UITransform);
    if (!ut) return null;
    const w = ut.contentSize.width / B;
    const h = ut.contentSize.height / B;
    return { gx: n.position.x / B - w / 2, gy: n.position.y / B - h / 2, w, h };
}

function tintOf(n: Node, fallback: string): string {
    const sp = n.getComponent(Sprite);
    if (!sp) return fallback;
    const c = sp.color;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`.toUpperCase();
}

/** MapRoot 노드에서 존/벽/배치물/스폰을 읽어 MapData로 (타일은 호출부가 채움) */
export function parseMapRoot(root: Node): MapData | null {
    const rootUt = root.getComponent(UITransform);
    const tiles = rootUt ? Math.round(rootUt.contentSize.width / B) : 49;
    const groundRadius = Math.floor((tiles - 1) / 2);

    const zones: ZoneDef[] = [];
    const zonesGroup = root.getChildByName('zones');
    for (const kind of ['hub', 'dungeon'] as ZoneKind[]) {
        const g = zonesGroup?.getChildByName(kind);
        if (!g) continue;
        for (const n of g.children) {
            if (n.name.startsWith('_')) continue;
            const r = rectOf(n);
            if (r) zones.push({ name: n.name, kind, ...r, tint: tintOf(n, '#2A2240') });
        }
    }
    zones.sort((a, b) => a.w * a.h - b.w * b.h); // (v2에선 존 그룹이 없어도 됨 — 빈 배열 허용)

    const propList: PropDef[] = [];
    const collectProps = (group: Node | null, baseX: number, baseY: number) => {
        for (const n of group?.children ?? []) {
            if (n.name.startsWith('_')) continue;
            const ut = n.getComponent(UITransform);
            propList.push({
                kind: n.name.replace(/[0-9]+$/, ''), // crate2 → crate
                gx: (baseX + n.position.x) / B,
                gy: (baseY + n.position.y) / B,
                w: (ut ? ut.contentSize.width : 30) * PROP_SCALE,
                h: (ut ? ut.contentSize.height : 30) * PROP_SCALE,
                tint: tintOf(n, '#7C7686'),
            });
        }
    };
    collectProps(root.getChildByName('props'), 0, 0); // 전역 그룹 (레거시)
    // region 단위 배치물 — 각 구역의 props 하위 그룹, 구역과 함께 움직임
    for (const region of root.getChildByName('regions')?.children ?? []) {
        collectProps(region.getChildByName('props'), region.position.x, region.position.y);
    }

    let playerSpawn = { gx: 0, gy: 0 };
    const spawnNode = root.getChildByName('spawn')?.children.find(n => !n.name.startsWith('_'));
    if (spawnNode) {
        playerSpawn = { gx: spawnNode.position.x / B, gy: spawnNode.position.y / B };
    }

    return { name: 'scene', groundRadius, playerSpawn, zones, props: propList };
}
