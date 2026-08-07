import { Color, Node, SpriteFrame } from 'cc';
import { MapObjectDef, MapTriggerDef, MapUnitDef, TriggerType, ResourceKind, UpgradeKind } from './MapData';
import { isoX, isoY, TILE_W } from './Projection';

const TRANSFER_S = 0.3;      // 아이템(고기·요리·돈) 이동 시간 — 기획 정의 전 (임의)
const COOK_S = 1.0;          // 고기 1개 요리 시간 — 기획 정의 전 (임의)
const SPAWN_INTERVAL_S = 10; // NPC 스폰 주기 — 기획의 스폰 규칙 정의 전 (임의: 10초에 1명)
const SELL_PRICE = 1;        // 요리 1개 판매가 (골드) — 종전 회수 체인의 개당 1골드를 그대로 승계 (임의)

/**
 * 강화 스펙 (BIBLE §7-b 3종) — **비용 곡선은 기획 TBD라 전부 (임의)**.
 * 확정되면 이 표 한 곳만 고치면 된다 (BALANCE §강화 비용 곡선 → 여기로 복사).
 *  - step: 레벨당 증가폭 (절대값 방식 — BALANCE §레벨링 원칙)
 *  - costBase/costStep: 비용 = costBase + costStep × 현재레벨
 */
export const UPGRADE_SPEC: Record<UpgradeKind, {
    label: string; unit: string; step: number; costBase: number; costStep: number;
}> = {
    // 공격력 +1/레벨 = BALANCE §강화 1차 스케치 값 (닭 2타→1타 브레이크포인트)
    attack: { label: '공격력', unit: '', step: 1, costBase: 50, costStep: 10 },
    // 이동속도 +20px/s = 무게 페널티 1개분(-20px/s) 상쇄 (임의 — BALANCE에 항목 없음)
    speed: { label: '이동속도', unit: 'px/s', step: 20, costBase: 50, costStep: 10 },
    // 운반 한계 +2/레벨 = BALANCE §강화 1차 스케치 값 (시그니처 강화)
    carry: { label: '운반', unit: '개', step: 2, costBase: 50, costStep: 10 },
};

/**
 * 손님 상태 — CustomerSystem(이동)과 TriggerSystem(판매/정산)이 공유.
 *  waiting(대기열 이동중) → wants-food(줄 끝, 요리 대기) → satisfied(요리 받음)
 *  → leaving(결제 완료, 퇴장 이동중) → done(퇴장 완료·비활성)
 */
export type CustomerState = 'waiting' | 'wants-food' | 'satisfied' | 'leaving' | 'done';

export interface TriggerNpc {
    def: MapUnitDef;
    node: Node;
    gx: number; gy: number; // 현재 점유 타일 — CustomerSystem이 매 프레임 갱신
    slot: number;           // 타일 내 슬롯 (0/1) — 한 타일에 두 명이 반씩
    spawnId: number;        // 스폰 순서 — 스폰 트리거가 1씩 증가해 부여 (작을수록 먼저 온 손님)
    state: CustomerState;
    served: boolean;        // 판매대가 이미 요리를 준 손님인지 (중복 제공 방지)
    paid: boolean;          // 이미 결제된 손님인지 (판매 즉시 결제 — 중복 지급 방지)
}

export interface TriggerUi {
    makeNode(name: string, parent: Node): Node;
    addSprite(name: string, parent: Node, frame: SpriteFrame, w: number, h: number, color: Color): Node;
    square(): SpriteFrame;
    color(hex: string, alpha?: number): Color;
}

