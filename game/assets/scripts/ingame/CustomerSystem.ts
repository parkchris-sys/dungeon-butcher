import { Node, Sprite, SpriteFrame, Color, UITransform } from 'cc';
import { isoX, isoY, TILE_W, TILE_H } from './Projection';
import { TILE_ATTR_QUEUE, TILE_ATTR_EXIT } from './MapData';
import { TriggerNpc } from './TriggerSystem';

/**
 * 손님 NPC 시스템 — 스폰(스폰 트리거 요청) · 이동(대기열/퇴장) · 참을성/기분/성향.
 *
 * 흐름: 스폰(spawn 트리거) → 대기열(attr=2) 따라 이동(waiting) → 줄 끝에서 요리 대기(wants-food)
 *       → 판매대가 요리 주면 만족(satisfied·기분 행복) → 정산대가 돈 회수하면 퇴장(leaving)
 *       → 퇴장(attr=3) 따라 이동 → 끝나면 비활성(done, 풀 재사용).
 *
 * 타일당 2명: 2:1 타일을 좌/우 반으로 나눠 슬롯 0/1에 한 명씩.
 * 참을성/기분/성향(전부 임의 — 기획 정의 전):
 *   성향 급함/느긋함/시간무한 = 참을성 10/30/9999. 10초마다 1 감소, 0이면 기분 1단계↓ 후 리셋.
 *   기분 화남<지루함<보통<행복함. 화남에서 소진되면 즉시 포기 → 가까운 퇴장 타일로 나감.
 *   요리를 받으면(satisfied) 기분 행복.
 */

const MOVE_S = 0.25;         // 한 칸 이동 시간(초) — (임의)
const PATIENCE_TICK_S = 10;  // 참을성 1 감소 주기(초) — (임의)
const TEMPER_PATIENCE = [10, 30, 9999]; // 급함/느긋함/시간무한 참을성 — (임의)

// 기분 단계
const ANGRY = 0, BORED = 1, NORMAL = 2, HAPPY = 3;

// 타일 내 슬롯(0/1) 화면 offset — 2:1 타일을 좌/우 반으로
const SLOT_OFF: [number, number][] = [[-TILE_W / 4, TILE_H / 8], [TILE_W / 4, -TILE_H / 8]];

export interface CustomerHost {
    entities: Node;
    tileAttrAt(gx: number, gy: number): number;
    makeNode(name: string, parent: Node): Node;
    addSprite(name: string, parent: Node, frame: SpriteFrame, w: number, h: number, color: Color): Node;
    square(): SpriteFrame;
    diamond(): SpriteFrame;
    color(hex: string, alpha?: number): Color;
    unitFrame(img: number): SpriteFrame | null; // 손님 외형 (maps/units)
    moodFrame(mood: number): SpriteFrame | null; // 기분 이모티콘 (0..3)
    charPx: number;
}

interface Cust {
    npc: TriggerNpc;
    body: Sprite;
    moodNode: Node;
    moodSprite: Sprite;
    active: boolean;
    visited: Set<string>;
    moving: boolean;
    moveT: number;
    fromX: number; fromY: number; toX: number; toY: number;
    targetGx: number; targetGy: number; targetSlot: number;
    temperament: number;
    patienceMax: number;
    patience: number;
    patienceTimer: number;
    mood: number;
    lastMood: number;
    prevState: string;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (gx: number, gy: number) => `${gx},${gy}`;

export class CustomerSystem {
    private readonly custs: Cust[] = [];
    private nextSpawnId = 0;

    constructor(private readonly host: CustomerHost, private readonly shared: TriggerNpc[]) {}

