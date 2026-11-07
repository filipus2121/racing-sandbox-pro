import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
(globalThis as Record<string, unknown>).__PROBE__ = true;
const car = new Vehicle(GT3_VENOM, defaultSetup(GT3_VENOM));
for (let i = 0; i < 4; i++) {
  car.setSurface(i, { ...NEUTRAL_SURFACE });
  car.tyres[i].coreTemp = GT3_VENOM.tyreRear.tempOpt;
  car.tyres[i].surfaceTemp = GT3_VENOM.tyreRear.tempOpt;
}
car.place(0, 0, 0, 51); car.gear = 6;
const inp = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
const dt = 1 / 500;
for (let i = 0; i < 100; i++) stepVehicle(car, inp, defaultEnvironment, dt);
console.log(((globalThis as unknown as { __P: string[] }).__P ?? []).join('\n'));