export interface TriggerHost {
    entities: Node;
    playerNode(): Node;
    playerG(): { gx: number; gy: number };
    takePlayerMeat(): boolean;
    addGold(amount: number): void;
    /** 플레이어가 등에 진 리소스 1개 꺼내기 — 없으면 false (raw는 등짐 고기 스택) */
    takePlayerResource(kind: ResourceKind): boolean;
    /** 플레이어에게 리소스 1개 적재 — 한계 초과 등으로 못 받으면 false */
    givePlayerResource(kind: ResourceKind): boolean;
    /** NPC 스폰 요청 — CustomerSystem이 풀에서 손님 1명 활성화 후 spawnId 부여 */
    spawnCustomer(gx: number, gy: number, img: number): void;
    /** 현재 보유 골드 — 게이트 해금 비용 판정 */
    gold(): number;
    /** 골드 차감 (부족하면 false) */
    spendGold(amount: number): boolean;
    /**
     * 트리거 타일과 **겹치는 오브젝트 노드** (없으면 null).
     * 자원을 그 오브젝트의 **자식**으로 붙이기 위한 것 — 자식은 항상 부모 위에 그려지므로
     * 표면에 놓인 것처럼 보이고, 깊이 정렬은 오브젝트 하나로 결정된다(자원이 따로 튀지 않음).
     */
    objectNodeOverlapping(gx: number, gy: number, w: number, h: number): Node | null;
    ui: TriggerUi;
}

interface RuntimeTrigger {
    def: MapTriggerDef;
    raw: Node[];
    cooked: Node[];
    money: Node[];
    timer: number;
    working: boolean;
    customers: TriggerNpc[];
    /**
     * 자원을 붙일 오브젝트 노드 — 트리거 타일을 함께 점유한 오브젝트가 있으면 그 노드.
     * 자원은 이 노드의 자식이 되어 **오브젝트와 같은 깊이로 정렬**된다(표면에 얹힌 취급).
     * 없으면 null이고, 그때는 entities에 직접 붙여 itemSortY로 정렬한다.
     */
    itemParent: Node | null;
    /** 오브젝트가 없을 때 쓰는 정렬 깊이 (트리거 타일 중심 살짝 앞) */
    itemSortY: number;
}

/** 리소스 종류별 표시색 */
const RES_COLOR: Record<ResourceKind, string> = {
    raw: '#C0503F', cooked: '#E7A33E', money: '#F0B429',
};

interface Flight {
    node: Node;
    sx: number;
    sy: number;
    ex: number;
    ey: number;
    elapsed: number;
    done(): void;
}

/**
 * 맵 트리거 생산 체인 런타임.
 * 연결은 MapTriggerDef.id로 해석하며 트리거/오브젝트 영역은 서로 독립이라 겹칠 수 있다.
 */
export class TriggerSystem {
    private readonly byId = new Map<string, RuntimeTrigger>();
    private readonly flights: Flight[] = [];
    private readonly npcs: TriggerNpc[];
    /** 해금된 게이트 ID — 세이브가 더미(§5)라 세션 내에서만 유지 (영구 저장은 세이브 도입 시) */
    private readonly unlockedGates = new Set<string>();
    /** 강화 레벨 — 종류별 구매 횟수. 세이브 도입 전까지 세션 내 유지 */
    private readonly upgradeLevels = new Map<UpgradeKind, number>();

    constructor(
        private readonly host: TriggerHost,
        defs: MapTriggerDef[],
        npcs: TriggerNpc[],
        private readonly objects: MapObjectDef[],
    ) {
        this.npcs = npcs;
        for (const def of defs) {
            if (!def.id || this.byId.has(def.id)) {
                console.warn(`[TriggerSystem] 비어 있거나 중복된 트리거 ID: '${def.id}'`);
                continue;
            }
            this.byId.set(def.id, {
                def, raw: [], cooked: [], money: [], timer: 0, working: false, customers: [],
                itemParent: host.objectNodeOverlapping(def.gx, def.gy, def.w, def.h),
                itemSortY: this.center(def).y - 1,
            });
        }
        this.validateLinks();
        this.validateGates();
    }

