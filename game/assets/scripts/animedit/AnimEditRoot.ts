import {
    _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Color, Layers,
    RenderRoot2D, Label, CCObject, JsonAsset, assetManager, CCInteger,
} from 'cc';
import { EDITOR } from 'cc/env';
import { AnimClip } from './AnimClip';
import { AnimFrame } from './AnimFrame';
import { AnimData, AnimClipDef, AnimFrameDef, parseAnimDataJson } from '../ingame/AnimData';

const { ccclass, property, executeInEditMode } = _decorator;

declare const Editor: any; // 에디터 전역 (EDITOR 가드로 빌드 미포함)

const ANIM_JSON = 'db://assets/resources/anim/animdata.json';
const CHARS_DIR = 'db://assets/resources/chars';
const PREVIEW_PX = 256; // 미리보기 표시 높이(px) — 게임 128px의 2배로 크게 본다

/**
 * 애니메이션 편집 씬 루트 (에디터 전용) — AnimRoot 노드에 붙인다.
 *
 * 구조:  AnimRoot ─ clips ─ {클립 노드(AnimClip)} ─ {프레임 노드(AnimFrame)} …
 *                 └ _preview (자동 생성, 씬 저장 안 함)
 *
 * 프레임 이미지는 `resources/chars/{클립키}_{n}.png` 규칙으로 자동 매칭된다
 * (아트가 파일만 넣으면 목록에 잡힘 — 맵 에디터의 타일/오브젝트와 동일한 방식).
 *
 * Inspector:
 *  - addClip ✅       : 클립 노드 추가
 *  - addFrame ✅      : **미리보기 중인 클립**에 프레임 1장 추가
 *  - autoFillFrames ✅: 미리보기 클립의 이미지 파일을 스캔해 프레임을 자동 생성
 *  - exportJson ✅    : resources/anim/animdata.json 내보내기 (게임이 읽는 데이터)
 *  - importJson ✅    : animdata.json → 편집 노드로 복원
 */
@ccclass('AnimEditRoot')
@executeInEditMode
export class AnimEditRoot extends Component {
    @property({ tooltip: '체크 = 클립 추가 (clips 그룹에 새 노드)' })
    addClip = false;

    @property({ tooltip: '체크 = 미리보기 중인 클립에 프레임 1장 추가' })
    addFrame = false;

    @property({ tooltip: '체크 = 미리보기 클립의 이미지 파일(chars/{키}_{n}.png)을 스캔해 프레임 자동 생성' })
    autoFillFrames = false;

    @property({ tooltip: '체크 = resources/anim/animdata.json 내보내기' })
    exportJson = false;

    @property({ tooltip: '체크 = animdata.json 불러오기 ⚠️클립 노드를 파일 내용으로 교체' })
    importJson = false;

    @property({ type: CCInteger, visible: false })
    private _pad = 0; // (예약)

    // ── 미리보기 상태 ──
    private previewClip: AnimClip | null = null;
    private frameIdx = 0;
    private frameT = 0;
    private lastTime = 0;
    private previewSprite: Sprite | null = null;
    private infoLabel: Label | null = null;
    /** 클립키_n → SpriteFrame (에디터 캐시) */
    private frames = new Map<string, SpriteFrame>();
    private scanned = false;
    private rescanTick = 0;

    update() {
        if (!EDITOR) return;
        this.ensureView();
        this.ensureFrameCache();
        this.syncPreviewSelection();
        this.tickPreview();

        if (this.addClip) { this.addClip = false; this.doAddClip(); }
        if (this.addFrame) { this.addFrame = false; this.doAddFrame(); }
        if (this.autoFillFrames) { this.autoFillFrames = false; this.doAutoFill(); }
        if (this.exportJson) { this.exportJson = false; this.doExport(); }
        if (this.importJson) { this.importJson = false; this.doImport(); }
    }

