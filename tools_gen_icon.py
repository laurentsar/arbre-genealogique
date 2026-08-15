#!/usr/bin/env python3
"""Génère les icônes de l'app en PNG, sans dépendance (ni Pillow ni ImageMagick).

Motif : un arbre stylisé (tronc + feuillage rond) en camaïeu ambre sur fond
ardoise chaud — cohérent avec le thème sombre/sépia de l'application.

Sorties : img/icon-512.png, img/icon-192.png
"""
import struct, zlib

BG = (22, 17, 13, 255)        # fond ardoise chaude
TRUNK = (90, 58, 30, 255)     # tronc brun
LEAVES = (207, 154, 76, 255)  # feuillage ambre (couleur d'accent)
LEAVES_2 = (232, 183, 105, 255)  # reflet plus clair


def blend(dst, src):
    a = src[3] / 255.0
    if a >= 1:
        return src
    return tuple(int(src[i] * a + dst[i] * (1 - a)) for i in range(3)) + (255,)


def rounded_rect_mask(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 + r <= x <= x1 - r or y0 + r <= y <= y1 - r:
        return x0 <= x <= x1 and y0 <= y <= y1
    return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= r


def in_circle(px, py, cx, cy, r):
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def draw(size, with_bg=True, inset=0.0):
    S = size
    img = [[(0, 0, 0, 0)] * S for _ in range(S)]

    def X(u):
        return (inset + u * (1 - 2 * inset)) * S

    def Y(v):
        return (inset + v * (1 - 2 * inset)) * S

    if with_bg:
        r = S * 0.22
        for y in range(S):
            for x in range(S):
                if rounded_rect_mask(x, y, 0, 0, S - 1, S - 1, r):
                    img[y][x] = BG

    def put(x, y, color):
        if 0 <= x < S and 0 <= y < S:
            img[y][x] = blend(img[y][x], color) if img[y][x][3] else color

    # tronc
    tx0, tx1 = X(0.45), X(0.55)
    ty0, ty1 = Y(0.60), Y(0.86)
    for y in range(int(ty0), int(ty1)):
        for x in range(int(tx0), int(tx1)):
            put(x, y, TRUNK)

    # feuillage : trois cercles superposés
    blobs = [
        (X(0.5), Y(0.42), S * 0.22, LEAVES),
        (X(0.34), Y(0.52), S * 0.16, LEAVES),
        (X(0.66), Y(0.52), S * 0.16, LEAVES),
        (X(0.5), Y(0.30), S * 0.14, LEAVES_2),
    ]
    x0, x1 = int(X(0.12)), int(X(0.88))
    y0, y1 = int(Y(0.14)), int(Y(0.70))
    for y in range(y0, y1):
        for x in range(x0, x1):
            for (cx, cy, r, color) in blobs:
                if in_circle(x + 0.5, y + 0.5, cx, cy, r):
                    put(x, y, color)
                    break
    return img


def write_png(path, img):
    S = len(img)
    raw = b''.join(b'\x00' + b''.join(struct.pack('4B', *px) for px in row) for row in img)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', comp)
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print(path, S, 'px')


if __name__ == '__main__':
    write_png('img/icon-512.png', draw(512, with_bg=True))
    write_png('img/icon-192.png', draw(192, with_bg=True))