    /** 스폰 트리거 요청 — (gx,gy) 타일의 빈 슬롯에 손님 1명 활성화, spawnId 부여 */
    spawn(gx: number, gy: number, img: number) {
        const slot = !this.slotOccupied(gx, gy, 0, null) ? 0
            : !this.slotOccupied(gx, gy, 1, null) ? 1 : -1;
        if (slot < 0) return; // 스폰 지점 두 슬롯 모두 참 — 이번 주기 건너뜀

        const c = this.custs.find(x => !x.active) ?? this.create();
        const n = c.npc;
        n.spawnId = ++this.nextSpawnId;
        n.gx = gx; n.gy = gy; n.slot = slot;
        n.served = false; n.paid = false;
        n.state = this.host.tileAttrAt(gx, gy) === TILE_ATTR_QUEUE ? 'waiting' : 'wants-food';

        c.active = true;
        c.visited.clear();
        c.visited.add(key(gx, gy));
        c.moving = false; c.moveT = 0;
        c.temperament = Math.floor(Math.random() * 3);
        c.patienceMax = TEMPER_PATIENCE[c.temperament];
        c.patience = c.patienceMax;
        c.patienceTimer = 0;
        c.mood = NORMAL;
        c.lastMood = -1;
        c.prevState = n.state;

        // 외형 프레임 교체 (재사용 노드도 갱신)
        const art = this.host.unitFrame(img);
        const cp = this.host.charPx;
        if (art) {
            c.body.spriteFrame = art;
            c.body.color = this.host.color('#FFFFFF');
            this.setBodySize(c, cp * (art.rect.width / art.rect.height), cp);
        } else {
            c.body.spriteFrame = this.host.square();
            c.body.color = this.host.color('#3BAF6E');
            this.setBodySize(c, cp * 0.6, cp * 0.8);
        }

        n.node.active = true;
        this.placeAt(c);
        this.refreshMood(c);
    }

    update(dt: number) {
        for (const c of this.custs) {
            if (!c.active) continue;
            const n = c.npc;

            // 요리 받으면 기분 행복
            if (n.state === 'satisfied' && c.prevState !== 'satisfied') c.mood = HAPPY;
            c.prevState = n.state;

            // 참을성/기분 — 대기 중(waiting/wants-food)에만 소진
            if (n.state === 'waiting' || n.state === 'wants-food') {
                c.patienceTimer += dt;
                while (c.patienceTimer >= PATIENCE_TICK_S) {
                    c.patienceTimer -= PATIENCE_TICK_S;
                    c.patience -= 1;
                    if (c.patience <= 0) {
                        if (c.mood === ANGRY) { this.giveUp(c); break; }
                        c.mood -= 1;
                        c.patience = c.patienceMax;
                    }
                }
            }
            this.refreshMood(c);

            if (c.moving) {
                c.moveT += dt / MOVE_S;
                const t = Math.min(1, c.moveT);
                n.node.setPosition(c.fromX + (c.toX - c.fromX) * t, c.fromY + (c.toY - c.fromY) * t, 0);
                if (t >= 1) {
                    c.moving = false;
                    n.gx = c.targetGx; n.gy = c.targetGy; n.slot = c.targetSlot;
                    c.visited.add(key(n.gx, n.gy));
                }
                continue;
            }

            const desired = n.state === 'waiting' ? TILE_ATTR_QUEUE
                : n.state === 'leaving' ? TILE_ATTR_EXIT : 0;
            if (desired === 0) continue; // wants-food/satisfied: 제자리 대기

            const nx = this.findNext(c, desired);
            if (nx === 'end') {
                if (n.state === 'waiting') n.state = 'wants-food'; // 줄 끝 — 요리 대기
                else this.deactivate(c);                           // 퇴장 완료
                continue;
            }
            if (nx === 'blocked') continue; // 앞이 꽉 참 — 대기(줄서기)

            c.targetGx = nx.gx; c.targetGy = nx.gy; c.targetSlot = nx.slot;
            c.fromX = n.node.position.x; c.fromY = n.node.position.y;
            const off = SLOT_OFF[nx.slot];
            c.toX = isoX(nx.gx, nx.gy) + off[0];
            c.toY = isoY(nx.gx, nx.gy) + off[1];
            c.moving = true; c.moveT = 0;
        }
    }

    private giveUp(c: Cust) {
        c.npc.state = 'leaving'; // 포기 — 퇴장 이동 시작 (가까운 퇴장 타일로)
        c.moving = false;
    }