    // ── 뷰 (미리보기 스프라이트 + 정보 라벨) ──
    private ensureView() {
        if (!this.node.getComponent(RenderRoot2D)) this.node.addComponent(RenderRoot2D);

        let preview = this.node.getChildByName('_preview');
        if (!preview) {
            preview = new Node('_preview');
            preview.hideFlags = CCObject.Flags.DontSave; // 런타임 프레임 — 씬 저장 금지
            preview.layer = Layers.Enum.UI_2D;
            this.node.addChild(preview);
            preview.addComponent(UITransform).setContentSize(PREVIEW_PX, PREVIEW_PX);
            const sp = preview.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            this.previewSprite = sp;
        } else if (!this.previewSprite) {
            this.previewSprite = preview.getComponent(Sprite);
        }

        let info = this.node.getChildByName('_info');
        if (!info) {
            info = new Node('_info');
            info.hideFlags = CCObject.Flags.DontSave;
            info.layer = Layers.Enum.UI_2D;
            this.node.addChild(info);
            info.setPosition(0, -PREVIEW_PX * 0.75, 0);
            const lb = info.addComponent(Label);
            lb.fontSize = 22;
            lb.lineHeight = 28;
            lb.color = new Color(255, 255, 255, 200);
            this.infoLabel = lb;
        } else if (!this.infoLabel) {
            this.infoLabel = info.getComponent(Label);
        }
    }

    // ── 프레임 이미지 캐시 (chars 폴더 스캔) ──
    private ensureFrameCache() {
        // 아직 못 찾은 이미지가 있으면 주기적으로 재스캔 (새 파일 추가 시 리로드 불필요)
        if (this.scanned && (++this.rescanTick % 120 !== 0)) return;
        if (this.scanned && this.frames.size > 0 && this.rescanTick % 120 !== 0) return;
        this.scanned = true;
        Editor.Message.request('asset-db', 'query-assets', { pattern: `${CHARS_DIR}/**/*` })
            .then((assets: Array<{ name?: string; uuid?: string }>) => {
                for (const a of assets ?? []) {
                    const name = String(a.name ?? '');
                    if (!a.uuid || a.uuid.includes('@')) continue;
                    if (!/^(.+)_(\d+)$/.test(name)) continue;
                    if (this.frames.has(name)) continue;
                    // 타일/오브젝트와 동일: spriteFrame 서브에셋 우선, 없으면 texture 래핑
                    assetManager.loadAny({ uuid: `${a.uuid}@f9941` }, (err: Error | null, sf: SpriteFrame) => {
                        if (!err && sf && sf.texture) { this.frames.set(name, sf); return; }
                        assetManager.loadAny({ uuid: `${a.uuid}@6c48a` }, (e2: Error | null, tex: any) => {
                            if (e2 || !tex) return;
                            const f = sf ?? new SpriteFrame();
                            f.texture = tex;
                            f.packable = false;
                            this.frames.set(name, f);
                        });
                    });
                }
            })
            .catch(() => { this.scanned = false; });
    }

    private frameOf(clipKey: string, n: number): SpriteFrame | null {
        return this.frames.get(`${clipKey}_${n}`) ?? null;
    }

    // ── 클립/프레임 노드 ──
    private clipsGroup(): Node {
        let g = this.node.getChildByName('clips');
        if (!g) {
            g = new Node('clips');
            g.layer = Layers.Enum.UI_2D;
            this.node.addChild(g);
        }
        return g;
    }

    /** 클립 노드 목록 (컴포넌트 자동 부착 — 복제해서 만들어도 바로 편집 가능) */
    private clipList(): AnimClip[] {
        const out: AnimClip[] = [];
        for (const n of this.clipsGroup().children) {
            if (n.name.startsWith('_')) continue;
            out.push(n.getComponent(AnimClip) ?? n.addComponent(AnimClip));
        }
        return out;
    }

    /** 클립의 프레임 목록 = 자식 순서 (컴포넌트 자동 부착) */
    private frameList(clip: AnimClip): AnimFrame[] {
        const out: AnimFrame[] = [];
        for (const n of clip.node.children) {
            if (n.name.startsWith('_')) continue;
            out.push(n.getComponent(AnimFrame) ?? n.addComponent(AnimFrame));
        }
        return out;
    }

    private doAddClip() {
        const g = this.clipsGroup();
        const n = new Node(`클립${g.children.length + 1}`);
        n.layer = Layers.Enum.UI_2D;
        g.addChild(n);
        const c = n.addComponent(AnimClip);
        c.clipKey = '';
        c.preview = true; // 새로 만든 클립을 바로 편집하도록
        for (const other of this.clipList()) if (other !== c) other.preview = false;
        console.log('[AnimEditRoot] 클립 추가 — clipKey를 `{종류}_{상태}`로 지정하세요 (예: chicken_walk)');
    }

