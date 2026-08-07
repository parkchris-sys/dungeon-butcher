import { Node, Sprite, SpriteFrame, Color, instantiate } from 'cc';
import { isoX, isoY, TILE_W, TILE_H } from './Projection';
import { TILE_ATTR_QUEUE, TILE_ATTR_EXIT } from './MapData';
import { TriggerNpc } from './TriggerSystem';

/**
 * 손님 NPC 시스템 — 스폰(스폰 트리거 요청) · 이동(대기열/퇴장) · 참을성/기분/성향.
 *
 * 스폰은 **에디터에 배치해둔 손님 NPC(템플릿)를 복제(instantiate)** 해서 만든다.
 * 스폰 트리거의 npcImg가 복제할 템플릿을 고른다(img 일치 / 0이면 임의). 풀로 재사용.
 *
 * 흐름: 스폰 → 대기열(attr=2) 따라 이동(waiting) → 줄 끝에서 요리 대기(wants-food)
 *       → 판매대가 요리 주면 만족(satisfied·기분 행복) → 정산대가 돈 회수하면 퇴장(leaving)
 *       → 퇴장(attr=3) 따라 이동 → 끝나면 비활성(done, 풀 재사용).
 * 타일당 1명: 한 칸에 한 명만 점유(슬롯 하나).
 * 참을성/기분/성향(전부 임의): 성향 10/30/9999, 10초마다 1↓·0이면 기분↓+리셋, 화남 소진 시 포기→퇴장.
 */

const MOVE_S = 0.25;
const PATIENCE_TICK_S = 10;
const TEMPER_PATIENCE = [10, 30, 9999]; // 급함/느긋함/시간무한 — (임의)

const ANGRY = 0, BORED = 1, NORMAL = 2, HAPPY = 3;
// 타일당 1명 — 슬롯 하나(타일 중심)
const SLOT_OFF: [number, number][] = [[0, 0]];

export interface NpcTemplate { node: Node; img: number; kind: string; }

export interface CustomerHost {
    entities: Node;
    tileAttrAt(gx: number, gy: number): number;
    makeNode(name: string, parent: Node): Node;
    addSprite(name: string, parent: Node, frame: SpriteFrame, w: number, h: number, color: Color): Node;
    square(): SpriteFrame;
    diamond(): SpriteFrame;
    color(hex: string, alpha?: number): Color;
    moodFrame(mood: number): SpriteFrame | null;
    charPx: number;
}

interface Cust {
    npc: TriggerNpc;
    moodNode: Node;
    moodSprite: Sprite;
    templateKey: number; // 복제 출처 템플릿 img (-1=제네릭) — 풀 재사용 키
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
const cellKey = (gx: number, gy: number) => `${gx},${gy}`;

export class CustomerSystem {
    private readonly custs: Cust[] = [];
    private nextSpawnId = 0;

    constructor(
        private readonly host: CustomerHost,
        private readonly shared: TriggerNpc[],
        private readonly templates: NpcTemplate[],
    ) {}

    /** 스폰 트리거 요청 — (gx,gy) 타일 빈 슬롯에 손님 1명. 템플릿 복제(없으면 제네릭), spawnId 부여 */
    spawn(gx: number, gy: number, img: number) {
        const slot = this.slotOccupied(gx, gy, 0, null) ? -1 : 0;
        if (slot < 0) return; // 스폰 지점 타일이 이미 참 — 이번 주기 건너뜀

        const tmpl = this.pickTemplate(img);
        const tkey = tmpl ? tmpl.img : -1;
        const c = this.custs.find(x => !x.active && x.templateKey === tkey) ?? this.build(tmpl, tkey);
        const n = c.npc;
        n.spawnId = ++this.nextSpawnId;
        n.gx = gx; n.gy = gy; n.slot = slot;
        n.served = false; n.paid = false;
        n.state = this.host.tileAttrAt(gx, gy) === TILE_ATTR_QUEUE ? 'waiting' : 'wants-food';

        c.active = true;
        c.visited.clear();
        c.visited.add(cellKey(gx, gy));
        c.moving = false; c.moveT = 0;
        c.temperament = Math.floor(Math.random() * 3);
        c.patienceMax = TEMPER_PATIENCE[c.temperament];
        c.patience = c.patienceMax;
        c.patienceTimer = 0;
        c.mood = NORMAL;
        c.lastMood = -1;
        c.prevState = n.state;

        n.node.active = true;
        this.placeAt(c);
        this.refreshMood(c);
    }

