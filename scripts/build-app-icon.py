from PIL import Image, ImageDraw
from pathlib import Path
scale=4
im=Image.new('RGBA',(256*scale,256*scale),(0,0,0,0))
d=ImageDraw.Draw(im)
def box(xy):return tuple(int(v*scale) for v in xy)
green='#dcf76b'
d.rounded_rectangle(box((0,0,255,255)),radius=54*scale,fill='#101b18')
d.rounded_rectangle(box((32,52,224,204)),radius=23*scale,fill=green)
d.rounded_rectangle(box((44,64,212,192)),radius=11*scale,fill='#101b18')
for x in [76,180]:d.line(box((x,64,x,192)),fill=green,width=10*scale)
for x1,x2 in [(40,70),(186,216)]:
 for y in [102,154]:d.line(box((x1,y,x2,y)),fill=green,width=10*scale)
points=[(100,129),(120,149),(157,106)]
d.line([(x*scale,y*scale) for x,y in points],fill='#f5f8ef',width=14*scale,joint='curve')
for x,y in points:d.ellipse(box((x-7,y-7,x+7,y+7)),fill='#f5f8ef')
im=im.resize((256,256),Image.Resampling.LANCZOS)
im.save('assets/stills-library.png')
im.save('assets/stills-library.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Created editable SVG, PNG and Windows multi-size icon.')