    private doAddFrame() {
        const clip = this.previewClip;
        if (!clip) { console.warn('[AnimEditRoot] 미리보기 중인 클립이 없습니다 (클립 노드의 preview 체크)'); return; }
        const idx = clip.node.children.length + 1;
        const n = new Node(`f${idx}`);
        n.layer = Layers.Enum.UI_2D;
        clip.node.addChild(n);
        const f = n.addComponent(AnimFrame);
        f.img = idx; // 기본값 = 순서 번호
        console.log(`[AnimEditRoot] 프레임 추가 (${clip.clipKey || '키 미지정'} #${idx})`);
    }

    /** 이미지 파일을 스캔해 프레임 자동 생성 — `{키}_1`부터 끊기기 전까지 */
    private doAutoFill() {
        const clip = this.previewClip;
        if (!clip || !clip.clipKey) {
            console.warn('[AnimEditRoot] 미리보기 클립과 clipKey를 먼저 지정하세요');
            return;
        }
        let count = 0;
        while (this.frameOf(clip.clipKey, count + 1)) count++;
        if (count === 0) {
            console.warn(`[AnimEditRoot] '${clip.clipKey}_1.png'을 찾지 못했습니다 — resources/chars에 파일이 있는지, 이름 규칙이 맞는지 확인하세요`);
            return;
        }
        for (const c of [...clip.node.children]) c.destroy();
        for (let i = 1; i <= count; i++) {
            const n = new Node(`f${i}`);
            n.layer = Layers.Enum.UI_2D;
            clip.node.addChild(n);
            n.addComponent(AnimFrame).img = i;
        }
        console.log(`[AnimEditRoot] '${clip.clipKey}' 프레임 ${count}장 자동 생성`);
    }

    // ── 미리보기 재생 ──
    private syncPreviewSelection() {
        let next: AnimClip | null = null;
        for (const c of this.clipList()) {
            if (!c.preview) continue;
            if (!next) next = c;
            else c.preview = false; // 한 번에 하나만
        }
        if (next !== this.previewClip) {
            this.previewClip = next;
            this.frameIdx = 0;
            this.frameT = 0;
        }
    }

    private tickPreview() {
        const clip = this.previewClip;
        const sp = this.previewSprite;
        if (!clip || !sp) {
            if (this.infoLabel) this.infoLabel.string = '미리보기할 클립의 preview를 체크하세요';
            return;
        }
        const frames = this.frameList(clip);
        if (frames.length === 0) {
            if (this.infoLabel) this.infoLabel.string = `${clip.clipKey || '(키 미지정)'} — 프레임 없음 (autoFillFrames 또는 addFrame)`;
            return;
        }

        // 에디터에는 dt가 없으므로 실시간 시계로 진행
        const now = Date.now() / 1000;
        const dt = this.lastTime > 0 ? Math.min(0.1, now - this.lastTime) : 0;
        this.lastTime = now;

        if (this.frameIdx >= frames.length) this.frameIdx = 0;
        const cur = frames[this.frameIdx];
        const fps = clip.fps > 0 ? clip.fps : 10;
        const dur = (1 / fps) * (cur.hold > 0 ? cur.hold : 1);
        this.frameT += dt;
        if (this.frameT >= dur) {
            this.frameT -= dur;
            const last = this.frameIdx >= frames.length - 1;
            this.frameIdx = last ? 0 : this.frameIdx + 1; // 편집 중에는 항상 순환 재생
        }

        const f = frames[this.frameIdx];
        const imgNo = f.img > 0 ? f.img : this.frameIdx + 1;
        const sf = this.frameOf(clip.clipKey, imgNo);
        if (sf) {
            sp.spriteFrame = sf;
            sp.node.active = true;
            // 게임과 동일한 비율 유지 + 프레임별 스쿼시
            const aspect = sf.rect.width / Math.max(1, sf.rect.height);
            const h = PREVIEW_PX * (f.scaleY > 0 ? f.scaleY : 1);
            const w = PREVIEW_PX * aspect * (f.scaleX > 0 ? f.scaleX : 1);
            sp.node.getComponent(UITransform)!.setContentSize(w, h);
            // 프레임별 offset (게임 px → 미리보기 배율 반영)
            const k = PREVIEW_PX / 128;
            sp.node.setPosition(f.offX * k, f.offY * k, 0);
        } else {
            sp.node.active = false;
        }
        if (this.infoLabel) {
            this.infoLabel.string = `${clip.clipKey || '(키 미지정)'}  ${this.frameIdx + 1}/${frames.length}`
                + `  img=${imgNo}${sf ? '' : ' ⚠이미지 없음'}  hold=${f.hold}`
                + (f.event ? `  event=${f.event}` : '');
        }
    }

