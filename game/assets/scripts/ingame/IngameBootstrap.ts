import {
    _decorator, Component, Node, Sprite, SpriteFrame, Texture2D, ImageAsset,
    UITransform, Color, Layers, input, Input, EventKeyboard, KeyCode, math,
    director, Canvas, Camera, DirectionalLight, view, ResolutionPolicy, Label, Widget,
} from 'cc';
import { TILE_W, TILE_H, isoX, isoY, screenToGrid } from './Projection';
import { MapData, ZoneDef, DEV_MAP } from './MapData';

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
    @property({ tooltip: '뷰 줌(월드 스케일). 2026-07-10 뷰 검증에서 1.5로 확정' })
    zoom = 1.5;

    @property({ tooltip: '이동 속도(px/s, 화면 기준). TBD — 무게/운반 한계 기획과 연동, 결정 전까지 Z/X 튜닝 키 유지' })
    moveSpeed = 500;

    @property({ tooltip: '카메라 팔로우 부드러움(클수록 빠름)' })
    followSmooth = 10;

    /** 맵 원천 — 지금은 코드(DEV_MAP), 이후 Tiled JSON 로더가 이 자리를 대체 */
    private map: MapData = DEV_MAP;

    private world!: Node;
    private player!: Node;
    private entities!: Node;
    private pressed = new Set<KeyCode>();
    private pgx = 0;  // 플레이어 그리드 좌표
    private pgy = 0;
    private currentZone: ZoneDef | null = null;

    // 튜닝 HUD (뷰 검증용 — 확정되면 통째로 제거)
    private hudLabel: Label | null = null;
    private defaults = { zoom: 1, moveSpeed: 500 };

    onLoad() {
        const canvas = this.ensureCanvas();
        this.node.layer = Layers.Enum.UI_2D;
        if (this.node.parent !== canvas) {
            this.node.parent = canvas; // 컨텐츠를 Canvas 아래로 이동(어디에 붙였든 동작)
        }

        this.world = this.makeNode('World', this.node);
        this.world.setScale(this.zoom, this.zoom, 1);

        this.buildBackground(this.world);
        this.buildGround(this.world);
        this.buildZones(this.world);

        this.entities = this.makeNode('Entities', this.world);
        this.buildProps(this.entities);

        this.pgx = this.map.playerSpawn.gx;
        this.pgy = this.map.playerSpawn.gy;
        this.player = this.buildPlayer(this.entities);

        this.defaults = { zoom: this.zoom, moveSpeed: this.moveSpeed };
        this.buildTuningHud();
        this.detectZone();
        this.sortEntities();
    }

    onEnable() {
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    }
    onDisable() {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        this.pressed.clear();
    }
    private onKeyDown(e: EventKeyboard) {
        this.pressed.add(e.keyCode);
        // 뷰 튜닝 키 (검증용): Q/E 줌, Z/X 속도, R 리셋
        switch (e.keyCode) {
            case KeyCode.KEY_Q: this.zoom = Math.max(0.4, +(this.zoom - 0.05).toFixed(2)); break;
            case KeyCode.KEY_E: this.zoom = Math.min(2.0, +(this.zoom + 0.05).toFixed(2)); break;
            case KeyCode.KEY_Z: this.moveSpeed = Math.max(100, this.moveSpeed - 50); break;
            case KeyCode.KEY_X: this.moveSpeed = Math.min(1500, this.moveSpeed + 50); break;
            case KeyCode.KEY_R:
                this.zoom = this.defaults.zoom;
                this.moveSpeed = this.defaults.moveSpeed;
                break;
        }
        this.refreshTuningHud();
    }
    private onKeyUp(e: EventKeyboard) { this.pressed.delete(e.keyCode); }

    update(dt: number) {
        // 화면 기준 입력 → 아이소 그리드 이동으로 역투영(WASD가 화면 상하좌우로 자연스럽게 느껴짐)
        let sx = 0, sy = 0;
        if (this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT)) sx -= 1;
        if (this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) sx += 1;
        if (this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN)) sy -= 1;
        if (this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) sy += 1;

        if (sx !== 0 || sy !== 0) {
            const len = Math.hypot(sx, sy);
            const step = (this.moveSpeed * dt) / len;
            const d = screenToGrid(sx * step, sy * step);
            const R = this.map.groundRadius;
            this.pgx = math.clamp(this.pgx + d.gx, -R, R);
            this.pgy = math.clamp(this.pgy + d.gy, -R, R);
            this.player.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);
            this.sortEntities();
            this.detectZone();
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

    // ── 존 (그리드 정사각 → 화면 마름모 틴트, 존당 노드 1개) ──
    private buildZones(parent: Node) {
        const zones = this.makeNode('Zones', parent);
        for (const z of this.map.zones) {
            const overlay = this.addSprite(`zone_${z.name}`, zones, this.diamondFrame(),
                z.span * TILE_W, z.span * TILE_H, this.color(z.tint, 110));
            overlay.setPosition(isoX(z.gx, z.gy), isoY(z.gx, z.gy), 0);
        }
    }

    /** 플레이어가 어느 존에 있는지 판정 — 이후 웨이브 스포너/BGM 트리거가 물릴 자리 */
    private detectZone() {
        let found: ZoneDef | null = null;
        for (const z of this.map.zones) {
            const half = z.span / 2;
            if (Math.abs(this.pgx - z.gx) <= half && Math.abs(this.pgy - z.gy) <= half) {
                found = z;
                break;
            }
        }
        if (found !== this.currentZone) {
            this.currentZone = found;
            this.refreshTuningHud();
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

    // ── 플레이어(하얀 네모 + 발밑 그림자) ──
    private buildPlayer(parent: Node): Node {
        const p = this.makeNode('Player', parent);
        p.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);

        const shadow = this.addSprite('Shadow', p, this.diamondFrame(), 56, 28, this.color('#000000', 90));
        shadow.setPosition(0, 0, 0);

        const body = this.addSprite('Body', p, this.squareFrame(), 44, 60, this.color('#FFFFFF'));
        body.setPosition(0, 36, 0); // 발이 타일에 닿게 위로 올림
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

    // ── 튜닝 HUD (뷰 검증용 — 값 확정되면 제거) ──
    private buildTuningHud() {
        const hud = this.makeNode('TuningHud', this.node); // world 밖 — 화면 고정
        const w = hud.addComponent(Widget);
        w.isAlignTop = true; w.top = 60;
        w.isAlignLeft = true; w.left = 30;

        this.hudLabel = hud.addComponent(Label);
        this.hudLabel.fontSize = 34;
        this.hudLabel.lineHeight = 46;
        this.hudLabel.color = this.color('#9FE870');
        this.hudLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.hudLabel.verticalAlign = Label.VerticalAlign.TOP;
        this.refreshTuningHud();
    }

    private refreshTuningHud() {
        if (!this.hudLabel) return;
        this.hudLabel.string =
            `zoom ${this.zoom.toFixed(2)}  (Q-/E+)\n` +
            `speed ${this.moveSpeed}  (Z-/X+)\n` +
            `tile ${TILE_W}x${TILE_H}  ·  R reset\n` +
            `zone: ${this.currentZone ? this.currentZone.name : '—'}`;
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
            this._floorPattern = this.makeFrame(TILE_W, TILE_H, (x, y) => {
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
