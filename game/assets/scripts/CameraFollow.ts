import { _decorator, Component, Node, math } from 'cc';
import { GameConfig } from './GameConfig';

const { ccclass } = _decorator;

/**
 * 카메라 따라가기 — World 노드를 역스크롤해 타겟을 화면 중앙에 유지.
 * (2D 카메라 설정을 건드리지 않는 가장 안전한 방식 — SnowCamp 검증)
 * World 노드에 붙인다.
 */
@ccclass('CameraFollow')
export class CameraFollow extends Component {
    public target: Node | null = null;
    public smoothing = GameConfig.camera.smoothing;

    start() {
        if (this.target) {
            this.node.setPosition(-this.target.position.x, -this.target.position.y, 0);
        }
    }

    lateUpdate(dt: number) {
        if (!this.target) {
            return;
        }
        const tp = this.target.position;
        const t = Math.min(1, this.smoothing * dt);
        const cur = this.node.position;
        this.node.setPosition(
            math.lerp(cur.x, -tp.x, t),
            math.lerp(cur.y, -tp.y, t),
            0,
        );
    }
}
