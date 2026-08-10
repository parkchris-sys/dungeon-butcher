import {
    _decorator, Component, Node, Sprite, SpriteFrame, Texture2D, ImageAsset,
    UITransform, Color, Layers, director, Canvas, Camera, DirectionalLight,
    view, ResolutionPolicy, Label, Widget, sys, resources, game, UIOpacity,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * 인트로 + 로비 (specs/INTRO_LOBBY.md v0.1).
 *
 * 흐름: 앱 실행 → [최초 1회면 인트로 3컷] → 로비 → (버튼) → 마을(ingame 씬)
 *  - **인트로는 최초 1회만** — 로컬 플래그 하나로 판정 (§5: 세이브는 더미)
 *  - 로비는 인게임 연속 맵과 **분리된 별도 화면** (BIBLE §4 "씬 전환 없음"은 인게임에만 적용)
 *  - 처음부터하기/이어하기 **둘 다 마을 진입** — 세이브를 만들지 않는다는 기획 확정 반영
 *  - **종료 버튼은 웹 빌드에서 숨김** (브라우저엔 종료 개념 없음)
 *
 * 아트(로비 배경·인트로 3컷·로고)가 오기 전까지 색판 플레이스홀더로 표시한다.
 * 배경 이미지가 들어오면 resources/lobby/bg.png, 인트로는 resources/lobby/intro_1..3.png로
 * 넣으면 자동으로 잡힌다 (파일 없으면 조용히 플레이스홀더).
 */
@ccclass('LobbyBootstrap')
export class LobbyBootstrap extends Component {
    /** 인트로 시청 기록 키 — 이 플래그 하나가 유일한 저장 항목 (§5 세이브 더미) */
    private static readonly INTRO_SEEN_KEY = 'db_intro_seen';
    /** 게임 씬 이름 — assets/scenes/ingame.scene */
    private static readonly GAME_SCENE = 'ingame';
    private static readonly VERSION = 'v0.1';

    /** 인트로 컷 유지 시간(초) — 기획 자막 확정 전 (임의) */
    private static readonly CUT_S = 3.0;

    // ── 회사 로고 스플래시 ──
    /** 로고 유지 시간(초) — 페이드 시작 전까지 (임의) */
    private static readonly SPLASH_HOLD_S = 1.6;
    /** 페이드 아웃 시간(초) (임의) */
    private static readonly SPLASH_FADE_S = 0.4;
    /** 화면 폭 대비 로고 폭 — 세로 화면에서 답답하지 않은 정도 (임의) */
    private static readonly SPLASH_W_RATIO = 0.62;

    private root!: Node;
    private introFrames: (SpriteFrame | null)[] = [];
    private bgFrame: SpriteFrame | null = null;
    private logoFrame: SpriteFrame | null = null;

    // 스플래시 상태
    private splashRoot: Node | null = null;
    private splashFade: UIOpacity | null = null;
    private splashTimer = 0;
    private splashAfter: (() => void) | null = null;

    // 인트로 상태
    private introRoot: Node | null = null;
    private introCutIndex = -1;
    private introTimer = 0;
    private introRunning = false;
    private cutSprite: Sprite | null = null;
    private cutLabel: Label | null = null;

    private loading = false; // 씬 로드 중 중복 입력 방지

    onLoad() {
        const canvas = this.ensureCanvas();
        this.node.layer = Layers.Enum.UI_2D;
        if (this.node.parent !== canvas) this.node.parent = canvas;
        const w = this.node.getComponent(Widget) ?? this.node.addComponent(Widget);
        w.isAlignTop = w.isAlignBottom = w.isAlignLeft = w.isAlignRight = true;
        w.top = w.bottom = w.left = w.right = 0;
        w.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        this.root = this.node;

        // 아트가 있으면 쓰고, 없으면 플레이스홀더 (둘 다 조용히 처리)
        this.loadArt(() => {
            // 회사 로고 → 인트로(최초 1회) → 로비. 로고 파일이 없으면 스플래시는 건너뛴다
            this.startSplash(() => {
                if (this.introSeen()) this.buildLobby();
                else this.startIntro();
            });
        });
    }

    // ── 아트 로드 (없으면 null — 플레이스홀더로 동작) ──
    private loadArt(done: () => void) {
        let pending = 5; // bg + 인트로 3컷 + 회사 로고
        const load = (path: string, assign: (f: SpriteFrame | null) => void) => {
            resources.load(`${path}/texture`, Texture2D, (err, tex) => {
                if (!err && tex) {
                    const f = new SpriteFrame();
                    f.texture = tex;
                    f.packable = false;
                    assign(f);
                } else assign(null);
                if (--pending === 0) done();
            });
        };
        load('lobby/bg', f => { this.bgFrame = f; });
        load('lobby/splash_logo', f => { this.logoFrame = f; });
        this.introFrames = [null, null, null];
        for (let i = 0; i < 3; i++) {
            load(`lobby/intro_${i + 1}`, f => { this.introFrames[i] = f; });
        }
    }

    // ── 회사 로고 스플래시 ──
    /**
     * resources/lobby/splash_logo.png 를 화면 중앙에 띄운다. 파일이 없으면 **조용히 건너뛴다**
     * (아트 반입 전에도 부팅이 막히지 않게 — 로비 배경·인트로와 같은 규칙).
     * 원본 비율을 유지해서 폭 기준으로만 맞추므로 정사각·가로형 어느 쪽을 줘도 안 찌그러진다.
     * 아무 데나 누르면 즉시 넘어간다.
     */
    private startSplash(after: () => void) {
        if (!this.logoFrame) { after(); return; }
        this.splashAfter = after;

        const root = this.makeNode('Splash', this.root);
        const rw = root.addComponent(Widget);
        rw.isAlignTop = rw.isAlignBottom = rw.isAlignLeft = rw.isAlignRight = true;
        rw.top = rw.bottom = rw.left = rw.right = 0;
        this.splashFade = root.addComponent(UIOpacity);

        // 배경 — 로고 원본이 검정 바탕이라 화면도 검정으로 깔아 이음매가 안 보이게
        const bg = this.addSprite('SplashBg', root, this.whiteFrame(), 1080, 1920, this.color('#000000'));
        const bw = bg.addComponent(Widget);
        bw.isAlignTop = bw.isAlignBottom = bw.isAlignLeft = bw.isAlignRight = true;
        bw.top = bw.bottom = bw.left = bw.right = 0;

        // 로고 — 화면 정중앙, 원본 비율 유지
        const r = this.logoFrame.rect;
        const w = 1080 * LobbyBootstrap.SPLASH_W_RATIO;
        const h = r.width > 0 ? w * (r.height / r.width) : w;
        const logo = this.addSprite('SplashLogo', root, this.logoFrame, w, h, this.color('#FFFFFF'));
        const lw = logo.addComponent(Widget);
        lw.isAlignHorizontalCenter = true;
        lw.isAlignVerticalCenter = true;
        lw.horizontalCenter = 0;
        lw.verticalCenter = 0;

        this.splashTimer = LobbyBootstrap.SPLASH_HOLD_S + LobbyBootstrap.SPLASH_FADE_S;
        bg.on(Node.EventType.TOUCH_END, () => this.endSplash());
        this.splashRoot = root;
    }

    private endSplash() {
        if (!this.splashRoot) return;
        this.splashRoot.destroy();
        this.splashRoot = null;
        this.splashFade = null;
        const after = this.splashAfter;
        this.splashAfter = null;
        after?.();
    }

    // ── 인트로 (3컷 + 스킵) ──
    /** 컷별 자막 — 문구는 기획 확정 대기 (임의) */
    private static readonly CUTS: { text: string; tint: string }[] = [
        { text: '평범한 정육점의 하루였다…', tint: '#8A7A6A' },
        { text: '…트럭이 오는 걸 보지 못했다.', tint: '#5A3A32' },
        { text: '눈을 뜨니, 낯선 세계의 정육식당.', tint: '#4A3A6A' },
    ];

    private startIntro() {
        this.introRoot = this.makeNode('Intro', this.root);
        const full = this.introRoot.addComponent(Widget);
        full.isAlignTop = full.isAlignBottom = full.isAlignLeft = full.isAlignRight = true;
        full.top = full.bottom = full.left = full.right = 0;

        // 컷 이미지(없으면 색판) — 화면을 채움
        const cut = this.addSprite('Cut', this.introRoot, this.whiteFrame(), 1080, 1920, this.color('#2A2230'));
        const cutW = cut.addComponent(Widget);
        cutW.isAlignTop = cutW.isAlignBottom = cutW.isAlignLeft = cutW.isAlignRight = true;
        cutW.top = cutW.bottom = cutW.left = cutW.right = 0;
        this.cutSprite = cut.getComponent(Sprite);

        // 자막 (하단)
        const cap = this.makeNode('Caption', this.introRoot);
        const capW = cap.addComponent(Widget);
        capW.isAlignBottom = true; capW.bottom = 260;
        capW.isAlignHorizontalCenter = true;
        this.cutLabel = cap.addComponent(Label);
        this.cutLabel.fontSize = 52;
        this.cutLabel.lineHeight = 64;
        this.cutLabel.isBold = true;
        this.cutLabel.color = this.color('#F7EFD8');

        // 스킵 버튼 (우상단)
        const skip = this.textButton('건너뛰기', this.introRoot, 220, 84, '#1A1520', 34);
        const sw = skip.addComponent(Widget);
        sw.isAlignTop = true; sw.top = 70;
        sw.isAlignRight = true; sw.right = 40;
        skip.on(Node.EventType.TOUCH_END, () => this.endIntro());

        this.introRunning = true;
        this.introCutIndex = -1;
        this.nextCut();
    }

    private nextCut() {
        this.introCutIndex += 1;
        if (this.introCutIndex >= LobbyBootstrap.CUTS.length) {
            this.endIntro();
            return;
        }
        const c = LobbyBootstrap.CUTS[this.introCutIndex];
        const art = this.introFrames[this.introCutIndex];
        if (this.cutSprite) {
            this.cutSprite.spriteFrame = art ?? this.whiteFrame();
            this.cutSprite.color = art ? this.color('#FFFFFF') : this.color(c.tint);
        }
        if (this.cutLabel) this.cutLabel.string = c.text;
        this.introTimer = LobbyBootstrap.CUT_S;
    }

    private endIntro() {
        if (!this.introRunning) return;
        this.introRunning = false;
        this.markIntroSeen(); // 최초 1회 — 다시보기 없음 (§3)
        this.introRoot?.destroy();
        this.introRoot = null;
        this.buildLobby();
    }

    update(dt: number) {
        if (this.splashRoot) {
            this.splashTimer -= dt;
            const fade = LobbyBootstrap.SPLASH_FADE_S;
            if (this.splashFade && this.splashTimer < fade) {
                this.splashFade.opacity = Math.max(0, Math.round(255 * this.splashTimer / fade));
            }
            if (this.splashTimer <= 0) this.endSplash();
            return;
        }
        if (!this.introRunning) return;
        this.introTimer -= dt;
        if (this.introTimer <= 0) this.nextCut();
    }

    // ── 로비 ──
    private buildLobby() {
        const lobby = this.makeNode('Lobby', this.root);
        const lw = lobby.addComponent(Widget);
        lw.isAlignTop = lw.isAlignBottom = lw.isAlignLeft = lw.isAlignRight = true;
        lw.top = lw.bottom = lw.left = lw.right = 0;

        // 배경 (아트 없으면 던전 바이올렛 톤 색판 — BIBLE §5 팔레트)
        const bg = this.addSprite('Bg', lobby, this.bgFrame ?? this.whiteFrame(),
            1080, 1920, this.bgFrame ? this.color('#FFFFFF') : this.color('#2A2240'));
        const bw = bg.addComponent(Widget);
        bw.isAlignTop = bw.isAlignBottom = bw.isAlignLeft = bw.isAlignRight = true;
        bw.top = bw.bottom = bw.left = bw.right = 0;
        if (!this.bgFrame) {
            // 플레이스홀더 안내 — 아트 반입 전임을 화면에서 알 수 있게
            const hint = this.makeNode('BgHint', lobby);
            const hwi = hint.addComponent(Widget);
            hwi.isAlignTop = true; hwi.top = 520;
            hwi.isAlignHorizontalCenter = true;
            const hl = hint.addComponent(Label);
            hl.string = '(로비 배경 아트 대기 — resources/lobby/bg.png)';
            hl.fontSize = 30;
            hl.color = this.color('#6C6480');
        }

        // 로고 (아트 오면 이미지로 교체)
        const logo = this.makeNode('Logo', lobby);
        const gw = logo.addComponent(Widget);
        gw.isAlignTop = true; gw.top = 300;
        gw.isAlignHorizontalCenter = true;
        const gl = logo.addComponent(Label);
        gl.string = '던전 정육점';
        // ⚠ 실기기(32비트 저사양)에서 104px 볼드가 글리프 겹침으로 깨짐 —
        // 크기를 낮추고 BITMAP 캐시로 렌더 (아트 로고 오면 이미지로 교체 예정)
        gl.fontSize = 80;
        gl.lineHeight = 96;
        gl.isBold = true;
        gl.cacheMode = Label.CacheMode.BITMAP;
        gl.color = this.color('#F2A93B');

        // 버튼 4종 — 세로 1열, 화면 하단~중앙 (§4)
        const isWeb = sys.isBrowser;
        const items: { label: string; onTap: () => void }[] = [
            { label: '처음부터하기', onTap: () => this.enterGame() },
            { label: '이어하기', onTap: () => this.enterGame() }, // 세이브 더미 — 동작 동일 (§5)
            { label: '설정', onTap: () => this.showSettings() },
        ];
        // 웹 빌드에는 종료 개념이 없으므로 숨김 (§4)
        if (!isWeb) items.push({ label: '종료', onTap: () => game.end() });

        const BTN_W = 620, BTN_H = 132, GAP = 28;
        items.forEach((it, i) => {
            const btn = this.textButton(it.label, lobby, BTN_W, BTN_H, '#1A1520', 52);
            const bwid = btn.addComponent(Widget);
            bwid.isAlignBottom = true;
            bwid.bottom = 620 - i * (BTN_H + GAP); // 위에서 아래로 쌓임 (첫 버튼이 가장 위)
            bwid.isAlignHorizontalCenter = true;
            btn.on(Node.EventType.TOUCH_END, it.onTap);
        });

        // 버전 표기 (우하단)
        const ver = this.makeNode('Version', lobby);
        const vw = ver.addComponent(Widget);
        vw.isAlignBottom = true; vw.bottom = 40;
        vw.isAlignRight = true; vw.right = 40;
        const vl = ver.addComponent(Label);
        vl.string = LobbyBootstrap.VERSION;
        vl.fontSize = 32;
        vl.color = this.color('#6C6480');
    }

    /** 설정 팝업 — 내용 미정(기획), 지금은 자리만 (§6 미결) */
    private showSettings() {
        const dim = this.addSprite('SettingsDim', this.root, this.whiteFrame(), 1080, 1920, this.color('#000000', 180));
        const dw = dim.addComponent(Widget);
        dw.isAlignTop = dw.isAlignBottom = dw.isAlignLeft = dw.isAlignRight = true;
        dw.top = dw.bottom = dw.left = dw.right = 0;

        const panel = this.addSprite('Panel', dim, this.whiteFrame(), 760, 460, this.color('#221C2C'));
        panel.setPosition(0, 0, 0);
        const title = this.makeNode('Title', panel);
        title.setPosition(0, 150, 0);
        const tl = title.addComponent(Label);
        tl.string = '설정';
        tl.fontSize = 60;
        tl.isBold = true;
        tl.color = this.color('#F7EFD8');

        const body = this.makeNode('Body', panel);
        body.setPosition(0, 20, 0);
        const bl = body.addComponent(Label);
        bl.string = '설정 항목은 기획 확정 대기\n(사운드 on/off 등)';
        bl.fontSize = 34;
        bl.lineHeight = 46;
        bl.color = this.color('#9A92AA');

        const close = this.textButton('닫기', panel, 300, 100, '#3A3050', 42);
        close.setPosition(0, -150, 0);
        close.on(Node.EventType.TOUCH_END, () => dim.destroy());
    }

    private enterGame() {
        if (this.loading) return;
        this.loading = true;
        director.loadScene(LobbyBootstrap.GAME_SCENE, (err) => {
            if (err) {
                console.error('[LobbyBootstrap] 게임 씬 로드 실패 — 빌드에 ingame 씬이 포함됐는지 확인', err);
                this.loading = false;
            }
        });
    }

    // ── 인트로 최초 1회 플래그 (유일한 저장 항목) ──
    private introSeen(): boolean {
        try { return sys.localStorage.getItem(LobbyBootstrap.INTRO_SEEN_KEY) === '1'; }
        catch { return false; }
    }
    private markIntroSeen() {
        try { sys.localStorage.setItem(LobbyBootstrap.INTRO_SEEN_KEY, '1'); } catch { /* 저장 실패는 무시 */ }
    }

    // ── UI 헬퍼 ──
    private textButton(text: string, parent: Node, w: number, h: number, bg: string, fontSize: number): Node {
        const btn = this.addSprite(`btn_${text}`, parent, this.whiteFrame(), w, h, this.color(bg, 235));
        const lbNode = this.makeNode('Label', btn);
        const lb = lbNode.addComponent(Label);
        lb.string = text;
        lb.fontSize = fontSize;
        lb.isBold = true;
        lb.color = this.color('#F7EFD8');
        // 눌림 피드백 (터치 시 살짝 밝게)
        const sp = btn.getComponent(Sprite)!;
        const normal = sp.color.clone();
        btn.on(Node.EventType.TOUCH_START, () => { sp.color = this.color('#4A3E62', 235); });
        const restore = () => { sp.color = normal; };
        btn.on(Node.EventType.TOUCH_END, restore);
        btn.on(Node.EventType.TOUCH_CANCEL, restore);
        return btn;
    }

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

    /** 절차적 흰 사각 프레임 — 색판·버튼 공용 (이미지 에셋 0개) */
    private _white: SpriteFrame | null = null;
    private whiteFrame(): SpriteFrame {
        if (this._white) return this._white;
        const w = 4, h = 4;
        const data = new Uint8Array(w * h * 4).fill(255);
        const image = new ImageAsset({
            _data: data, _compressed: false, width: w, height: h,
            format: Texture2D.PixelFormat.RGBA8888,
        } as any);
        const tex = new Texture2D();
        tex.image = image;
        const frame = new SpriteFrame();
        frame.texture = tex;
        frame.packable = false;
        this._white = frame;
        return frame;
    }

    // ── 셋업: 해상도·Canvas·2D 카메라 (ingame과 동일 규격) ──
    private ensureCanvas(): Node {
        view.setDesignResolutionSize(1080, 1920, ResolutionPolicy.FIXED_WIDTH);
        const scene = director.getScene()!;

        const stale: Node[] = [];
        scene.walk((n) => {
            if (n.getComponent(DirectionalLight)) stale.push(n);
        });
        for (const n of stale) n.active = false;

        const existing = scene.getComponentInChildren(Canvas);
        if (existing) {
            existing.node.active = true;
            if (existing.cameraComponent) existing.cameraComponent.node.active = true;
            return existing.node;
        }

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
        cam.clearColor = this.color('#14101C');
        cam.visibility = Layers.Enum.UI_2D;
        cam.near = 1;
        cam.far = 2000;

        const canvas = canvasNode.addComponent(Canvas);
        canvas.cameraComponent = cam;
        canvas.alignCanvasWithScreen = true;
        return canvasNode;
    }
}
