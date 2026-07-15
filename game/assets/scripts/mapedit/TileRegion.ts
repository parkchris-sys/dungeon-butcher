import { _decorator, Component, CCBoolean, CCInteger } from 'cc';

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

    @property({
        type: CCInteger,
        tooltip: '지역 고유 ID — 모든 지역이 서로 다른 번호를 가져야 함 (생성 시 자동 부여).\n'
            + '던전 지역이면 몬스터 스폰 설정(DUNGEON_KINDS)의 키로 사용됨.\n'
            + '노드 이름은 자유롭게 (예: 슬라임 굴, 시작 마을)',
    })
    regionId = 0;
}
