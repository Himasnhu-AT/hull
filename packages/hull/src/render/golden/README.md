# Golden images: WebGL2 against WebGPU

`images/webgl2.png` and `images/webgpu.png` are the same scene drawn by each backend: the vfx bench page
(`../../vfx/demo`), dusk look, medium quality, 640x360 at device pixel ratio 1, seed 7, 40 fixed steps after one burst of
every example effect. Nothing depends on real time; the page steps the game.

The two backends cannot match bit for bit (different rasterisers and shadow filters), so a pair passes when at most 5%
of pixels differ by more than 24/255 in any colour channel and the mean difference is under 4/255
(`compare.test.ts` checks the committed pair). Measured: 0.06% of pixels over 24, mean 0.09, PSNR 47.7 dB.

Capture again (headless Chrome through agent-browser gets a real WebGPU adapter on this Mac with no flags):

    node_modules/.bin/vite packages/hull/src/vfx/demo --port 5335
    agent-browser open 'http://127.0.0.1:5335/?hullBackend=webgpu&fire=1&snap=40&notrail=1&quality=medium'
    # then window.demo.capture() returns a PNG data URL; do the same with hullBackend=webgl2

Compare: `node compare-cli.ts images/webgpu.png images/webgl2.png diff.png`.

Known differences, low to high quality:
* Low tier (no post chain): smoke particles blend a little differently (mean diff about 2.4/255).
* High tier: grain is random per frame, and FXAA is three's own node on WebGPU against a trimmed FXAA 3.11 on WebGL2.
* Edges of spheres and particles differ by a pixel (rasteriser and MSAA resolve).
