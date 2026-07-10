import {
    _decorator, Component, Node, Sprite, SpriteFrame, Texture2D, ImageAsset,
    UITransform, Color, Layers, input, Input, EventKeyboard, KeyCode, math,
    director, Canvas, Camera, DirectionalLight, view, ResolutionPolicy, Label, Widget,
    resources, JsonAsset, Graphics, Vec2, Vec3, EventTouch, UIOpacity, Mask,
} from 'cc';
import { TILE_W, TILE_H, isoX, isoY, screenToGrid } from './Projection';
import { MapData, ZoneDef, ZoneKind, DEV_MAP } from './MapData';
import { parseTiledMap } from './TiledLoader';
import { CombatSystem } from './CombatSystem';

const { ccclass, property } = _decorator;

/**
 * 인게임 뷰 프로토타입 — "느낌 확인용".
 * 아이소 검은 바닥 + 하얀 네모 캐릭터 + 카메라 팔로우를 코드로 생성한다.
 * 사용법: 씬 아무 곳에 빈 노드를 만들고 이 컴포넌트만 붙이면 끝 —
 *   디자인 해상도(1080x1920 FIXED_WIDTH)·Canvas·2D 카메라까지 코드가 직접 세팅하고,
 *   씬에 남아 있는 기본 3D 카메라/라이트는 자동으로 꺼 준다.
 * 이미지 에셋 0개 — 절차적 흰 프레임을 tint만 바꿔 재사용(전부 1 드로우콜로 배칭).
 */
@ccclass('IngameBootstrap')
export class IngameBootstrap extends Component {
    /**
     * 뷰 줌(월드 스케일) — 코드 값이 원본 (인스펙터 노출 금지: 씬에 저장된 옛 값이 덮어쓰는 사고 방지).
     * 1.5 = 팀 잠정 확정 (2026-07-10) — 웨이브(적 무리) 들어간 뒤 최종 확정 예정, 그때까지 −/＋ 패널 유지
     */
    private zoom = 1.5;

    @property({ tooltip: '기본 이동 속도(px/s, 화면 기준) — BALANCE v0.2: 500' })
    moveSpeed = 500;

    /** 무게 페널티 — BALANCE v0.2: 스택 1개당 -20px/s (만재 10개 = 300px/s) */
    private static readonly WEIGHT_PENALTY = 20;
    private carryCount = 0; // CombatSystem이 onMeatCount로 갱신

    @property({ tooltip: '카메라 팔로우 부드러움(클수록 빠름)' })
    followSmooth = 10;

    /** 맵 원천 — 디자이너 Tiled JSON(resources/maps/ingame_map) 우선, 없으면 DEV_MAP */
    private map: MapData = DEV_MAP;

    private world!: Node;
    private player!: Node;
    private entities!: Node;
    private ready = false; // 맵 로드 완료 전 update 가드
    /** 존별 바닥 패턴 텍스처 (resources/maps/tiles/floor_<kind>.png — 없으면 틴트 폴백) */
    private zoneFrames: Partial<Record<ZoneKind, SpriteFrame>> = {};
    /** 플레이어 스프라이트 (resources/chars/player_left·right.png — 없으면 흰 박스 폴백) */
    private playerFrames: { left?: SpriteFrame; right?: SpriteFrame } = {};
    private playerSprite: Sprite | null = null;
    private facing: 'left' | 'right' = 'right';
    private pressed = new Set<KeyCode>();
    private pgx = 0;  // 플레이어 그리드 좌표
    private pgy = 0;
    private currentZone: ZoneDef | null = null;

    // 터치 조이스틱 (플로팅 — 누른 자리가 중심)
    private static readonly JOY_RING_R = 220;   // 바깥 링 반지름 (감도 조절 이력: 110→220)
    private static readonly JOY_TRAVEL = 160;   // 노브 최대 이동 반경 — 클수록 감도 완만
    private static readonly JOY_DEADZONE = 20;
    private joystick: Node | null = null;
    private joyKnob: Node | null = null;
    private joyFade: UIOpacity | null = null; // active 토글 대신 투명도 — 네이티브에서 Graphics 렌더데이터 유지
    private touchOrigin = new Vec2();
    private touchDir = new Vec2();
    private touchMag = 0; // 아날로그 입력 세기 0~1 — 노브 변위 비례 (바깥 원 = 최고 속도)

    // 존 진입 배너
    private bannerLabel: Label | null = null;
    private bannerFade: UIOpacity | null = null;
    private bannerTimer = 0;

