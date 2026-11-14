#!/usr/bin/env python3
"""Remove only white background connected to image borders, retaining interior artwork."""
from collections import deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "shipwrekt" / "assets"
for name in ("shipwrekt-teal.png", "scanner-orange.png", "boarding-party-red.png"):
    path = ROOT / name
    im = Image.open(path).convert("RGBA")
    w,h = im.size
    px = im.load()
    seen = bytearray(w*h)
    q = deque()
    def near_white(x,y):
        r,g,b,_=px[x,y]
        return min(r,g,b)>=198 and max(r,g,b)-min(r,g,b)<=20
    for x in range(w):
        for y in (0,h-1):
            i=y*w+x
            if not seen[i] and near_white(x,y): seen[i]=1;q.append((x,y))
    for y in range(h):
        for x in (0,w-1):
            i=y*w+x
            if not seen[i] and near_white(x,y): seen[i]=1;q.append((x,y))
    while q:
        x,y=q.popleft()
        for nx,ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0<=nx<w and 0<=ny<h:
                i=ny*w+nx
                if not seen[i] and near_white(nx,ny):
                    seen[i]=1;q.append((nx,ny))
    removed=0
    for y in range(h):
        for x in range(w):
            if seen[y*w+x]:
                r,g,b,a=px[x,y]
                # feather near-white fringe, with true white fully transparent
                opacity=0
                px[x,y]=(r,g,b,opacity)
                removed+=1
    im.save(path,optimize=True)
    print(name,"background pixels processed:",removed,"corner alpha:",im.getpixel((0,0))[3])
