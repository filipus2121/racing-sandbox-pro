import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { NASCAR_NEXTGEN, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, CarInput, stepVehicle, SurfaceSample } from '../src/physics/vehicle.js';

const track = buildPresetTrack(TRACK_PRESETS.find(p => p.id === 'daytona')!);
const DT = 1 / 500;
const S = { grip: 1, rollingResist: 0, waterDepth: 0, bank: 0, slopeAlong: 0, slopeAcross: 0, rubber: 0 };

function radius(steer: number, v0: number, bank: number): { R: number; yaw: number } {
  const car = new Vehicle(NASCAR_NEXTGEN, defaultSetup(NASCAR_NEXTGEN));
  car.place(0, 0, 0, v0);
  car.gear = 3; car.rpm = 4000;
  for (let i = 0; i < 8 * 500; i++) {
    for (let w = 0; w < 4; w++) {
      const wp = car.wheelPosition(w);
      const c = Math.cos(car.heading), sn = Math.sin(car.heading);
      S.bank = bank; S.slopeAlong = 0; S.slopeAcross = Math.tan(bank);
      car.setSurface(w, S);
      void wp; void c; void sn;
    }
    const err = v0 - car.speed;
    const input: CarInput = { ...NO_INPUT, steer, throttle: err > 0.3 ? 0.6 : 0, brake: err < -0.3 ? 0.12 : 0 };
    stepVehicle(car, input, defaultEnvironment, DT);
  }
  const yaw = car.yawRate;
  return { R: Math.abs(yaw) > 1e-5 ? car.speed / Math.abs(yaw) : Infinity, yaw };
}

console.log('steady-state turn radius vs steering input (Next Gen)');
console.log(' steer(norm)  |  flat: yaw rad/s   R m   dir  |  31deg bank: yaw   R m   dir');
for (const steer of [-0.4, -0.2, -0.05, 0, 0.05, 0.2, 0.4]) {
  for (const kmh of [60, 160]) {
    const v0 = kmh / 3.6;
    const flat = radius(steer, v0, 0);
    const bank = radius(steer, v0, 31 * Math.PI / 180);
    const dir = (y: number) => y > 0.001 ? 'LEFT' : y < -0.001 ? 'RIGHT' : 'straight';
    console.log(`  ${steer.toFixed(2).padStart(6)}   | ${kmh} km/h ${flat.yaw.toFixed(4).padStart(8)} ` +
      `${(isFinite(flat.R) ? flat.R.toFixed(0) : 'inf').padStart(7)} ${dir(flat.yaw).padStart(8)}` +
      ` | ${bank.yaw.toFixed(4).padStart(8)} ${(isFinite(bank.R) ? bank.R.toFixed(0) : 'inf').padStart(7)} ${dir(bank.yaw).padStart(8)}`);
  }
}
