import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
const setup = defaultSetup(GT3_VENOM);
const c = new Vehicle(GT3_VENOM, setup);
for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
c.place(0, 0, 0, 0);
c.gear = 1; c.rpm = GT3_VENOM.engine.idleRpm;
const inp = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
console.log('idle', GT3_VENOM.engine.idleRpm, 'redline', GT3_VENOM.engine.redlineRpm, 'gears', setup.gearRatios.length, 'gear1', setup.gearRatios[0], 'final', setup.finalDrive);
for (let i = 0; i < 8 / dt; i++) {
  stepVehicle(c, inp, defaultEnvironment, dt);
  if (i % 250 === 0) {
    console.log('t', (i * dt).toFixed(1),
      'v', c.speed.toFixed(2),
      'kmh', (c.speed * 3.6).toFixed(1),
      'rpm', Math.round(c.rpm),
      'gear', c.gear,
      'clutchSlip', c.clutchSlip.toFixed(1),
      'wheelTq', c.wheelTorqueDrive.toFixed(0),
      'fxRR', c.wheels[3].fx.toFixed(0),
      'fzRR', c.wheels[3].fz.toFixed(0),
      'slipRR', c.tyres[3].relaxedSlipRatio.toFixed(3));
  }
}
