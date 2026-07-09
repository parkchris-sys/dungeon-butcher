import { _decorator, Component, Node } from 'cc';
import { GameConfig, PALETTE } from './GameConfig';
import { VisualFactory } from './VisualFactory';
import { PlayerController } from './PlayerController';
import { CameraFollow } from './CameraFollow';

const { ccclass } = _decorator;

/**
 * 게임 시작점 — Canvas 아래 Game 노드에 붙는다.
 * 정육 식당 허브 바닥 + 정육점 주인(더미)을 코드로 생성한다.
 * 마일스톤: WASD 이동만 (상호작용 없음).
 */

/** 시드 고정 난수 — 실행마다 같은 배치 */
function mulberry32(seed: number) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

@ccclass('GameBootstrap')
export class GameBootstrap extends Component {
    onLoad() {
        const world = VisualFactory.createGroup(this.node, 'World');

        this.buildHubFloor(world);
        const player = this.buildButcher(world);

        const follow = world.addComponent(CameraFollow);
        follow.target = player;
    }

    /** 정겨운 정육 식당 허브 바닥 (양피지/우드 톤 + 플랭크 라인) */
    private buildHubFloor(world: Node) {
        const m = GameConfig.map;
        const width = m.maxX - m.minX;
        const height = m.maxY - m.minY;

        // 바닥 (따뜻한 양피지 톤)
        VisualFactory.createRect('Floor', world, 0, 0, width, height, VisualFactory.hex('#EADFC4'));

        // 나무 플랭크 라인 (이동감이 보이게 가로 줄)
        const plankColor = VisualFactory.hex(PALETTE.rusticWood, 34);
        for (let y = m.minY + 80; y < m.maxY; y += 80) {
            VisualFactory.createRect(`Plank_${y}`, world, 0, y, width, 3, plankColor);
        }

        // 장식: 돌/나무 소품 (읽히는 실루엣의 단순 사각형)
        const rand = mulberry32(20260708);
        for (let i = 0; i < 26; i++) {
            const x = m.minX + 100 + rand() * (width - 200);
            const y = m.minY + 100 + rand() * (height - 200);
            if (x * x + y * y < 200 * 200) {
                continue; // 시작 지점 주변은 비움
            }
            const size = 20 + rand() * 22;
            const color = rand() < 0.5 ? VisualFactory.hex(PALETTE.stoneGray) : VisualFactory.hex(PALETTE.rusticWood);
            VisualFactory.createRect(`Deco_${i}`, world, x, y, size, size * (0.7 + rand() * 0.4), color);
        }

        // 맵 경계 (잉크 톤 테두리)
        const bt = 24;
        const border = VisualFactory.hex(PALETTE.ink);
        VisualFactory.createRect('BorderTop', world, 0, m.maxY - bt / 2, width, bt, border);
        VisualFactory.createRect('BorderBottom', world, 0, m.minY + bt / 2, width, bt, border);
        VisualFactory.createRect('BorderLeft', world, m.minX + bt / 2, 0, bt, height, border);
        VisualFactory.createRect('BorderRight', world, m.maxX - bt / 2, 0, bt, height, border);
    }

    /**
     * 정육점 주인 더미 (BIBLE §7: 땅딸막·큰 앞치마·두툼한 팔·클리버, Lv.1 견습).
     * Root(로직) / Visual(그림) 구조 — 픽셀 아트가 오면 Visual만 교체.
     */
    private buildButcher(world: Node): Node {
        const s = GameConfig.player.size;

        const player = VisualFactory.createGroup(world, 'Player');
        player.setPosition(0, 0, 0);

        // 그림자
        const shadow = VisualFactory.createCircle('Shadow', player, 0, -s * 0.5, s * 0.42, VisualFactory.hex(PALETTE.ink, 70));
        shadow.setScale(1, 0.4, 1);

        const visual = VisualFactory.createGroup(player, 'Visual');

        // 땅딸막한 몸 (러스틱 우드 톤 옷)
        VisualFactory.createRect('Body', visual, 0, -s * 0.08, s * 0.82, s * 0.62, VisualFactory.hex(PALETTE.rusticWood));
        // 낡은 앞치마 (Lv.1 견습 — 양피지 톤)
        VisualFactory.createRect('Apron', visual, 0, -s * 0.12, s * 0.5, s * 0.5, VisualFactory.hex(PALETTE.parchment));
        VisualFactory.createRect('ApronStrap', visual, 0, s * 0.16, s * 0.3, s * 0.06, VisualFactory.hex(PALETTE.agedMeat));
        // 두툼한 팔
        VisualFactory.createRect('Arm_L', visual, -s * 0.5, -s * 0.05, s * 0.18, s * 0.36, VisualFactory.hex(PALETTE.rusticWood));
        const armR = VisualFactory.createRect('Arm_R', visual, s * 0.5, -s * 0.05, s * 0.18, s * 0.36, VisualFactory.hex(PALETTE.rusticWood));
        // 클리버 (오른손 — 돌 회색 날 + 우드 손잡이)
        const cleaver = VisualFactory.createGroup(armR, 'WeaponSocket');
        cleaver.setPosition(s * 0.1, s * 0.2, 0);
        VisualFactory.createRect('CleaverHandle', cleaver, 0, -s * 0.12, s * 0.08, s * 0.22, VisualFactory.hex('#5A3A26'));
        VisualFactory.createRect('CleaverBlade', cleaver, 0, s * 0.12, s * 0.3, s * 0.34, VisualFactory.hex(PALETTE.stoneGray));
        // 머리
        const head = VisualFactory.createRect('Head', visual, 0, s * 0.38, s * 0.44, s * 0.4, VisualFactory.hex('#E8C49A'));
        VisualFactory.createRect('Hair', head, 0, s * 0.14, s * 0.48, s * 0.14, VisualFactory.hex('#5A3A26'));
        // 다리
        VisualFactory.createRect('Leg_L', visual, -s * 0.18, -s * 0.46, s * 0.16, s * 0.18, VisualFactory.hex(PALETTE.ink));
        VisualFactory.createRect('Leg_R', visual, s * 0.18, -s * 0.46, s * 0.16, s * 0.18, VisualFactory.hex(PALETTE.ink));

        player.addComponent(PlayerController);
        return player;
    }
}
