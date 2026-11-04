# Port five permissive repos, rebuild the paint physics

Nobody has published an open-source tool that plans palette-knife strokes from an image, and nobody has released code for conserved-volume impasto. Even so, the parts we need exist, and most of them come under licences we can use. For the planner, the best code to port is **Im2Oil (CC0)**, a fully non-neural oil-painting planner, together with **Hertzmann's own 1998 layered-painting code (MIT)**. They should be combined with a **structure-tensor direction field** taken from Lindemeier's painty (MIT) or wet-paint-flow (MIT, JavaScript), and with **Paint Transformer's coarse-to-fine tiling (Apache-2.0)**. On the simulation side, no open code fits, but three papers supply the deterministic building blocks: Baxter's IMPaSTo (donor-cell transport that conserves paint exactly), Chu et al. 2010 (a canvas snapshot buffer that stops colour-smearing feedback during pickup), and Sumner et al. 1998 (height-field plowing with angle-of-repose relaxation, which gives the "deep crevice beside a crest" profile). For our open rendering issues, the beaded glints are a known specular-aliasing problem. It has a well-documented fix, NDF filtering, which Filament (Apache-2.0) and a JCGT 2021 paper describe, and it can be computed from grid finite differences so the CPU and GPU renderers stay in sync. For pigment, we should write our own small two-constant Kubelka–Munk model, seeded from rgb2spec (BSD-3) or spectral.js (MIT). **Mixbox is CC BY-NC 4.0 and cannot be shipped.** There are two legal flags. First, Adobe's **US8462173B2** "pickup and reservoir" paint patent has an estimated expiry of 2031 and resembles our locked-in reservoir nodes, so it needs a lawyer's review. Second, all GPL, non-commercial or unlicensed code below is ideas-only. Almost every fix for the open rendering and simulation issues would change locked-in behaviour, so those fixes are marked **needs your approval**. The planner is new code, so it is not.

---

## Top recommendations at a glance

| # | Recommendation | Main sources | Reuse | Approval |
|---|---|---|---|---|
| 1 | Build the planner from Im2Oil's density, anchor, extent and area-order pipeline, Hertzmann's per-layer error grid, a structure-tensor field, and Paint Transformer's overlapping 4-phase tiling. | Im2Oil (CC0), painterJava (MIT), painty / wet-paint-flow (MIT), Paint Transformer (Apache-2.0) | Code can be ported | Not needed (new code) |
| 2 | Fix beaded berm glints in **both** places. In the sim: no step longer than 1 cell, plus volume-conserving smoothing of the crest along the berm. In the renderer: Sobel normals plus geometric specular anti-aliasing (AA) computed from grid differences and aligned with the ridge. | Baxter, Chu 2010, Filament, Tokuyoshi & Kaplanyan 2021 | Ideas; Filament code is Apache-2.0 | **Needs your approval** (changes crest glints and berms) |
| 3 | Pair every glint with a recess: compute cavity and edge terms together, allow a glint only when a valley lies within r px, add micro-shadowing, and use asymmetric repose angles in the plow. | Blender workbench (GPL, ideas), Filament, Sumner 1998 | Ideas, plus Apache-2.0 code | **Needs your approval** (changes cavity darkening and plowing) |
| 4 | Reduce colour bands: pickup reads from a per-stroke canvas snapshot (Ω), pigment is stored as integer mass, and output is dithered with a deterministic integer-hash dither before 8-bit quantisation. | Chu 2010, IMPaSTo, libmypaint (ISC) | Ideas | **Needs your approval** (touches reservoirs, pickup and marbled colour) |
| 5 | Replace the ~18-line `pigment.ts` with a 8–16-band two-constant KM model when colour fidelity matters. | Curtis 1997, IMPaSTo, rgb2spec (BSD-3), spectral.js (MIT) | Tables and code can be ported | **Needs your approval** (changes marbled colour) |
| 6 | Determinism rules for the whole pipeline: a seeded integer PRNG, no `Math.sin` hash, `Math.sqrt` allowed, angle-doubled vectors in place of angles, a fixed iteration order, and a stable sort with a total-order key. | Synthesised from all notes | — | Not needed |

---

## Legal and licence flags that gate every reuse decision

