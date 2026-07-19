import { Node, Sprite, SpriteFrame, Color, Label } from 'cc';
import { isoX, isoY } from './Projection';

/**
 * 던전 코어: 웨이브 스폰 → 자동 근접공격 → 고기 드랍/픽업 → 등 뒤 스택★ (PHASE1 §3).
 * 순수 로직 클래스 — 부트스트랩이 host 파사드로 노드 생성/월드 상태를 제공한다.
 * 슬라임/고기 노드는 풀링으로 재사용 (물량전 GC 방지).
 */

/** 밸런스 — BALANCE.md "Phase 1 임시 밸런스 v0.2 (2026-07-10)"의 복사본. 원본은 문서. */
const BAL = {
    wave: { maxAlive: 18, batchMin: 3, batchMax: 4, intervalS: 2.0, rMin: 8, rMax: 11 },
    slime: { hp: 2, speed: 1.3, contactR: 0.55, atk: 1, separationR: 0.9 }, // separationR: 몹끼리 최소 간격(타일, 임의)
    player: { maxHp: 10, invulnS: 0.6, hubRegen: 2 },      // invuln: 캐릭터 기준 전체 공유(확정), hubRegen: 마을 HP/s
    attack: { intervalS: 0.45, range: 1.8, knockback: 0.7 },
    meat: { dropChance: 0.6, dropMax: 2, pickupR: 0.9, flyS: 0.18, maxGround: 40 },
    stack: { limit: 10, pieceH: 15, swayAmp: 4, swaySpeed: 3 },
};

/**
 * 던전별 스폰 몬스터 종류 — 던전 ID(1부터) → 종류 목록 (임의 — 기획 표 확정 시 BALANCE로 이관).
 * 미지정 던전은 DEFAULT_KINDS. 현재 구현된 종류는 slime뿐이라 구조만 준비됨.
 */
const DUNGEON_KINDS: Record<number, string[]> = {
    // 예: 1: ['slime'], 2: ['slime', 'goblin'],
};
const DEFAULT_KINDS = ['slime'];

export interface CombatUi {
    makeNode(name: string, parent: Node): Node;
    addSprite(name: string, parent: Node, frame: SpriteFrame, w: number, h: number, color: Color): Node;
    square(): SpriteFrame;
    diamond(): SpriteFrame;
    color(hex: string, alpha?: number): Color;
}

/** 몬스터가 진입 가능한 존인가 — 마을·통로는 불가침 (통로 규칙은 임의, 기획 확정 대상) */
function monsterPassable(kind: 'hub' | 'dungeon' | 'corridor' | null): boolean {
    return kind !== 'hub' && kind !== 'corridor';
}

export interface CombatHost {
    entities: Node;
    playerNode(): Node;
    playerG(): { gx: number; gy: number };
    facing(): 'left' | 'right';
    inDungeon(): boolean;
    inHub(): boolean;
    zoneKindAt(gx: number, gy: number): 'hub' | 'dungeon' | 'corridor' | null;
    dungeonIdAt(gx: number, gy: number): number;  // 던전 인스턴스 ID (0=던전 아님)
    playerDungeonId(): number;
    /** 던전별 스폰 종류 — 맵 에디터 몬스터 배치에서 파생 (null=미지정 → 코드 표/기본값) */
    dungeonKindsOf(dungeonId: number): string[] | null;
    hitsWall(gx: number, gy: number): boolean;
    groundR(): number;
    ui: CombatUi;
    onMeatCount(count: number, limit: number): void;
    onHp(hp: number, max: number): void;
    onPlayerHit(): void;
    onPlayerDeath(): void;
}

interface Slime {
    node: Node;
    body: Sprite;
    gx: number; gy: number;
    homeGx: number; homeGy: number; // 스폰 위치 — 관심 끊으면 여기로 복귀
    dungeonId: number;              // 소속 던전 — 다른 던전으로는 이동·추적 불가
    kind: string;                   // 몬스터 종류 (던전별 설정 — 현재 slime만 구현)
    hp: number;
    flashT: number;   // 피격 플래시 남은 시간
    dieT: number;     // 0보다 크면 사망 연출 중
    alive: boolean;
}

interface Meat {
    node: Node;
    gx: number; gy: number;
    flying: boolean;  // 픽업돼 플레이어에게 날아가는 중
    t: number;
    sx: number; sy: number; // 비행 시작 화면좌표
}