    /** npcImg에 맞는 템플릿 — img 일치 우선, 없으면 임의. 템플릿이 없으면 null(제네릭) */
    private pickTemplate(img: number): NpcTemplate | null {
        if (this.templates.length === 0) return null;
        if (img > 0) {
            const m = this.templates.find(t => t.img === img);
            if (m) return m;
        }
        return this.templates[Math.floor(Math.random() * this.templates.length)];
    }

    /** 손님 노드 생성 — 템플릿이 있으면 복제, 없으면 제네릭 초록 박스. 기분 이모티콘 부착. */
    private build(tmpl: NpcTemplate | null, tkey: number): Cust {
        const cp = this.host.charPx;
        let node: Node;
        if (tmpl) {
            node = instantiate(tmpl.node) as Node;
            node.name = `customer_${tmpl.kind}`;
            this.host.entities.addChild(node);
        } else {
            node = this.host.makeNode('Customer', this.host.entities);
            this.host.addSprite('Shadow', node, this.host.diamond(), TILE_W * 0.5, TILE_H * 0.5, this.host.color('#000000', 90))
                .setPosition(0, 0, 0);
            const body = this.host.addSprite('Body', node, this.host.square(), cp * 0.6, cp * 0.8, this.host.color('#3BAF6E'));
            body.setPosition(0, cp * 0.4, 0);
        }
        const moodNode = this.host.addSprite('Mood', node, this.host.square(), 40, 40, this.host.color('#FFFFFF'));
        moodNode.setPosition(0, cp + 30, 0);

        const npc: TriggerNpc = {
            def: { kind: 'customer', img: tkey > 0 ? tkey : 0, gx: 0, gy: 0 },
            node, gx: 0, gy: 0, slot: 0, spawnId: 0,
            state: 'done', served: false, paid: false,
        };
        this.shared.push(npc);
        const c: Cust = {
            npc, moodNode, moodSprite: moodNode.getComponent(Sprite)!, templateKey: tkey,
            active: false, visited: new Set(), moving: false, moveT: 0,
            fromX: 0, fromY: 0, toX: 0, toY: 0, targetGx: 0, targetGy: 0, targetSlot: 0,
            temperament: 0, patienceMax: 10, patience: 10, patienceTimer: 0,
            mood: NORMAL, lastMood: -1, prevState: 'done',
        };
        node.active = false;
        this.custs.push(c);
        return c;
    }

    update(dt: number) {
        for (const c of this.custs) {
            if (!c.active) continue;
            const n = c.npc;

            if (n.state === 'satisfied' && c.prevState !== 'satisfied') c.mood = HAPPY;
            // 판매 즉시 결제(결정 2026-08-07)라 만족한 손님은 곧바로 퇴장한다.
            // 행복 이모티콘을 한 프레임 보여준 뒤 넘기려고 prevState 갱신 후에 전환한다.
            else if (n.state === 'satisfied' && n.paid) n.state = 'leaving';
            c.prevState = n.state;

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
                    c.visited.add(cellKey(n.gx, n.gy));
                }
                continue;
            }

            const desired = n.state === 'waiting' ? TILE_ATTR_QUEUE
                : n.state === 'leaving' ? TILE_ATTR_EXIT : 0;
            if (desired === 0) continue;

            const nx = this.findNext(c, desired);
            if (nx === 'end') {
                if (n.state === 'waiting') n.state = 'wants-food';
                else this.deactivate(c);
                continue;
            }
            if (nx === 'blocked') continue;

            c.targetGx = nx.gx; c.targetGy = nx.gy; c.targetSlot = nx.slot;
            c.fromX = n.node.position.x; c.fromY = n.node.position.y;
            const off = SLOT_OFF[nx.slot];
            c.toX = isoX(nx.gx, nx.gy) + off[0];
            c.toY = isoY(nx.gx, nx.gy) + off[1];
            c.moving = true; c.moveT = 0;
        }
    }

    private giveUp(c: Cust) {
        c.npc.state = 'leaving';
        c.moving = false;
    }

    private findNext(c: Cust, desired: number): { gx: number; gy: number; slot: number } | 'blocked' | 'end' {
        const n = c.npc;
        let anyTile = false;
        for (const [dx, dy] of DIRS) {
            const gx = n.gx + dx, gy = n.gy + dy;
            if (c.visited.has(cellKey(gx, gy))) continue;
            if (this.host.tileAttrAt(gx, gy) !== desired) continue;
            anyTile = true;
            if (!this.slotOccupied(gx, gy, 0, c)) return { gx, gy, slot: 0 };
        }
        return anyTile ? 'blocked' : 'end';
    }

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
}