    // ── 내보내기 / 불러오기 (mapdata와 동일한 왕복) ──
    private doExport() {
        const clips: Record<string, AnimClipDef> = {};
        let frameTotal = 0;
        for (const c of this.clipList()) {
            const key = c.clipKey.trim();
            if (!key) { console.warn(`[AnimEditRoot] 클립 '${c.node.name}'의 clipKey가 비어 있어 제외됩니다`); continue; }
            if (clips[key]) console.warn(`[AnimEditRoot] 클립 키 중복: ${key}`);
            const frames: AnimFrameDef[] = this.frameList(c).map((f, i) => ({
                img: f.img > 0 ? f.img : i + 1,
                hold: f.hold !== 1 ? f.hold : undefined,
                offX: f.offX || undefined,
                offY: f.offY || undefined,
                scaleX: f.scaleX !== 1 ? f.scaleX : undefined,
                scaleY: f.scaleY !== 1 ? f.scaleY : undefined,
                event: f.event.trim() || undefined,
            }));
            if (frames.length === 0) { console.warn(`[AnimEditRoot] 클립 '${key}'에 프레임이 없어 제외됩니다`); continue; }
            frameTotal += frames.length;
            clips[key] = {
                fps: c.fps > 0 ? c.fps : 10,
                loop: c.loop,
                next: c.next.trim() || undefined,
                frames,
            };
        }
        Editor.Message.request('asset-db', 'create-asset', ANIM_JSON, JSON.stringify({ clips }), { overwrite: true })
            .then(() => console.log(`[AnimEditRoot] 내보내기 완료 → ${ANIM_JSON} (클립 ${Object.keys(clips).length}개, 프레임 ${frameTotal}장)`))
            .catch((e: unknown) => console.warn('[AnimEditRoot] 내보내기 실패', e));
    }

    private doImport() {
        Editor.Message.request('asset-db', 'query-asset-info', ANIM_JSON)
            .then((info: { uuid?: string } | null) => {
                if (!info?.uuid) { console.warn('[AnimEditRoot] animdata.json이 없습니다'); return; }
                assetManager.loadAny({ uuid: info.uuid }, (err: Error | null, asset: JsonAsset) => {
                    if (err || !asset) { console.warn('[AnimEditRoot] animdata.json 로드 실패', err); return; }
                    this.applyImport(parseAnimDataJson(asset.json));
                });
            })
            .catch((e: unknown) => console.warn('[AnimEditRoot] 조회 실패', e));
    }

    private applyImport(data: AnimData | null) {
        if (!data) { console.warn('[AnimEditRoot] animdata.json 형식이 올바르지 않습니다'); return; }
        const g = this.clipsGroup();
        this.previewClip = null;
        for (const c of [...g.children]) c.destroy();
        let first = true;
        for (const key of Object.keys(data.clips)) {
            const def = data.clips[key];
            const n = new Node(key);
            n.layer = Layers.Enum.UI_2D;
            g.addChild(n);
            const c = n.addComponent(AnimClip);
            c.clipKey = key;
            c.fps = def.fps;
            c.loop = def.loop;
            c.next = def.next ?? '';
            c.preview = first; // 첫 클립을 미리보기로
            first = false;
            def.frames.forEach((f, i) => {
                const fn = new Node(`f${i + 1}`);
                fn.layer = Layers.Enum.UI_2D;
                n.addChild(fn);
                const fc = fn.addComponent(AnimFrame);
                fc.img = f.img;
                fc.hold = f.hold ?? 1;
                fc.offX = f.offX ?? 0;
                fc.offY = f.offY ?? 0;
                fc.scaleX = f.scaleX ?? 1;
                fc.scaleY = f.scaleY ?? 1;
                fc.event = f.event ?? '';
            });
        }
        console.log(`[AnimEditRoot] 불러오기 완료 — 클립 ${Object.keys(data.clips).length}개`);
    }
}
