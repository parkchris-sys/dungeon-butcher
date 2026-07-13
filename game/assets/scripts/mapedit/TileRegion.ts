import { _decorator, Component, CCBoolean } from 'cc';

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 타일 편집 구역 마커 — regions 그룹 아래 사각형 노드에 붙는다.
 * editTiles를 체크하면 MapEditRoot가 이 구역 크기만큼만 타일 노드를 생성해 자식으로 넣어준다.
 * 다른 구역을 체크하면 타일 노드는 그쪽으로 재사용 이동 (남는 건 제거, 모자란 건 생성).
 * 이동/크기는 32px 격자에 자동 스냅.
 */
@ccclass('TileRegion')
@executeInEditMode
export class TileRegion extends Component {
    @property({ type: CCBoolean, tooltip: '체크 = 이 구역의 타일을 펼쳐서 편집 (한 번에 한 구역만)' })
    editTiles = false;
}
