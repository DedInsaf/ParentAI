"""Validated image-space outlines for the frontal portrait profile."""
import math

ANCHORS = ('crown', 'templeLeft', 'templeRight', 'earLeft', 'earRight',
           'neckLeft', 'neckRight', 'shoulderLeft', 'shoulderRight', 'chestLeft', 'chestRight')


def validate_anchors(value, landmarks):
    if not isinstance(value, dict) or set(value) != set(ANCHORS):
        raise ValueError('Нужен полный контур головы, шеи и плеч.')
    points = {}
    for key in ANCHORS:
        point = value[key]
        if (not isinstance(point, dict) or any(type(point.get(axis)) not in (int, float)
                or not math.isfinite(point[axis]) or not .01 <= point[axis] <= .99 for axis in ('x', 'y'))):
            raise ValueError('Все точки контура должны быть внутри снимка.')
        points[key] = {axis: point[axis] for axis in ('x', 'y')}
    if points['crown']['y'] >= landmarks[10]['y']:
        raise ValueError('Макушка должна быть выше лба.')
    for left, right in [('templeLeft', 'templeRight'), ('earLeft', 'earRight'), ('neckLeft', 'neckRight'),
                        ('shoulderLeft', 'shoulderRight'), ('chestLeft', 'chestRight')]:
        if points[right]['x'] - points[left]['x'] < .015:
            raise ValueError('Левая и правая границы контура пересекаются.')
    if not points['templeLeft']['x'] < points['crown']['x'] < points['templeRight']['x']:
        raise ValueError('Макушка должна быть между краями волос.')
    if points['earLeft']['x'] >= landmarks[234]['x'] or points['earRight']['x'] <= landmarks[454]['x']:
        raise ValueError('Разместите точки ушей за краями лица.')
    for side in ('Left', 'Right'):
        if points['neck'+side]['y'] <= landmarks[152]['y']:
            raise ValueError('Шея у воротника должна быть ниже подбородка.')
        if points['shoulder'+side]['y'] < points['neck'+side]['y']:
            raise ValueError('Точки плеч должны быть ниже края шеи.')
        if points['chest'+side]['y'] <= points['shoulder'+side]['y']:
            raise ValueError('Низ туловища должен быть ниже плеч.')
    if (points['shoulderLeft']['x'] >= points['neckLeft']['x']
            or points['shoulderRight']['x'] <= points['neckRight']['x']):
        raise ValueError('Точки плеч должны быть за пределами шеи.')
    return points
