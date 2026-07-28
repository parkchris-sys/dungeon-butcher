import {
    _decorator, Component, Sprite, UITransform, Color,
    CCInteger, CCString, Enum,
} from 'cc';
import { EDITOR } from 'cc/env';
import { TriggerType, ResourceKind } from '../ingame/MapData';

const { ccclass, property, executeInEditMode } = _decorator;
const B = 32;
const TRIGGER_MAX = 16;

export enum MapTriggerKind {
    IngredientDropoff = 0,
    Cooking = 1,
    ServingCounter = 2,
    PurchaseSpot = 3,
    Checkout = 4,
    MoneyPickup = 5,
    NpcSpawn = 6,
    /** 플레이어리소스이동 — 연결 트리거 있으면 플레이어 보유분을 보냄, 없으면 쌓인 것을 플레이어가 회수 */
    PlayerResource = 7,
}

const TYPE_NAMES: TriggerType[] = [
    'ingredient-dropoff',
    'cooking',
    'serving-counter',
    'purchase-spot',
    'checkout',
    'money-pickup',
    'npc-spawn',
    'player-resource',
];

const TYPE_COLORS = [
    '#D96C4A',
    '#E58E26',
    '#C8A951',
    '#4CA66B',
    '#5379C8',
    '#9B63C5',
    '#3FBFBF',
    '#E0559B',
];

/** Inspector 드롭다운용 리소스 종류 — 값 순서는 RESOURCE_NAMES와 일치 */
export enum MapResourceKind {
    생고기 = 0,
    요리 = 1,
    돈 = 2,
}
const RESOURCE_NAMES: ResourceKind[] = ['raw', 'cooked', 'money'];

export function resourceKindOf(v: MapResourceKind): ResourceKind {
    return RESOURCE_NAMES[v] ?? 'raw';
}
export function resourceEnumOf(r: ResourceKind | undefined): MapResourceKind {
    const i = RESOURCE_NAMES.indexOf(r ?? 'raw');
    return (i < 0 ? 0 : i) as MapResourceKind;
}

export function triggerTypeOf(kind: MapTriggerKind): TriggerType {
    return TYPE_NAMES[kind] ?? 'ingredient-dropoff';
}

export function triggerKindOf(type: TriggerType): MapTriggerKind {
    const i = TYPE_NAMES.indexOf(type);
    return (i < 0 ? 0 : i) as MapTriggerKind;
}

/**
 * 맵 에디터용 트리거 영역.
 * triggerId/objectId 문자열로 연결하므로 노드 이름이나 배열 순서가 바뀌어도 연결이 유지된다.
 */
@ccclass('MapTrigger')
@executeInEditMode
export class MapTrigger extends Component {
    @property({ type: CCString, tooltip: '트리거 고유 ID. 다른 트리거의 연결 대상에 이 값을 입력합니다.' })
    triggerId = '';

    @property({ type: Enum(MapTriggerKind), tooltip: '트리거 처리 타입' })
    triggerType = MapTriggerKind.IngredientDropoff;

    @property({ type: CCInteger, tooltip: '점유 타일 수(가로)' })
    tileW = 1;

    @property({ type: CCInteger, tooltip: '점유 타일 수(세로)' })
    tileH = 1;

    @property({ type: CCString, tooltip: '연결 트리거 1번의 triggerId\n'
        + '플레이어리소스이동: 값이 있으면 → 그 트리거로 보내기 / 비우면 → 플레이어가 회수' })
    triggerLink1 = '';

    @property({ type: Enum(MapResourceKind), tooltip: '플레이어리소스이동 전용: 이송할 리소스 종류 (생고기/요리/돈)' })
    resource = MapResourceKind.생고기;

    @property({ type: CCString, tooltip: '연결 오브젝트 1번의 objectId (선택)' })
    objectLink1 = '';

    @property({ type: CCInteger, tooltip: 'NPC스폰(npc-spawn) 전용: 스폰할 NPC 외형 ID (maps/units, 0=기본)' })
    npcImg = 0;

    update() {
        if (!EDITOR) return;
        this.tileW = Math.min(TRIGGER_MAX, Math.max(1, Math.round(this.tileW)));
        this.tileH = Math.min(TRIGGER_MAX, Math.max(1, Math.round(this.tileH)));

        const ut = this.node.getComponent(UITransform);
        ut?.setContentSize(this.tileW * B, this.tileH * B);

        const p = this.node.position;
        const gx0 = Math.floor(p.x / B - this.tileW / 2 + 0.5);
        const gy0 = Math.floor(p.y / B - this.tileH / 2 + 0.5);
        const fitX = (gx0 - 0.5 + this.tileW / 2) * B;
        const fitY = (gy0 - 0.5 + this.tileH / 2) * B;
        if (p.x !== fitX || p.y !== fitY) this.node.setPosition(fitX, fitY, 0);

        const sprite = this.getComponent(Sprite);
        if (sprite) {
            const color = new Color();
            Color.fromHEX(color, TYPE_COLORS[this.triggerType] ?? TYPE_COLORS[0]);
            color.a = 95;
            sprite.color = color;
        }
    }
}