    update(dt: number) {
        this.updateFlights(dt);
        for (const trigger of this.byId.values()) {
            trigger.timer = Math.max(0, trigger.timer - dt);
            switch (trigger.def.type) {
                case 'ingredient-dropoff': this.updateIngredientDropoff(trigger); break;
                case 'cooking': this.updateCooking(trigger); break;
                case 'serving-counter': this.updateServingCounter(trigger); break;
                case 'purchase-spot': this.updatePurchaseSpot(trigger); break;
                // 정산대·회수위치는 **폐기됨** (결정 2026-08-07 — 판매 즉시 골드).
                // 맵에 남아 있어도 아무 동작을 하지 않는다. 타입 자체는 데이터 호환을 위해 유지
                // (디자이너가 재내보내기로 지울 때까지) — 시작 시 경고로 안내한다.
                case 'checkout':
                case 'money-pickup': break;
                case 'npc-spawn': this.updateNpcSpawn(trigger); break;
                case 'player-resource': this.updatePlayerResource(trigger); break;
                // 게이트·강화는 매 프레임 처리 없음 — 부트스트랩이 조회(lockedGateAt/upgradeAt)로 처리
                case 'gate': case 'upgrade': break;
            }
        }
    }

    private updateIngredientDropoff(source: RuntimeTrigger) {
        if (source.timer > 0 || !this.containsPlayer(source.def)) return;
        const target = this.linked(source, 0, 'cooking');
        if (!target || !this.host.takePlayerMeat()) return;
        source.timer = TRANSFER_S;
        const p = this.host.playerNode().position;
        this.fly('RawMeat', p.x, p.y + 90, target, '#C0503F', p.y - 1, () => {
            this.pushItem(target, target.raw, 'RawMeat', '#C0503F');
        });
    }

    private updateCooking(source: RuntimeTrigger) {
        if (source.raw.length === 0) {
            source.timer = 0;
            source.working = false;
            return;
        }
        if (!source.working) {
            source.working = true;
            source.timer = COOK_S;
            return;
        }
        if (source.timer > 0) return;

        const target = this.linked(source, 0, 'serving-counter');
        if (!target) return;
        const bottom = source.raw.shift();
        bottom?.destroy();
        this.reflow(source, source.raw);
        source.timer = 0;
        source.working = false;
        const start = this.itemPoint(source.def);
        this.fly('CookedFood', start.x, start.y + 22, target, '#E7A33E', this.flightSortY(source), () => {
            this.pushItem(target, target.cooked, 'CookedFood', '#E7A33E');
        });
    }

    private updateServingCounter(source: RuntimeTrigger) {
        if (source.timer > 0 || source.cooked.length === 0) return;
        const spot = this.linked(source, 0, 'purchase-spot');
        if (!spot) return;
        // 구매위치에 여러 명이면 spawnId가 가장 작은(먼저 온) 손님부터 응대
        const customer = this.front(spot.customers, n => n.state === 'wants-food' && !n.served);
        if (!customer) return;

        const food = source.cooked.pop();
        food?.destroy();
        customer.served = true;
        source.timer = TRANSFER_S;
        const start = this.itemPoint(source.def);
        this.flyToPoint('ServedFood', start.x, start.y + 22,
            customer.node.position.x, customer.node.position.y + 70, '#E7A33E', this.flightSortY(source), () => {
                customer.state = 'satisfied';
                // 판매 즉시 골드 (결정 2026-08-07 재확정) — 정산대·회수위치를 거치지 않는다.
                // "고기는 운반 대상이지만 돈은 아니다" (BIBLE §9-a 4). 표시는 "+N" 팝업(§10-a).
                customer.paid = true;
                this.host.addGold(SELL_PRICE);
                // 퇴장 전환은 CustomerSystem이 처리 — 한 프레임 뒤라 행복 이모티콘이 보인다
            });
    }

