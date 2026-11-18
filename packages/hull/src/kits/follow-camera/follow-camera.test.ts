import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { Camera } from '../../render/index.ts';
import { ThirdPerson } from '../third-person/third-person.ts';
import { ArenaLevel } from '../level/level.ts';
import bench from './bench.ts';
import { FollowCamera, followTuning } from './follow-camera.ts';

const sources = kitSources(...ALL_KITS);

async function start() {
  const r = await startRig(bench, sources, 'third-person');
  const w = r.g.world;
  return { r, w, me: w.find('player')!, cam: w.find('camera')!.get(FollowCamera)!, cn: w.find('camera')! };
}

describe('follow camera kit', () => {
  it('sits behind and above the target at rest and turns with the look input', async () => {
    const { r, me, cam, cn } = await start();
    r.step(60);
    expect(cam.dist).toBeCloseTo(followTuning.distance, 1);
    expect(cn.position.z - me.position.z).toBeGreaterThan(3);
    expect(cn.position.y).toBeGreaterThan(me.position.y + 1.5);
    r.step(30, { lookPad: { x: 1 } });
    expect(cam.yaw).toBeLessThan(-1);
    r.step(1, { look: { x: 0, y: 5000 } });
    expect(cam.pitch).toBeGreaterThanOrEqual(followTuning.pitchMin - 1e-9);
  });

  it('widens the view and pulls back with speed, and settles when the target stops', async () => {
    const { r, cn } = await start();
    r.step(60);
    const cameraFov = cn.get(Camera)!.fov;
    expect(cameraFov).toBeCloseTo(followTuning.fov, 1);
    r.step(50, { move: { y: -1 }, boost: { d: 1 }, sprint: { d: 1 } });
    expect(cn.get(Camera)!.fov).toBeGreaterThan(followTuning.fov + 5);
    r.step(150);
    expect(cn.get(Camera)!.fov).toBeLessThan(followTuning.fov + 1);
  });

  it('does not go through a wall behind the target, and eases out again', async () => {
    const { r, w, me, cam, cn } = await start();
    const half = w.find('level')!.get(ArenaLevel)!.half;
    // Camera is behind (+z) at yaw 0: walk backwards into the +z wall.
    r.step(400, { move: { y: 1 } });
    expect(me.position.z).toBeGreaterThan(half - 1.5);
    expect(cn.position.z).toBeLessThan(half);
    expect(cam.dist).toBeLessThan(2);
    r.step(20, { move: { y: -1 } });
    r.step(120, { move: { y: -1 } });
    expect(cam.dist).toBeGreaterThan(followTuning.distance * 0.8);
    void ThirdPerson;
  });
});