export class CombatSystem {
    private host: CombatHost;
    private time = 0;
    private spawnTimer = 0;
    private attackTimer = 0;

    private slimes: Slime[] = [];
    private slimePool: Slime[] = [];
    private meats: Meat[] = [];
    private meatPool: Meat[] = [];

    private slashNode: Node | null = null;
    private slashT = 0;

    private stackRoot: Node;
    private stackPieces: Node[] = [];
    private meatCount = 0;
    private fullLabel: Node | null = null;
    private fullT = 0;

    private hp = BAL.player.maxHp;
    private invulnT = 0;

    constructor(host: CombatHost) {
        this.host = host;
        // 등 뒤 스택 루트 — 플레이어 자식이라 이동을 따라감
        this.stackRoot = host.ui.makeNode('BackStack', host.playerNode());
        host.onMeatCount(0, BAL.stack.limit);
        host.onHp(this.hp, BAL.player.maxHp);
    }

    /** 던전별 스폰 종류 — 우선순위: 에디터 몬스터 배치 > 코드 표(DUNGEON_KINDS) > 기본값 */
    private pickKind(dungeonId: number): string {
        const kinds = this.host.dungeonKindsOf(dungeonId)
            ?? DUNGEON_KINDS[dungeonId] ?? DEFAULT_KINDS;
        return kinds[Math.floor(Math.random() * kinds.length)];
    }

    /** 활성 개체 존재 여부 — 부트스트랩이 매 프레임 정렬할지 판단용 */
    hasActive(): boolean {
        return this.slimes.length > 0 || this.meats.length > 0;
    }

    update(dt: number) {
        this.time += dt;
        this.updateSpawn(dt);
        this.updateSlimes(dt);
        this.separateSlimes();
        this.updateAttack(dt);
        this.updateMeat(dt);
        this.updateStack(dt);
        this.updateRegen(dt);
        if (this.slashNode && (this.slashT -= dt) <= 0) this.slashNode.active = false;
        if (this.fullLabel && (this.fullT -= dt) <= 0) this.fullLabel.active = false;
    }

    // ── 웨이브 스폰 (규칙 TBD 기획 — 임시: 던전 안에서 주기 스폰) ──
    private updateSpawn(dt: number) {
        this.spawnTimer -= dt;
        const pid = this.host.playerDungeonId();
        if (pid === 0 || this.spawnTimer > 0) return; // 던전 안일 때만
        this.spawnTimer = BAL.wave.intervalS;

        const alive = this.slimes.filter(s => s.alive).length;
        const batch = Math.min(
            BAL.wave.batchMin + Math.floor(Math.random() * (BAL.wave.batchMax - BAL.wave.batchMin + 1)),
            BAL.wave.maxAlive - alive);
        const p = this.host.playerG();
        const R = this.host.groundR();
        for (let i = 0; i < batch; i++) {
            const ang = Math.random() * Math.PI * 2;
            const dist = BAL.wave.rMin + Math.random() * (BAL.wave.rMax - BAL.wave.rMin);
            const gx = Math.max(-R, Math.min(R, p.gx + Math.cos(ang) * dist));
            const gy = Math.max(-R, Math.min(R, p.gy + Math.sin(ang) * dist));
            if (this.host.hitsWall(gx, gy)) continue;
            if (this.host.dungeonIdAt(gx, gy) !== pid) continue; // 플레이어와 같은 던전 안에서만
            this.spawnSlime(gx, gy);
        }
    }

    private spawnSlime(gx: number, gy: number) {
        let s = this.slimePool.pop();
        if (!s) {
            const ui = this.host.ui;
            const node = ui.makeNode('Slime', this.host.entities);
            const shadow = ui.addSprite('Shadow', node, ui.diamond(), 52, 24, ui.color('#000000', 70));
            shadow.setPosition(0, 0, 0);
            const bodyNode = ui.addSprite('Body', node, ui.square(), 64, 46, ui.color('#3B7A54'));
            bodyNode.setPosition(0, 24, 0);
            ui.addSprite('EyeL', bodyNode, ui.square(), 8, 11, ui.color('#F7EFD8')).setPosition(-13, 4, 0);
            ui.addSprite('EyeR', bodyNode, ui.square(), 8, 11, ui.color('#F7EFD8')).setPosition(13, 4, 0);
            s = {
                node, body: bodyNode.getComponent(Sprite)!, gx, gy,
                homeGx: gx, homeGy: gy, dungeonId: 0, kind: 'slime',
                hp: BAL.slime.hp, flashT: 0, dieT: 0, alive: true,
            };
        }
        s.gx = gx; s.gy = gy;
        s.homeGx = gx; s.homeGy = gy;
        s.dungeonId = this.host.dungeonIdAt(gx, gy);
        s.kind = this.pickKind(s.dungeonId); // 던전별 스폰 종류 (현재 slime만 — 종류별 외형/스탯은 추후)
        s.hp = BAL.slime.hp;
        s.flashT = 0; s.dieT = 0; s.alive = true;
        s.node.active = true;
        s.node.setScale(1, 1, 1);
        s.body.color = this.host.ui.color('#3B7A54');
        s.node.setPosition(isoX(gx, gy), isoY(gx, gy), 0);
        this.slimes.push(s);
    }