These are research findings, not legal advice. The biggest exposure is a patent, not a licence. **US8462173B2**, "System and method for simulation of paint deposition using a pickup and reservoir model", was filed by Adobe (DiVerdi, Hadap, Krishnaswamy) with priority 2009-09-30 and granted 2013-06-11. Google Patents lists it as "Active" with an **anticipated expiration of 2031-08-12**, and describes a two-layer brush with a reservoir buffer and a pickup buffer ([Google Patents](https://patents.google.com/patent/US8462173)). Our locked-in per-node reservoirs with wet pickup resemble that description in spirit (researcher inference), but nobody has read the claims. Baxter's dAb brush already had a "surface" layer that refilled from a "reservoir" layer, and it was published in 2001 and 2004 ([Baxter dissertation §4.4](https://www.billbaxter.com/dissertation/Baxter-dissertation.pdf)). That makes it likely relevant prior art, which counsel should weigh. A second Adobe-adjacent patent, US8599213 ("configurable wetness, drying, and mixing"), came up in search, but neither its assignee nor its claims were checked.

| Item | Status | Consequence for us |
|---|---|---|
| US8462173B2 (Adobe pickup + reservoir) | Active, estimated expiry 2031-08-12; claims not read | **Legal review needed** before commercial release of the reservoir/pickup sim |
| Mixbox code, LUT and polynomial coefficients | **CC BY-NC 4.0**; commercial licence only by emailing the authors, no public price ([LICENSE](https://github.com/scrtwpns/mixbox/blob/master/LICENSE), [site](https://scrtwpns.com/mixbox/)) | Ideas only; do not copy the LUT or coefficients. Mixbox's own patent status was not checked. |
| Im2Oil `voronoi.py` | Repo is CC0, but the file looks structurally like N. Rougier's weighted-Voronoi-stippling code (unverified) | **Check where the file came from** before porting it line for line; re-deriving weighted Lloyd from the paper is safe |
| Stylized Neural Painting brush PNGs (`brush_fromweb2_*`) | Repo is CC0, but the filenames suggest the images were taken from the web | Don't ship these images; make our own knife and brush textures |
| Evrid/Oil-painting-stroke-generation | CC0, but its header says it contains code from an unlicensed repo ([repo](https://github.com/Evrid/Oil-painting-stroke-generation)) | Ideas only |
| No LICENSE file: ximluo/painterly, clipdraw, cloudpainter, impress, zqwerty | All rights reserved by default | Ideas only |
| GPL: Krita (GPL-2.0+), Blender, FRIDA, gpuakf, PyPainterly, AniPainter, SimplePainterlyRendering | Copyleft | Ideas only for a possibly commercial project |
| Non-commercial: Pigmento code, CLIPasso (CC BY-NC-SA 4.0) | NC | Ideas only |
| Remotional/impasto-oil-painting-simulator | MIT, but its LICENSE says it was "generated by HY4 (AI model)" ([repo](https://github.com/Remotional/impasto-oil-painting-simulator)) | Use the ideas, but don't treat the code as an authority |
| Unity HDRP specular AA | Unity Companion License (not OSI) | Ideas only |
| JCGT 2021 paper text and listings | CC BY-ND 3.0 ([JCGT](https://www.jcgt.org/published/0010/02/02/paper-lowres.pdf)) | Re-implement from the formulas |
| US 7102647 "Interactive horizon mapping" | Found, but its status was not checked ([Justia](https://patents.justia.com/patent/7102647)) | Check before shipping precomputed horizon maps; a short ray march avoids the question |

---

## Image-to-stroke planning: Hertzmann's own code plus a structure tensor gives a licence-clean core

The canonical layered algorithm is available from its author under MIT. In **hertzmann/painterJava**, `Painter.doLayer()` computes the error between a blurred reference and the canvas **once per layer**. It walks a grid with cell size equal to the brush radius and seeds a stroke at the pixel of maximum error whenever a cell's summed error exceeds `threshold·gridStep²`. It traces each stroke along the normal to the gradient and stops once the canvas is closer to the reference than the stroke colour would be ([Painter.java](https://github.com/hertzmann/painterJava/blob/main/java/Painter.java)). Defaults are three layers of radius 2, 4 and 8, a reference blur of 0.5·radius, `threshold=100`, and 4–16 control points. Stroke order is randomised cheaply: each stroke gets a z value from a `java.util.Random` seeded per layer, and a per-pixel z-buffer resolves the overlaps ([IntImage.java](https://github.com/hertzmann/painterJava/blob/main/java/IntImage.java)). There is one bug: `lastdx`/`lastdy` are declared per layer, so each stroke's first filtered step carries over the previous stroke's direction. Because the error grid is fixed for the whole layer, the set of strokes in a layer does not depend on the order they are emitted. *(Researcher inference:)* that is the property we want, because we can plan a whole layer and then sort it. Our sim must apply strokes in sequence, so we need a stored sort key rather than a z-buffer composite.

Hertzmann traces along the raw per-pixel gradient, which produces "worm" strokes. Every modern implementation that was read smooths the orientation field first. **lindemeier/painty** (MIT) blurs the gradient, then blurs the tensor components E=dx², F=dxdy, G=dy² at scales tied to the brush radius. It then takes the minor eigenvector in closed form, `sqrt((E−G)²+4F²)`, in `EdgeTangentFlow.cxx` ([source](https://github.com/lindemeier/painty/blob/develop/painty/image/src/EdgeTangentFlow.cxx)). **wet-paint-flow** (MIT, JavaScript) does the same with summed-area-table box blurs, and traces strokes in both directions with midpoint (RK2) steps in `traceInto()` ([main.js](https://github.com/simonxxooxxoo/wet-paint-flow/blob/main/main.js)). ximluo/painterly (no licence, so ideas only) blurs magnitude-weighted (cos2θ, sin2θ) vectors three times at σ = 0.5·radius. It also adds a turn budget of about 60° so strokes do not "curl into worms", and keeps going straight where the gradient is weak ([strokes.py](https://github.com/ximluo/painterly/blob/main/src/painterly/strokes.py)). Kang's ETF also gives coherent fields, but it costs O(r²) per pixel per iteration and needs `tanh`, cos and sin. The MIT SSARCandy port also has a channel bug: it computes flow from the blue channel only ([ETF.cpp](https://github.com/SSARCandy/Coherent-Line-Drawing/blob/master/src/ETF.cpp)). Hays & Essa took a different route: they interpolate a field from 10–200 "strong" strokes per layer using a *linear* radial basis function, which they found "more aesthetically pleasing", and grow each stroke until it hits a Canny edge ([IVBPA paper](https://faculty.cc.gatech.edu/~hays/papers/IVBPA_Final.pdf)). No code for Hays & Essa was found.

For a palette knife, seeding strokes by region matters more than for a brush, because knife strokes are wide, short and fill an area. painty's `PictureTargetSbrPainter::paint()` first measures the canvas-versus-target difference as a mix of Lab colour difference and difference-of-Gaussians (DoG) edge difference. It runs SLICO superpixels weighted by that difference, puts one stroke at the centre of the largest inscribed circle of each active region, and sets the stroke width to twice the inscribed radius. A path keeps growing only while Kubelka–Munk compositing of the chosen paint brings the region closer to the target ([PictureTargetSbrPainter.cxx](https://github.com/lindemeier/painty/blob/develop/painty/sbr/src/PictureTargetSbrPainter.cxx)). Gooch et al. 2002 get stroke centrelines and width profiles from region medial axes ([PDF](https://users.cs.northwestern.edu/~bgooch/PDFs/painting.pdf)). For stroke order, the sources mention several heuristics: large to small, random within a layer, least salient first ([Collomosse & Hall](https://personalpages.surrey.ac.uk/j.collomosse/pubs/Collomosse-IJAIT-2006.pdf)), background objects first, then depth, then a 5×5 spatial grid ([Ilinkin et al.](https://arxiv.org/pdf/2210.07590)), and grouping by colour. The robot-painting systems (painty, AniPainter, FRIDA, Evrid) all settle on records of *(centreline, width, colour or paint index, layer)*, sorted by brush size, then colour, then location.

| Repo / paper | Licence | Last activity | What to learn (files / functions) | Reuse vs idea | Deterministic-TS fit (inference) |
|---|---|---|---|---|---|
| [hertzmann/painterJava](https://github.com/hertzmann/painterJava) | MIT © 2022 Hertzmann | 2023-10-05 (code from ~1998) | `Painter.makeStrokes/doLayer` (error grid, argmax seeding, termination), `SplineStroke.computeLimitCurve` (cubic B-spline), `IntImage.bpaint` random-z ordering | **Port; keep the MIT notice; fix the `lastdx` leak** | High: only `sqrt`; replace `java.util.Random` with our own PRNG |
| [lindemeier/painty](https://github.com/lindemeier/painty) (branch `develop`) | MIT © 2020 | 2020-11-22 | `EdgeTangentFlow.cxx` `ComputeTensors`, `GetMinEigenVector`; `PathTracer::trace` (bidirectional, step 0.25·r; a probable `growF`/`growB` bug); `PictureTargetSbrPainter::paint/generateBrushStrokes/computeDifference/checkConvergence`; `Superpixel.cxx` SLICO, `getInscribedCircle`; `smoothOABF` | **Port**, but it depends on OpenCV | Medium: remove `std::random_device`, `std::random_shuffle` and `std::pow` |
| [simonxxooxxoo/wet-paint-flow](https://github.com/simonxxooxxoo/wet-paint-flow) | MIT © 2026 | 2026-08-20 | `buildDirectionField` (integral-image tensor), `traceInto` (RK2; stops on depth jump > 0.075 or colour distance > 0.31), `poissonLayer` (R2 sequence + grid Poisson disc), `lineBlend3`; tiers of 6 / 22.5 / 71.5 % | **Port** (closest language) | Medium: its `hash()` is `fract(Math.sin(…))`; also uses `atan2/cos/sin/hypot` |
| [SSARCandy/Coherent-Line-Drawing](https://github.com/SSARCandy/Coherent-Line-Drawing) | MIT © 2019 | 2026-07-09 | `src/ETF.cpp` `initial_ETF`, `refine_ETF`, `computeNewVector`; `webgl/index.html` | Port if ETF is wanted | Low: `tanh`, trig, blue-channel bug, O(r²) cost |
| [esimov/colidr](https://github.com/esimov/colidr) | MIT © 2019 | 2021-04-13 | `etf.go`, `cld.go` | Port | Low (same maths as ETF) |
| [msmolens/painterly-rendering](https://github.com/msmolens/painterly-rendering) | MIT © 2004–15 | 2015-03-01 | `Stroke.cpp` `subdivideCubicBSpline`, `subdivideFourPoint`, `scanConvert` (ribbon + caps), `arcLength`; style presets | Port the geometry | High (plain arithmetic) |
| [ximluo/painterly](https://github.com/ximluo/painterly) | **None** | 2026-08-09 | `_etf` (angle-doubled blur), `_grow_stroke` (turn budget, keep straight below gradient 2.0), `_failing_cells`, `_bezier` refit; `order.py` `painter_order` lexicographic key; claims byte-identical output for the same seed | **Ideas only** | The design fits |
| [manuelladron/painterPython](https://github.com/manuelladron/painterPython) | MIT | 2023-12-03 | — (NaN-prone termination; samples canvas colour at the stroke start only) | Skip | — |
| [PyPainterly](https://github.com/pschaldenbrand/PyPainterly) / [AniPainter](https://github.com/pschaldenbrand/AniPainter) | GPL-3.0 | 2021-02-21 / 2022-05-17 | AniPainter `curved_stroke_to_straight` (PCA fit to a 3-point stroke), `save_strokes_for_robot` (sort by radius, then colour) | Ideas only | — |
| [jkyprian/gpuakf](https://github.com/jkyprian/gpuakf) | GPL-3.0 | 2024-05-19 | `sst.glsl`, `akf_v2.glsl` (anisotropic Kuwahara as an abstraction pre-pass) | Ideas only | Would need a GPU-free re-derivation |
| [Trenza1ore/Relax-Painter](https://github.com/Trenza1ore/Relax-Painter) | MIT © 2025 | 2025-12-29 | Not real relaxation (README admits it is simplified) | Skip | — |
| Hays & Essa 2004 ([PDF](https://faculty.cc.gatech.edu/~hays/papers/IVBPA_Final.pdf)) | Paper | 2004 | Linear-RBF field from strong strokes; growth clipped at Canny edges | Idea (no code) | Good fallback where the tensor is low-confidence |
| Paint by Relaxation, via [Hertzmann 2003 survey](https://www.dgp.toronto.edu/~hertzman/sbr02/hertzmann-cga03.pdf) | Paper | 2003 | Energy E_app + w·N_strokes + w·uncovered | Idea: **use as a test metric**, not as the optimiser ("can take many hours") | Good |
| Gooch 2002, Collomosse & Hall 2006, Ilinkin et al. 2022 | Papers | — | Medial-axis strokes; least-salient-first order; object, then depth, then grid order | Ideas | Collomosse's genetic search is non-deterministic as described |

---

## Paint simulation: no open code conserves impasto volume, but the papers supply the primitives

None of the open codebases read (dli/paint, libmypaint, Krita) simulates conserved impasto volume. The useful material is in papers, none of which released code. In Baxter's **IMPaSTo**, paint volume is advected as just another scalar with a donor-cell flux scheme. Each cell keeps q(Δx − |vΔt|) and donates q|vΔt| downwind, and the CFL bound guarantees that no cell gives away more than it holds ([dissertation §6.4.1](https://www.billbaxter.com/dissertation/Baxter-dissertation.pdf)). Paint under the brush moves at half the brush's tangential velocity. A heuristic "pressure" velocity **v_p = −c∇p**, where p is penetration depth, pushes paint out from under the deepest contact. An "anti-Teflon" clamp leaves a minimum residual of paint in each cell. Baxter's own Stokes paint model, by contrast, "is currently not conserved, in large part because of the semi-Lagrangian advection" (§5.6), and the same weakness applies to Stuyck et al.'s mobile oil model and to dli/paint ([advect.frag](https://github.com/dli/paint/blob/master/shaders/advect.frag)). dAb, IMPaSTo and Chu 2010 all step the brush **at most one canvas texel per step**.

**Chu, Baxter, Wei & Govindaraju 2010** explains why paint simulations go muddy. A footprint N pixels wide resamples each pixel about N times, and newly deposited paint gets picked up again, so the stroke drifts toward the brush colour. The fix has two parts: a pickup map at canvas resolution, plus a **canvas snapshot buffer Ω** that pickup reads from. Ω is refreshed everywhere except under the pickup map, and fully refreshed on sharp direction changes. The paper reports that the map alone reduces blur, while adding Ω eliminates it ([Chu et al. NPAR 2010](https://microsoft.com/en-us/research/wp-content/uploads/2010/06/PaintModel_NPAR_2010.pdf)). The closest prior art to our plowing is **Sumner, O'Brien & Hodgins 1998**. The tool contact pushes height-field columns down. The displaced material goes to the first ring of non-contact columns, which forms the berm. Then relaxation moves σ of the excess height downhill wherever the slope exceeds θ_in (next to the tool) or θ_out (elsewhere), repeating until slopes fall below θ_stop. The paper's sand values are θ_out = 0.436, θ_in = 0.8, σ = 0.2 and α = 0.3; its snow values are θ = 1.57 and α = 0 ([Sumner et al.](https://escholarship.org/content/qt3nk515kp/qt3nk515kp.pdf?t=rbq1r9)). Mei et al.'s virtual-pipe model contributes the outflow scale factor K = min(1, available / requested), which stops any cell from emitting more than it holds ([Mei 2007](https://core.ac.uk/download/52631892.pdf)).

*(Researcher inferences, not sourced.)* All three conservative schemes become bit-exact and independent of traversal order if they are implemented with **integer volume and integer per-pigment mass**. Each pass computes donations from a read-only old buffer, scales them with an integer Mei-style K, and scatters them into a new buffer, with remainders carried in a fixed direction. Concentration would be derived only for rendering, so renormalisation drift cannot cause colour banding. dAb's 8-bit relative height is a warning: when height is stored at low precision, shading shows terracing ([§4.8](https://www.billbaxter.com/dissertation/Baxter-dissertation.pdf)).

| Source | Licence | Last activity | What to learn | Reuse vs idea | Deterministic-TS fit (inference) |
|---|---|---|---|---|---|
| Baxter dissertation: dAb / Stokes / IMPaSTo ([PDF](https://www.billbaxter.com/dissertation/Baxter-dissertation.pdf), [IMPaSTo text](https://math.vu.nl/~eliens/demo/local/documents/impasto.htm)) | Papers; no code released ([publications](https://www.billbaxter.com/publications)) | 2004 | Donor-cell flux + CFL; anti-Teflon residual; ½ brush velocity + v_p = −c∇p; Algorithm 1 transfer (XFER_FRACTION 0.1, EQUALPAINT_CUTOFF 1/30, smoothstep(0.2, 0.3, \|v\|) so a slow brush doesn't ooze, MAX_XFER 0.001); ≤1-texel stepping; drying into dry layers | Idea | **Excellent** in integer form |
| Chu et al. NPAR 2010 ([PDF](https://microsoft.com/en-us/research/wp-content/uploads/2010/06/PaintModel_NPAR_2010.pdf)) | Paper | 2010 | Canvas-resolution pickup map; snapshot Ω; imprints ≤1 px apart | Idea | Excellent (one buffer copy per stroke) |
| Sumner et al. 1998 ([PDF](https://escholarship.org/content/qt3nk515kp/qt3nk515kp.pdf?t=rbq1r9)) | Paper | 1998 | Contact contour labels, displacement to the first ring, asymmetric θ_in/θ_out erosion | Idea | Excellent: compare Δh with integer tanθ·d, no arctan |
| Mei et al. 2007 ([PDF](https://core.ac.uk/download/52631892.pdf)) | Paper | 2007 | Outflow scale K | Idea | Excellent |
| Stuyck et al. ([PDF](https://tuurstuyck.github.io/assets/oilpaint_low_res.pdf)) | Paper | — | Fixed pigment-layer stack that merges the bottom two layers when full; viscosity modulated by smoothstep of pigment density; Torrance–Sparrow fit to measured oil | Idea | Its semi-Lagrangian transport is non-conservative |
| Wetbrush, Chen et al. 2015 ([PDF](https://wanghmin.github.io/publication/chen-2015-wgb/Chen-2015-WGB.pdf)) | Paper; no code | 2015 | Bristle load and capacity hysteresis; 64-ray AO | Mostly skip | 3D grid + FLIP particles: poor fit |
| Okaichi et al. 2008, "A virtual painting knife" ([Springer](https://link.springer.com/article/10.1007/s00371-008-0257-5)) | Paper (paywalled) | 2008 | The only dedicated palette-knife paper | **Unread**; only the abstract | Unknown |
| [dli/paint](https://github.com/dli/paint) | MIT © 2017 | 2017-02-14 | `splat.frag` (capsule splat), split blend (colour alpha-composited, **height additive**); `painting.frag` `computeGradient` (3×3 Sobel) and GGX | Port the normal and BRDF code; **skip `advect.frag`** | Bristle randomness uses `Math.random` |
| [mypaint/libmypaint](https://github.com/mypaint/libmypaint) | ISC | 2026-04-14 | `brushmodes.c` 15-bit fixed-point compositing; smudge buckets in `mypaint-brush.c` | Pattern to copy | Integer maths is deterministic; its WGM `fastpow` is not |
| [KDE/krita](https://github.com/KDE/krita) paintops | GPL-2.0-or-later | HEAD 2026-10-28 | `hairy_brush.cpp` ink depletion; `KisColorSmudgeStrategyLightness.cpp` pseudo-height | Ideas only | No volume model |

---

## Pigment mixing: write a small two-constant Kubelka–Munk model; Mixbox stays ideas-only

Mixbox's idea is clean, but its licence rules it out. The paper's latent is four pigment concentrations plus an RGB residual. Mixing is a linear interpolation in that latent, and the residual makes the RGB round trip exact ([paper](https://scrtwpns.com/mixbox.pdf)). Reading the shipped `mixbox.js` showed that the runtime differs from the paper. It uses a **64³ uint8 RGB→concentration LUT** with trilinear lookup, and a **homogeneous cubic polynomial with 20 monomials** as the decoder ([mixbox.js](https://github.com/scrtwpns/mixbox/blob/master/javascript/mixbox.js)). That runtime is pure arithmetic and would be deterministic, but the code, LUT and coefficients are **CC BY-NC 4.0**, and the last commit was 2022-12-16. The method can be rebuilt from our own pigment data and our own offline NNLS solver. Whether a clean-room rebuild is safe from any Secret Weapons patent is a question for counsel. spectral.js (MIT) upsamples RGB to 38 bands using 7 Smits-style basis spectra and mixes with **single-constant** KM ([spectral.js](https://github.com/rvanwijnen/spectral.js/blob/master/spectral.js)). Single-constant KM cannot express hiding power or glazes, and spectral.js weights each paint by factor², so mix(mix(a,b),c) ≠ mix(a,b,c) (researcher reading of the code).

The physics we need is standard and free to reimplement. Two-constant KM mixes K and S as concentration-weighted averages (IMPaSTo, Pigmento and Mixbox all do this). Thick paint uses R∞ = a − √(a²−1) with a = 1 + K/S, which needs only `sqrt`. Thin glazes use the finite-thickness R and T formulas from Curtis et al., which need sinh and cosh, followed by the rational Kubelka compositing formula R = R1 + T1²R2/(1 − R1R2) ([Curtis 1997](https://grail.cs.washington.edu/projects/watercolor/paper_small.pdf)). IMPaSTo found that **8 wavelengths chosen by Gaussian quadrature are "almost identical" to 101 samples** ([IMPaSTo](https://math.vu.nl/~eliens/demo/local/documents/impasto.htm)). Pigmento says "below 8 wavelengths, the color reproduction loses fidelity" ([Pigmento](https://ar5iv.labs.arxiv.org/html/1707.08323)). Licence-clean spectra can come from rgb2spec (BSD-3). Its sigmoid model, `½ + x/(2√(1+x²))`, needs only `sqrt`, and its offline Levenberg–Marquardt fitter is self-contained ([rgb2spec](https://github.com/mitsuba-renderer/rgb2spec)). The measured-paint databases (Okumura's RIT thesis is "withdrawn"; no download was found for Berns' database) are not usable sources.

| Source | Licence | Last activity | What to learn | Reuse vs idea | Deterministic-TS fit (inference) |
|---|---|---|---|---|---|
| [scrtwpns/mixbox](https://github.com/scrtwpns/mixbox) | **CC BY-NC 4.0**; commercial licence by contact | 2022-12-16 | `unpackedFloatRgbToLatent` (64³ LUT), `evalPolynomial`, `lerpLatent`, latent + residual idea | **Ideas only** | Deterministic, but blocked by the licence |
| [rvanwijnen/spectral.js](https://github.com/rvanwijnen/spectral.js) | MIT © 2025 | 2026-01-01 | `lRGB_to_R`, `BASE_SPECTRA` (7×38), `CIE.CMF`, `KS`, `KM` | Copy the tables with attribution | `sqrt` plus sRGB `pow` (use a LUT); drop `gamutMap` (trig, cbrt) |
| [mitsuba-renderer/rgb2spec](https://github.com/mitsuba-renderer/rgb2spec) | BSD-3 © 2020 Jakob | 2026-09-16 | `rgb2spec_eval_precise`, `rgb2spec_fetch`, `rgb2spec_opt.cpp` (LM in CIELAB) | **Reuse offline** to generate pigment spectra | `sqrt` only |
| [CraGL/fastLayerDecomposition](https://github.com/CraGL/fastLayerDecomposition) | MIT © 2023 | 2026-09-29 | `Convexhull_simplification.py` palette from the RGB convex hull | Port the geometry for palette extraction | Good |
| [JianchaoTan/Pigmento-PaintingAnalysis](https://github.com/JianchaoTan/Pigmento-PaintingAnalysis) | **Non-commercial** | 2018-12-25 | `equations_in_RealPigments`; ideas: ANLS unmixing, initialising from hull vertices, a sparsity term | Ideas only | — |
| libmypaint `helpers.c` | ISC | 2026-04-14 | 10-band weighted-geometric-mean (WGM) mix | Not KM; skip | `powf` per band |
| Curtis 1997; IMPaSTo 2004 | Papers | — | KM from colours over white and over black; finite-thickness R/T; layer compositing; 8-band quadrature | Reimplement | sinh/cosh via `dmath` or a LUT over quantised optical thickness |

*(Researcher inference.)* A target `pigment.ts` would use 6–10 pigments, each with K[N] and S[N] for N = 8–16 bands generated offline. Each cell would hold an integer mass vector. Shading would apply R∞ when h·S is above a hiding threshold and finite-layer compositing otherwise, then a fixed 3×N spectral→linear-RGB matrix, then an sRGB LUT. For the planner there would be an offline 32³ RGB→recipe LUT built by fixed-iteration NNLS, restricted to 2–3 pigments per recipe. This changes how marbled colour looks, so it **needs your approval**. The planner can emit target RGB plus an optional recipe so that it does not depend on this decision.

---

## Rendering: beaded glints are a specular-aliasing problem with a published fix

A thin crest lit by a sharp GGX lobe only glows where n·h is close to 1. Small ripples along the crest, including the staircase left by stepped deposition, push n·h in and out of the peak and produce a string of beads (researcher diagnosis; no paint-specific source was found). The production fix is **geometric specular anti-aliasing (NDF filtering)**. Filament's `computeKernelRoughness` and `normalFiltering` add a variance term based on how fast the normal changes, roughness² + min(2σ²(‖Δn_u‖²+‖Δn_v‖²), κ), and apply the same treatment to clear-coat ([Filament surface_lighting.fs](https://github.com/google/filament/blob/main/shaders/src/surface_lighting.fs)). Tokuyoshi & Kaplanyan give **σ² = 1/(2π) and κ = 0.18**, plus anisotropic and axis-aligned variants ([JCGT 2021](https://www.jcgt.org/published/0010/02/02/paper-lowres.pdf)). Filament reads `dFdx` and `dFdy`, but our surface is a fixed grid. *(Inference:)* Δn can therefore be grid finite differences, which `relight.ts` and `relight-gpu.ts` can compute identically, whereas WGSL `dpdx` works on 2×2 quads and will not match the CPU. An anisotropic kernel aligned with the ridge would widen the lobe only across the berm, joining the glints up along it while keeping them sharp across it. Filament also evaluates its clear-coat lobe (F0 = 0.04, "fix IOR to 1.5") against a **smoother normal** than the base. Elkhuizen et al. cite a refractive index of 1.47–1.52 for oil paint and varnish ([TU Delft](https://pure.tudelft.nl/ws/portalfiles/portal/68206864/3317949.pdf)), which supports F0 ≈ 0.04. *(Inference:)* a sharp coat lobe on a low-passed height field gives the continuous "wet sheet" highlight, and a rougher base lobe carries the knife-scale facets. Physically, oil levels itself under surface tension, so the smoothed coat is plausible as well as an anti-beading measure.

To place a dark recess beside each glint, the best template is Blender's workbench cavity pass. It is GPL, so we can use the idea only, but the formulas are short. One sample loop accumulates both **cavities** (darken) and **edges** (brighten). A curvature pass takes the divergence of the normal and applies separate valley and ridge soft clamps using `c·(1 − c·k)`, with no exp or pow ([Blender shaders](https://projects.blender.org/blender/blender/src/branch/main/source/blender/draw/engines/workbench/shaders)). XeGTAO (MIT, Intel) supplies a horizon-based AO with an analytic arc integral and a polynomial `XeGTAO_FastACos` ([XeGTAO](https://github.com/GameTechDev/XeGTAO)). *(Inference:)* on an orthographic height field with fixed slice directions and fixed step counts, XeGTAO is fully deterministic and needs no trig. Filament's `computeMicroShadowing` turns AO into a cone, so crevices also darken direct light. *(Inference, aimed at the 47 % figure:)* physically based AO alone will not guarantee that a recess sits next to every glint. Glints can be **gated**, kept only where a valley lies within r px along ±∇h. Recesses can also be **carved**, by darkening a strip dilated downhill from each crest. Both use only min, max and multiply-add.

| Source | Licence | Last activity | What to learn | Reuse vs idea | Deterministic-TS fit (inference) |
|---|---|---|---|---|---|
| [google/filament](https://github.com/google/filament) | Apache-2.0 | 2026-11-03 | `computeKernelRoughness`, `normalFiltering`, `clearCoatLobe` (coat uses the geometric normal), `computeMicroShadowing` | Port with notice | High once `dFdx` is replaced with grid differences |
| Tokuyoshi & Kaplanyan, [JCGT 2021](https://www.jcgt.org/published/0010/02/02/paper-lowres.pdf) | Paper (text CC BY-ND) | 2021 | σ² = 1/2π, κ = 0.18; anisotropic 2×2 kernel (Listing 1); axis-aligned clamp (Listing 3) | Reimplement | Arithmetic plus `sqrt` |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | MIT | 2026-11-03 | `geometryRoughness` heuristic; roughness floor 0.045; `BRDF_GGX_Clearcoat`. Avoid `NormalMapShader.js` forward differences (half-texel shift) | Port with notice | High |
| [GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO) | MIT © Intel | 2024-04-22 | `XeGTAO_MainPass` horizon search, arc integral, bent normal, `XeGTAO_FastACos` | Port with notice | High with fixed directions |
| Blender workbench `workbench_cavity` / `workbench_curvature` | GPL | 2026-11-04 | Dual cavity and edge accumulation; normal-divergence curvature; soft clamp | **Ideas only** | High (arithmetic) |
| [Remotional/impasto-oil-painting-simulator](https://github.com/Remotional/impasto-oil-painting-simulator) | MIT (AI-generated) | 2026-08-31 | `composite.ts`: Sobel normals, 20-step shadow march, 10-sample ring AO | Ideas | High |
| [wet-paint-flow](https://github.com/simonxxooxxoo/wet-paint-flow) `wetSpecular` | MIT | 2026-08-20 | Roughness `mix(0.44, 0.11, wet)`, so wet paint is glossier | Idea | High |
| Jimenez 2014 bloom ([iryoku](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/)) | Talk | 2014 | 13-tap downsample, Karis average, tent upsample | Idea (slides not opened) | Use explicit `textureLoad` taps, not hardware bilinear |
| LEAN mapping ([Olano & Baker](https://userpages.cs.umbc.edu/olano/papers/lean/)) | Paper | 2010 | Slope moments → anisotropic lobe | Idea | Good |
| [cnr-isti-vclab/relight](https://github.com/cnr-isti-vclab/relight) | LGPL-3.0 core | 2026-10-21 | RTI capture of real impasto | Reference data for tuning | — |

---

## Learned painters contribute renderers, tilings and ordering rules, not networks

**Im2Oil (ACM MM 2022, CC0) is not a neural method at all, and it is almost the planner we need.** Its steps are:

- **Density:** gradient magnitude, box-blurred and normalised to [p_max/100, p_max]. The anchor count is `int(density.sum())`, so it is linear in the one fineness parameter.
- **Anchors:** placed by 15 iterations of weighted Voronoi (Lloyd) relaxation.
- **Orientation:** ETF.
- **Extent:** `FindPath_V7` marches 1 px at a time in both directions along the field and along its perpendicular. It continues while hue stays within 30 OpenCV units and value within 15, up to `max_length = 3·max_width`, clamped by √(1/density) ([search_and_render.py](https://github.com/TZYSJTU/Im2Oil/blob/HEAD/search_and_render.py), [Line_Tools.py](https://github.com/TZYSJTU/Im2Oil/blob/HEAD/Line_Tools.py)).
- **Order:** by **area, descending**.
- **Gap filling:** about 3 rounds of connected-component hole filling.

Its brush texture modulates only V, with hue and saturation held flat ([simulate_RGB.py](https://github.com/TZYSJTU/Im2Oil/blob/HEAD/simulate_RGB.py)). *(Inference:)* that maps naturally onto "texture is height, relighting supplies the value". In a 115-volunteer MOS study, Im2Oil at p = 1/4 scored **8.26**, against 7.46 for Stylized Neural Painting, 7.17 for Learning to Paint and 6.96 for Paint Transformer ([ar5iv 2209.13219](https://ar5iv.labs.arxiv.org/html/2209.13219)). The paper reports no PSNR or timing.

The other repos contribute pieces of machinery. **Paint Transformer** (Apache-2.0) uses a 32·2^k patch pyramid with 8 strokes per patch. It samples **colour from the target at the stroke centre**, so only geometry is predicted. It renders in 50%-overlapping windows in **4 checkerboard phases**, and adds a final layer shifted by half a patch so no detail is missed ([inference.py](https://github.com/Huage001/PaintTransformer/blob/HEAD/inference/inference.py)). Its training code keeps a stroke only if it covers less than 75% of every earlier stroke, and it computes a closed-form **Gaussian-Wasserstein distance** between rotated rectangles ([painter_model.py](https://github.com/Huage001/PaintTransformer/blob/HEAD/train/models/painter_model.py)). **Stylized Neural Painting** (CC0) samples stroke centres from blur(|T−C|)^4, splits a global budget as total/Σ cells over levels (500/55 ≈ 9 per block), and emits stroke i of every patch before stroke i+1, so no region is finished in one go ([painter.py](https://github.com/jiupinjia/stylized-neural-painting/blob/HEAD/painter.py)). **Learning to Paint** (MIT) parameterises a stroke as a quadratic Bézier whose control point is a fraction of the chord (so it cannot loop), with linearly interpolated radius and opacity, drawn as 100 discs at 2× supersampling ([stroke_gen.py](https://github.com/megvii-research/ICCV2019-LearningToPaint/blob/HEAD/baseline/Renderer/stroke_gen.py)). Its tiles-plus-seam-blur scheme would leave seams in a height field. The 2022–2025 learned papers mainly contribute ordering principles: background before foreground, one object at a time ([Intelli-Paint](https://arxiv.org/abs/2112.08930v1), [Inverse Painting](https://inversepainting.github.io)), choosing the next region where help is most needed ([Compositional Neural Painter](https://arxiv.org/html/2309.03504v2)), and small strokes in detailed regions ([AttentionPainter](https://arxiv.org/abs/2410.16418)).

| Repo / paper | Licence | Last activity | What to learn | Reuse vs idea | Deterministic-TS fit (inference) |
|---|---|---|---|---|---|
| [TZYSJTU/Im2Oil](https://github.com/TZYSJTU/Im2Oil) | CC0 (check `voronoi.py` provenance) | 2023-07-26 (code 2022-09/10) | `voronoi_sampler.py` `K_Means_Sampler`; `voronoi.py` `centroids`; `ETF/edge_tangent_flow.py`; `Line_Tools.py` `FindPath_V7`; `search_and_render.py` `Search_Stroke`; `simulate_RGB.py` `GetBrush_HSV`; hole-fill loop in `Oil-Painting.py`; `quicksort.py` | **Port** (re-derive Lloyd) | High: replace `np.random` and the N(0,1)/100 tie-break with a seeded hash |
| [Huage001/PaintTransformer](https://github.com/Huage001/PaintTransformer) | Apache-2.0 | 2021-10-20 | `inference.py` pyramid, `param2img_parallel/serial` (4-phase windows), half-shift layer; `painter_model.py` occlusion rule, `gaussian_w_distance` | **Port the tiling and metrics**; skip the network | High |
| [jiupinjia/stylized-neural-painting](https://github.com/jiupinjia/stylized-neural-painting) | CC0 (brush PNGs unverified) | 2021-08-26 | `painter.py` `stroke_sampler`, `_shuffle_strokes_and_reshape`; `demo_prog.py` budget; `renderer.py` 2×2 dilate-colour / erode-alpha, two-colour ramp | Port the ideas and code; not the PNGs | High with argmax + non-maximum suppression in place of `np.random.choice` |
| [megvii-research/ICCV2019-LearningToPaint](https://github.com/megvii-research/ICCV2019-LearningToPaint) | MIT © 2019 | 2025-05-07 (code 2019) | `stroke_gen.py` `draw`; the "error decrease per stroke" acceptance test | Port the stroke parameterisation | High |
| [cmubig/Frida](https://github.com/cmubig/Frida) | GPL-3.0 | 2024-06-18 | k-means in LAB palette snapping; `sort_brush_strokes_by_color/location` (greedy TSP) | Ideas only | — |
| [yael-vinker/CLIPasso](https://github.com/yael-vinker/CLIPasso) | CC BY-NC-SA 4.0 | 2022-10-03 | Initialisation from saliency × XDoG edges | Ideas only | Needs a non-neural saliency |
| [kvfrans/clipdraw](https://github.com/kvfrans/clipdraw) | None | 2022-04-28 | — | Ideas only | — |
| Compositional Neural Painter, Intelli-Paint, AttentionPainter, Inverse Painting, ProcessPainter, Prudviraj & Jamwal 2025 | Licences unverified | 2022–2025 | Next region by error; background first; density prior; segments-then-strokes | Ideas only | Implement as non-neural heuristics |

---

## Open issues mapped to candidate fixes

| Open issue | Candidate fix (source) | Layer | Approval |
|---|---|---|---|
| Glints along long berms look like beads | (a) Step the tool ≤1 cell per substep (dAb, IMPaSTo, Chu 2010). (b) Volume-conserving 1D smoothing of crest height along the berm tangent, moving mass only between neighbours (inference). (c) Sobel/Scharr normals instead of forward or central differences (dli/paint, impasto-sim). (d) Geometric specular AA from grid Δn, anisotropic and aligned with the ridge (Filament, JCGT 2021). (e) Coat lobe on a low-passed normal (Filament) | sim + `relight.ts` + `relight-gpu.ts` | **Needs your approval** (berms, crest glints) |
| Only 47 % of glints sit beside a dark recess | (a) Cavity and edge terms from one pass (Blender, ideas). (b) Allow a glint only where a valley lies within r px along ±∇h (inference). (c) Carve a recess by dilating each crest downhill (inference). (d) Micro-shadowing (Filament) plus a key-light height-field ray march (impasto-sim idea). (e) Steep θ_in at the tool, shallower θ_out outside (Sumner) | sim + render | **Needs your approval** (differential cavity darkening, plowing) |
| Colour bands reduced but not gone | (a) Pickup reads from the snapshot Ω (Chu 2010). (b) Integer per-pigment mass, with concentration derived only for rendering (IMPaSTo conservation; inference). (c) Integer-hash ordered dither before 8-bit output, identical on CPU and GPU (inference). (d) Check height precision, given dAb's terracing (Baxter §4.8) | `canvas.ts`, `tool.ts`, render | **Needs your approval** (reservoirs, wet pickup, marbled colour) |
| Lyskov-style look (deep crevices beside blinding glints) | Sumner asymmetric repose; IMPaSTo v_p = −c∇p squish to deepen the trough under the edge; sharp coat over rough base; micro-shadowing; planner emits short, wide, straight-ish knife strokes | All layers | Sim and render parts **need your approval**; the planner does not |

---

## Adopt / Skip

**Adopt**

- **Planner:** Im2Oil pipeline (CC0; re-derive weighted Lloyd if `voronoi.py`'s provenance is unclear).
- **Planner:** Hertzmann's per-layer error grid and termination test (MIT; fix the `lastdx` leak).
- **Planner:** structure-tensor field with minor eigenvector and anisotropy confidence (painty `ComputeTensors` / wet-paint-flow `buildDirectionField`, MIT).
- **Planner:** bidirectional RK2 tracing (wet-paint-flow `traceInto`, painty `PathTracer`).
- **Planner:** superpixel inscribed-circle seeding for coarse knife layers (painty, MIT).
- **Planner:** Paint Transformer 4-phase overlapping tiling, half-shift pass, 75 % occlusion rule and Gaussian-Wasserstein merge (Apache-2.0).
- **Planner:** SNP budget formula and interleaved emission (CC0).
- **Planner:** Learning to Paint's quadratic Bézier with a relative control point (MIT).
- **Planner:** low-discrepancy R2 seeding with an integer hash (from wet-paint-flow, minus its `Math.sin` hash).
- **Planner:** convex-hull palette extraction (fastLayerDecomposition, MIT).
- **Testing:** Hertzmann's relaxation energy as a test metric.
- **Sim primitives (needs your approval):** integer donor-cell transport with Mei K scaling; the snapshot buffer Ω; Sumner displacement-plus-repose with integer slope thresholds; ≤1-cell stepping.
- **Render (needs your approval):** Filament NDF filtering on grid differences; clear-coat on a smoothed normal; micro-shadowing; XeGTAO-style fixed-direction horizon AO (MIT); Blender-style dual cavity and edge terms (re-implemented); Sobel normals.
- **Pigment (needs your approval):** two-constant KM, 8–16 bands, spectra from rgb2spec (BSD-3) or spectral.js tables (MIT).

**Skip**

- **Code we cannot ship:** Mixbox code, LUT and coefficients (CC BY-NC); Pigmento code (NC); all GPL code (Krita, Blender, FRIDA, gpuakf, PyPainterly, AniPainter); unlicensed repos (ximluo, clipdraw, cloudpainter); SNP brush PNGs.
- **Non-conservative transport:** semi-Lagrangian advection (dli/paint `advect.frag`, Stuyck, Baxter's Stokes paint), which loses volume.
- **Approaches that don't fit:** Wetbrush-style 3D grid with particles; Paint by Relaxation as an optimiser (too slow); Collomosse's genetic search (non-deterministic); Learning to Paint's independent tiles with seam blur (seams in a height field).
- **Numerics to avoid:** single-constant KM (spectral.js `mix`), because it has no hiding or glazes; ETF as the primary field, because the tensor is cheaper, has a closed form and avoids `tanh`; any `Math.sin` hash; WGSL `dpdx/dpdy` for anything that must match the CPU.

---

## Recommended planner design: Im2Oil anchors, Hertzmann layers, tensor flow, knife-shaped strokes

The design below is the researchers' synthesis. Each step names its prior art. The choices specific to palette knives (length:width ratio, turn limit, load ramps, order within a layer) are **design choices, not sourced findings**, because no open palette-knife planner exists. The planner is new code, so it is not covered by the locked-in-behaviour rule. It should still follow the sim's numeric rules: no `Math.sin`, `pow`, `exp` or `random`; use `dmath.ts`; `Math.sqrt` is allowed.

**0. Contract.** The planner is `plan(image: RGBA8, settings, seed) → StrokePlan`. It is a pure function. Each stroke record holds:

- `id`
- `layer`
- `orderKey`
- `path`: a quadratic Bézier with 3 control points in canvas cells
- `width` profile
- `bladeAngle` relative to the tangent
- `pressure` ramp at start and end
- `load` volume
- `targetRGB`
- optional `pigmentRecipe`

Robot planners converge on the same record shape (centreline, width, paint, layer) ([AniPainter](https://github.com/pschaldenbrand/AniPainter/blob/master/paint.py), [painty](https://github.com/lindemeier/painty/blob/develop/painty/sbr/src/PictureTargetSbrPainter.cxx)). The plan is serialised and its hash is checked in determinism tests.

**1. Analysis maps** (computed once):

- **Colour:** sRGB→linear through a 256-entry LUT. Perceptual colour distance through a `dmath` cube root or a LUT (CIELAB); OKLab with `Math.cbrt` is not used.
- **Optional abstraction pre-pass:** an orientation-aligned bilateral filter (painty `smoothOABF` idea), used only for sampling colours.
- **Density map** D = normalise(box-blur(|Sobel|), p_max/100, p_max), as in Im2Oil.
- **Direction field:** for each layer scale, a structure tensor with inner and outer blurs proportional to knife width, computed with integral images. The tangent is the closed-form minor eigenvector. Confidence is anisotropy (λ1−λ2)/(λ1+λ2). Everything is stored as vectors, never as angles.
- **Palette:** a convex-hull palette (fastLayerDecomposition idea) or k-means in Lab with median-cut initialisation, plus an optional RGB→recipe LUT once a KM `pigment.ts` exists.
- **Optional saliency** for background-first ordering, from a non-neural method (for example spectral residual; not researched here).

**2. Layer schedule.** Use 3–5 layers with knife width roughly halving each time (Hertzmann doubles radii: 2, 4, 8). The global stroke budget is N ≈ Σ D (Im2Oil), split across layers as total/Σ cells (SNP), or capped per cell per layer (Paint Transformer uses 8 per 32 px cell). Im2Oil's counts of 566–5,097 strokes across p_max = 1/36…1/4 give a calibration range for fineness.

**3. Seeding each layer** against a frozen error map E = blur(|T − C|):

- **Coarse layers:** superpixels weighted by E, with one seed at each region's inscribed-circle centre and width = 2× the inscribed radius (painty). This gives region-filling knife strokes.
- **Medium and fine layers:** weighted-Lloyd anchors over D·E (Im2Oil), initialised from an R2 sequence in fixed point instead of `np.random`. Alternatively, use Hertzmann's per-cell argmax when error exceeds `threshold·cell²`.
- **What C is.** For the first layer, C is the blank or underpainted canvas. For later layers, *(design choice)* C is the **sim's own unlit pigment albedo** after the previous layer has been simulated. Plowing moves paint away from where it was planned, so feedback from the real sim corrects drift. Because the sim is deterministic, this stays reproducible. Within a layer the error map is frozen, Hertzmann-style, so the layer's stroke set does not depend on its order.

**4. Growing strokes.**

- From each seed, trace in both directions with RK2 steps of 0.25·width along the tensor tangent, aligning signs with dot products (painty, wet-paint-flow).
- Stop when any of these happens:
  - the Lab distance from the anchor colour exceeds a tolerance (Im2Oil uses hue within 30 units and V within 15);
  - Hertzmann's test holds: the canvas is closer to the target than the stroke colour would be;
  - length reaches 3× width (Im2Oil's ratio, which suits short knife strokes);
  - the cumulative turn exceeds a **tight knife budget**. ximluo uses about 60°; for a rigid blade something like 20–30° is a design choice.
- Where confidence is low, keep going straight (ximluo), or fall back to the coarser layer's field (in the spirit of Hays & Essa).
- Width comes from perpendicular marching (Im2Oil w1, w2), clamped by √(1/D) and the layer cap.
- Refit the spine to a quadratic Bézier with its control point as a fraction of the chord (Learning to Paint, ximluo's `_bezier`).

**5. Accepting and cleaning up strokes.**

- Colour = target at the anchor, or the footprint mean (Paint Transformer, Im2Oil). Optionally snap it to the palette.
- Reject a candidate that would cover ≥75 % of an already accepted stroke in the same layer (Paint Transformer).
- Merge near-duplicates under a Gaussian-Wasserstein threshold.
- Optionally accept only if a cheap proxy footprint lowers local L1 error (Learning to Paint's reward used as a greedy test). Refine with deterministic coordinate descent instead of RMSprop (SNP idea).

**6. Knife parameters** (design choices). The blade is perpendicular to the path tangent by default, with a skew setting. Pressure and load ramp up at the start and release at the end, like SNP's two-colour ramp and Im2Oil's V-only texture, with texture expressed as height. Load volume scales with layer: studio lore says "thin to thick" or "fat over lean", which no source encodes. Make it a setting.

**7. Ordering.** Sort stably by a lexicographic key (ximluo's structure; Hertzmann's random z becomes the final hash):

1. layer, coarse to fine;
2. region rank, background or least-salient first (Collomosse, Intelli-Paint, Inverse Painting);
3. optional colour bin. FRIDA puts lighter colours first; studio lore puts dark first. Make it a setting;
4. Paint Transformer checkerboard phase (0–3), then cell interleave (SNP);
5. area descending (Im2Oil);
6. `hash32(seed, strokeId)`.

Every key component must be an integer or an exact comparison, so the order is total.

**8. Hole fill.** Rasterise the planned footprints into a coverage mask. Take connected components of the uncovered pixels, put an anchor at each centroid, regrow strokes with minimum length and width increased each round, and stop after about 3 rounds or when no holes remain (Im2Oil). These strokes go at the end of their layer.

**9. Tests.** Check that the plan hash is identical across runs and engines. Track:

- the Hertzmann energy E_app + w·N + w·uncovered;
- L1/ΔE against stroke count at several p_max values;
- coverage before hole fill;
- that median stroke area falls with each layer;
- the fraction of each stroke still visible after the sim.

Measured "naturalness" of order has no standard metric, so judge it visually.

---

## What could not be verified

- **Patents.**
  - The claims of US8462173B2 were not read, and the 2031 expiry is Google's estimate.
  - The assignee and claims of US8599213 were not checked.
  - The status of US 7102647 (horizon mapping) was not checked.
  - Nobody searched for Secret Weapons (Mixbox) patents.
  - None of this is legal advice.
- **Provenance.**
  - Whether Im2Oil's `voronoi.py` derives from Rougier's stippling code.
  - Where SNP's `brush_fromweb2_*` PNGs came from.
  - The licences of Compositional Neural Painter, Inverse Painting and the PaddleGAN Paint Transformer port (not located).
- **The only palette-knife paper.** The Okaichi et al. 2008 full text was not accessible, so its knife geometry and transfer model are unknown. Corel Painter's Plow, Depth and Smoothing internals, and those of Rebelle and Adobe Fresco, are undocumented.
- **Papers not read.**
  - Hertzmann's NPAR2000 C++ code (not public).
  - The Vanderhaeghe & Collomosse 2013 chapter.
  - Lindemeier et al. 2015 CGF (the fetch failed).
  - The full Nolte et al. 2023 survey.
  - The Kang 2007 and Kyprianidis papers (described only through code).
  - Baxter's brush-model papers.
  - The full Viscous/CASA paper.
  - The exact deposition formula in Chu 2010 (lost in text extraction).
  - Jimenez's 2014 bloom slides (details come from secondary implementations).
  - The 2016 and 2019 specular-AA slides.
- **Nothing was run.** All behaviour claims come from reading the source. No implementation was executed, and direction-field quality was not benchmarked. Mixbox's decoded LUT length and sample mix outputs were not measured. No 8 vs 16 vs 38-band comparison was run for KM.
- **Determinism details.**
  - WGSL `sqrt`/`inverseSqrt` precision versus JS float64 `Math.sqrt` has not been checked against the WGSL accuracy table. This matters for keeping `relight.ts` and `relight-gpu.ts` in sync.
  - The claim that `Math.sqrt` is correctly rounded in every JS engine rests on IEEE-754 and ECMAScript's treatment of sqrt, not on an engine test.
- **Missing data.** No measured roughness α for wet or dry oil paint was found (Elkhuizen does not fit roughness). There is no quantitative AO study for painted surfaces. The availability and licence of the Berns and Okumura spectral databases are unknown.
- **Researcher diagnoses.** The diagnosis that "beading = specular aliasing on stepped crests" and the fixes for glint–recess coupling are inferences, not sourced paint-specific results. They need confirmation on our own renders.
- **Coverage and metadata.** Search coverage of 2025–2026 learned-painting work is thin beyond June 2025. GitHub API metadata (stars, archived flags) was blocked, so "last activity" means the date of the newest commit in a shallow clone.

---

## Conclusion

The research changes what kind of problem this is. The planner is not a research problem: most of it can be ported from Im2Oil, painterJava and Paint Transformer, all under usable licences, and the open part is how to adapt it to rigid, short, wide knife strokes. That should be settled by tuning against the sim, not by more literature. The hard and novel part remains the sim–render boundary. The sources point to **two different kinds of bead fix**. Sim-side fixes (≤1-cell stepping, smoothing along the crest) remove the ripple. Render-side fixes (NDF filtering, a smoothed coat) hide it. Prefer the sim-side fixes, because hiding the ripple also softens the "blinding glint" we are aiming for. The integer-mass representation that IMPaSTo-style conservation suggests would fix colour banding and conservation drift in one step.

The planner design closes the loop through the sim's own albedo between layers. That turns plowing drift, normally a planning error, into a signal the planner corrects. Because sim and planner are both deterministic, the loop costs nothing in reproducibility. Finally, the reservoir-and-pickup patent should go to counsel **before** further work on wet-pickup features rather than after: of everything in this report, it is the one risk that engineering cannot work around.

---

## Coordinator spot-checks (2026-11-03)

- **Licences re-checked** against the LICENSE/COPYING file in every cloned repo (36 in total). All match the tables above. `cnr-isti-vclab/relight` ships `LICENSE`, `LICENSE-LGPL-3.0` and `LICENSE-GPL-3.0`, which is consistent with "core LGPL-3.0, optional parts GPL-3.0". No-LICENSE status confirmed for ximluo/painterly, kvfrans/clipdraw, cloudpainter, impress and zqwerty.
- **painterJava direction leak confirmed:** `lastdx`/`lastdy` are declared at `Painter.java:262–263`, outside the per-stroke loop, and are read at line 339 (`k > 1`) and line 346. The seeding test is at line 301 (`totalErr > threshold * gridStep * gridStep`).
- **wet-paint-flow `Math.sin` usage confirmed** (`main.js` lines 534, 610 and 612). Port its algorithms, not its hash.
- **Im2Oil `voronoi.py` provenance still unresolved.** The `rasterize()` scanline routine matches the structure of Rougier's weighted-Voronoi-stippling, but GitHub could not be reached from this environment to diff the two, and the ReScience/Zenodo record (CC BY 4.0) lists no files. Recommendation: write weighted Lloyd relaxation from scratch (~80 lines) rather than port this file.
