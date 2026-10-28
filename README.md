# Impasto · Milestone 0

A browser prototype for exploring layered oil-paint marks under movable light. The current milestone is an authored visual proof: it renders two built-in scenes, a still-life composition and a compact material diagnostic. It does not include photo input, image conversion, WASM, spectral rendering, workers, or a second rendering backend.

## Requirements

- Node.js 22.12 or newer
- A browser with WebGPU enabled and a compatible GPU/driver

The page needs WebGPU to draw the canvas. If WebGPU is unavailable, the interface reports that state instead of showing a CPU-rendered fallback.

## Run locally

Install the project dependencies, then start Vite:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The app uses TypeScript and Vite; no image assets or remote service are required.

## Controls

- Choose **Composition** or **Diagnostics** to switch authored documents.
- Drag on the canvas to move the light; the azimuth and elevation sliders provide direct controls.
- Adjust relief depth and surface roughness, or reset to the default lighting and material values.
- Switch between **Paint**, **Color**, **Height**, and **Normal** views.

The render-pass monitor reports counts for the current renderer instance. Changing lighting or view settings reruns the fullscreen lighting pass. Resizing the surface or switching scenes rebuilds the retained surfaces.

## Implementation outline

- Scene data is authored deterministically in TypeScript (`src/scene.ts`). Each stroke carries its path, width, pigment color, brush profile, seed, height, and roughness.
- `src/geometry.ts` samples the authored paths and builds indexed ribbon meshes. Invalid paths and unsafe reversals or crossings return empty geometry.
- `src/renderer.ts` rasterizes ordered stroke geometry into separate retained pigment and relief textures. The relief field comes from stroke height and brush profile, independent of pigment brightness.
- `src/shaders.ts` adds deterministic pigment variation and relief ridges, then derives screen-space normals and relights the retained surfaces in a fullscreen pass. Pigment is converted to linear light for surface compositing and encoded for display at presentation.
- `src/main.ts` wires the scene selector, material and lighting controls, view modes, pointer-based light movement, and pass counters.

This is a screen-space material study. It does not model a full 3D canvas, physical paint transport, pigment mixing, or spectral reflectance. The authored geometry and shader fields are a visual approximation, and appearance can vary by GPU and browser.

## Checks

Run the TypeScript check and production build with dependencies installed:

```sh
npm run typecheck
npm run build
```

The geometry tests use Node.js 22's experimental TypeScript stripping to import the TypeScript modules directly:

```sh
node --experimental-strip-types --test
```

The tests cover deterministic scene data, finite indexed mesh output, authored crossing cases, geometry independence from color/height metadata, invalid points, reversals, and self-intersections. These commands are documented here; run them in the current environment before treating their results as validated.

## Milestone 0 handoff

The retained-surface renderer, authored sample scenes, live light/material controls, debug views, and geometry checks form the current implementation boundary. There is no photo pipeline or production asset path in this milestone. A browser review should confirm GPU initialization, scene switching, relighting, resizing, and the visual readability of the four view modes on a WebGPU-capable device.
