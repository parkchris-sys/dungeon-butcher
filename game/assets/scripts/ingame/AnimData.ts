/**
 * 스프라이트 애니메이션 클립 계약 — 순수 데이터, cc import 없음.
 * 원천: 애니메이션 편집 씬(animedit)이 내보낸 resources/anim/animdata.json.
 * 게임은 이 JSON만 읽는다 (맵 데이터와 동일한 흐름 — 에디터 씬은 빌드 미포함).
 *
 * 프레임 이미지는 파일명 규칙으로 매칭: `resources/chars/{종류}_{상태}_{n}.png`
 * (ASSET_LIST 규약: 영문 스네이크케이스 · 애니메이션은 프레임별 파일 `_1.png ~ _N.png`)
 */

/** 프레임 1장 — 이미지 + 프레임별 기교(offset·스케일·노출시간·이벤트) */
export interface AnimFrameDef {
    /** 프레임 번호 = 파일명의 `_n` (1부터). 0/없음이면 배열 순서를 사용 */
    img: number;
    /** 노출 시간 배수 (1=기본 1/fps, 0.5=짧게 스침, 2=두 배 길게) — 타이밍 기교 */
    hold?: number;
    /** 프레임별 화면 offset(px) — 통통 튀기·반동·머리 흔들림 */
    offX?: number;
    offY?: number;
    /** 프레임별 스케일 — 스쿼시&스트레치 (착지·타격 임팩트) */
    scaleX?: number;
    scaleY?: number;
    /** 이벤트 마커 — 이 프레임에 진입할 때 게임 로직에 알림 (예: 'hit' = 데미지 타이밍) */
    event?: string;
    /**
     * 등짐 스택 기준점 — 고기가 쌓이기 시작하는 위치 (등짐 컨셉, 2026-08-07).
     * **원본 이미지 픽셀** 기준, 원점은 **이미지 하단 중앙**(= 캐릭터 발밑), y는 위쪽이 +.
     * 런타임이 표시 크기에 맞춰 환산하고 좌우 반전 시 x를 뒤집는다.
     * 지정하지 않은 프레임은 **그 클립에서 마지막으로 지정된 값**을 이어 쓴다
     * (1번 프레임만 잡아도 되고, 걸음마다 흔들리게 하려면 프레임별로 잡으면 된다).
     * 클립 전체에 없으면 코드 기본값으로 폴백.
     */
    stackX?: number;
    stackY?: number;
}

/** 클립 1개 = 한 종류의 한 상태 (예: chicken_walk) */
export interface AnimClipDef {
    fps: number;            // 기본 프레임 속도 (hold 미지정 프레임에 적용)
    loop: boolean;
    /** 비반복 클립 종료 후 자동 전환할 클립 키 (예: player_attack → player_idle) */
    next?: string;
    frames: AnimFrameDef[];
}

/** 클립 키(`{종류}_{상태}`) → 정의 */
export interface AnimData {
    clips: Record<string, AnimClipDef>;
}

/** 기본 fps — 픽셀아트는 낮은 편이 잘 읽힌다 (임의, 기획·아트 확인 대상) */
export const ANIM_DEFAULT_FPS = 10;

/** 클립 키 만들기 — 파일명 규칙과 동일 (chicken + walk → chicken_walk) */
export function animKey(kind: string, state: string): string {
    return `${kind}_${state}`;
}

/** animdata.json → AnimData (형식이 깨졌으면 null) */
export function parseAnimDataJson(j: unknown): AnimData | null {
    const d = j as { clips?: Record<string, Partial<AnimClipDef>> };
    if (!d || !d.clips || typeof d.clips !== 'object') return null;
    const clips: Record<string, AnimClipDef> = {};
    for (const key of Object.keys(d.clips)) {
        const c = d.clips[key];
        const frames = Array.isArray(c?.frames) ? c!.frames! : [];
        if (frames.length === 0) continue; // 프레임 없는 클립은 무효
        clips[key] = {
            fps: c!.fps && c!.fps > 0 ? c!.fps : ANIM_DEFAULT_FPS,
            loop: c!.loop !== false, // 기본 반복
            next: c!.next,
            frames: frames.map((f, i) => ({
                img: f.img && f.img > 0 ? f.img : i + 1,
                hold: f.hold && f.hold > 0 ? f.hold : 1,
                offX: f.offX ?? 0,
                offY: f.offY ?? 0,
                scaleX: f.scaleX && f.scaleX > 0 ? f.scaleX : 1,
                scaleY: f.scaleY && f.scaleY > 0 ? f.scaleY : 1,
                event: f.event || undefined,
                // 0은 "미지정"으로 본다 — 발밑 중앙에 짐을 쌓는 경우는 없으므로
                stackX: f.stackX || undefined,
                stackY: f.stackY || undefined,
            })),
        };
    }
    return { clips };
}
