<h1 align="center">impasto</h1>

<p align="center">
  Turn any photo into a palette-knife style painting.<br>
  <a href="https://www.dongha.ca/lab/impasto"><b>Try it in your browser →</b></a>
</p>


https://github.com/user-attachments/assets/db305659-1605-42f7-b331-419b5aa827ae


## What it does

- **Paints stroke by stroke.** It looks at your photo, decides where each knife stroke should go, then paints them one at a time, big shapes first and details last.
- **The paint is thick.** Strokes leave real ridges and heaps, so you can move the light and watch them catch it.
- **Runs anywhere.** Plain TypeScript with no dependencies. It works in the browser and in Node.

<p align="center">
  <img src="docs/images/pipeline.jpg" alt="Left to right: the photo, the planned strokes, and the finished painting" width="100%"><br>
  <sub>Photo → planned strokes → painting</sub>
</p>

## Try it on your computer

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
git clone https://github.com/donghaxkim/impasto.git
cd impasto/sim
npm install

# Paint your photo
npm run paint -- photo.jpg --look oil --name my-photo --export-surface

# Make a page where you can move the light
npm run viewer -- out/my-photo.impasto
```

Open `out/viewer-my-photo.html` in your browser and drag to move the light. A painting takes a few minutes. Add `--width 120` for a smaller, faster one.

## Use it in your own code

```sh
npm install tryimpasto
```

```ts
import { renderImpasto } from 'tryimpasto';
import { createImpastoViewer, attachPointerLight } from 'tryimpasto/viewer';

const result = await renderImpasto(photo, { preset: 'oil' });

const viewer = await createImpastoViewer(canvas, result.surface, {
  look: result.light.look,
  light: result.light,
  fallback: result.image,
});
attachPointerLight(viewer); // drag to move the light
```

The [engine docs](sim/README.md) cover everything else, like running it in a worker and saving paintings.

## How it works

1. **Look.** It finds the edges, shapes and directions in your photo.
2. **Plan.** It picks strokes layer by layer, from wide knives down to fine ones, only painting where the canvas still doesn't match the photo.
3. **Paint.** Each stroke pushes simulated paint across a canvas. The paint piles up, mixes and holds its shape like the real thing.
4. **Light.** The finished surface is lit like a real painting, with highlights and shadows that move with the light.

For a more detailed explanation, read [how impasto works](https://www.dongha.ca/impasto).

Built on ideas from Hertzmann's painterly rendering, Im2Oil, Paint Transformer and IMPaSTo.

## License

[MIT](LICENSE)
