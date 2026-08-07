import {
    _decorator, Component, Node, Sprite, SpriteFrame, Texture2D, ImageAsset,
    UITransform, Color, Layers, input, Input, EventKeyboard, KeyCode, math,
    director, Canvas, Camera, DirectionalLight, view, ResolutionPolicy, Label, Widget,
    resources, JsonAsset, Graphics, Vec2, Vec3, EventTouch, UIOpacity,
} from 'cc';
import { TILE_W, TILE_H, isoX, isoY, screenToGrid } from './Projection';
import {
    MapData, ZoneDef, ZoneKind, ZoneType, TileDef, DEV_MAP, MapTriggerDef, UpgradeKind,
    buildTileGrid, buildDungeonIdGrid, parseMapDataJson, TILE_ATTR_BLOCKED,
} from './MapData';
import { TileView } from './TileView';
import { parseTiledMap } from './TiledLoader';
import { CombatSystem } from './CombatSystem';
import { TriggerNpc, TriggerSystem, UPGRADE_SPEC } from './TriggerSystem';
import { CustomerSystem, NpcTemplate } from './CustomerSystem';
import { AnimData, animKey, parseAnimDataJson } from './AnimData';
import { SpriteAnimator } from './SpriteAnimator';
import { Dir8, DIR8_MIRROR, DIR8_VEC, dirFromScreen, sideOf } from './Facing8';

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
    /** 가상화 타일 렌더러 + 타일 데이터 그리드 */
    private tileView: TileView | null = null;
    private tileGrid: TileDef[][] = [];
    private dungeonIds: number[][] = []; // 던전 인스턴스 ID (1부터) — 이어진 던전 덩어리 단위
    private dungeonNames = new Map<number, string>(); // 던전 ID → 지역 이름 (mapdata.regions)
    private regionNames = new Map<number, string>();  // 지역 ID → 이름 (게이트 팝업 목적지 표시)
    private currentDungeonId = 0; // 배너 재표시용 — 던전 간 직접 이동 감지
    /** 플레이어 스프라이트 (resources/chars/player_left·right.png — 없으면 흰 박스 폴백) */
    private playerFrames: { left?: SpriteFrame; right?: SpriteFrame } = {};
    private playerSprite: Sprite | null = null;
    /** 바라보는 방향 — **주인공만 8방향** (BIBLE §6-a). 화면 기준, 자세히는 Facing8.ts */
    private facing: Dir8 = 'e';
    /** 마지막 좌/우 성분 — 8방향 아트가 없을 때의 폴백·등짐 위치용 (n·s엔 좌우가 없다) */
    private lastSide: 'e' | 'w' = 'e';
    private movingNow = false; // 이 프레임 이동 중인지 — 공격 클립 분화(attack_idle/attack_walk)용
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

    // 줌 조절 패널 (실기기 확정용 — 값 확정되면 제거)
    private zoomPanel: Node | null = null;
    private zoomLabel: Label | null = null;

    // 던전 코어 (웨이브·자동공격·고기·스택)
    private combat: CombatSystem | null = null;
    private triggerSystem: TriggerSystem | null = null;
    private customerSystem: CustomerSystem | null = null;
    private triggerNpcs: TriggerNpc[] = []; // 손님(customer) NPC만 — 트리거·이동 시스템이 공유
    private npcTemplates: NpcTemplate[] = []; // 배치된 손님 NPC = 스폰 시 복제할 템플릿
    private hpBarRoot: Node | null = null;       // 캐릭터 머리 위 HP바 (사냥지대 한정)
    private goldPopups: { node: Node; t: number }[] = []; // "+N" 골드 팝업
    private goldCount = 0;
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

        // 맵 로드 체인: ① mapdata.json(편집 씬에서 내보낸 데이터) → ② Tiled JSON → ③ DEV_MAP
        // (mapedit.scene은 에디터 전용 — 빌드에 미포함, 런타임 로드 없음)
        resources.load('maps/mapdata', JsonAsset, (err, asset) => {
            if (!err && asset) {
                const parsed = parseMapDataJson(asset.json);
                if (parsed) {
                    this.map = parsed;
                    this.loadZoneTextures(() => this.buildWorld());
                    return;
                }
                console.warn('[IngameBootstrap] mapdata.json 파싱 실패 — Tiled 폴백');
            } else {
                console.warn('[IngameBootstrap] mapdata.json 없음 — Tiled 폴백');
            }
            resources.load('maps/ingame_map', JsonAsset, (err2, asset2) => {
                if (!err2 && asset2) {
                    const parsed = parseTiledMap(asset2.json);
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
        });
    }

    /** ID → 이미지 프레임 (maps/floors·objs·units — {ID}_{이름}.png). 타일별 이미지는 폐지 → 구역 통짜 바닥 이미지 */
    private floorFrames = new Map<number, SpriteFrame>();
    private objFrames = new Map<number, SpriteFrame>();
    private unitFrames = new Map<number, SpriteFrame>();
    private moodFrames = new Map<number, SpriteFrame>(); // 기분 이모티콘 (0 화남..3 행복)
    /** 던전 ID → 스폰 몬스터 종류 (맵 에디터 몬스터 배치에서 파생) */
    private spawnKinds = new Map<number, string[]>();
    /**
     * 애니메이션 — 클립 정의(animdata.json) + 프레임 이미지.
     * 프레임 키는 `{클립키}_{n}` (파일명 규칙 `chars/{종류}_{상태}_{n}.png`와 동일).
     * 아트 미반입이면 둘 다 비어 있고, 각 개체는 기존 정적 이미지를 그대로 쓴다(폴백).
     */
    private animData: AnimData | null = null;
    private animFrames = new Map<string, SpriteFrame>();
    private playerAnim: SpriteAnimator | null = null;
    private playerAttackFacing: Dir8 = 'e'; // 공격 시작 시 방향 고정
    /** 구역 통짜 바닥 이미지 스프라이트 + 컬링용 화면 bbox (world 좌표) */
    private floorSprites: { node: Node; x: number; y: number; hw: number; hh: number }[] = [];

    /**
     * 아트 텍스처 로드 — 없는 것은 조용히 폴백.
     * 타일은 maps/tiles 폴더 전체를 스캔해 파일명 규칙 `{ID}_{이름}.png`로 매핑
     * (예: 1_auto.png → img 1). 이름 부분은 자유라 아트 교체 시 코드 수정 불필요.
     */
    private loadZoneTextures(done: () => void) {
        let pending = 7; // 플레이어 잡 + 바닥·오브젝트·유닛·기분 폴더 + 애니메이션(클립·프레임)

        const playerJobs: [string, (f: SpriteFrame) => void][] = [
            ['chars/player_left',  f => { this.playerFrames.left = f; }],
            ['chars/player_right', f => { this.playerFrames.right = f; }],
        ];
        let playerPending = playerJobs.length;
        for (const [path, assign] of playerJobs) {
            resources.load(`${path}/texture`, Texture2D, (err, tex) => {
                if (!err && tex) {
                    const frame = new SpriteFrame();
                    frame.texture = tex;
                    frame.packable = false;
                    assign(frame);
                }
                if (--playerPending === 0 && --pending === 0) done();
            });
        }

        const scanDir = (dir: string, into: Map<number, SpriteFrame>) => {
            resources.loadDir(dir, SpriteFrame, (err, frames) => {
                if (!err && frames) {
                    for (const frame of frames) {
                        const m = frame.name.match(/^(\d+)_/); // {ID}_{이름}
                        if (!m) continue;
                        into.set(+m[1], frame);
                    }
                }
                if (--pending === 0) done();
            });
        };
        scanDir('maps/floors', this.floorFrames);
        scanDir('maps/objs', this.objFrames);
        scanDir('maps/units', this.unitFrames);
        scanDir('maps/moods', this.moodFrames);

        // 애니메이션 클립 정의 (편집 씬이 내보낸 JSON) — 없으면 정적 이미지 폴백
        resources.load('anim/animdata', JsonAsset, (err, asset) => {
            if (!err && asset) this.animData = parseAnimDataJson(asset.json);
            if (--pending === 0) done();
        });
        // 애니메이션 프레임 — `chars/{종류}_{상태}_{n}.png` (ASSET_LIST 규약)
        resources.loadDir('chars', SpriteFrame, (err, frames) => {
            if (!err && frames) {
                for (const f of frames) {
                    // 파일명 끝의 `_{n}`을 프레임 번호로 — 앞부분이 클립 키(chicken_walk)
                    const m = f.name.match(/^(.+)_(\d+)$/);
                    if (!m) continue;
                    this.animFrames.set(`${m[1]}_${+m[2]}`, f);
                }
            }
            if (--pending === 0) done();
        });
    }

    /** 클립 키 + 프레임 번호 → SpriteFrame (없으면 null → 애니메이터가 정적 유지) */
    private animFrameOf(clipKey: string, imgNo: number): SpriteFrame | null {
        return this.animFrames.get(`${clipKey}_${imgNo}`) ?? null;
    }

    /**
     * 애니메이터 생성 — **클립 정의가 아예 없으면 null**을 돌려준다.
     * 그러면 개체는 기존 정적 스프라이트를 그대로 쓰고 애니메이션 관련 비용이 0이 된다
     * (아트 반입 전에도 게임이 그대로 돌아가게 하는 폴백).
     */
    private makeAnimator(body: Sprite, baseY: number, w: number, h: number): SpriteAnimator | null {
        if (!this.animData || this.animFrames.size === 0) return null;
        const anim = new SpriteAnimator(body.node, body, (k, n) => this.animFrameOf(k, n));
        anim.setBase(body.node.position.x, baseY, w, h);
        // 플레이스홀더 박스(64×46 + 초록 틴트)를 물려받지 않게, 그림 원본 비율·흰 틴트로 맞춘다
        anim.setFitHeight(IngameBootstrap.MONSTER_PX, this.color('#FFFFFF'));
        return anim;
    }

    private buildWorld() {
        this.world = this.makeNode('World', this.node);
        this.world.setScale(this.zoom, this.zoom, 1);

        this.buildBackground(this.world);

        // 가상화 타일 바닥 — 화면에 보이는 만큼만 노드 생성, 재사용
        this.tileGrid = this.map.tiles ?? buildTileGrid(this.map);
        const R = this.map.groundRadius;
        this.dungeonIds = buildDungeonIdGrid(this.tileGrid, R);
        this.dungeonNames.clear();
        this.regionNames.clear();
        for (const r of this.map.regions ?? []) {
            if (r.id > 0) {
                this.dungeonNames.set(r.id, r.name);
                this.regionNames.set(r.id, r.name); // 게이트 팝업의 목적지 이름 (지역 라벨 그대로)
            }
        }
        this.tileView = new TileView(this.world, this.diamondFrame(), R, (gx, gy) => {
            const row = this.tileGrid[gy + R];
            return row ? row[gx + R] ?? null : null;
        });
        // 구역별 통짜 바닥 이미지 (타일 베이스 위, 커서·개체 아래) + 화면 밖 컬링
        this.buildFloors(this.world);

        // 맵 에디터 몬스터 배치 → 던전별 스폰 종류 (같은 던전에 여러 종류 배치 가능)
        this.spawnKinds.clear();
        for (const m of this.map.monsters ?? []) {
            const did = this.dungeonIdAt(m.gx, m.gy);
            if (did === 0) continue; // 던전 밖 배치 — 에디터가 내보내기 시 경고함
            const arr = this.spawnKinds.get(did) ?? [];
            if (arr.indexOf(m.kind) < 0) arr.push(m.kind);
            this.spawnKinds.set(did, arr);
        }

        this.entities = this.makeNode('Entities', this.world);
        this.buildProps(this.entities);
        this.buildObjects(this.entities);
        this.buildNpcs(this.entities);

        // 플레이어 외형 — 에디터 spawn 마커의 img (maps/units) 지정 시 원화 대체 (좌우 동일 — 방향별 아트는 추후)
        const skin = this.map.playerImg ? this.unitFrames.get(this.map.playerImg) : undefined;
        if (skin) {
            this.playerFrames.left = skin;
            this.playerFrames.right = skin;
        }

        this.pgx = this.map.playerSpawn.gx;
        this.pgy = this.map.playerSpawn.gy;
        this.player = this.buildPlayer(this.entities);

        this.buildZoneBanner();
        this.buildJoystick();
        this.buildZoomPanel();
        this.buildPlayerHpBar(); // 상시 코너 HUD 없음 — HP바만 캐릭터 머리 위 (BIBLE §10-a)
        this.detectZone();
        this.sortEntities();
        this.tileView!.update(this.pgx, this.pgy, this.zoom); // 초기 타일 채우기

        this.combat = new CombatSystem({
            entities: this.entities,
            playerNode: () => this.player,
            playerG: () => ({ gx: this.pgx, gy: this.pgy }),
            facing: () => this.lastSide, // 등짐 위치용 좌/우 (8방향 중 n·s는 좌우가 없어 직전 값)
            inDungeon: () => this.currentZone?.kind === 'dungeon',
            inHub: () => this.currentZone?.kind === 'hub',
            zoneKindAt: (gx, gy) => this.zoneKindAt(gx, gy),
            dungeonIdAt: (gx, gy) => this.dungeonIdAt(gx, gy),
            playerDungeonId: () => this.dungeonIdAt(this.pgx, this.pgy),
            dungeonKindsOf: (id) => this.spawnKinds.get(id) ?? null,
            hitsWall: (gx, gy) => this.hitsWall(gx, gy),
            groundR: () => this.map.groundRadius,
            attackPower: () => 1 + this.upgradeBonus('attack'),
            carryLimit: () => 10 + this.upgradeBonus('carry'),
            // 공격 클립이 있으면 재생하고 true — 타격은 'hit' 프레임에 들어간다 (방향별 클립 지원).
            // ⚠ 방향은 **바라보는 방향 그대로**다 — 표적 쪽으로 자동 회전하지 않는다 (결정 2026-08-07).
            playAttackAnim: () => {
                this.playerAttackFacing = this.facing; // 공격 중 방향 고정 (중간에 뒤집히지 않음)
                // 이동 중이면 attack_walk, 멈춰 있으면 attack_idle → 없으면 기본 attack (BIBLE §6-b 디테일 2)
                const states = this.movingNow ? ['attack_walk', 'attack'] : ['attack_idle', 'attack'];
                return this.playDirectional(this.playerAnim, 'player', states, this.facing, true) !== '';
            },
            // 바라보는 방향 단위 벡터 (화면 기준) — "바라보는 방향의 적만 공격" 판정용
            facingVec: () => DIR8_VEC[this.facing],
            // 만재 전용 클립이 있으면 땀 플레이스홀더를 띄우지 않는다 (클립 쪽 연출과 중복)
            hasHeavyAnim: () => this.hasHeavyClips(),
            makeAnimator: (body, baseY, w, h) => this.makeAnimator(body, baseY, w, h),
            playMonsterAnim: (anim, kind, state) => { anim?.play(this.animData, animKey(kind, state)); },
            updateAnim: (anim, dt, faceLeft) => {
                // 방향별 클립이 있으면 그걸 쓰고, 없으면 좌우 반전 (플레이어와 동일 규칙)
                if (anim && faceLeft !== undefined) anim.setMirror(faceLeft);
                anim?.update(dt, this.animData);
            },
            ui: {
                makeNode: (n, p) => this.makeNode(n, p),
                addSprite: (n, p, f, w, h, c) => this.addSprite(n, p, f, w, h, c),
                square: () => this.squareFrame(),
                diamond: () => this.diamondFrame(),
                color: (hex, a) => this.color(hex, a),
            },
            onMeatCount: (n, max) => {
                this.carryCount = n; // 무게 페널티 반영
                // 운반량 숫자 표시 없음 — 등짐 스택 자체로만 표현 (BIBLE §10-a)
            },
            onHp: (hp, max) => this.setHpBar(hp, max),
            onPlayerHit: () => { this.playerFlashT = 0.15; },
            onPlayerDeath: () => this.respawnPlayer(),
        });
        // 손님 시스템 먼저 — 스폰 트리거가 이 시스템에 스폰을 요청한다 (triggerNpcs 공유)
        this.customerSystem = new CustomerSystem({
            entities: this.entities,
            tileAttrAt: (gx, gy) => this.tileAttrAt(gx, gy),
            makeNode: (n, p) => this.makeNode(n, p),
            addSprite: (n, p, f, w, h, c) => this.addSprite(n, p, f, w, h, c),
            square: () => this.squareFrame(),
            diamond: () => this.diamondFrame(),
            color: (hex, a) => this.color(hex, a),
            moodFrame: (mood) => this.moodFrames.get(mood) ?? null,
            charPx: IngameBootstrap.CHAR_PX,
        }, this.triggerNpcs, this.npcTemplates);

        this.triggerSystem = new TriggerSystem({
            entities: this.entities,
            playerNode: () => this.player,
            playerG: () => ({ gx: this.pgx, gy: this.pgy }),
            takePlayerMeat: () => this.combat?.takeTopMeat() ?? false,
            addGold: amount => {
                this.goldCount += amount;
                this.showGoldGain(amount); // 상시 카운터 대신 "+N" 팝업 (BIBLE §10-a)
            },
            spawnCustomer: (gx, gy, img) => this.customerSystem?.spawn(gx, gy, img),
            gold: () => this.goldCount,
            spendGold: (amount) => {
                if (this.goldCount < amount) return false;
                this.goldCount -= amount;
                return true;
            },
            // 플레이어리소스이동 — 돈은 등에 지지 않으므로 등짐(raw/cooked)만 처리
            takePlayerResource: (kind) => kind === 'money'
                ? false : (this.combat?.takeResource(kind) ?? false),
            givePlayerResource: (kind) => kind === 'money'
                ? false : (this.combat?.addResource(kind) ?? false),
            ui: {
                makeNode: (n, p) => this.makeNode(n, p),
                addSprite: (n, p, f, w, h, c) => this.addSprite(n, p, f, w, h, c),
                square: () => this.squareFrame(),
                color: (hex, a) => this.color(hex, a),
            },
        }, this.map.triggers ?? [], this.triggerNpcs, this.map.objects ?? []);
        this.ready = true;
    }

    /** (gx,gy) 타일의 속성 번호 (TILE_ATTR_*) — 손님 대기열/퇴장 판정용 */
    private tileAttrAt(gx: number, gy: number): number {
        const R = this.map.groundRadius;
        const row = this.tileGrid[Math.round(gy) + R];
        const t = row ? row[Math.round(gx) + R] : undefined;
        return t ? t.attr : 0;
    }

    /** (gx,gy)의 던전 인스턴스 ID (0=던전 아님) */
    private dungeonIdAt(gx: number, gy: number): number {
        const R = this.map.groundRadius;
        const row = this.dungeonIds[Math.round(gy) + R];
        return row ? (row[Math.round(gx) + R] ?? 0) : 0;
    }

    /** (gx,gy)가 밟고 있는 타일의 zone 속성값 (0=없음) — 존 판정의 원본은 타일 데이터 */
    private zoneIndexAtTile(gx: number, gy: number): number {
        const R = this.map.groundRadius;
        const row = this.tileGrid[Math.round(gy) + R];
        const t = row ? row[Math.round(gx) + R] : undefined;
        return t ? t.zone : 0;
    }

    /** 존 종류 판정 — 타일의 zone 속성 기반 (몬스터 이동 제약·스폰 위치 검사용) */
    private zoneKindAt(gx: number, gy: number): ZoneKind | null {
        const zi = this.zoneIndexAtTile(gx, gy);
        return zi > 0 ? (this.map.zones[zi - 1]?.kind ?? null) : null;
    }

    /** 죽음 → 마을 스폰 부활 (런 획득물 손실은 CombatSystem이 처리) */
    private respawnPlayer() {
        this.pgx = this.map.playerSpawn.gx;
        this.pgy = this.map.playerSpawn.gy;
        this.player.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);
        this.detectZone();
        // 사망 안내 배너
        if (this.bannerLabel && this.bannerFade) {
            this.bannerLabel.string = '고기를 모두 잃었다…';
            this.bannerLabel.color = this.color('#C0503F');
            this.bannerFade.opacity = 255;
            this.bannerTimer = 2.2;
        }
    }

    /**
     * HP 바 — 캐릭터 머리 위 플로팅(다이제틱). BIBLE §10-a (2026-07-24 확정):
     * 상시 코너 HUD 없음 · HP바는 사냥지대에서만 표시(마을에서는 숨김) ·
     * 운반량은 등짐 스택 자체로만 표현(숫자 없음) · 골드는 획득 시 "+N" 팝업만.
     */
    private static readonly HPBAR_W = 96;
    private static readonly HPBAR_H = 10;

    private buildPlayerHpBar() {
        const W = IngameBootstrap.HPBAR_W, H = IngameBootstrap.HPBAR_H;
        const bar = this.makeNode('HpBar', this.player); // 플레이어 자식 — 이동을 따라감
        bar.setPosition(0, IngameBootstrap.CHAR_PX + 18, 0);
        bar.addComponent(UITransform).setContentSize(W, H);
        const bg = this.addSprite('Bg', bar, this.squareFrame(), W, H, this.color('#1A1520', 200));
        bg.setPosition(0, 0, 0);
        this.hpFill = this.addSprite('Fill', bar, this.squareFrame(), W - 4, H - 4, this.color('#C0503F'));
        this.hpBarRoot = bar;
        this.setHpBar(1, 1);
        this.refreshHpBarVisible();
    }

    private setHpBar(hp: number, max: number) {
        if (!this.hpFill) return;
        const full = IngameBootstrap.HPBAR_W - 4;
        const w = Math.max(0, full * (hp / max));
        this.hpFill.getComponent(UITransform)!.setContentSize(w, IngameBootstrap.HPBAR_H - 4);
        this.hpFill.setPosition(-full / 2 + w / 2, 0, 0); // 왼쪽부터 줄어드는 바
    }

    /** HP바는 사냥지대(던전)에서만 — 마을에서는 숨김 (BIBLE §10-a) */
    private refreshHpBarVisible() {
        if (this.hpBarRoot) this.hpBarRoot.active = this.currentZone?.kind === 'dungeon';
    }

    /** 팝업이 열려 있는지 */
    private popupOpen(): boolean {
        return !!this.gatePopup || !!this.upPopup;
    }

    /**
     * 터치가 팝업 **패널(버튼 영역) 위**인지 — 패널 위 터치만 조이스틱에서 제외한다.
     * ⚠ 이동을 전면 차단하면 안 된다: 팝업은 닫기 버튼이 없고 **발판/문 앞을 벗어나야 닫히므로**
     *   전면 차단은 교착 상태가 된다. 반대로 패널을 보호하지 않으면 버튼 터치가 이동으로 새어
     *   팝업이 파괴되며 TOUCH_END가 유실된다(해금·구매 실패). 그래서 **패널만** 제외.
     */
    private popupPanels: Node[] = [];
    private touchOnPopupPanel(p: Vec2): boolean {
        for (const panel of this.popupPanels) {
            if (!panel.isValid || !panel.activeInHierarchy) continue;
            const ut = panel.getComponent(UITransform);
            if (ut && ut.getBoundingBoxToWorld().contains(p)) return true;
        }
        return false;
    }

    /** 강화 보너스 = 레벨 × 레벨당 증가폭 (절대값 방식 — BALANCE §레벨링 원칙) */
    private upgradeBonus(kind: UpgradeKind): number {
        const lv = this.triggerSystem?.upgradeLevel(kind) ?? 0;
        return lv * UPGRADE_SPEC[kind].step;
    }

    // ── 강화 팝업 (BIBLE §10-b ① 강화 팝업) ──
    /**
     * 공통 규칙(§10-b): 발판 진입 시 자동 열림 · 벗어나면 자동 닫힘 · 닫기 버튼 없음.
     * 표시 4종: **현재 스탯 · 강화 후(증가분) · 보유 골드 · 필요 골드**.
     * 버튼: 1회 / 10회 구매 — 10회는 **자금 부족 시 가능한 만큼만** (결정).
     * 구매해도 팝업은 닫히지 않고 수치만 즉시 갱신 (임의).
     */
    private upPopup: Node | null = null;
    private upPopupId = '';
    private upKind: UpgradeKind = 'attack';
    private upCurLabel: Label | null = null;
    private upNextLabel: Label | null = null;
    private upGoldLabel: Label | null = null;
    private upBtn1: Node | null = null;
    private upBtn1Label: Label | null = null;
    private upBtn10: Node | null = null;
    private upBtn10Label: Label | null = null;

    private updateUpgradePopup() {
        const pad = this.triggerSystem?.upgradeAt(this.pgx, this.pgy) ?? null;
        if (!pad) {
            if (this.upPopup) {
                this.upPopup.destroy(); this.upPopup = null; this.upPopupId = '';
                this.popupPanels = [];
            }
            return;
        }
        if (this.upPopupId !== pad.id) this.buildUpgradePopup(pad);
        this.refreshUpgradePopup();
    }

    /** 강화 종류별 현재 스탯 값 (표시용) */
    private upgradeStatValue(kind: UpgradeKind): number {
        if (kind === 'attack') return 1 + this.upgradeBonus('attack');
        if (kind === 'carry') return 10 + this.upgradeBonus('carry');
        return this.moveSpeed + this.upgradeBonus('speed'); // speed
    }

    private buildUpgradePopup(pad: MapTriggerDef) {
        this.upPopup?.destroy();
        this.upPopupId = pad.id;
        this.upKind = pad.upgradeKind ?? 'attack';
        const spec = UPGRADE_SPEC[this.upKind];

        const dim = this.addSprite('UpDim', this.node, this.squareFrame(), 1080, 1920, this.color('#000000', 170));
        const dw = dim.addComponent(Widget);
        dw.isAlignTop = dw.isAlignBottom = dw.isAlignLeft = dw.isAlignRight = true;
        dw.top = dw.bottom = dw.left = dw.right = 0;
        this.upPopup = dim;

        const panel = this.addSprite('Panel', dim, this.squareFrame(), 880, 760, this.color('#221C2C'));
        panel.setPosition(0, 0, 0);
        this.popupPanels = [panel]; // 이 패널 위 터치는 조이스틱으로 안 잡음

        // 카테고리명 + 오브젝트명 (§10-b 와이어프레임)
        const cat = this.makeNode('Cat', panel);
        cat.setPosition(0, 300, 0);
        const cl = cat.addComponent(Label);
        cl.string = `${spec.label} 강화`;
        cl.fontSize = 62;
        cl.isBold = true;
        cl.cacheMode = Label.CacheMode.BITMAP;
        cl.color = this.color('#F7EFD8');

        const obj = this.makeNode('ObjName', panel);
        obj.setPosition(0, 236, 0);
        const ol = obj.addComponent(Label);
        // 오브젝트명은 에디터 트리거 노드 ID를 그대로 (아트 오브젝트명 확정 시 매핑)
        ol.string = pad.id;
        ol.fontSize = 32;
        ol.color = this.color('#6C6480');

        const row = (y: number, size = 40): Label => {
            const n = this.makeNode('Row', panel);
            n.setPosition(0, y, 0);
            const lb = n.addComponent(Label);
            lb.fontSize = size;
            lb.color = this.color('#F7EFD8');
            return lb;
        };
        this.upCurLabel = row(130);
        this.upNextLabel = row(70);
        this.upGoldLabel = row(10);

        // 주 버튼: 1회 구매 / 보조: 10회 구매 (닫기 버튼 없음)
        const mk = (label: string, y: number, times: number, w: number, h: number, bg: string) => {
            const btn = this.addSprite(`buy${times}`, panel, this.squareFrame(), w, h, this.color(bg));
            btn.setPosition(0, y, 0);
            const lb = this.makeNode('L', btn).addComponent(Label);
            lb.string = label;
            lb.fontSize = 44;
            lb.isBold = true;
            lb.color = this.color('#F7EFD8');
            btn.on(Node.EventType.TOUCH_END, () => {
                const bought = this.triggerSystem?.buyUpgrade(this.upKind, times) ?? 0;
                if (bought > 0) this.showZoneBannerText(`${spec.label} +${bought}`, '#9FE870');
                this.refreshUpgradePopup(); // 팝업 유지, 수치만 즉시 갱신
            });
            return { btn, lb };
        };
        const b1 = mk('1회 구매', -110, 1, 560, 116, '#3A3050');
        this.upBtn1 = b1.btn; this.upBtn1Label = b1.lb;
        const b10 = mk('10회 구매', -250, 10, 560, 104, '#2E2740');
        this.upBtn10 = b10.btn; this.upBtn10Label = b10.lb;
    }

    private refreshUpgradePopup() {
        const ts = this.triggerSystem;
        if (!ts) return;
        const kind = this.upKind;
        const spec = UPGRADE_SPEC[kind];
        const cur = this.upgradeStatValue(kind);
        const cost1 = ts.upgradeCost(kind);
        const cost10 = ts.upgradeCostFor(kind, 10);
        const u = spec.unit ? ` ${spec.unit}` : '';

        if (this.upCurLabel) this.upCurLabel.string = `현재 ${spec.label}      ${cur}${u}`;
        if (this.upNextLabel) {
            this.upNextLabel.string = `강화 후      ${cur + spec.step}${u}  (+${spec.step})`;
            this.upNextLabel.color = this.color('#9FE870'); // 증가분 강조 (초록)
        }
        if (this.upGoldLabel) {
            this.upGoldLabel.string = `보유 골드      ${this.goldCount}`;
            this.upGoldLabel.color = this.color(this.goldCount >= cost1 ? '#F0B429' : '#C0503F');
        }
        // 버튼 라벨에 비용 표기 + 골드 부족 시 비활성 표현
        const setBtn = (btn: Node | null, lb: Label | null, text: string, enough: boolean, bg: string) => {
            if (lb) {
                lb.string = text;
                lb.color = this.color(enough ? '#F7EFD8' : '#6C6480');
            }
            const sp = btn?.getComponent(Sprite);
            if (sp) sp.color = this.color(enough ? bg : '#2A2434');
        };
        setBtn(this.upBtn1, this.upBtn1Label, `1회 구매 — ${cost1}G`, this.goldCount >= cost1, '#3A3050');
        // 10회는 부분 구매 허용이므로 1회분만 있어도 활성 (§10-b 결정)
        setBtn(this.upBtn10, this.upBtn10Label, `10회 구매 — ${cost10}G`, this.goldCount >= cost1, '#2E2740');
    }

    // ── 구역 해금 팝업 (BIBLE §10-b ② 맵 해금 팝업) ──
    /**
     * 공통 규칙: **발판(문 앞) 진입 시 자동 열림 · 벗어나면 자동 닫힘 · 닫기 버튼 없음**,
     * 화면 중앙 + 뒤쪽 딤, 골드 부족 시 해금 버튼 비활성.
     * 표시: 목적지 지역 이름 · 해금 비용 · 보유 골드(부족하면 빨강). 비용 0이면 "무료 통과" 배지.
     */
    private gatePopup: Node | null = null;
    private gatePopupId = '';
    private gateCostLabel: Label | null = null;
    private gateGoldLabel: Label | null = null;
    private gateButton: Node | null = null;
    private gateButtonLabel: Label | null = null;

    /** 매 프레임 — 문 앞이면 열고, 벗어나면 닫고, 열려 있으면 골드 표시 갱신 */
    private updateGatePopup() {
        const gate = this.gateInFront();
        if (!gate) {
            if (this.gatePopup) {
                this.gatePopup.destroy(); this.gatePopup = null; this.gatePopupId = '';
                this.popupPanels = [];
            }
            return;
        }
        if (this.gatePopupId !== gate.id) this.buildGatePopup(gate);
        this.refreshGatePopup(gate);
    }

    private buildGatePopup(gate: MapTriggerDef) {
        this.gatePopup?.destroy();
        this.gatePopupId = gate.id;
        console.log(`[Gate] 팝업 열림 '${gate.id}' 비용=${gate.unlockCost ?? 0} 목적지=${gate.targetRegionId ?? 0}`);

        const dim = this.addSprite('GateDim', this.node, this.squareFrame(), 1080, 1920, this.color('#000000', 170));
        const dw = dim.addComponent(Widget);
        dw.isAlignTop = dw.isAlignBottom = dw.isAlignLeft = dw.isAlignRight = true;
        dw.top = dw.bottom = dw.left = dw.right = 0;
        this.gatePopup = dim;

        const panel = this.addSprite('Panel', dim, this.squareFrame(), 860, 620, this.color('#221C2C'));
        panel.setPosition(0, 0, 0);
        this.popupPanels = [panel]; // 이 패널 위 터치는 조이스틱으로 안 잡음

        const title = this.makeNode('Title', panel);
        title.setPosition(0, 230, 0);
        const tl = title.addComponent(Label);
        tl.string = '다음 구역으로';
        tl.fontSize = 46;
        tl.color = this.color('#9A92AA');

        // 목적지 지역 이름 = 맵 에디터의 지역 라벨 그대로
        const destName = this.regionNames.get(gate.targetRegionId ?? 0) ?? '미지의 구역';
        const dest = this.makeNode('Dest', panel);
        dest.setPosition(0, 150, 0);
        const dl = dest.addComponent(Label);
        dl.string = destName;
        dl.fontSize = 68;
        dl.isBold = true;
        dl.cacheMode = Label.CacheMode.BITMAP; // 큰 볼드 글리프 겹침 회피 (실기기 확인분)
        dl.color = this.color('#F7EFD8');

        const cost = gate.unlockCost ?? 0;
        if (cost === 0) {
            // 최초 마을→사냥지대: 비용 0 "무료 통과" 배지 — 튜토리얼 역할 (§7-c 결정)
            const badge = this.addSprite('FreeBadge', panel, this.squareFrame(), 320, 76, this.color('#3BAF6E'));
            badge.setPosition(0, 30, 0);
            const bl = this.makeNode('L', badge).addComponent(Label);
            bl.string = '무료 통과';
            bl.fontSize = 40;
            bl.isBold = true;
            bl.color = this.color('#F7EFD8');
        } else {
            const costNode = this.makeNode('Cost', panel);
            costNode.setPosition(0, 40, 0);
            this.gateCostLabel = costNode.addComponent(Label);
            this.gateCostLabel.fontSize = 40;
            this.gateCostLabel.color = this.color('#F7EFD8');

            const goldNode = this.makeNode('Gold', panel);
            goldNode.setPosition(0, -20, 0);
            this.gateGoldLabel = goldNode.addComponent(Label);
            this.gateGoldLabel.fontSize = 40;
        }

        // 해금 버튼 (닫기 버튼은 없음 — 조작은 이동만)
        const btn = this.addSprite('UnlockBtn', panel, this.squareFrame(), 520, 116, this.color('#3A3050'));
        btn.setPosition(0, -180, 0);
        this.gateButton = btn;
        const lb = this.makeNode('L', btn).addComponent(Label);
        lb.string = cost === 0 ? '들어가기' : '해금하기';
        lb.fontSize = 48;
        lb.isBold = true;
        lb.color = this.color('#F7EFD8');
        this.gateButtonLabel = lb;
        btn.on(Node.EventType.TOUCH_END, () => {
            if (this.triggerSystem?.tryUnlockGate(gate.id)) {
                this.gatePopup?.destroy();
                this.gatePopup = null;
                this.gatePopupId = '';
                this.popupPanels = [];
                this.openGateObjects(gate); // 연결된 문 오브젝트 숨김 (잠김→열림)
                this.showZoneBannerText(`${destName} 개방!`, '#9FE870');
            }
        });
    }

    /**
     * 해금 시 연결된 문 오브젝트를 숨긴다 (잠김 → 열림).
     * 게이트의 `objectLink1`에 문 오브젝트를 연결하면 해금과 함께 사라진다 —
     * 열린 문 비주얼이 필요하면 그 자리에 별도 오브젝트를 겹쳐 두면 된다 (임의).
     */
    private openGateObjects(gate: MapTriggerDef) {
        for (const id of gate.objectLinks ?? []) {
            const node = this.objectNodes.get(id);
            if (node) node.active = false;
        }
    }

    /** 열려 있는 동안 보유 골드·버튼 활성 상태 갱신 */
    private refreshGatePopup(gate: MapTriggerDef) {
        const cost = gate.unlockCost ?? 0;
        if (cost === 0) return; // 무료 통과 — 갱신할 수치 없음
        const enough = this.goldCount >= cost;
        if (this.gateCostLabel) this.gateCostLabel.string = `해금 비용   ${cost}G`;
        if (this.gateGoldLabel) {
            this.gateGoldLabel.string = `보유 골드   ${this.goldCount}`;
            this.gateGoldLabel.color = this.color(enough ? '#F0B429' : '#C0503F'); // 부족하면 빨강
        }
        // 골드 부족 시 버튼 비활성 표현
        const sp = this.gateButton?.getComponent(Sprite);
        if (sp) sp.color = this.color(enough ? '#3A3050' : '#2A2434');
        if (this.gateButtonLabel) this.gateButtonLabel.color = this.color(enough ? '#F7EFD8' : '#6C6480');
    }

    /** 골드 획득 "+N" 팝업 — 상시 카운터 대신 순간 연출 (BIBLE §10-a) */
    private showGoldGain(amount: number) {
        const node = this.makeNode('GoldGain', this.entities);
        const p = this.player.position;
        node.setPosition(p.x, p.y + IngameBootstrap.CHAR_PX, 0);
        (node as unknown as { __sortY: number }).__sortY = -1e6; // 팝업은 최전면
        const lb = node.addComponent(Label);
        lb.string = `+${amount}`;
        lb.fontSize = 44;
        lb.isBold = true;
        lb.color = this.color('#F0B429');
        this.goldPopups.push({ node, t: 0 });
    }

    private updateGoldPopups(dt: number) {
        for (let i = this.goldPopups.length - 1; i >= 0; i--) {
            const g = this.goldPopups[i];
            g.t += dt;
            g.node.setPosition(g.node.position.x, g.node.position.y + 60 * dt, 0); // 위로 떠오름
            const op = g.node.getComponent(UIOpacity) ?? g.node.addComponent(UIOpacity);
            op.opacity = 255 * Math.max(0, 1 - g.t / 0.9);
            if (g.t >= 0.9) {
                g.node.destroy();
                this.goldPopups.splice(i, 1);
            }
        }
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
        // 실기기에서 큰 볼드 폰트가 글리프 겹침으로 깨지는 문제 회피 (로비 로고와 동일 증상)
        this.bannerLabel.cacheMode = Label.CacheMode.BITMAP;
        this.bannerFade = bn.addComponent(UIOpacity);
        this.bannerFade.opacity = 0;
    }

    /** 임의 문구 배너 (게이트 개방 알림 등) */
    private showZoneBannerText(text: string, hex: string) {
        if (!this.bannerLabel || !this.bannerFade) return;
        this.bannerLabel.string = text;
        this.bannerLabel.color = this.color(hex);
        this.bannerFade.opacity = 255;
        this.bannerTimer = 1.8;
    }

    private showZoneBanner(z: ZoneDef, nameOverride?: string) {
        if (!this.bannerLabel || !this.bannerFade) return;
        this.bannerLabel.string = nameOverride ?? z.name;
        const bannerColor = z.kind === 'dungeon' ? '#B9A6F0'
            : z.kind === 'corridor' ? '#9FA6B0' : '#F2A93B';
        this.bannerLabel.color = this.color(bannerColor);
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
        let panelTran = panel.getComponent(UITransform);
        if (!panelTran) {
            panel.addComponent(UITransform).setContentSize(340, 100);
        } else {
            panelTran.setContentSize(340, 100);
        }

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
        // 팝업 패널(버튼) 위 터치만 조이스틱 제외 — 딤 영역은 이동 가능해야 팝업을 닫을 수 있다
        if (this.popupOpen() && this.touchOnPopupPanel(e.getUILocation())) return;
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
            // 바라보기 — 입력 벡터를 8방향으로 스냅 (주인공만 8방향, 합의 2026-08-07)
            const face = dirFromScreen(sx, sy);
            if (face) this.setFacing(face);

            const len = Math.hypot(sx, sy);
            // 무게 페널티 — 스택이 쌓일수록 느려짐 (운반의 무게, C7 리스크 테이킹) + 이동속도 강화 반영
            const base = this.moveSpeed + this.upgradeBonus('speed');
            const speed = (base - IngameBootstrap.WEIGHT_PENALTY * this.carryCount) * inputMag;
            const step = (speed * dt) / len;
            const d = screenToGrid(sx * step, sy * step);
            this.tryMove(d.gx, d.gy);
            this.player.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);
            this.detectZone();
        }

        // 플레이어 애니메이션 (이동 중이면 walk, 아니면 idle — 클립 없으면 정적 유지)
        this.movingNow = sx !== 0 || sy !== 0; // 공격 클립 분화 판단에 재사용
        this.updatePlayerAnim(dt, this.movingNow);

        // 가상화 타일 갱신 (중심 타일이 바뀔 때만 내부 재계산)
        if (this.tileView) this.tileView.update(this.pgx, this.pgy, this.zoom);
        this.updateFloorCulling();
        this.updateGoldPopups(dt);
        this.updateGatePopup();    // 문 앞이면 해금 팝업 자동 열림 / 벗어나면 자동 닫힘 (§10-b)
        this.updateUpgradePopup(); // 강화 발판 위면 강화 팝업 (§10-b)

        // 던전 코어 갱신 + 깊이 정렬 (개체가 움직이므로 매 프레임)
        if (this.combat) {
            this.combat.update(dt);
            this.customerSystem?.update(dt); // 손님 이동 먼저 — 트리거가 갱신된 위치를 봄
            this.triggerSystem?.update(dt);
            this.sortEntities();
        }

        // 플레이어 피격 플래시 (붉게 번쩍)
        if (this.playerFlashT > 0 && this.playerSprite) {
            this.playerFlashT -= dt;
            this.playerSprite.color = this.playerFlashT > 0
                ? this.color('#FF6A5A') : this.color('#FFFFFF');
        }

        // 카메라 팔로우 — World를 옮겨 플레이어를 따라가되, 맵 경계 밖(void)이 과하게 보이지 않게
        // 카메라 중심을 맵 범위 안으로 클램프한다. 가장자리에선 중앙 고정 대신 맵이 화면을 채운다.
        const z = this.zoom;
        const R = this.map.groundRadius;
        const vs = view.getVisibleSize();
        const halfW = vs.width / 2 / z;   // 뷰포트 반폭(월드 단위)
        const halfH = vs.height / 2 / z;
        const halfMapX = R * TILE_W;      // 아이소 맵 x 반경 (isoX(R,-R))
        const halfMapY = R * TILE_H;      // 아이소 맵 y 반경 (isoY(R,R))
        const marginX = TILE_W;
        const marginTop = IngameBootstrap.CHAR_PX + TILE_H; // 위: 캐릭터 머리 보이게 여유
        const marginBottom = TILE_H;                         // 아래: 최소 여백
        const limX = halfMapX + marginX - halfW;
        const cx = math.clamp(isoX(this.pgx, this.pgy), Math.min(0, -limX), Math.max(0, limX));
        const cy = math.clamp(isoY(this.pgx, this.pgy),
            Math.min(0, -(halfMapY + marginBottom - halfH)),
            Math.max(0, halfMapY + marginTop - halfH));
        const targetX = -cx * z;
        const targetY = -cy * z;
        const p = this.world.position;
        const t = Math.min(1, this.followSmooth * dt);
        this.world.setScale(z, z, 1);
        this.world.setPosition(math.lerp(p.x, targetX, t), math.lerp(p.y, targetY, t), 0);
    }

    // ── 배경 (맵 밖 여백판 — 바닥 자체는 TileView가 그림) ──
    private mapW() { return (this.map.groundRadius * 2 + 1) * TILE_W; }
    private mapH() { return (this.map.groundRadius * 2 + 1) * TILE_H; }

    private buildBackground(parent: Node) {
        const bg = this.addSprite('Background', parent, this.squareFrame(),
            this.mapW(), this.mapH(), this.color('#22222A'));
        bg.setPosition(0, 0, 0);
    }

    // ── 벽 충돌 (축 분리 이동 — 벽에 비스듬히 닿으면 미끄러짐) ──
    private tryMove(dgx: number, dgy: number) {
        const R = this.map.groundRadius;
        const nx = math.clamp(this.pgx + dgx, -R, R);
        if (!this.hitsWall(nx, this.pgy) && !this.hitsSolidObject(nx, this.pgy)
            && !this.hitsLockedGate(nx, this.pgy)) this.pgx = nx;
        const ny = math.clamp(this.pgy + dgy, -R, R);
        if (!this.hitsWall(this.pgx, ny) && !this.hitsSolidObject(this.pgx, ny)
            && !this.hitsLockedGate(this.pgx, ny)) this.pgy = ny;
    }

    /** 이동 가능 = "존이 칠해진 타일" 위. 타일 없음/zone 없음(0)/attr 이동불가(1) = 차단 */
    private hitsWall(gx: number, gy: number): boolean {
        const R = this.map.groundRadius;
        const row = this.tileGrid[Math.round(gy) + R];
        const t = row ? row[Math.round(gx) + R] : undefined;
        return !t || t.zone === ZoneType.None || t.attr === TILE_ATTR_BLOCKED;
    }

    /** 잠긴 게이트 타일은 통과 불가 — 해금하면 그대로 지나갈 수 있다 (BIBLE §7-c) */
    private hitsLockedGate(gx: number, gy: number): boolean {
        return !!this.triggerSystem?.lockedGateAt(gx, gy);
    }

    /**
     * 문 앞에 서 있는지 — 잠긴 게이트에 인접(정방향 1칸)하면 팝업을 연다.
     * 게이트 타일 자체가 통과 불가(문)라서 그 위에 설 수 없으므로, "문 앞 발판"을
     * 별도 영역으로 만들지 않고 인접 판정으로 대체했다 (임의 — 규격 §7-c "문 앞 발판" 해석).
     */
    private gateInFront(): MapTriggerDef | null {
        const ts = this.triggerSystem;
        if (!ts) return null;
        const gx = Math.round(this.pgx), gy = Math.round(this.pgy);
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const g = ts.lockedGateAt(gx + dx, gy + dy);
            if (g) return g;
        }
        return null;
    }

    /** 플레이어 전용 오브젝트 점유 판정. walkable=true인 오브젝트는 통과한다. */
    private hitsSolidObject(gx: number, gy: number): boolean {
        const tx = Math.round(gx);
        const ty = Math.round(gy);
        for (const object of this.map.objects ?? []) {
            if (object.walkable) continue;
            // 게이트 해금으로 숨겨진(열린) 문 오브젝트는 더 이상 막지 않는다
            if (object.id && this.objectNodes.get(object.id)?.active === false) continue;
            if (tx >= object.gx && tx < object.gx + object.w &&
                ty >= object.gy && ty < object.gy + object.h) return true;
        }
        return false;
    }

    /** 플레이어가 어느 존에 있는지 판정 — 밟고 있는 타일의 zone 속성 기반 */
    private detectZone() {
        const zi = this.zoneIndexAtTile(this.pgx, this.pgy);
        const found: ZoneDef | null = zi > 0 ? (this.map.zones[zi - 1] ?? null) : null;
        const did = found?.kind === 'dungeon' ? this.dungeonIdAt(this.pgx, this.pgy) : 0;
        if (found !== this.currentZone || did !== this.currentDungeonId) {
            this.currentZone = found;
            this.currentDungeonId = did;
            this.refreshHpBarVisible(); // HP바는 사냥지대에서만 (BIBLE §10-a)
            // 던전은 지역 이름(d1 등) 우선 표시 — 던전끼리 붙어 있어도 이동 시 배너 재표시
            if (found) this.showZoneBanner(found, did > 0 ? this.dungeonNames.get(did) : undefined);
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

    // ── 구역 통짜 바닥 이미지 (타일별 이미지 대체) ──
    private buildFloors(parent: Node) {
        this.floorSprites = [];
        const floors = this.makeNode('Floors', parent);
        for (const r of this.map.regions ?? []) {
            const id = r.floorImg ?? 0;
            if (!id) continue;
            const f = this.floorFrames.get(id);
            const scale = r.floorScale ?? 1;
            const cx = r.gx + (r.w - 1) / 2, cy = r.gy + (r.h - 1) / 2;
            const x = isoX(cx, cy) + (r.floorOffX ?? 0);
            const y = isoY(cx, cy) + (r.floorOffY ?? 0);
            let node: Node, w: number, h: number;
            if (f) {
                w = f.rect.width * scale; h = f.rect.height * scale;
                node = this.addSprite(`floor_${r.name}`, floors, f, w, h, this.color('#FFFFFF'));
            } else {
                // 이미지 없음 — 구역 크기 마젠타 플레이스홀더 (floorImg 지정됐으나 파일 못 찾음)
                console.warn(`[IngameBootstrap] 바닥 이미지 ${id}번을 찾지 못함 (구역 ${r.name}) — 플레이스홀더 표시`);
                w = (r.w + r.h) * TILE_W / 2; h = (r.w + r.h) * TILE_H / 2;
                node = this.addSprite(`floor_missing_${r.name}`, floors, this.diamondFrame(), w, h, this.color('#DC46C8', 150));
            }
            node.setPosition(x, y, 0);
            this.floorSprites.push({ node, x, y, hw: w / 2, hh: h / 2 });
        }
    }

    /** 화면 밖 바닥 이미지는 그리지 않음 — 뷰포트 사각형과 교차하는 것만 활성 */
    private updateFloorCulling() {
        if (this.floorSprites.length === 0) return;
        const vs = view.getVisibleSize();
        const halfVW = vs.width / 2 / this.zoom + TILE_W;
        const halfVH = vs.height / 2 / this.zoom + TILE_H;
        const ccx = isoX(this.pgx, this.pgy);
        const ccy = isoY(this.pgx, this.pgy);
        for (const f of this.floorSprites) {
            const visible = Math.abs(f.x - ccx) <= halfVW + f.hw
                && Math.abs(f.y - ccy) <= halfVH + f.hh;
            if (f.node.active !== visible) f.node.active = visible;
        }
    }

    // ── 맵 오브젝트 (타일 단위 배치물 — 에디터 objects 루트) ──
    /** objectId → 노드 — 트리거가 연결된 오브젝트를 런타임에 조작(게이트 해금 시 문 숨김) */
    private objectNodes = new Map<string, Node>();

    private buildObjects(parent: Node) {
        this.objectNodes.clear();
        for (const o of this.map.objects ?? []) {
            // 발자국(w×h 타일) 중심에 배치 — 아이소 폭/높이 = (w+h)/2 타일
            const cx = o.gx + (o.w - 1) / 2;
            const cy = o.gy + (o.h - 1) / 2;
            const isoW = (o.w + o.h) / 2 * TILE_W;
            const isoH = (o.w + o.h) / 2 * TILE_H;
            const p = this.makeNode(`obj_${o.kind}`, parent);
            p.setPosition(isoX(cx, cy), isoY(cx, cy), 0);
            if (o.id) this.objectNodes.set(o.id, p); // 트리거가 연결로 참조할 수 있게 등록
            // 바닥 데칼 = 항상 캐릭터보다 먼저(뒤에) 그려지게 — 정렬 깊이를 최후방으로
            if (o.floorDecal) (p as unknown as { __sortY: number }).__sortY = 1e6;

            if (!o.floorDecal) { // 바닥 데칼은 그림자 없음(바닥에 붙음)
                const shadow = this.addSprite('Shadow', p, this.diamondFrame(),
                    isoW * 0.95, isoH * 0.95, this.color('#000000', 90));
                shadow.setPosition(0, 0, 0);
            }

            const scale = o.imgScale ?? 1;
            const offX = o.imgOffX ?? 0, offY = o.imgOffY ?? 0;
            const art = this.objFrames.get(o.img);
            if (art) {
                // 이미지 크기 = 원본×배율 (타일 크기와 무관). 하단 = 발자국 아래 꼭짓점(앵커) + offset
                const bw = art.rect.width * scale, bh = art.rect.height * scale;
                const body = this.addSprite('Body', p, art, bw, bh, this.color('#FFFFFF'));
                body.setPosition(offX, -isoH / 2 + bh / 2 + offY, 0);
            } else {
                // 이미지 미지정 — 실루엣 박스 폴백 (발자국 아이소 폭 기준)
                const bh = isoW * 0.6;
                const body = this.addSprite('Body', p, this.squareFrame(), isoW * 0.8, bh, this.color('#8A6A4A'));
                body.setPosition(offX, -isoH / 2 + bh / 2 + offY, 0);
            }
        }
    }

    /** 손님으로 취급하는 NPC kind — 대기열 이동·판매 루프 대상 (그 외 NPC는 정적 표시) */
    private static readonly CUSTOMER_KINDS = new Set(['customer', '손님']);

    // ── NPC (손님 kind = 스폰 트리거로 복제될 템플릿, 나머지는 정적 표시) ──
    private buildNpcs(parent: Node) {
        const c = IngameBootstrap.CHAR_PX;
        this.triggerNpcs = [];   // 손님은 CustomerSystem이 스폰 시 채움
        this.npcTemplates = [];  // 배치된 손님 = 복제 템플릿
        // 손님 템플릿은 숨김 컨테이너에 만들어 두고, 스폰 시 복제해서 쓴다
        const templatesRoot = this.makeNode('NpcTemplates', this.node);
        templatesRoot.active = false;

        for (const u of this.map.npcs ?? []) {
            const isCustomer = IngameBootstrap.CUSTOMER_KINDS.has(u.kind);
            const host = isCustomer ? templatesRoot : parent;
            const p = this.makeNode(`npc_${u.kind}`, host);
            if (!isCustomer) p.setPosition(isoX(u.gx, u.gy), isoY(u.gx, u.gy), 0);

            const shadow = this.addSprite('Shadow', p, this.diamondFrame(),
                TILE_W * 0.55, TILE_H * 0.55, this.color('#000000', 90));
            shadow.setPosition(0, 0, 0);

            const art = this.unitFrames.get(u.img);
            let body: Node;
            if (art) {
                const w = c * (art.rect.width / art.rect.height);
                body = this.addSprite('Body', p, art, w, c, this.color('#FFFFFF'));
            } else {
                body = this.addSprite('Body', p, this.squareFrame(), c * 0.6, c * 0.8, this.color('#3BAF6E'));
            }
            body.setPosition(0, c / 2, 0); // 발이 타일 중심에 닿게

            if (isCustomer) this.npcTemplates.push({ node: p, img: u.img, kind: u.kind });
        }
    }

    /** 아이소 깊이 정렬 — 화면 y가 클수록(위) 뒤로. Entities 자식 siblingIndex 갱신 */
    private sortEntities() {
        const children = this.entities.children.slice();
        // 화면 y가 클수록(위) 뒤로. 일부 노드는 __sortY로 정렬 깊이를 따로 지정(트리거 아이템 등)
        const sortY = (n: Node) => (n as unknown as { __sortY?: number }).__sortY ?? n.position.y;
        children.sort((a, b) => sortY(b) - sortY(a));
        for (let i = 0; i < children.length; i++) {
            children[i].setSiblingIndex(i);
        }
    }

    /** 기본 캐릭터 크기 — C3 아트 레퍼런스 확정 (2026-07-10): 128×128 @ 1080×1920 */
    private static readonly CHAR_PX = 128;

    /** 몬스터 표시 높이 (임의) — 플레이어(128)보다 작아 보이게 */
    private static readonly MONSTER_PX = 88;

    // ── 플레이어(하얀 네모 + 발밑 그림자) ──
    private buildPlayer(parent: Node): Node {
        const c = IngameBootstrap.CHAR_PX;
        const p = this.makeNode('Player', parent);
        p.setPosition(isoX(this.pgx, this.pgy), isoY(this.pgx, this.pgy), 0);

        // 아트가 있으면 원화(높이 c 기준, 폭은 원본 비율), 없으면 흰 박스 폴백
        const art = this.staticArt();
        let body: Node;
        if (art) {
            const w = c * (art.rect.width / art.rect.height);
            body = this.addSprite('Body', p, art, w, c, this.color('#FFFFFF'));
        } else {
            body = this.addSprite('Body', p, this.squareFrame(), c, c, this.color('#FFFFFF'));
        }
        body.setPosition(0, c / 2, 0); // 발이 타일 중심에 닿게
        this.playerSprite = body.getComponent(Sprite);

        // 애니메이터 — 클립(player_idle/player_walk/player_attack)이 있으면 그쪽이 스프라이트를 굴린다.
        // 클립이 없으면 play()가 false를 돌려주고 위의 정적 원화가 그대로 유지된다 (아트 반입 전 폴백).
        this.playerAnim = new SpriteAnimator(body, this.playerSprite!,
            (k, n) => this.animFrameOf(k, n),
            (ev) => { if (ev === 'hit') this.combat?.triggerAttackHit(); });
        const ut = body.getComponent(UITransform);
        this.playerAnim.setBase(0, c / 2, ut ? ut.contentSize.width : c, ut ? ut.contentSize.height : c);
        // 클립 프레임은 여유 패딩이 붙어 원화와 비율이 다르다 → 클립이 바뀔 때마다 높이 c 기준으로 다시 맞춘다
        this.playerAnim.setFitHeight(c, this.color('#FFFFFF'));
        return p;
    }

    /**
     * 방향별 클립 재생 — **아트 물량을 데이터로 선택**할 수 있게 두 방식을 모두 지원한다:
     *  ① `{kind}_{state}_{left|right}` 클립이 있으면 그걸 그대로 (양방향을 따로 그린 경우)
     *  ② 없으면 `{kind}_{state}` + **좌우 반전** (한쪽만 그린 경우 — 물량 절반)
     * 반환: 실제로 재생 중인 클립 키 ('' = 클립 없음 → 정적 이미지 유지)
     */
    private playDirectional(anim: SpriteAnimator | null, kind: string, states: string[],
        dir: Dir8, restart = false): string {
        if (!anim || !this.animData) return '';
        const data = this.animData;
        const side = sideOf(dir) ?? this.lastSide; // n·s는 좌우 성분이 없어 직전 값을 쓴다
        const tryKey = (state: string, d: string, mirror: boolean): string => {
            const k = `${kind}_${state}_${d}`;
            if (!data.clips[k]) return '';
            anim.setMirror(mirror);
            return anim.play(data, k, restart) ? k : '';
        };
        // 상태는 **선호 순서**대로 (예: idle_heavy → idle). 각 상태 안에서 방향 폴백을 먼저 다 시도한다
        // — "만재 걸음"처럼 상태가 주는 정보가 방향 정확도보다 중요하기 때문.
        for (const state of states) {
            // ① 그 방향 클립 그대로
            let key = tryKey(state, dir, false);
            if (key) return key;
            // ② 좌우 반전 짝 (e·ne·se만 그려도 w·nw·sw가 나온다 — BIBLE §6-a 제작 5방향)
            const pair = DIR8_MIRROR[dir];
            if (pair) {
                key = tryKey(state, pair, true);
                if (key) return key;
            }
            // ③ 8방향 아트 반입 전 폴백 — 좌/우(e·w) 클립으로 대체
            if (side !== dir) {
                key = tryKey(state, side, false);
                if (key) return key;
                key = tryKey(state, DIR8_MIRROR[side]!, true);
                if (key) return key;
            }
            // ④ 무방향 클립 + 좌우 반전
            const legacy = animKey(kind, state);
            if (data.clips[legacy]) {
                anim.setMirror(side === 'w');
                return anim.play(data, legacy, restart) ? legacy : '';
            }
        }
        return '';
    }

    /** 등짐 만재 여부 — 만재 전용 클립(idle_heavy·walk_heavy) 선택 + 공격 잠금 표시에 쓴다 */
    private isHeavy(): boolean {
        return this.carryCount >= 10 + this.upgradeBonus('carry');
    }

    /** 만재 전용 클립이 하나라도 반입됐는지 (방향 무관) — 땀 플레이스홀더 중복 방지 */
    private hasHeavyClips(): boolean {
        if (!this.animData) return false;
        for (const k of Object.keys(this.animData.clips)) {
            if (k.startsWith('player_idle_heavy') || k.startsWith('player_walk_heavy')) return true;
        }
        return false;
    }

    /** 정적 원화 (클립 미반입 폴백) — 좌/우 2장뿐이라 8방향 중 좌우 성분만 반영된다 */
    private staticArt(): SpriteFrame | null {
        return (this.lastSide === 'w' ? this.playerFrames.left : this.playerFrames.right) ?? null;
    }

    /** 바라보는 방향 변경 (8방향) — 애니메이션이 없을 때만 정적 좌/우 원화를 교체한다 */
    private setFacing(f: Dir8) {
        if (f === this.facing) return;
        this.facing = f;
        const side = sideOf(f);
        if (side) this.lastSide = side; // n·s는 좌우 성분이 없으므로 직전 값을 유지
        // 애니메이션이 돌고 있으면 방향은 클립·반전이 처리한다 (정적 교체는 덮어쓰기 충돌)
        const animating = !!this.playerAnim?.current;
        const art = this.staticArt();
        if (!animating && art && this.playerSprite) this.playerSprite.spriteFrame = art;
    }

    /**
     * 플레이어 애니메이션 상태 전환 — 이동 여부로 walk/idle, 공격 중엔 attack 유지.
     * attack 클립은 loop=false·next=player_idle로 두면 끝나고 자동 복귀한다.
     */
    private updatePlayerAnim(dt: number, moving: boolean) {
        const anim = this.playerAnim;
        if (!anim || !this.animData) return;
        // 공격 중에는 클립·방향을 그대로 둔다 (attack 종료 시 next로 복귀).
        // ⚠ 여기서 setMirror를 다시 걸면 안 된다 — 방향별 클립(player_attack_w)은
        //   playDirectional이 이미 반전 없이 재생했으므로 한 번 더 뒤집으면 반대로 보인다.
        const attacking = anim.current.startsWith('player_attack') && !anim.done;
        if (!attacking) {
            // 만재면 중량 초과 클립 우선, 없으면 기본 클립 (BIBLE §6-b 디테일 1)
            const base = moving ? 'walk' : 'idle';
            const states = this.isHeavy() ? [`${base}_heavy`, base] : [base];
            this.playDirectional(anim, 'player', states, this.facing);
        }
        anim.update(dt, this.animData);
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
