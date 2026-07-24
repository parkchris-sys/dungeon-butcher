import { Color, Node, SpriteFrame } from 'cc';
import { MapObjectDef, MapTriggerDef, MapUnitDef, TriggerType } from './MapData';
import { isoX, isoY, TILE_W } from './Projection';

const TRANSFER_S = 0.3; // 아이템(고기·요리·돈) 이동 시간 — 기획 정의 전 (임의)
const COOK_S = 1.0;     // 고기 1개 요리 시간 — 기획 정의 전 (임의)

/**
 * 손님 상태 — CustomerSystem(이동)과 TriggerSystem(판매/정산)이 공유.
 *  waiting(대기열 이동중) → wants-food(줄 끝, 요리 대기) → satisfied(요리 받음)
 *  → leaving(정산 완료, 퇴장 이동중) → done(퇴장 완료·비활성)
 */
export type CustomerState = 'waiting' | 'wants-food' | 'satisfied' | 'leaving' | 'done';

export interface TriggerNpc {
    def: MapUnitDef;
    node: Node;
    gx: number; gy: number; // 현재 점유 타일 — CustomerSystem이 매 프레임 갱신
    state: CustomerState;
    served: boolean;        // 판매대가 이미 요리를 준 손님인지 (중복 제공 방지)
    paid: boolean;          // 정산대가 이미 돈을 회수한 손님인지 (중복 회수 방지)
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
}

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
            });
        }
        this.validateLinks();
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
                case 'checkout': this.updateCheckout(trigger); break;
                case 'money-pickup': this.updateMoneyPickup(trigger); break;
            }
        }
    }

    private updateIngredientDropoff(source: RuntimeTrigger) {
        if (source.timer > 0 || !this.containsPlayer(source.def)) return;
        const target = this.linked(source, 0, 'cooking');
        if (!target || !this.host.takePlayerMeat()) return;
        source.timer = TRANSFER_S;
        const p = this.host.playerNode().position;
        this.fly('RawMeat', p.x, p.y + 90, target, '#C0503F', () => {
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
        const start = this.center(source.def);
        this.fly('CookedFood', start.x, start.y + 22, target, '#E7A33E', () => {
            this.pushItem(target, target.cooked, 'CookedFood', '#E7A33E');
        });
    }

    private updateServingCounter(source: RuntimeTrigger) {
        if (source.timer > 0 || source.cooked.length === 0) return;
        const spot = this.linked(source, 0, 'purchase-spot');
        if (!spot) return;
        const customer = spot.customers.find(n => n.state === 'wants-food' && !n.served);
        if (!customer) return;

        const food = source.cooked.pop();
        food?.destroy();
        customer.served = true;
        source.timer = TRANSFER_S;
        const start = this.center(source.def);
        this.flyToPoint('ServedFood', start.x, start.y + 22,
            customer.node.position.x, customer.node.position.y + 70, '#E7A33E', () => {
                customer.state = 'satisfied';
            });
    }

    private updateCheckout(source: RuntimeTrigger) {
        if (source.timer > 0) return;
        const spot = this.linked(source, 0, 'purchase-spot');
        if (!spot) return;
        const customer = spot.customers.find(n => n.state === 'satisfied' && !n.paid);
        if (!customer) return;

        customer.paid = true;
        source.timer = TRANSFER_S;
        const target = this.center(source.def);
        this.flyToPoint('Money', customer.node.position.x, customer.node.position.y + 70,
            target.x, target.y + 22, '#F0B429', () => {
                this.pushItem(source, source.money, 'Money', '#F0B429');
                // 퇴장 시작 — 실제 내보내기(퇴장 타일 따라 이동·비활성)는 CustomerSystem이 처리
                customer.state = 'leaving';
            });
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

    private updateMoneyPickup(source: RuntimeTrigger) {
        if (source.timer > 0 || !this.containsPlayer(source.def)) return;
        const checkout = this.linked(source, 0, 'checkout');
        if (!checkout || checkout.money.length === 0) return;

        const top = checkout.money.pop();
        top?.destroy();
        source.timer = TRANSFER_S;
        const start = this.center(checkout.def);
        const p = this.host.playerNode().position;
        this.flyToPoint('MoneyPickup', start.x, start.y + 22, p.x, p.y + 70, '#F0B429', () => {
            this.host.addGold(1);
        });
    }

    private validateLinks() {
        const expected: Partial<Record<TriggerType, TriggerType>> = {
            'ingredient-dropoff': 'cooking',
            'cooking': 'serving-counter',
            'serving-counter': 'purchase-spot',
            'checkout': 'purchase-spot',
            'money-pickup': 'checkout',
        };
        for (const trigger of this.byId.values()) {
            for (const objectId of trigger.def.objectLinks) {
                if (!this.objects.some(object => object.id === objectId)) {
                    console.warn(`[TriggerSystem] '${trigger.def.id}'의 연결 오브젝트 '${objectId}'를 찾을 수 없습니다`);
                }
            }
            const required = expected[trigger.def.type];
            if (!required) continue;
            const target = this.byId.get(trigger.def.triggerLinks[0] ?? '');
            if (!target) console.warn(`[TriggerSystem] '${trigger.def.id}'의 1번 연결 트리거를 찾을 수 없습니다`);
            else if (target.def.type !== required) {
                console.warn(`[TriggerSystem] '${trigger.def.id}'의 1번 연결은 ${required} 타입이어야 합니다`);
            }
        }
    }

    private linked(source: RuntimeTrigger, index: number, expected: TriggerType): RuntimeTrigger | null {
        const target = this.byId.get(source.def.triggerLinks[index] ?? '') ?? null;
        return target?.def.type === expected ? target : null;
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

    private pushItem(owner: RuntimeTrigger, stack: Node[], name: string, color: string) {
        const center = this.center(owner.def);
        const node = this.host.ui.addSprite(name, this.host.entities, this.host.ui.square(),
            28, 16, this.host.ui.color(color));
        node.setPosition(center.x, center.y + 12 + stack.length * 10, 0);
        stack.push(node);
    }

    private reflow(owner: RuntimeTrigger, stack: Node[]) {
        const center = this.center(owner.def);
        for (let i = 0; i < stack.length; i++) {
            stack[i].setPosition(center.x, center.y + 12 + i * 10, 0);
        }
    }

    private fly(name: string, sx: number, sy: number, target: RuntimeTrigger, color: string, done: () => void) {
        const end = this.center(target.def);
        this.flyToPoint(name, sx, sy, end.x, end.y + 22, color, done);
    }

    private flyToPoint(
        name: string, sx: number, sy: number, ex: number, ey: number,
        color: string, done: () => void,
    ) {
        const node = this.host.ui.addSprite(name, this.host.entities, this.host.ui.square(),
            28, 16, this.host.ui.color(color));
        node.setPosition(sx, sy, 0);
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
