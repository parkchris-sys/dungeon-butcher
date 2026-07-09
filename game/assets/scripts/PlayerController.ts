import { _decorator, Component, input, Input, EventKeyboard, KeyCode, Vec2 } from 'cc';
import { GameConfig } from './GameConfig';

const { ccclass } = _decorator;

/**
 * 정육점 주인 이동 — WASD/방향키.
 * (상호작용 없음 — 이동 프로토타입)
 */
@ccclass('PlayerController')
export class PlayerController extends Component {
    private pressed = new Set<KeyCode>();
    private dir = new Vec2();

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
    }

    private onKeyUp(e: EventKeyboard) {
        this.pressed.delete(e.keyCode);
    }

    update(dt: number) {
        let x = 0;
        let y = 0;
        if (this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT)) x -= 1;
        if (this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) x += 1;
        if (this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN)) y -= 1;
        if (this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) y += 1;
        if (x === 0 && y === 0) {
            return;
        }

        this.dir.set(x, y);
        this.dir.normalize();

        const speed = GameConfig.player.moveSpeed;
        const p = this.node.position;
        const half = GameConfig.player.size / 2;
        const m = GameConfig.map;
        const nx = Math.min(m.maxX - half, Math.max(m.minX + half, p.x + this.dir.x * speed * dt));
        const ny = Math.min(m.maxY - half, Math.max(m.minY + half, p.y + this.dir.y * speed * dt));
        this.node.setPosition(nx, ny, 0);
    }
}