    /**
     * 플레이어리소스이동 — 플레이어가 트리거 영역에 있을 때 동작이 연결 유무로 갈린다.
     *  ① 연결 트리거 있음: 플레이어 보유 리소스(resource 종류) 1개를 연결 트리거로 이송해 쌓음
     *  ② 연결 트리거 없음: 이 트리거에 쌓인 리소스를 플레이어에게 이송(회수)
     * 한 번에 1개씩 TRANSFER_S 간격으로 — 서 있는 동안 순차 이송.
     */
    private updatePlayerResource(t: RuntimeTrigger) {
        if (t.timer > 0 || !this.containsPlayer(t.def)) return;
        const kind: ResourceKind = t.def.resource ?? 'raw';
        const color = RES_COLOR[kind];
        const linkId = t.def.triggerLinks[0] ?? '';
        const target = linkId ? this.byId.get(linkId) ?? null : null;

        if (linkId) {
            // ① 보내기 — 연결 대상이 없으면 경고만 (validateLinks에서 이미 알림)
            if (!target || !this.host.takePlayerResource(kind)) return;
            t.timer = TRANSFER_S;
            const p = this.host.playerNode().position;
            this.fly(`Res_${kind}`, p.x, p.y + 90, target, color, p.y - 1, () => {
                this.pushItem(target, this.stackOf(target, kind), `Res_${kind}`, color);
            });
        } else {
            // ② 회수 — 이 트리거에 쌓인 것을 플레이어에게
            const stack = this.stackOf(t, kind);
            if (stack.length === 0) return;
            if (kind === 'money') {
                // 돈은 등에 지지 않고 골드로 즉시 편입
                stack.pop()!.destroy();
                t.timer = TRANSFER_S;
                const start = this.itemPoint(t.def);
                const p = this.host.playerNode().position;
                this.flyToPoint('Res_money', start.x, start.y + 22, p.x, p.y + 70, color, this.flightSortY(t), () => {
                    this.host.addGold(1);
                });
                return;
            }
            if (!this.host.givePlayerResource(kind)) return; // 등짐 가득 — 대기
            stack.pop()!.destroy();
            this.reflow(t, stack);
            t.timer = TRANSFER_S;
            const start = this.itemPoint(t.def);
            const p = this.host.playerNode().position;
            this.flyToPoint(`Res_${kind}`, start.x, start.y + 22, p.x, p.y + 70, color, this.flightSortY(t), () => {});
        }
    }

    /** 트리거의 리소스 종류별 스택 */
    private stackOf(t: RuntimeTrigger, kind: ResourceKind): Node[] {
        return kind === 'raw' ? t.raw : kind === 'cooked' ? t.cooked : t.money;
    }

    private updateNpcSpawn(t: RuntimeTrigger) {
        if (t.timer > 0) return;
        t.timer = SPAWN_INTERVAL_S;
        // 스폰 트리거 타일 중심에 손님 1명 요청 — spawnId 부여·슬롯 배치는 CustomerSystem
        const cx = Math.round(t.def.gx + (t.def.w - 1) / 2);
        const cy = Math.round(t.def.gy + (t.def.h - 1) / 2);
        this.host.spawnCustomer(cx, cy, t.def.npcImg ?? 0);
    }

    // ── 구역 해금 게이트 (BIBLE §7-c, 팝업 규격 §10-b) ──
    /** (gx,gy)를 덮는 **잠긴** 게이트 — 없으면 null. 이동 차단·팝업 표시의 기준 */
    lockedGateAt(gx: number, gy: number): MapTriggerDef | null {
        for (const t of this.byId.values()) {
            if (t.def.type !== 'gate') continue;
            if (this.unlockedGates.has(t.def.id)) continue;
            if (this.containsTile(t.def, Math.round(gx), Math.round(gy))) return t.def;
        }
        return null;
    }

    /** 해금 여부 */
    isGateUnlocked(id: string): boolean {
        return this.unlockedGates.has(id);
    }

    /**
     * 해금 시도 — 비용만큼 골드를 차감하고 개방. 비용 0이면 무료 통과(튜토리얼 게이트).
     * 골드 부족이면 false (팝업의 버튼은 비활성 상태로 표시됨).
     */
    tryUnlockGate(id: string): boolean {
        const t = this.byId.get(id);
        if (!t || t.def.type !== 'gate') return false;
        if (this.unlockedGates.has(id)) return true;
        const cost = t.def.unlockCost ?? 0;
        if (cost > 0 && !this.host.spendGold(cost)) return false;
        this.unlockedGates.add(id);
        console.log(`[TriggerSystem] 게이트 '${id}' 해금 (비용 ${cost})`);
        return true;
    }

    // ── 강화 (BIBLE §7-a·§7-b, 팝업 규격 §10-b ①) ──
    /** (gx,gy)를 덮는 강화 발판 — 없으면 null (팝업 열기 기준) */
    upgradeAt(gx: number, gy: number): MapTriggerDef | null {
        for (const t of this.byId.values()) {
            if (t.def.type !== 'upgrade') continue;
            if (this.containsTile(t.def, Math.round(gx), Math.round(gy))) return t.def;
        }
        return null;
    }