    // ── 슬라임 이동(추적/복귀)·피격 연출·접촉 데미지·사망 ──
    private updateSlimes(dt: number) {
        const p = this.host.playerG();
        const pid = this.host.playerDungeonId(); // 0=던전 밖
        if (this.invulnT > 0) this.invulnT -= dt;

        for (const s of this.slimes) {
            if (s.dieT > 0) {
                s.dieT += dt;
                const t = s.dieT / 0.15;
                s.node.setScale(1 + t * 0.6, 1 - t * 0.5, 1); // 납작하게 팝
                if (t >= 1) this.releaseSlime(s);
                continue;
            }
            if (s.flashT > 0 && (s.flashT -= dt) <= 0) {
                s.body.color = this.host.ui.color('#3B7A54');
            }

            // 추적 = 플레이어가 "이 몬스터의 던전"에 있을 때만 — 마을·통로·다른 던전이면 복귀
            const chasing = pid === s.dungeonId;
            const tx = chasing ? p.gx : s.homeGx;
            const ty = chasing ? p.gy : s.homeGy;
            const dx = tx - s.gx, dy = ty - s.gy;
            const dist = Math.hypot(dx, dy);
            const stopAt = chasing ? BAL.slime.contactR : 0.05;
            if (dist > stopAt) {
                const step = (BAL.slime.speed * dt) / dist;
                const nx = s.gx + dx * step, ny = s.gy + dy * step;
                // 축 분리(벽 따라 미끄러짐) + 마을·통로·다른 던전 진입 금지
                if (this.canStand(s, nx, s.gy)) s.gx = nx;
                if (this.canStand(s, s.gx, ny)) s.gy = ny;
                // 통통 튀는 물량전 느낌: 이동 중 살짝 스쿼시
                const bounce = Math.abs(Math.sin(this.time * 8 + s.gx * 3));
                s.node.setScale(1 + bounce * 0.06, 1 - bounce * 0.08, 1);
            }
            s.node.setPosition(isoX(s.gx, s.gy), isoY(s.gx, s.gy), 0);

            // 접촉 데미지 (추적 중일 때만, 무적시간으로 틱 제한)
            if (chasing && this.invulnT <= 0) {
                const pd = Math.hypot(s.gx - p.gx, s.gy - p.gy);
                if (pd <= BAL.slime.contactR + 0.15) this.hurtPlayer(BAL.slime.atk);
            }
        }
        this.slimes = this.slimes.filter(s => s.alive);
    }

    /** 몬스터가 (gx,gy)에 설 수 있는가 — 벽/존 규칙 + 소속 던전 안에서만 */
    private canStand(s: Slime, gx: number, gy: number): boolean {
        return !this.host.hitsWall(gx, gy) &&
            monsterPassable(this.host.zoneKindAt(gx, gy)) &&
            this.host.dungeonIdAt(gx, gy) === s.dungeonId;
    }

    // ── 플레이어 피격/죽음 (PHASE1 §3: 죽으면 런 획득물 손실, 마을 부활) ──
    private hurtPlayer(dmg: number) {
        this.invulnT = BAL.player.invulnS;
        this.hp -= dmg;
        this.host.onHp(Math.max(0, this.hp), BAL.player.maxHp);
        this.host.onPlayerHit();
        if (this.hp <= 0) {
            this.clearStack();          // 런에서 얻은 고기 전부 손실
            this.hp = BAL.player.maxHp; // HP 가득 채워 부활
            this.host.onHp(this.hp, BAL.player.maxHp);
            this.host.onPlayerDeath();  // 부트스트랩이 마을 스폰으로 이동 처리
        }
    }

