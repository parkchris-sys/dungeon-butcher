import { isoX, isoY } from './Projection';
import { TILE_ATTR_QUEUE, TILE_ATTR_EXIT } from './MapData';
import { TriggerNpc } from './TriggerSystem';

/**
 * 손님 NPC 이동·상태머신 (PHASE1 정육식당 루프).
 *
 * 흐름: 스폰 → 대기열(attr=2) 타일을 따라 한 칸씩 이동(waiting) → 더 갈 대기열 칸이
 *       없으면 요리 대기(wants-food) → 판매대가 요리를 주면 만족(satisfied) →
 *       정산대가 돈을 회수하면 퇴장(leaving) → 퇴장(attr=3) 타일을 따라 이동 →
 *       더 갈 퇴장 칸이 없으면 비활성(done, 재사용 위해 숨김) → 잠시 뒤 재스폰.
 *
 * 이동 규칙: 현재 칸의 정방향(대각선 제외) 4칸 중 "원하는 속성"이고 "아직 밟지 않은" 칸을
 *   목표로 삼는다. 이미 밟은 칸은 제외(줄에서 뒤로 안 감). 목표 칸을 다른 손님이 점유
 *   중이면 이동하지 않는다(줄 서기).
 *
 * 상태(satisfied/leaving 전이)는 TriggerSystem이 담당 — 두 시스템이 TriggerNpc를 공유한다.
 */

const MOVE_S = 0.25;     // 한 칸 이동 시간(초) — 기획 정의 전 (임의)
const RESPAWN_S = 3.0;   // 퇴장 후 재스폰까지 대기(초) — 기획 정의 전 (임의)

export interface CustomerHost {
    /** (gx,gy) 타일의 속성 번호 (TILE_ATTR_*) — 범위 밖/타일 없음은 0 */
    tileAttrAt(gx: number, gy: number): number;
}

interface Cust {
    npc: TriggerNpc;
    homeGx: number; homeGy: number;
    visited: Set<string>;
    moving: boolean;
    moveT: number;
    fromX: number; fromY: number;
    toX: number; toY: number;
    targetGx: number; targetGy: number;
    respawnT: number;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (gx: number, gy: number) => `${gx},${gy}`;

export class CustomerSystem {
    private readonly custs: Cust[] = [];

    constructor(private readonly host: CustomerHost, npcs: TriggerNpc[]) {
        for (const npc of npcs) {
            const c: Cust = {
                npc, homeGx: npc.def.gx, homeGy: npc.def.gy,
                visited: new Set(), moving: false, moveT: 0,
                fromX: 0, fromY: 0, toX: 0, toY: 0, targetGx: 0, targetGy: 0, respawnT: 0,
            };
            this.custs.push(c);
            this.reset(c);
        }
    }

    /** 손님을 스폰 타일로 되돌리고 초기 상태 부여 (최초 생성 + 재사용 공용) */
    private reset(c: Cust) {
        const n = c.npc;
        n.gx = c.homeGx; n.gy = c.homeGy;
        n.served = false; n.paid = false;
        c.visited.clear();
        c.visited.add(key(n.gx, n.gy));
        c.moving = false; c.moveT = 0; c.respawnT = 0;
        n.node.active = true;
        n.node.setPosition(isoX(n.gx, n.gy), isoY(n.gx, n.gy), 0);
        // 대기열 위에 스폰되면 줄을 따라 이동, 아니면 바로 요리 대기
        n.state = this.host.tileAttrAt(n.gx, n.gy) === TILE_ATTR_QUEUE ? 'waiting' : 'wants-food';
    }

    update(dt: number) {
        for (const c of this.custs) {
            const n = c.npc;

            if (n.state === 'done') {
                if ((c.respawnT -= dt) <= 0) {
                    // 스폰 지점(줄 시작)이 아직 다른 손님으로 막혀 있으면 잠시 뒤 재시도
                    if (this.occupied(c.homeGx, c.homeGy, c)) c.respawnT = 0.3;
                    else this.reset(c);
                }
                continue;
            }

            if (c.moving) {
                c.moveT += dt / MOVE_S;
                const t = Math.min(1, c.moveT);
                n.node.setPosition(c.fromX + (c.toX - c.fromX) * t, c.fromY + (c.toY - c.fromY) * t, 0);
                if (t >= 1) {
                    c.moving = false;
                    n.gx = c.targetGx; n.gy = c.targetGy;
                    c.visited.add(key(n.gx, n.gy));
                }
                continue;
            }

            // 정지 상태에서 다음 목표 결정 — waiting=대기열 추적, leaving=퇴장 추적, 그 외 정지
            const desired = n.state === 'waiting' ? TILE_ATTR_QUEUE
                : n.state === 'leaving' ? TILE_ATTR_EXIT : 0;
            if (desired === 0) continue;

            const next = this.findNext(c, desired);
            if (!next) {
                if (n.state === 'waiting') {
                    n.state = 'wants-food'; // 줄 끝 도달 — 요리를 원하는 상태
                } else {
                    n.node.active = false;  // 퇴장 완료 — 비활성(재사용 대기)
                    n.state = 'done';
                    c.respawnT = RESPAWN_S;
                }
                continue;
            }
            if (this.occupied(next[0], next[1], c)) continue; // 앞 손님이 막음 — 대기

            c.targetGx = next[0]; c.targetGy = next[1];
            c.fromX = n.node.position.x; c.fromY = n.node.position.y;
            c.toX = isoX(next[0], next[1]); c.toY = isoY(next[0], next[1]);
            c.moving = true; c.moveT = 0;
        }
    }

    /** 4방향 중 원하는 속성이고 아직 안 밟은 첫 칸 */
    private findNext(c: Cust, desired: number): [number, number] | null {
        const n = c.npc;
        for (const [dx, dy] of DIRS) {
            const gx = n.gx + dx, gy = n.gy + dy;
            if (c.visited.has(key(gx, gy))) continue;
            if (this.host.tileAttrAt(gx, gy) !== desired) continue;
            return [gx, gy];
        }
        return null;
    }

    /** 다른 손님이 그 칸을 점유(정지) 중이거나 그 칸으로 이동 중인가 */
    private occupied(gx: number, gy: number, self: Cust): boolean {
        for (const o of this.custs) {
            if (o === self || o.npc.state === 'done') continue;
            if (o.npc.gx === gx && o.npc.gy === gy) return true;
            if (o.moving && o.targetGx === gx && o.targetGy === gy) return true;
        }
        return false;
    }
}