    upgradeLevel(kind: UpgradeKind): number {
        return this.upgradeLevels.get(kind) ?? 0;
    }

    /** 다음 1레벨 비용 = costBase + costStep × 현재레벨 (임의 곡선) */
    upgradeCost(kind: UpgradeKind, levelOffset = 0): number {
        const s = UPGRADE_SPEC[kind];
        return s.costBase + s.costStep * (this.upgradeLevel(kind) + levelOffset);
    }

    /** n회 구매 총액 (연속 레벨 비용의 합) */
    upgradeCostFor(kind: UpgradeKind, times: number): number {
        let sum = 0;
        for (let i = 0; i < times; i++) sum += this.upgradeCost(kind, i);
        return sum;
    }

    /**
     * 강화 구매 — 최대 times회 시도하고 **실제 구매한 횟수**를 돌려준다.
     * 자금이 모자라면 **가능한 만큼만** 구매 (§10-b 10회 구매 규칙 = 결정).
     */
    buyUpgrade(kind: UpgradeKind, times: number): number {
        let bought = 0;
        for (let i = 0; i < times; i++) {
            const cost = this.upgradeCost(kind);
            if (this.host.gold() < cost || !this.host.spendGold(cost)) break;
            this.upgradeLevels.set(kind, this.upgradeLevel(kind) + 1);
            bought++;
        }
        if (bought > 0) {
            console.log(`[TriggerSystem] 강화 ${UPGRADE_SPEC[kind].label} +${bought} → Lv.${this.upgradeLevel(kind)}`);
        }
        return bought;
    }

    /** 조건을 만족하는 손님 중 spawnId가 가장 작은(먼저 온) 한 명 — 구매위치 우선순위 규칙 */
    private front(list: TriggerNpc[], ok: (n: TriggerNpc) => boolean): TriggerNpc | null {
        let best: TriggerNpc | null = null;
        for (const n of list) {
            if (ok(n) && (!best || n.spawnId < best.spawnId)) best = n;
        }
        return best;
    }

    private updatePurchaseSpot(spot: RuntimeTrigger) {
        for (const npc of this.npcs) {
            // 손님이 실제로 이 구매위치 타일에 서 있는 동안만 명단에 포함 (현재 점유 타일 기준)
            const inside = npc.state !== 'done' && this.containsTile(spot.def, npc.gx, npc.gy);
            const index = spot.customers.indexOf(npc);
            if (inside && index < 0) spot.customers.push(npc);
            else if (!inside && index >= 0) spot.customers.splice(index, 1);
        }
    }

    /**
     * 게이트 설정 점검 — 게이트 근처에 **통과 불가 오브젝트(문)가 있는데 연결되지 않은** 경우 경고.
     * 연결이 없으면 해금해도 그 문이 계속 길을 막아 "게이트가 안 열린다"로 보인다.
     */
    private validateGates() {
        // 게이트 영역을 1타일 확장한 범위와 오브젝트 영역이 겹치는지 (문은 게이트 위/바로 옆에 있음)
        const touches = (o: MapObjectDef, def: MapTriggerDef) =>
            o.gx <= def.gx + def.w && o.gx + o.w - 1 >= def.gx - 1 &&
            o.gy <= def.gy + def.h && o.gy + o.h - 1 >= def.gy - 1;
        for (const t of this.byId.values()) {
            if (t.def.type !== 'gate') continue;
            if ((t.def.objectLinks ?? []).length > 0) continue;
            const blockers = this.objects.filter(o => !o.walkable && touches(o, t.def));
            for (const b of blockers) {
                console.warn(`[TriggerSystem] 게이트 '${t.def.id}' 옆의 통과 불가 오브젝트 '${b.id ?? b.kind}'가 `
                    + `연결되지 않았습니다 — 해금해도 길이 막힙니다. 에디터에서 게이트의 objectLink1에 '${b.id ?? ''}'를 넣으세요`);
            }
        }
    }