    /** 마을 회복 +2 HP/s (BALANCE v0.2 — 만충까지 5초, 마을 복귀 동기) */
    private updateRegen(dt: number) {
        if (!this.host.inHub() || this.hp >= BAL.player.maxHp) return;
        this.hp = Math.min(BAL.player.maxHp, this.hp + BAL.player.hubRegen * dt);
        this.host.onHp(this.hp, BAL.player.maxHp);
    }

    private clearStack() {
        for (const piece of this.stackPieces) piece.destroy();
        this.stackPieces = [];
        this.meatCount = 0;
        this.host.onMeatCount(0, BAL.stack.limit);
    }

    /** 몹끼리 겹침 방지 — 쌍별 밀어내기 (최대 18마리, O(n²) 충분) */
    private separateSlimes() {
        const minD = BAL.slime.separationR;
        const list = this.slimes;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (a.dieT > 0) continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (b.dieT > 0) continue;
                let dx = b.gx - a.gx, dy = b.gy - a.gy;
                let d = Math.hypot(dx, dy);
                if (d >= minD) continue;
                if (d < 0.0001) { // 완전 겹침 — 결정적 방향으로 벌림
                    const ang = (i * 2.399 + j) % (Math.PI * 2);
                    dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
                }
                const push = (minD - d) / 2;
                const nx = (dx / d) * push, ny = (dy / d) * push;
                // 벽·타 존·다른 던전으로 밀려 들어가지 않게 각자 검사
                if (this.canStand(a, a.gx - nx, a.gy - ny)) {
                    a.gx -= nx; a.gy -= ny;
                }
                if (this.canStand(b, b.gx + nx, b.gy + ny)) {
                    b.gx += nx; b.gy += ny;
                }
            }
        }
        for (const s of list) {
            if (s.dieT > 0) continue;
            s.node.setPosition(isoX(s.gx, s.gy), isoY(s.gx, s.gy), 0);
        }
    }

    private releaseSlime(s: Slime) {
        s.alive = false;
        s.node.active = false;
        this.slimePool.push(s);
    }

    // ── 자동 근접공격 (핵앤슬래시 — 범위 내 전원 타격 + 넉백) ──
    private updateAttack(dt: number) {
        this.attackTimer -= dt;
        if (this.attackTimer > 0) return;
        const p = this.host.playerG();
        let nearest: Slime | null = null;
        let nearestD = Infinity;
        for (const s of this.slimes) {
            if (s.dieT > 0) continue;
            const d = Math.hypot(s.gx - p.gx, s.gy - p.gy);
            if (d < nearestD) { nearestD = d; nearest = s; }
        }
        if (!nearest || nearestD > BAL.attack.range) return;

        this.attackTimer = BAL.attack.intervalS;
        this.showSlash(p, nearest);

        // 단일 타겟 — 제일 가까운 적 하나만 타격 (2026-07-10 결정)
        const s = nearest;
        const dx = s.gx - p.gx, dy = s.gy - p.gy;
        const d = Math.max(Math.hypot(dx, dy), 0.001);
        s.hp -= 1;
        s.flashT = 0.09;
        s.body.color = this.host.ui.color('#FFFFFF');
        // 넉백 (벽 통과 방지)
        const k = BAL.attack.knockback / d;
        const nx = s.gx + dx * k, ny = s.gy + dy * k;
        if (!this.host.hitsWall(nx, s.gy)) s.gx = nx;
        if (!this.host.hitsWall(s.gx, ny)) s.gy = ny;
        if (s.hp <= 0) {
            s.dieT = 0.001;
            this.dropMeat(s.gx, s.gy);
        }
    }

    private showSlash(p: { gx: number; gy: number }, target: Slime) {
        if (!this.slashNode) {
            const ui = this.host.ui;
            this.slashNode = ui.addSprite('Slash', this.host.entities, ui.square(), 96, 12, ui.color('#F7EFD8', 230));
        }
        const px = isoX(p.gx, p.gy), py = isoY(p.gx, p.gy) + 40;
        const tx = isoX(target.gx, target.gy), ty = isoY(target.gx, target.gy) + 20;
        this.slashNode.active = true;
        this.slashNode.setPosition((px + tx) / 2, (py + ty) / 2, 0);
        this.slashNode.angle = Math.atan2(ty - py, tx - px) * 180 / Math.PI;
        this.slashT = 0.1;
    }

    // ── 고기 드랍 & 픽업 ──
    private dropMeat(gx: number, gy: number) {
        if (Math.random() > BAL.meat.dropChance) return;
        const count = 1 + Math.floor(Math.random() * BAL.meat.dropMax);
        for (let i = 0; i < count; i++) {
            if (this.meats.length >= BAL.meat.maxGround) return;
            let m = this.meatPool.pop();
            if (!m) {
                const ui = this.host.ui;
                const node = ui.makeNode('Meat', this.host.entities);
                const piece = ui.addSprite('Piece', node, ui.square(), 34, 24, ui.color('#C0503F'));
                piece.setPosition(0, 10, 0);
                ui.addSprite('Fat', piece, ui.square(), 34, 7, ui.color('#F7EFD8', 220)).setPosition(0, 9, 0);
                m = { node, gx, gy, flying: false, t: 0, sx: 0, sy: 0 };
            }
            m.gx = gx + (Math.random() - 0.5) * 1.2;
            m.gy = gy + (Math.random() - 0.5) * 1.2;
            m.flying = false; m.t = 0;
            m.node.active = true;
            m.node.setPosition(isoX(m.gx, m.gy), isoY(m.gx, m.gy), 0);
            this.meats.push(m);
        }
    }

    private updateMeat(dt: number) {
        const p = this.host.playerG();
        const playerNode = this.host.playerNode();
        for (const m of this.meats) {
            if (m.flying) {
                m.t += dt / BAL.meat.flyS;
                const t = Math.min(1, m.t);
                const px = playerNode.position.x, py = playerNode.position.y + 40;
                m.node.setPosition(
                    m.sx + (px - m.sx) * t,
                    m.sy + (py - m.sy) * t + Math.sin(t * Math.PI) * 30, // 포물선 느낌
                    0);
                if (t >= 1) {
                    this.releaseMeat(m);
                    this.addToStack();
                }
                continue;
            }
            const d = Math.hypot(m.gx - p.gx, m.gy - p.gy);
            if (d <= BAL.meat.pickupR) {
                if (this.meatCount >= BAL.stack.limit) {
                    this.showFull(); // 가득참 — 더 안 주움 (PHASE1 §3)
                } else {
                    m.flying = true;
                    m.t = 0;
                    m.sx = m.node.position.x;
                    m.sy = m.node.position.y;
                }
            }
        }
        this.meats = this.meats.filter(m => m.node.active);
    }

    private releaseMeat(m: Meat) {
        m.node.active = false;
        this.meatPool.push(m);
    }

    // ── 등 뒤 스택 ★ (1~10 개별 조각 + 관성 흔들림) ──
    private addToStack() {
        this.meatCount += 1;
        this.host.onMeatCount(this.meatCount, BAL.stack.limit);
        const ui = this.host.ui;
        const i = this.stackPieces.length;
        const piece = ui.addSprite(`StackMeat_${i}`, this.stackRoot, ui.square(), 38, BAL.stack.pieceH - 2,
            ui.color(i % 2 === 0 ? '#C0503F' : '#8C3A2E'));
        this.stackPieces.push(piece);
    }

    private updateStack(dt: number) {
        // 등판 위치 = 바라보는 방향의 반대쪽
        const back = this.host.facing() === 'right' ? -20 : 20;
        this.stackRoot.setPosition(back, 66, 0);
        for (let i = 0; i < this.stackPieces.length; i++) {
            // 위로 갈수록 크게 흔들림(관성) — BIBLE §3
            const sway = Math.sin(this.time * BAL.stack.swaySpeed + i * 0.5)
                * BAL.stack.swayAmp * (i + 1) / BAL.stack.limit;
            this.stackPieces[i].setPosition(sway, i * BAL.stack.pieceH, 0);
        }
    }

    private showFull() {
        if (!this.fullLabel) {
            const node = this.host.ui.makeNode('FullLabel', this.host.playerNode());
            const lb = node.addComponent(Label);
            lb.string = '가득참!';
            lb.fontSize = 36;
            lb.isBold = true;
            lb.color = this.host.ui.color('#F0B429');
            node.setPosition(0, 170, 0);
            this.fullLabel = node;
        }
        if (this.fullT <= 0) {
            this.fullLabel.active = true;
            this.fullT = 0.8;
        }
    }
}
