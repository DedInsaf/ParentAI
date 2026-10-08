// Shared, dependency-free image operations for the local portrait matting worker.
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finiteAlpha = value => Number.isFinite(value) ? clamp(value) : 0;

function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(width * height) || width * height > 0x7fffffff) {
    throw new RangeError('Invalid portrait image dimensions');
  }
  return width * height;
}

function requireLength(values, expected) {
  if (values == null || values.length !== expected) throw new TypeError('Invalid portrait image buffer');
}

export function imageToNchw(rgba, width, height) {
  const count = pixelCount(width, height);
  requireLength(rgba, count * 4);
  const output = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[i * 4 + channel];
      output[channel * count + i] = clamp(Number.isFinite(value) ? value : 0, 0, 255) / 127.5 - 1;
    }
  }
  return output;
}

export function resampleAlpha(alpha, sourceWidth, sourceHeight, width, height) {
  const sourceCount = pixelCount(sourceWidth, sourceHeight), count = pixelCount(width, height);
  requireLength(alpha, sourceCount);
  const output = new Float32Array(count);
  // Pixel-center sampling keeps a matte aligned with the resized photograph.
  for (let y = 0; y < height; y++) {
    const sy = clamp((y + .5) * sourceHeight / height - .5, 0, sourceHeight - 1);
    const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = clamp((x + .5) * sourceWidth / width - .5, 0, sourceWidth - 1);
      const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), fx = sx - x0;
      const upper = finiteAlpha(alpha[y0 * sourceWidth + x0]) * (1 - fx) + finiteAlpha(alpha[y0 * sourceWidth + x1]) * fx;
      const lower = finiteAlpha(alpha[y1 * sourceWidth + x0]) * (1 - fx) + finiteAlpha(alpha[y1 * sourceWidth + x1]) * fx;
      output[y * width + x] = upper * (1 - fy) + lower * fy;
    }
  }
  return output;
}

function forNeighbours(index, width, height, visit) {
  const x = index % width, y = Math.floor(index / width);
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      if (nx >= 0 && nx < width) visit(ny * width + nx);
    }
  }
}

export function largestCategoryComponent(categories,width,height,category){
  const count=pixelCount(width,height);requireLength(categories,count);
  if(!Number.isInteger(category)||category<0||category>255)throw new RangeError('Invalid portrait category');
  const labels=new Int32Array(count),queue=new Int32Array(count);let label=0,largest=0,largestSize=0;
  for(let seed=0;seed<count;seed++){
    if(categories[seed]!==category||labels[seed])continue;
    const current=++label;let read=0,length=1;queue[0]=seed;labels[seed]=current;
    while(read<length)forNeighbours(queue[read++],width,height,next=>{
      if(categories[next]===category&&!labels[next]){labels[next]=current;queue[length++]=next;}
    });
    if(length>largestSize){largestSize=length;largest=current;}
  }
  const result=new Uint8Array(count);if(largest)for(let i=0;i<count;i++)if(labels[i]===largest)result[i]=1;
  return result;
}

export function openedCategoryComponent(categories,width,height,category,radius=2){
  const source=largestCategoryComponent(categories,width,height,category),count=pixelCount(width,height);
  if(!Number.isInteger(radius)||radius<1)throw new RangeError('Invalid opening radius');
  const eroded=new Uint8Array(count),opened=new Uint8Array(count);
  for(let y=radius;y<height-radius;y++)for(let x=radius;x<width-radius;x++){
    let keep=1;
    for(let oy=-radius;oy<=radius&&keep;oy++)for(let ox=-radius;ox<=radius;ox++)if(!source[(y+oy)*width+x+ox]){keep=0;break;}
    eroded[y*width+x]=keep;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let keep=0;
    for(let oy=-radius;oy<=radius&&!keep;oy++)for(let ox=-radius;ox<=radius;ox++){
      const px=x+ox,py=y+oy;if(px>=0&&py>=0&&px<width&&py<height&&eroded[py*width+px]){keep=1;break;}
    }
    opened[y*width+x]=keep;
  }
  // Very small or heavily occluded hairstyles may not survive erosion.
  return opened.some(Boolean)?opened:source;
}

