/**
 * 편집 씬 전역 표시 토글 — MapEditRoot의 체크박스가 값을 쓰고, 각 마커 컴포넌트가 읽는다.
 * MapEditRoot가 MapObject 등을 import하므로, 마커가 MapEditRoot를 직접 import하면
 * 순환 참조가 된다. 그래서 플래그만 담는 별도 모듈로 분리했다.
 */
export const EditFlags = {
    /** 오브젝트가 점유하는 타일을 마름모로 표시 (이미지에 가려 어느 칸인지 안 보이는 문제) */
    showObjectTiles: true,
};