    private validateLinks() {
        const expected: Partial<Record<TriggerType, TriggerType>> = {
            'ingredient-dropoff': 'cooking',
            'cooking': 'serving-counter',
            'serving-counter': 'purchase-spot',
        };
        for (const trigger of this.byId.values()) {
            // 폐기된 타입 안내 (결정 2026-08-07) — 남아 있어도 무동작이므로 맵에서 지우면 된다
            if (trigger.def.type === 'checkout' || trigger.def.type === 'money-pickup') {
                console.warn(`[TriggerSystem] '${trigger.def.id}'(${trigger.def.type})는 폐기된 타입입니다 `
                    + `— 판매 즉시 골드로 바뀌어 아무 동작을 하지 않습니다. 에디터에서 삭제 후 재내보내기 하세요`);
            }
            for (const objectId of trigger.def.objectLinks) {
                if (!this.objects.some(object => object.id === objectId)) {
                    console.warn(`[TriggerSystem] '${trigger.def.id}'의 연결 오브젝트 '${objectId}'를 찾을 수 없습니다`);
                }
            }
            // 2번 연결은 전 타입 공통 옵션 — 적혀 있으면 존재 여부만 확인
            const link2 = trigger.def.triggerLinks[1] ?? '';
            if (link2 && !this.byId.get(link2)) {
                console.warn(`[TriggerSystem] '${trigger.def.id}'의 2번 연결 트리거 '${link2}'를 찾을 수 없습니다`);
            }
            // 플레이어리소스이동은 연결 없음도 정상(회수 모드) — 링크가 적혔을 때만 존재 확인
            if (trigger.def.type === 'player-resource') {
                const linkId = trigger.def.triggerLinks[0] ?? '';
                if (linkId && !this.byId.get(linkId)) {
                    console.warn(`[TriggerSystem] '${trigger.def.id}'의 연결 트리거 '${linkId}'를 찾을 수 없습니다`);
                }
                continue;
            }
            const required = expected[trigger.def.type];
            if (!required) continue;
            const target = this.byId.get(trigger.def.triggerLinks[0] ?? '');
            if (!target) console.warn(`[TriggerSystem] '${trigger.def.id}'의 1번 연결 트리거를 찾을 수 없습니다`);
            // player-resource는 범용 보관소라 어느 자리에든 올 수 있음 (조립식 플로우)
            else if (target.def.type !== required && target.def.type !== 'player-resource') {
                console.warn(`[TriggerSystem] '${trigger.def.id}'의 1번 연결은 ${required} 또는 player-resource 타입이어야 합니다`);
            }
        }
    }

    /**
     * 연결 트리거 조회 — 기대 타입이거나 **플레이어리소스이동(범용 리소스 보관소)** 이면 통과.
     * 후자를 허용해야 `고기굽기 → 리소스이동B(회수)`처럼 조립식 플로우가 성립한다
     * (허용 안 하면 대상이 null이 되어 체인이 그 지점에서 끊긴다).
     */
    private linked(source: RuntimeTrigger, index: number, expected: TriggerType): RuntimeTrigger | null {
        const target = this.byId.get(source.def.triggerLinks[index] ?? '') ?? null;
        if (!target) return null;
        return (target.def.type === expected || target.def.type === 'player-resource') ? target : null;
    }

    private containsPlayer(def: MapTriggerDef): boolean {
        const p = this.host.playerG();
        return this.containsTile(def, Math.round(p.gx), Math.round(p.gy));
    }

    private containsTile(def: MapTriggerDef, gx: number, gy: number): boolean {
        return gx >= def.gx && gx < def.gx + def.w && gy >= def.gy && gy < def.gy + def.h;
    }

    private center(def: MapTriggerDef): { x: number; y: number } {
        const gx = def.gx + (def.w - 1) / 2;
        const gy = def.gy + (def.h - 1) / 2;
        return { x: isoX(gx, gy), y: isoY(gx, gy) };
    }