    // 현재 타일 하이라이트 (칸 단위 스냅)
    private tileCursor: Node | null = null;

    // 줌 조절 패널 (실기기 확정용 — 값 확정되면 제거)
    private zoomPanel: Node | null = null;
    private zoomLabel: Label | null = null;

    // 던전 코어 (웨이브·자동공격·고기·스택)
    private combat: CombatSystem | null = null;
    private meatHud: Label | null = null;
    private hpFill: Node | null = null;
    private playerFlashT = 0;

    onLoad() {
        const canvas = this.ensureCanvas();
        this.node.layer = Layers.Enum.UI_2D;
        if (this.node.parent !== canvas) {
            this.node.parent = canvas; // 컨텐츠를 Canvas 아래로 이동(어디에 붙였든 동작)
        }
        if (!this.node.getComponent(UITransform)) {
            this.node.addComponent(UITransform); // 터치 좌표 → 로컬 변환용
        }
        // 캔버스 전체를 채움 — 자식 HUD(줌 패널·배너)의 Widget 정렬 기준이 됨
        const rootWidget = this.node.getComponent(Widget) ?? this.node.addComponent(Widget);
        rootWidget.isAlignTop = rootWidget.isAlignBottom = true;
        rootWidget.isAlignLeft = rootWidget.isAlignRight = true;
        rootWidget.top = rootWidget.bottom = rootWidget.left = rootWidget.right = 0;
        rootWidget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;

        // 디자이너 맵(Tiled JSON) 우선 로드 — 실패 시 DEV_MAP 폴백
        resources.load('maps/ingame_map', JsonAsset, (err, asset) => {
            if (!err && asset) {
                const parsed = parseTiledMap(asset.json);
                if (parsed) {
                    this.map = parsed;
                } else {
                    console.warn('[IngameBootstrap] ingame_map.json 파싱 실패 — DEV_MAP 폴백');
                }
            } else {
                console.warn('[IngameBootstrap] resources/maps/ingame_map.json 없음 — DEV_MAP 폴백');
            }
            this.loadZoneTextures(() => this.buildWorld());
        });
    }

    /** 아트 텍스처 로드(바닥 패턴·플레이어) — 없는 것은 조용히 폴백 */
    private loadZoneTextures(done: () => void) {
        const jobs: [string, (f: SpriteFrame) => void][] = [
            ['maps/tiles/floor_hub',    f => { this.zoneFrames.hub = f; }],
            ['maps/tiles/floor_dungeon', f => { this.zoneFrames.dungeon = f; }],
            ['chars/player_left',        f => { this.playerFrames.left = f; }],
            ['chars/player_right',       f => { this.playerFrames.right = f; }],
        ];
        let pending = jobs.length;
        for (const [path, assign] of jobs) {
            resources.load(`${path}/texture`, Texture2D, (err, tex) => {
                if (!err && tex) {
                    const frame = new SpriteFrame();
                    frame.texture = tex;
                    frame.packable = false;
                    assign(frame);
                }
                if (--pending === 0) done();
            });
        }
    }

    private buildWorld() {
        this.world = this.makeNode('World', this.node);
        this.world.setScale(this.zoom, this.zoom, 1);

        this.buildBackground(this.world);
        this.buildGround(this.world);
        this.buildZones(this.world);
        this.buildWalls(this.world);

        // 현재 타일 하이라이트 (디자인 목업식 — 칸 단위 스냅, 생고기 레드 틴트)
        this.tileCursor = this.addSprite('TileCursor', this.world, this.diamondFrame(),
            TILE_W, TILE_H, this.color('#C0503F', 100));

        this.entities = this.makeNode('Entities', this.world);
        this.buildProps(this.entities);

        this.pgx = this.map.playerSpawn.gx;
        this.pgy = this.map.playerSpawn.gy;
        this.player = this.buildPlayer(this.entities);
        this.tileCursor!.setPosition(
            isoX(Math.round(this.pgx), Math.round(this.pgy)),
            isoY(Math.round(this.pgx), Math.round(this.pgy)), 0);

        this.buildZoneBanner();
        this.buildJoystick();
        this.buildZoomPanel();
        this.buildMeatHud();
        this.detectZone();
        this.sortEntities();

        this.combat = new CombatSystem({
            entities: this.entities,
            playerNode: () => this.player,
            playerG: () => ({ gx: this.pgx, gy: this.pgy }),
            facing: () => this.facing,
            inDungeon: () => this.currentZone?.kind === 'dungeon',
            inHub: () => this.currentZone?.kind === 'hub',
            zoneKindAt: (gx, gy) => this.zoneKindAt(gx, gy),
            hitsWall: (gx, gy) => this.hitsWall(gx, gy),
            groundR: () => this.map.groundRadius,
            ui: {
                makeNode: (n, p) => this.makeNode(n, p),
                addSprite: (n, p, f, w, h, c) => this.addSprite(n, p, f, w, h, c),
                square: () => this.squareFrame(),
                diamond: () => this.diamondFrame(),
                color: (hex, a) => this.color(hex, a),
            },
            onMeatCount: (n, max) => {
                this.carryCount = n; // 무게 페널티 반영
                if (this.meatHud) this.meatHud.string = `고기 ${n}/${max}`;
            },
            onHp: (hp, max) => this.setHpBar(hp, max),
            onPlayerHit: () => { this.playerFlashT = 0.15; },
            onPlayerDeath: () => this.respawnPlayer(),
        });
        this.ready = true;
    }