    /** 4방향 중 원하는 속성·미방문 타일의 빈 슬롯 — 없으면 'blocked'(대기)/'end'(경로 끝) */
    private findNext(c: Cust, desired: number): { gx: number; gy: number; slot: number } | 'blocked' | 'end' {
        const n = c.npc;
        let anyTile = false;
        for (const [dx, dy] of DIRS) {
            const gx = n.gx + dx, gy = n.gy + dy;
            if (c.visited.has(key(gx, gy))) continue;
            if (this.host.tileAttrAt(gx, gy) !== desired) continue;
            anyTile = true;
            for (const slot of [0, 1]) {
                if (!this.slotOccupied(gx, gy, slot, c)) return { gx, gy, slot };
            }
        }
        return anyTile ? 'blocked' : 'end';
    }

    /** (gx,gy,slot)를 다른 손님이 점유(정지) 중이거나 그리로 이동 중인가 */
    private slotOccupied(gx: number, gy: number, slot: number, self: Cust | null): boolean {
        for (const o of this.custs) {
            if (o === self || !o.active) continue;
            if (o.npc.gx === gx && o.npc.gy === gy && o.npc.slot === slot) return true;
            if (o.moving && o.targetGx === gx && o.targetGy === gy && o.targetSlot === slot) return true;
        }
        return false;
    }

    private placeAt(c: Cust) {
        const off = SLOT_OFF[c.npc.slot];
        c.npc.node.setPosition(isoX(c.npc.gx, c.npc.gy) + off[0], isoY(c.npc.gx, c.npc.gy) + off[1], 0);
    }

    private deactivate(c: Cust) {
        c.active = false;
        c.npc.state = 'done';
        c.npc.node.active = false;
    }

    private refreshMood(c: Cust) {
        if (c.mood === c.lastMood) return;
        c.lastMood = c.mood;
        const f = this.host.moodFrame(c.mood);
        if (f) { c.moodSprite.spriteFrame = f; c.moodNode.active = true; }
        else c.moodNode.active = false;
    }

    private setBodySize(c: Cust, w: number, h: number) {
        c.body.node.getComponent(UITransform)?.setContentSize(w, h);
        c.body.node.setPosition(0, h / 2, 0);
    }

    /** 새 손님 노드 생성 (그림자 + 외형 + 기분 이모티콘) */
    private create(): Cust {
        const cp = this.host.charPx;
        const node = this.host.makeNode('Customer', this.host.entities);
        this.host.addSprite('Shadow', node, this.host.diamond(), TILE_W * 0.5, TILE_H * 0.5, this.host.color('#000000', 90))
            .setPosition(0, 0, 0);
        const bodyNode = this.host.addSprite('Body', node, this.host.square(), cp * 0.6, cp * 0.8, this.host.color('#3BAF6E'));
        bodyNode.setPosition(0, cp * 0.4, 0);
        const moodNode = this.host.addSprite('Mood', node, this.host.square(), 40, 40, this.host.color('#FFFFFF'));
        moodNode.setPosition(0, cp + 30, 0);

        const npc: TriggerNpc = {
            def: { kind: 'customer', img: 0, gx: 0, gy: 0 },
            node, gx: 0, gy: 0, slot: 0, spawnId: 0,
            state: 'done', served: false, paid: false,
        };
        this.shared.push(npc);
        const c: Cust = {
            npc, body: bodyNode.getComponent(Sprite)!,
            moodNode, moodSprite: moodNode.getComponent(Sprite)!,
            active: false, visited: new Set(), moving: false, moveT: 0,
            fromX: 0, fromY: 0, toX: 0, toY: 0, targetGx: 0, targetGy: 0, targetSlot: 0,
            temperament: 0, patienceMax: 10, patience: 10, patienceTimer: 0,
            mood: NORMAL, lastMood: -1, prevState: 'done',
        };
        node.active = false;
        this.custs.push(c);
        return c;
    }
}