export function cleanPortraitAlpha(alpha, width, height) {
  const count = pixelCount(width, height);
  requireLength(alpha, count);
  const values = Float32Array.from(alpha, finiteAlpha), labels = new Int32Array(count), queue = new Int32Array(count);
  let label = 0, largestLabel = 0, largestSize = 0;
  // Opaque dust and detached background predictions must not become geometry.
  for (let seed = 0; seed < count; seed++) {
    if (values[seed] < .5 || labels[seed]) continue;
    const currentLabel = ++label;
    let read = 0, length = 1;
    queue[0] = seed;
    labels[seed] = currentLabel;
    while (read < length) {
      forNeighbours(queue[read++], width, height, neighbour => {
        if (values[neighbour] >= .5 && !labels[neighbour]) {
          labels[neighbour] = currentLabel;
          queue[length++] = neighbour;
        }
      });
    }
    if (length > largestSize) { largestSize = length; largestLabel = currentLabel; }
  }
  const output = new Float32Array(count);
  if (!largestLabel) return output;
  const distance = new Int16Array(count).fill(-1), fringeRadius = Math.min(32766, Math.max(2, Math.ceil(Math.min(width, height) * .025)));
  let read = 0, length = 0;
  for (let i = 0; i < count; i++) {
    if (labels[i] !== largestLabel) continue;
    output[i] = values[i]; distance[i] = 0; queue[length++] = i;
  }
  // Keep the network's soft hair/skin edges instead of thresholding or eroding
  // them. The bounded fringe cannot bridge a large patch of background noise.
  while (read < length) {
    const index = queue[read++];
    if (distance[index] >= fringeRadius) continue;
    forNeighbours(index, width, height, neighbour => {
      if (distance[neighbour] >= 0 || values[neighbour] < .02 || (labels[neighbour] && labels[neighbour] !== largestLabel)) return;
      distance[neighbour] = distance[index] + 1;
      output[neighbour] = values[neighbour];
      queue[length++] = neighbour;
    });
  }
  // Flood every low-alpha region. A region touching any image edge is open
  // background; only small, fully enclosed prediction defects are filled.
  const visited = new Uint8Array(count), maxHoleArea = Math.max(4, Math.min(128, Math.round(count * .0003)));
  for (let seed = 0; seed < count; seed++) {
    if (visited[seed] || output[seed] >= .5) continue;
    read = 0; length = 1; queue[0] = seed; visited[seed] = 1;
    let exterior = false, boundaryTotal = 0, boundaryCount = 0;
    while (read < length) {
      const index = queue[read++], x = index % width, y = Math.floor(index / width);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) exterior = true;
      forNeighbours(index, width, height, neighbour => {
        if (output[neighbour] >= .5) { boundaryTotal += output[neighbour]; boundaryCount++; }
        else if (!visited[neighbour]) { visited[neighbour] = 1; queue[length++] = neighbour; }
      });
    }
    if (!exterior && length <= maxHoleArea && boundaryCount) {
      const replacement = boundaryTotal / boundaryCount;
      for (let i = 0; i < length; i++) output[queue[i]] = replacement;
    }
  }
  return output;
}

export function silhouetteRows(alpha, width, height, {startY = 0, endY = 1, centerX = .5, threshold = .5} = {}) {
  const count = pixelCount(width, height);
  requireLength(alpha, count);
  if (![startY, endY, centerX, threshold].every(Number.isFinite) || startY > endY || threshold <= 0 || threshold > 1) throw new RangeError('Invalid silhouette sampling options');
  const rows = [], first = Math.max(0, Math.ceil(startY * height - .5)), last = Math.min(height - 1, Math.floor(endY * height - .5));
  const center = clamp(centerX * width - .5, 0, width - 1), maxGap = Math.max(2, width * .05);
  for (let y = first; y <= last; y++) {
    let closest = null, closestGap = Infinity;
    for (let x = 0; x < width; x++) {
      if (finiteAlpha(alpha[y * width + x]) < threshold) continue;
      const left = x;
      while (x + 1 < width && finiteAlpha(alpha[y * width + x + 1]) >= threshold) x++;
      const right = x, gap = center < left ? left - center : center > right ? center - right : 0;
      if (gap < closestGap) { closest = {left, right}; closestGap = gap; }
    }
    if (closest && closestGap <= maxGap) rows.push({y: (y + .5) / height, left: closest.left / width, right: (closest.right + 1) / width});
  }
  return rows;
}