    /**
     * 자원이 놓이는 지점 — 트리거 중심 + `itemOffX/itemOffY`.
     * 가판대·그릴 표면 위에 올려진 것처럼 보이게 하려고 디자이너가 offset을 잡는다.
     * ⚠ 정렬 깊이는 **offset을 뺀 타일 중심** 기준으로 유지한다 — 위로 올린 만큼 앞으로
     *   튀어나오면 안 되기 때문(오브젝트보다 살짝 앞이면 충분).
     */
    /**
     * 비행 아이템의 정렬 깊이 — 출발 트리거에 오브젝트가 붙어 있으면 **그 오브젝트의 현재 깊이**를
     * 따른다(오브젝트 깊이는 매 프레임 플레이어 기준으로 바뀌므로 그때그때 읽는다).
     * 그래야 날아가는 동안에도 오브젝트 앞에 선 캐릭터가 아이템을 정상적으로 가린다.
     */
    private flightSortY(owner: RuntimeTrigger): number {
        const parent = owner.itemParent;
        if (!parent) return owner.itemSortY;
        return ((parent as unknown as { __sortY?: number }).__sortY ?? parent.position.y) - 0.001;
    }

    private itemPoint(def: MapTriggerDef): { x: number; y: number } {
        const c = this.center(def);
        return { x: c.x + (def.itemOffX ?? 0), y: c.y + (def.itemOffY ?? 0) };
    }

    private pushItem(owner: RuntimeTrigger, stack: Node[], name: string, color: string) {
        const base = this.itemBase(owner);
        const parent = owner.itemParent ?? this.host.entities;
        const node = this.host.ui.addSprite(name, parent, this.host.ui.square(),
            28, 16, this.host.ui.color(color));
        node.setPosition(base.x, base.y + 12 + stack.length * 10, 0);
        // 오브젝트 자식이면 정렬은 부모가 담당한다(같은 깊이) — 아니면 타일보다 살짝 앞
        if (!owner.itemParent) (node as unknown as { __sortY: number }).__sortY = owner.itemSortY;
        stack.push(node);
    }

    /** 자원 쌓기 시작점 — 오브젝트 자식이면 그 노드 로컬 좌표로 환산한다 */
    private itemBase(owner: RuntimeTrigger): { x: number; y: number } {
        const p = this.itemPoint(owner.def);
        const parent = owner.itemParent;
        if (!parent) return p;
        return { x: p.x - parent.position.x, y: p.y - parent.position.y };
    }

    private reflow(owner: RuntimeTrigger, stack: Node[]) {
        const base = this.itemBase(owner);
        for (let i = 0; i < stack.length; i++) {
            stack[i].setPosition(base.x, base.y + 12 + i * 10, 0);
        }
    }

    private fly(name: string, sx: number, sy: number, target: RuntimeTrigger, color: string, srcSortY: number, done: () => void) {
        const end = this.itemPoint(target.def);
        this.flyToPoint(name, sx, sy, end.x, end.y + 22, color, srcSortY, done);
    }

    private flyToPoint(
        name: string, sx: number, sy: number, ex: number, ey: number,
        color: string, srcSortY: number, done: () => void,
    ) {
        const node = this.host.ui.addSprite(name, this.host.entities, this.host.ui.square(),
            28, 16, this.host.ui.color(color));
        node.setPosition(sx, sy, 0);
        // 정렬 깊이를 출발 지점(소스) 기준으로 — 소스 앞에 선 캐릭터(예: 가판대 앞 플레이어)가
        // 비행 아이템을 정상적으로 가리게 (무조건 최전면이면 플레이어가 건네주는 것처럼 보임)
        (node as unknown as { __sortY: number }).__sortY = srcSortY;
        this.flights.push({ node, sx, sy, ex, ey, elapsed: 0, done });
    }

    private updateFlights(dt: number) {
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const flight = this.flights[i];
            flight.elapsed += dt;
            const t = Math.min(1, flight.elapsed / TRANSFER_S);
            flight.node.setPosition(
                flight.sx + (flight.ex - flight.sx) * t,
                flight.sy + (flight.ey - flight.sy) * t + Math.sin(t * Math.PI) * TILE_W * 0.55,
                0);
            if (t < 1) continue;
            flight.node.destroy();
            flight.done();
            this.flights.splice(i, 1);
        }
    }
}