    /** 존 종류 판정 (좌표 기준) — 몬스터 이동 제약·스폰 위치 검사용 */
    private zoneKindAt(gx: number, gy: number): ZoneKind | null {
        for (const z of this.map.zones) {
            if (gx >= z.gx && gx <= z.gx + z.w && gy >= z.gy && gy <= z.gy + z.h) return z.kind;
        }
        return null;
    }

    /** 죽음 → 마을 스폰 부활 (런 획득물 손실은 CombatSystem이 처리) */
    private respawnPlayer() {
        this.pgx = this.map.playerSpawn.gx;
        this.pgy = this.map.playerSpawn.gy;
        this.player.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);
        if (this.tileCursor) {
            this.tileCursor.setPosition(
                isoX(Math.round(this.pgx), Math.round(this.pgy)),
                isoY(Math.round(this.pgx), Math.round(this.pgy)), 0);
        }
        this.detectZone();
        // 사망 안내 배너
        if (this.bannerLabel && this.bannerFade) {
            this.bannerLabel.string = '고기를 모두 잃었다…';
            this.bannerLabel.color = this.color('#C0503F');
            this.bannerFade.opacity = 255;
            this.bannerTimer = 2.2;
        }
    }

    /** 고기 카운터 + HP 바 HUD (좌상단) — PHASE1 §10 월드-인 최소 HUD */
    private buildMeatHud() {
        const hud = this.makeNode('MeatHud', this.node);
        const w = hud.addComponent(Widget);
        w.isAlignTop = true; w.top = 80;
        w.isAlignLeft = true; w.left = 40;
        this.meatHud = hud.addComponent(Label);
        this.meatHud.fontSize = 48;
        this.meatHud.isBold = true;
        this.meatHud.color = this.color('#F7EFD8');
        this.meatHud.horizontalAlign = Label.HorizontalAlign.LEFT;

        // HP 바 (고기 카운터 아래)
        const bar = this.makeNode('HpBar', this.node);
        const bw = bar.addComponent(Widget);
        bw.isAlignTop = true; bw.top = 150;
        bw.isAlignLeft = true; bw.left = 40;
        bar.addComponent(UITransform).setContentSize(300, 26);
        const bg = this.addSprite('Bg', bar, this.squareFrame(), 300, 26, this.color('#2A2230', 220));
        bg.setPosition(150, 0, 0); // 좌측 기준 정렬
        this.hpFill = this.addSprite('Fill', bar, this.squareFrame(), 292, 18, this.color('#C0503F'));
        this.setHpBar(1, 1);
    }

    private setHpBar(hp: number, max: number) {
        if (!this.hpFill) return;
        const w = Math.max(0, 292 * (hp / max));
        this.hpFill.getComponent(UITransform)!.setContentSize(w, 18);
        this.hpFill.setPosition(4 + w / 2, 0, 0); // 왼쪽부터 줄어드는 바
    }

    // ── 존 진입 배너 (화면 상단 중앙, 떴다가 페이드아웃) ──
    private buildZoneBanner() {
        const bn = this.makeNode('ZoneBanner', this.node);
        const w = bn.addComponent(Widget);
        w.isAlignTop = true; w.top = 260;
        w.isAlignHorizontalCenter = true;

        this.bannerLabel = bn.addComponent(Label);
        this.bannerLabel.fontSize = 72;
        this.bannerLabel.lineHeight = 84;
        this.bannerLabel.isBold = true;
        this.bannerFade = bn.addComponent(UIOpacity);
        this.bannerFade.opacity = 0;
    }

    private showZoneBanner(z: ZoneDef) {
        if (!this.bannerLabel || !this.bannerFade) return;
        this.bannerLabel.string = z.name;
        this.bannerLabel.color = this.color(z.kind === 'dungeon' ? '#B9A6F0' : '#F2A93B');
        this.bannerFade.opacity = 255;
        this.bannerTimer = 1.8;
    }

    // ── 줌 조절 패널 (우상단 −/＋ 버튼 + 현재값 — 실기기 확정용) ──
    private buildZoomPanel() {
        const panel = this.makeNode('ZoomPanel', this.node);
        this.zoomPanel = panel;
        const w = panel.addComponent(Widget);
        w.isAlignTop = true; w.top = 80;
        w.isAlignRight = true; w.right = 40;
        panel.addComponent(UITransform).setContentSize(340, 100);

        const makeButton = (txt: string, x: number, delta: number) => {
            const btn = this.addSprite(`zoom_btn_${txt}`, panel, this.squareFrame(),
                100, 100, this.color('#2A2230', 210));
            btn.setPosition(x, 0, 0);
            const lbNode = this.makeNode('Label', btn);
            const lb = lbNode.addComponent(Label);
            lb.string = txt;
            lb.fontSize = 60;
            lb.isBold = true;
            lb.color = this.color('#F7EFD8');
            btn.on(Node.EventType.TOUCH_START, () => {
                this.zoom = +math.clamp(this.zoom + delta, 0.8, 3.0).toFixed(1);
                this.refreshZoomLabel();
            });
        };
        makeButton('-', -120, -0.1);
        makeButton('+', 120, +0.1);

        const num = this.makeNode('ZoomValue', panel);
        this.zoomLabel = num.addComponent(Label);
        this.zoomLabel.fontSize = 44;
        this.zoomLabel.isBold = true;
        this.zoomLabel.color = this.color('#9FE870');
        this.refreshZoomLabel();
    }

    private refreshZoomLabel() {
        if (this.zoomLabel) this.zoomLabel.string = `x${this.zoom.toFixed(1)}`;
    }

    /** 줌 패널 위 터치인지 — 조이스틱 오작동 방지 */
    private isOnZoomPanel(p: Vec2): boolean {
        if (!this.zoomPanel) return false;
        const pos = this.zoomPanel.position;
        return Math.abs(p.x - pos.x) <= 200 && Math.abs(p.y - pos.y) <= 80;
    }

    // ── 터치 조이스틱 비주얼 (누른 자리에 링+노브) ──
    private buildJoystick() {
        this.joystick = this.makeNode('Joystick', this.node);
        const base = this.makeNode('Base', this.joystick);
        const gb = base.addComponent(Graphics);
        gb.lineWidth = 4;
        gb.strokeColor = this.color('#FFFFFF', 80);
        gb.fillColor = this.color('#FFFFFF', 25);
        gb.circle(0, 0, IngameBootstrap.JOY_RING_R);
        gb.fill();
        gb.stroke();

        this.joyKnob = this.makeNode('Knob', this.joystick);
        const gk = this.joyKnob.addComponent(Graphics);
        gk.fillColor = this.color('#FFFFFF', 120);
        gk.circle(0, 0, 45);
        gk.fill();

        // active=false 대신 투명도로 숨김 — 네이티브(안드로이드)에서 비활성 노드의
        // Graphics 렌더데이터가 유실돼 안 보이는 문제 회피
        this.joyFade = this.joystick.addComponent(UIOpacity);
        this.joyFade.opacity = 0;
    }

    onEnable() {
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }
    onDisable() {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        this.pressed.clear();
    }
    private onKeyDown(e: EventKeyboard) {
        this.pressed.add(e.keyCode);
    }
    private onKeyUp(e: EventKeyboard) { this.pressed.delete(e.keyCode); }

    // ── 터치 조이스틱 (모바일 조작 — 화면 아무 데나 눌러 드래그) ──
    private uiPos(e: EventTouch): Vec2 {
        const ui = e.getUILocation();
        const local = this.node.getComponent(UITransform)!
            .convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
        return new Vec2(local.x, local.y);
    }

    private onTouchStart(e: EventTouch) {
        if (!this.ready || !this.joystick) return;
        const p = this.uiPos(e);
        if (this.isOnZoomPanel(p)) return; // 줌 버튼 터치는 조이스틱으로 안 잡음
        this.touchOrigin.set(p.x, p.y);
        this.joystick.setPosition(p.x, p.y, 0);
        this.joyKnob!.setPosition(0, 0, 0);
        if (this.joyFade) this.joyFade.opacity = 255;
        this.touchDir.set(0, 0);
        this.touchMag = 0;
    }

    private onTouchMove(e: EventTouch) {
        if (!this.joystick || !this.joyFade || this.joyFade.opacity === 0) return;
        const p = this.uiPos(e);
        let dx = p.x - this.touchOrigin.x;
        let dy = p.y - this.touchOrigin.y;
        const len = Math.hypot(dx, dy);
        const R = IngameBootstrap.JOY_TRAVEL;
        const DEAD = IngameBootstrap.JOY_DEADZONE;
        if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
        this.joyKnob!.setPosition(dx, dy, 0);
        if (len < DEAD) {
            this.touchDir.set(0, 0);
            this.touchMag = 0;
        } else {
            this.touchDir.set(dx, dy);
            // 변위 비례 세기: 데드존 경계 0 → 바깥 원 1
            this.touchMag = Math.min(1, (len - DEAD) / (R - DEAD));
        }
    }

    private onTouchEnd() {
        if (this.joyFade) this.joyFade.opacity = 0;
        this.touchDir.set(0, 0);
        this.touchMag = 0;
    }

    update(dt: number) {
        if (!this.ready) return;
        // 화면 기준 입력 → 아이소 그리드 이동으로 역투영(WASD가 화면 상하좌우로 자연스럽게 느껴짐)
        let sx = 0, sy = 0;
        if (this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT)) sx -= 1;
        if (this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) sx += 1;
        if (this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN)) sy -= 1;
        if (this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) sy += 1;

        // 터치 조이스틱이 잡혀 있으면 그쪽 우선 (아날로그 — 변위 비례 속도), 키보드는 항상 100%
        let inputMag = 1;
        if (this.touchDir.x !== 0 || this.touchDir.y !== 0) {
            sx = this.touchDir.x;
            sy = this.touchDir.y;
            inputMag = this.touchMag;
        }

        // 존 진입 배너 페이드 (1초 유지 → 0.8초 페이드)
        if (this.bannerTimer > 0 && this.bannerFade) {
            this.bannerTimer -= dt;
            this.bannerFade.opacity = 255 * math.clamp(this.bannerTimer / 0.8, 0, 1);
        }

        if (sx !== 0 || sy !== 0) {
            // 좌/우 바라보기 — 수평 입력 방향으로 스프라이트 전환 (수직 이동 시 유지)
            const face: 'left' | 'right' | null = sx > 0.01 ? 'right' : sx < -0.01 ? 'left' : null;
            if (face && face !== this.facing && this.playerFrames[face] && this.playerSprite) {
                this.facing = face;
                this.playerSprite.spriteFrame = this.playerFrames[face]!;
            }

            const len = Math.hypot(sx, sy);
            // 무게 페널티 — 스택이 쌓일수록 느려짐 (운반의 무게, C7 리스크 테이킹)
            const speed = (this.moveSpeed - IngameBootstrap.WEIGHT_PENALTY * this.carryCount) * inputMag;
            const step = (speed * dt) / len;
            const d = screenToGrid(sx * step, sy * step);
            this.tryMove(d.gx, d.gy);
            this.player.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);
            if (this.tileCursor) {
                const cx = Math.round(this.pgx), cy = Math.round(this.pgy);
                this.tileCursor.setPosition(isoX(cx, cy), isoY(cx, cy), 0);
            }
            this.detectZone();
        }

        // 던전 코어 갱신 + 깊이 정렬 (개체가 움직이므로 매 프레임)
        if (this.combat) {
            this.combat.update(dt);
            this.sortEntities();
        }

        // 플레이어 피격 플래시 (붉게 번쩍)
        if (this.playerFlashT > 0 && this.playerSprite) {
            this.playerFlashT -= dt;
            this.playerSprite.color = this.playerFlashT > 0
                ? this.color('#FF6A5A') : this.color('#FFFFFF');
        }

        // 카메라 팔로우 — World를 옮겨 플레이어를 화면 중앙에 고정
        const z = this.zoom;
        const targetX = -isoX(this.pgx, this.pgy) * z;
        const targetY = -isoY(this.pgx, this.pgy) * z;
        const p = this.world.position;
        const t = Math.min(1, this.followSmooth * dt);
        this.world.setScale(z, z, 1);
        this.world.setPosition(math.lerp(p.x, targetX, t), math.lerp(p.y, targetY, t), 0);
    }

    // ── 바닥 (노드 수 = 2 + 존 수 — 맵 크기와 무관) ──
    private mapW() { return (this.map.groundRadius * 2 + 1) * TILE_W; }
    private mapH() { return (this.map.groundRadius * 2 + 1) * TILE_H; }

    private buildBackground(parent: Node) {
        // 패턴의 투명한 그리드 라인 사이로 이 색이 비쳐 보인다
        const bg = this.addSprite('Background', parent, this.squareFrame(),
            this.mapW(), this.mapH(), this.color('#22222A'));
        bg.setPosition(0, 0, 0);
    }

    private buildGround(parent: Node) {
        // 마름모 패턴 텍스처 1장을 TILED로 반복 — 맵이 커져도 Ground는 노드 1개
        const ground = this.addSprite('Ground', parent, this.floorPatternFrame(),
            this.mapW(), this.mapH(), this.color('#0B0B0E'));
        ground.getComponent(Sprite)!.type = Sprite.Type.TILED;
        ground.setPosition(0, 0, 0);
    }

    // ── 존 (그리드 사각 → 화면 평행사변형) — 텍스처 있으면 마스킹 타일링, 없으면 틴트 ──
    private buildZones(parent: Node) {
        const zones = this.makeNode('Zones', parent);
        // 뒤 항목부터 그림 — 배열 앞쪽(판정 우선, 좁은 존)이 위에 올라오게
        for (let i = this.map.zones.length - 1; i >= 0; i--) {
            const z = this.map.zones[i];
            const node = this.makeNode(`zone_${z.name}`, zones);
            const corners: [number, number][] = [
                [z.gx, z.gy], [z.gx + z.w, z.gy], [z.gx + z.w, z.gy + z.h], [z.gx, z.gy + z.h],
            ].map(([gx, gy]) => [isoX(gx, gy), isoY(gx, gy)] as [number, number]);

            const frame = this.zoneFrames[z.kind];
            if (frame) {
                // 존 모양(평행사변형) 스텐실 마스크 + 패턴 타일링 스프라이트
                const mask = node.addComponent(Mask);
                mask.type = Mask.Type.GRAPHICS_STENCIL;
                const mg = node.getComponent(Graphics) ?? node.addComponent(Graphics);
                mg.fillColor = this.color('#FFFFFF');
                mg.moveTo(corners[0][0], corners[0][1]);
                for (let c = 1; c < corners.length; c++) mg.lineTo(corners[c][0], corners[c][1]);
                mg.close();
                mg.fill();

                // 패턴 위상을 전역(128×64 배수)에 스냅 — 존끼리 이음새 없이 이어짐
                const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
                const minX = Math.floor(Math.min(...xs) / TILE_W) * TILE_W;
                const maxX = Math.ceil(Math.max(...xs) / TILE_W) * TILE_W;
                const minY = Math.floor(Math.min(...ys) / TILE_H) * TILE_H;
                const maxY = Math.ceil(Math.max(...ys) / TILE_H) * TILE_H;

                const tex = this.makeNode('Pattern', node);
                tex.addComponent(UITransform).setContentSize(maxX - minX, maxY - minY);
                const sprite = tex.addComponent(Sprite);
                sprite.sizeMode = Sprite.SizeMode.CUSTOM;
                sprite.type = Sprite.Type.TILED;
                sprite.spriteFrame = frame;
                tex.setPosition((minX + maxX) / 2, (minY + maxY) / 2, 0);
            } else {
                // 폴백: 반투명 틴트 (텍스처 파일이 없을 때)
                const g = node.addComponent(Graphics);
                g.fillColor = this.color(z.tint, 110);
                g.moveTo(corners[0][0], corners[0][1]);
                for (let c = 1; c < corners.length; c++) g.lineTo(corners[c][0], corners[c][1]);
                g.close();
                g.fill();
            }
        }
    }

    // ── 벽 충돌 (축 분리 이동 — 벽에 비스듬히 닿으면 미끄러짐) ──
    private static readonly PLAYER_RADIUS = 0.35; // 그리드 단위 (임의)

    private tryMove(dgx: number, dgy: number) {
        const R = this.map.groundRadius;
        const nx = math.clamp(this.pgx + dgx, -R, R);
        if (!this.hitsWall(nx, this.pgy)) this.pgx = nx;
        const ny = math.clamp(this.pgy + dgy, -R, R);
        if (!this.hitsWall(this.pgx, ny)) this.pgy = ny;
    }

    private hitsWall(gx: number, gy: number): boolean {
        const r = IngameBootstrap.PLAYER_RADIUS;
        for (const w of this.map.walls) {
            if (gx > w.gx - r && gx < w.gx + w.w + r &&
                gy > w.gy - r && gy < w.gy + w.h + r) return true;
        }
        return false;
    }

    /** 벽 렌더링 — 전체 벽을 Graphics 노드 1개에 그림 */
    private buildWalls(parent: Node) {
        if (this.map.walls.length === 0) return;
        const node = this.makeNode('Walls', parent);
        const g = node.addComponent(Graphics);
        g.fillColor = this.color('#5A3A26', 235);
        g.strokeColor = this.color('#2A1F15', 255);
        g.lineWidth = 3;
        for (const w of this.map.walls) {
            const corners: [number, number][] = [
                [w.gx, w.gy], [w.gx + w.w, w.gy], [w.gx + w.w, w.gy + w.h], [w.gx, w.gy + w.h],
            ].map(([gx, gy]) => [isoX(gx, gy), isoY(gx, gy)] as [number, number]);
            g.moveTo(corners[0][0], corners[0][1]);
            for (let c = 1; c < corners.length; c++) g.lineTo(corners[c][0], corners[c][1]);
            g.close();
        }
        g.fill();
        g.stroke();
    }

    /** 플레이어가 어느 존에 있는지 판정 — 이후 웨이브 스포너/BGM 트리거가 물릴 자리 */
    private detectZone() {
        let found: ZoneDef | null = null;
        for (const z of this.map.zones) {
            if (this.pgx >= z.gx && this.pgx <= z.gx + z.w &&
                this.pgy >= z.gy && this.pgy <= z.gy + z.h) {
                found = z;
                break;
            }
        }
        if (found !== this.currentZone) {
            this.currentZone = found;
            if (found) this.showZoneBanner(found);
        }
    }

    // ── 배치물 (실루엣 박스 — 아트 오면 프리팹 스폰으로 교체) ──
    private buildProps(parent: Node) {
        for (const prop of this.map.props) {
            const p = this.makeNode(`prop_${prop.kind}`, parent);
            p.setPosition(isoX(prop.gx, prop.gy), isoY(prop.gx, prop.gy), 0);

            const shadow = this.addSprite('Shadow', p, this.diamondFrame(),
                prop.w * 0.9, prop.w * 0.45, this.color('#000000', 90));
            shadow.setPosition(0, 0, 0);

            const body = this.addSprite('Body', p, this.squareFrame(), prop.w, prop.h, this.color(prop.tint));
            body.setPosition(0, prop.h / 2, 0);
        }
    }

    /** 아이소 깊이 정렬 — 화면 y가 클수록(위) 뒤로. Entities 자식 siblingIndex 갱신 */
    private sortEntities() {
        const children = this.entities.children.slice();
        children.sort((a, b) => b.position.y - a.position.y);
        for (let i = 0; i < children.length; i++) {
            children[i].setSiblingIndex(i);
        }
    }

    /** 기본 캐릭터 크기 — C3 아트 레퍼런스 확정 (2026-07-10): 128×128 @ 1080×1920 */
    private static readonly CHAR_PX = 128;

    // ── 플레이어(하얀 네모 + 발밑 그림자) ──
    private buildPlayer(parent: Node): Node {
        const c = IngameBootstrap.CHAR_PX;
        const p = this.makeNode('Player', parent);
        p.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);

        // 아트가 있으면 원화(높이 c 기준, 폭은 원본 비율), 없으면 흰 박스 폴백
        const art = this.playerFrames[this.facing] ?? null;
        let body: Node;
        if (art) {
            const w = c * (art.rect.width / art.rect.height);
            body = this.addSprite('Body', p, art, w, c, this.color('#FFFFFF'));
        } else {
            body = this.addSprite('Body', p, this.squareFrame(), c, c, this.color('#FFFFFF'));
        }
        body.setPosition(0, c / 2, 0); // 발이 타일 중심에 닿게
        this.playerSprite = body.getComponent(Sprite);
        return p;
    }

    // ── 셋업: 해상도·Canvas·2D 카메라 (씬 수동 세팅 불필요) ──
    private ensureCanvas(): Node {
        // 디자인 해상도: 1080x1920 세로, FIXED_WIDTH(가로 고정 — 긴 기기는 세로로 더 보임)
        view.setDesignResolutionSize(1080, 1920, ResolutionPolicy.FIXED_WIDTH);

        const scene = director.getScene()!;

        // 씬에 남아 있는 기본 3D 카메라/라이트 끄기 (우리 카메라와 중복 클리어 방지)
        const stale: Node[] = [];
        scene.walk((n) => {
            if (n.getComponent(Camera) || n.getComponent(DirectionalLight)) stale.push(n);
        });
        for (const n of stale) n.active = false;

        // 이미 Canvas가 있으면 재사용
        const existing = scene.getComponentInChildren(Canvas);
        if (existing) {
            existing.node.active = true;
            if (existing.cameraComponent) existing.cameraComponent.node.active = true;
            return existing.node;
        }

        // Canvas + 전용 2D(Ortho) 카메라 생성
        const canvasNode = new Node('Canvas');
        canvasNode.layer = Layers.Enum.UI_2D;
        scene.addChild(canvasNode);
        canvasNode.addComponent(UITransform);

        const camNode = new Node('UICamera');
        camNode.layer = Layers.Enum.UI_2D;
        canvasNode.addChild(camNode);
        camNode.setPosition(0, 0, 1000);
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.ORTHO;
        cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        cam.clearColor = this.color('#101014'); // 맵 밖 여백색
        cam.visibility = Layers.Enum.UI_2D;
        cam.near = 1;
        cam.far = 2000;

        const canvas = canvasNode.addComponent(Canvas);
        canvas.cameraComponent = cam;
        canvas.alignCanvasWithScreen = true; // 화면 크기에 맞춰 orthoHeight 자동 관리

        return canvasNode;
    }

    // ── 노드/스프라이트 헬퍼 ──
    private makeNode(name: string, parent: Node): Node {
        const n = new Node(name);
        n.layer = Layers.Enum.UI_2D;
        parent.addChild(n);
        return n;
    }

    private addSprite(name: string, parent: Node, frame: SpriteFrame, w: number, h: number, color: Color): Node {
        const n = this.makeNode(name, parent);
        n.addComponent(UITransform).setContentSize(w, h);
        const s = n.addComponent(Sprite);
        s.sizeMode = Sprite.SizeMode.CUSTOM;
        s.spriteFrame = frame;
        s.color = color;
        return n;
    }

    private color(hex: string, alpha = 255): Color {
        const c = new Color();
        Color.fromHEX(c, hex);
        c.a = alpha;
        return c;
    }

    // ── 절차적 프레임(이미지 없이 도형) — 캐시해서 전부 공유 → 배칭 ──
    private _square: SpriteFrame | null = null;
    private _diamond: SpriteFrame | null = null;
    private _floorPattern: SpriteFrame | null = null;

    /**
     * 아이소 바닥 패턴 1셀(TILE_W×TILE_H). 마름모 격자 라인만 투명(뒤 Background 색이 비침).
     * 격자 라인 = frac(x/W + y/H)=0.5, frac(x/W - y/H)=0.5 두 직선 패밀리 → 이어붙이면 무한 마름모 그리드.
     */
    private floorPatternFrame(): SpriteFrame {
        if (!this._floorPattern) {
            const lw = 0.03; // 라인 두께 (임의)
            // 캔버스 = 4×4셀(512×256) — TILED 반복 수를 줄여 네이티브 UI 버퍼 한도(에러 9004) 회피
            this._floorPattern = this.makeFrame(TILE_W * 4, TILE_H * 4, (x, y) => {
                const u = (x + 0.5) / TILE_W;
                const v = (y + 0.5) / TILE_H;
                const a = (u + v) % 1;
                const b = (u - v + 8) % 1;
                const isLine = Math.abs(a - 0.5) < lw || Math.abs(b - 0.5) < lw;
                return isLine ? 0 : 255;
            });
        }
        return this._floorPattern;
    }

    private squareFrame(): SpriteFrame {
        if (!this._square) this._square = this.makeFrame(4, 4, () => 255);
        return this._square;
    }
    private diamondFrame(): SpriteFrame {
        if (!this._diamond) {
            this._diamond = this.makeFrame(TILE_W, TILE_H, (x, y) => {
                const dx = (x + 0.5 - TILE_W / 2) / (TILE_W / 2);
                const dy = (y + 0.5 - TILE_H / 2) / (TILE_H / 2);
                return Math.abs(dx) + Math.abs(dy) <= 1 ? 255 : 0;
            });
        }
        return this._diamond;
    }
    private makeFrame(w: number, h: number, alphaAt: (x: number, y: number) => number): SpriteFrame {
        const data = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = alphaAt(x, y);
            }
        }
        const image = new ImageAsset({
            _data: data, _compressed: false, width: w, height: h,
            format: Texture2D.PixelFormat.RGBA8888,
        } as any);
        const tex = new Texture2D();
        tex.image = image;
        const frame = new SpriteFrame();
        frame.texture = tex;
        frame.packable = false;
        return frame;
    }
}
