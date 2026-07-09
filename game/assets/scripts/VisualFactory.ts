import { Node, Sprite, SpriteFrame, Texture2D, ImageAsset, UITransform, Color, Layers } from 'cc';

/**
 * 임시 도형 아트 생성기 (SnowCamp에서 검증된 방식).
 * 이미지 파일 없이 색상 사각형/원 노드를 만든다.
 * 엔티티 구조 규약: Root(로직) / Visual(그림) — 아트 교체 시 Visual만 교체.
 */

let whiteFrame: SpriteFrame | null = null;
let circleFrame: SpriteFrame | null = null;

function createFrame(size: number, alphaAt: (x: number, y: number) => number): SpriteFrame {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = alphaAt(x, y);
        }
    }
    const image = new ImageAsset({
        _data: data,
        _compressed: false,
        width: size,
        height: size,
        format: Texture2D.PixelFormat.RGBA8888,
    } as any);
    const texture = new Texture2D();
    texture.image = image;
    const frame = new SpriteFrame();
    frame.texture = texture;
    frame.packable = false;
    return frame;
}

function getWhiteFrame(): SpriteFrame {
    if (!whiteFrame) {
        whiteFrame = createFrame(4, () => 255);
    }
    return whiteFrame;
}

function getCircleFrame(): SpriteFrame {
    if (!circleFrame) {
        const S = 64;
        const R = S / 2;
        circleFrame = createFrame(S, (x, y) => {
            const dx = x + 0.5 - R;
            const dy = y + 0.5 - R;
            const edge = R - 0.5 - Math.sqrt(dx * dx + dy * dy);
            if (edge >= 1.5) return 255;
            if (edge <= 0) return 0;
            return Math.round((edge / 1.5) * 255);
        });
    }
    return circleFrame;
}

function createSpriteNode(name: string, parent: Node, x: number, y: number, w: number, h: number, color: Color, frame: SpriteFrame): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    parent.addChild(node);
    node.setPosition(x, y, 0);
    node.addComponent(UITransform).setContentSize(w, h);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = frame;
    sprite.color = color;
    return node;
}

export class VisualFactory {
    static createGroup(parent: Node, name: string): Node {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        return node;
    }

    static createRect(name: string, parent: Node, x: number, y: number, w: number, h: number, color: Color): Node {
        return createSpriteNode(name, parent, x, y, w, h, color, getWhiteFrame());
    }

    static createCircle(name: string, parent: Node, x: number, y: number, radius: number, color: Color): Node {
        return createSpriteNode(name, parent, x, y, radius * 2, radius * 2, color, getCircleFrame());
    }

    /** '#RRGGBB' → Color (마스터 팔레트용) */
    static hex(hexString: string, alpha: number = 255): Color {
        const color = new Color();
        Color.fromHEX(color, hexString);
        color.a = alpha;
        return color;
    }
}
